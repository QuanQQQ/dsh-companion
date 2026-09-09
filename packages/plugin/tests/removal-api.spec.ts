import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'
import { createCompanionTools } from '../src/agent-tools.js'
import { createCompanionHttpRoute } from '../src/http-route.js'
import type { TaskWorkspaceResolver } from '../src/task-resolver.js'
import { isForwardCloseConfirmed } from '../src/closure.js'

async function setup() {
  const service = await CompanionService.create(new MemoryCompanionStateStore())
  const app = await service.registerTaskService({ taskId: 'a', name: 'App', port: 5173, protocol: 'http', source: 'agent' })
  const ticket = await service.createPairingTicket()
  const { device } = await service.pairDevice({ code: ticket.code, installationId: 'test', name: 'Test', osVersion: '15', architecture: 'arm64', companionVersion: 'test', capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true } })
  const lease = await service.openLease({ taskId: 'a', serviceId: app.id, deviceId: device.id })
  const task = { id: 'a', status: 'active', workspacePath: '/a' }
  const resolver: TaskWorkspaceResolver = { async list() { return [task, { id: 'b', status: 'active', workspacePath: '/b' }] }, async resolveFromCwd(cwd) { return cwd === '/a' ? task : undefined } }
  return { service, app, lease, resolver, task }
}

test('AI tools enforce Task scope, permit archived Task cleanup and expose unconfirmed closes', async () => {
  const { service, app, lease, resolver, task } = await setup()
  const definitions = createCompanionTools(service, resolver)
  const exec = { agent: { session: { header: { cwd: '/a' } } } }
  const invoke = async (name: string, args: Record<string, unknown>, context = exec) => {
    const tool = definitions.find(tool => tool.name === name)
    assert.ok(tool?.execute)
    return await tool.execute(args as never, context as never) as Record<string, unknown>
  }
  await assert.rejects(invoke('task_forward_close', { lease_id: lease.id }, { agent: { session: { header: { cwd: '/outside' } } } }), /Task Workspace/)
  const other = await service.registerTaskService({ taskId: 'b', name: 'Other', port: 5174, protocol: 'http', source: 'agent' })
  const otherLease = await service.openLease({ taskId: 'b', serviceId: other.id, deviceId: lease.deviceId })
  await assert.rejects(invoke('task_service_unregister', { service_id: other.id }), /Task/)
  await assert.rejects(invoke('task_forward_close', { lease_id: otherLease.id }), /Task/)
  task.status = 'archived'
  const closed = await invoke('task_forward_close', { lease_id: lease.id })
  assert.equal(closed.desired_state, 'closed')
  assert.equal(service.listTask('a').services.length, 1)
  assert.deepEqual(await invoke('task_forward_close', { lease_id: lease.id }), closed)
  const result = await invoke('task_service_unregister', { service_id: app.id })
  assert.ok(result.archived_at)
  assert.deepEqual(await invoke('task_service_unregister', { service_id: app.id }), result)
  const snapshot = await invoke('task_forward_list', {})
  const rows = snapshot.leases as { close_confirmed: boolean; instance_state: string }[]
  assert.equal(rows[0]!.close_confirmed, false)
  assert.equal(rows[0]!.instance_state, 'unconfirmed')
  await assert.rejects(invoke('task_forward_open', { service_id: app.id, device_id: lease.deviceId }), /archived Tasks/)
  assert.equal(service.listTask('b').leases[0]!.desiredState, 'open')
})

test('unregister HTTP requires authenticated same-origin JSON and enforces Task ownership', async t => {
  const { service, app, lease, resolver } = await setup()
  const route = createCompanionHttpRoute(service, [], undefined, resolver, undefined, {
    requestRejection: req => req.headers.cookie === 'admin=yes' ? undefined : 401,
  })
  const server = createServer((req, res) => { void route.handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/companion'
  const path = '/tasks/a/services/' + app.id + '/unregister'
  const post = (path: string, headers: Record<string, string>) => fetch(base + path, { method: 'POST', headers, body: '{}' })
  const admin = { cookie: 'admin=yes', 'content-type': 'application/json' }
  assert.equal((await post(path, { 'content-type': 'application/json' })).status, 401)
  assert.equal((await post(path, { ...admin, origin: 'http://evil.example' })).status, 403)
  assert.equal((await post(path, { cookie: 'admin=yes' })).status, 415)
  assert.equal((await post('/tasks/b/services/' + app.id + '/unregister', admin)).status, 404)
  assert.equal(service.listTask('a').leases[0]!.desiredState, 'open')
  const response = await post(path, admin)
  assert.equal(response.status, 200)
  const body = await response.json() as { service: { archivedAt: string }; leases: { id: string; desiredState: string }[] }
  assert.ok(body.service.archivedAt)
  assert.equal(body.leases[0]!.id, lease.id)
  assert.equal(body.leases[0]!.desiredState, 'closed')
  assert.equal((await post(path, admin)).status, 200)
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
