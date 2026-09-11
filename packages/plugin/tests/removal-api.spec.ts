import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'
import { createCompanionTools } from '../src/agent-tools.js'
import { createCompanionHttpRoute } from '../src/http-route.js'
import { isForwardCloseConfirmed } from '../src/closure.js'

async function setup() {
  const service = await CompanionService.create(new MemoryCompanionStateStore())
  const app = await service.registerService({ name: 'App', port: 5173, protocol: 'http', source: 'agent' })
  const ticket = await service.createPairingTicket()
  const { device } = await service.pairDevice({ code: ticket.code, installationId: 'test', name: 'Test', osVersion: '15', architecture: 'arm64', companionVersion: 'test', capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true } })
  const lease = await service.openLease({ serviceId: app.id, deviceId: device.id })
  return { service, app, lease }
}

test('AI compatibility tools operate on one Host-global registry from any cwd', async () => {
  const { service, app, lease } = await setup()
  const definitions = createCompanionTools(service)
  const invoke = async (name: string, args: Record<string, unknown>, cwd = '/outside/any-task') => {
    const tool = definitions.find(item => item.name === name)
    assert.ok(tool?.execute)
    return await tool.execute(args as never, { agent: { session: { header: { cwd } } } } as never) as Record<string, unknown>
  }
  const other = await service.registerService({ name: 'Other', port: 5174, protocol: 'http', source: 'agent' })
  const otherLease = await service.openLease({ serviceId: other.id, deviceId: lease.deviceId })

  const closed = await invoke('task_forward_close', { lease_id: lease.id })
  assert.equal(closed.desired_state, 'closed')
  assert.equal('task_id' in closed, false)
  const removed = await invoke('task_service_unregister', { service_id: other.id }, '/a/different/task')
  assert.ok(removed.archived_at)
  assert.equal(service.snapshot().leases.find(item => item.id === otherLease.id)?.desiredState, 'closed')
  const snapshot = await invoke('task_forward_list', {})
  assert.equal('task_id' in snapshot, false)
  const rows = snapshot.leases as { close_confirmed: boolean; instance_state: string }[]
  assert.ok(rows.every(row => row.close_confirmed === false && row.instance_state === 'unconfirmed'))
  await assert.rejects(invoke('task_forward_open', { service_id: other.id, device_id: lease.deviceId }), /registered/)
  assert.equal(service.list().services[0]!.id, app.id)
})

test('global unregister HTTP requires authenticated same-origin JSON and keeps legacy Task path compatible', async t => {
  const { service, app, lease } = await setup()
  const route = createCompanionHttpRoute(service, [], undefined, undefined, undefined, {
    requestRejection: req => req.headers.cookie === 'admin=yes' ? undefined : 401,
  })
  const server = createServer((req, res) => { void route.handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/companion'
  const path = '/services/' + app.id + '/unregister'
  const post = (target: string, headers: Record<string, string>) => fetch(base + target, { method: 'POST', headers, body: '{}' })
  const admin = { cookie: 'admin=yes', 'content-type': 'application/json' }
  assert.equal((await post(path, { 'content-type': 'application/json' })).status, 401)
  assert.equal((await post(path, { ...admin, origin: 'http://evil.example' })).status, 403)
  assert.equal((await post(path, { cookie: 'admin=yes' })).status, 415)
  assert.equal(service.list().leases[0]!.desiredState, 'open')
  const response = await post(path, admin)
  assert.equal(response.status, 200)
  const body = await response.json() as { service: { archivedAt: string }; leases: { id: string; desiredState: string }[] }
  assert.ok(body.service.archivedAt)
  assert.equal(body.leases[0]!.id, lease.id)
  assert.equal(body.leases[0]!.desiredState, 'closed')
  assert.equal((await post('/tasks/legacy-task/services/' + app.id + '/unregister', admin)).status, 200)
})

test('close confirmation needs current-generation evidence of both process exit and listener removal', () => {
  const lease = { desiredState: 'closed' as const, generation: 2 }
  const observed = { state: 'closed' as const, generation: 2, sshChild: 'exited' as const, listener: 'missing' as const }
  assert.equal(isForwardCloseConfirmed(lease), false)
  assert.equal(isForwardCloseConfirmed(lease, { ...observed, generation: 1 }), false)
  assert.equal(isForwardCloseConfirmed(lease, { ...observed, listener: 'owned' }), false)
  assert.equal(isForwardCloseConfirmed(lease, { ...observed, sshChild: 'running' }), false)
  assert.equal(isForwardCloseConfirmed(lease, observed), true)
})
