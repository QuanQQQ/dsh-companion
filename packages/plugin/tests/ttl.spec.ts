import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'
import { assertTtl, DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS } from '../src/domain.js'
import { createCompanionTools } from '../src/agent-tools.js'
import { createCompanionHttpRoute } from '../src/http-route.js'
import type { TaskWorkspaceResolver } from '../src/task-resolver.js'

const WEEK = 604_800_000
async function fixture() {
  let now = Date.parse('2026-09-10T00:00:00Z')
  const clock = { now: () => now }
  const store = new MemoryCompanionStateStore()
  const service = await CompanionService.create(store, { clock })
  const ticket = await service.createPairingTicket()
  const { device } = await service.pairDevice({ code: ticket.code, installationId: 'ttl-test', name: 'TTL test', osVersion: 'test', architecture: 'test', companionVersion: 'test', capabilities: { protocolVersion: 1, localForward: true, tcpProbe: false } })
  const app = await service.registerTaskService({ taskId: 'a', name: 'TTL app', port: 5173, protocol: 'http', source: 'manual' })
  const input = { taskId: 'a', serviceId: app.id, deviceId: device.id }
  const task = { id: 'a', status: 'active', workspacePath: '/a' }
  const resolver: TaskWorkspaceResolver = { async list() { return [task] }, async resolveFromCwd(cwd) { return cwd === '/a' ? task : undefined } }
  return { service, store, clock, input, resolver, advance: (ms: number) => { now += ms } }
}

test('default and maximum are seven days, with exact expiry and bounded shorter TTLs', async () => {
  assert.equal(DEFAULT_LEASE_TTL_MS, WEEK)
  assert.equal(MAX_LEASE_TTL_MS, WEEK)
  for (const ttl of [60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000, 86_400_000, WEEK]) assert.equal(assertTtl(ttl), ttl)
  for (const ttl of [0, 59_999, WEEK + 1, Infinity, NaN, 60_000.5]) assert.throws(() => assertTtl(ttl), /ttlMs/)
  const f = await fixture()
  const lease = await f.service.openLease(f.input)
  assert.equal(Date.parse(lease.expiresAt) - Date.parse(lease.createdAt), WEEK)
  f.advance(WEEK - 1)
  assert.equal(await f.service.expireLeases(), 0)
  f.advance(1)
  assert.equal(await f.service.expireLeases(), 1)
  assert.equal(f.service.snapshot().leases[0]!.closeReason, 'expired')
})

test('reloading, opening again, rechecking and restarting never extend an existing short Lease', async () => {
  const f = await fixture()
  const old = await f.service.openLease({ ...f.input, ttlMs: 7_200_000 })
  f.advance(60_000)
  const reloaded = await CompanionService.create(f.store, { clock: f.clock })
  assert.equal(reloaded.snapshot().leases[0]!.expiresAt, old.expiresAt)
  assert.equal((await reloaded.openLease(f.input)).expiresAt, old.expiresAt)
  assert.equal((await reloaded.restartLease(old.id)).expiresAt, old.expiresAt)
  await reloaded.recheckLease(old.id)
  assert.equal(reloaded.snapshot().leases[0]!.expiresAt, old.expiresAt)
  await reloaded.closeLease(old.id)
  const fresh = await reloaded.openLease(f.input)
  assert.notEqual(fresh.id, old.id)
  assert.equal(Date.parse(fresh.expiresAt) - Date.parse(fresh.createdAt), WEEK)
})

test('AI open defaults to 10080 minutes and rejects an authorization longer than a week', async () => {
  const f = await fixture()
  const tool = createCompanionTools(f.service, f.resolver).find(t => t.name === 'task_forward_open')!
  assert.ok(tool.execute)
  assert.match(JSON.stringify(tool), /10080/)
  const invoke = (ttl_minutes?: number) => tool.execute!({ service_id: f.input.serviceId, device_id: f.input.deviceId, ...(ttl_minutes === undefined ? {} : { ttl_minutes }) } as never, { agent: { session: { header: { cwd: '/a' } } } } as never)
  for (const minutes of [undefined, 1440, 10080]) {
    await invoke(minutes)
    const lease = f.service.snapshot().leases.at(-1)!
    assert.equal(Date.parse(lease.expiresAt) - Date.parse(lease.createdAt), (minutes ?? 10080) * 60_000)
    await f.service.closeLease(lease.id)
  }
  await assert.rejects(invoke(10081), /ttlMs/)
  assert.equal(f.service.snapshot().leases.length, 3)
})

test('authenticated HTTP open shares the week default and enforces its upper boundary', async t => {
  const f = await fixture()
  const route = createCompanionHttpRoute(f.service, [], undefined, f.resolver, undefined, { requestRejection: req => req.headers.cookie === 'test=yes' ? undefined : 401 })
  const server = createServer((req, res) => { void route.handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/companion/tasks/a/services/' + f.input.serviceId + '/leases'
  const post = (ttlMs?: number) => fetch(url, { method: 'POST', headers: { cookie: 'test=yes', 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: f.input.deviceId, ttlMs }) })
  for (const ttl of [undefined, 86_400_000, WEEK]) {
    assert.equal((await post(ttl)).status, 201)
    const lease = f.service.snapshot().leases.at(-1)!
    assert.equal(Date.parse(lease.expiresAt) - Date.parse(lease.createdAt), ttl ?? WEEK)
    await f.service.closeLease(lease.id)
  }
  assert.equal((await post(WEEK + 1)).status, 400)
  assert.equal(f.service.snapshot().leases.length, 3)
})
