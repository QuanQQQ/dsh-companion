import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject, type HostContext } from '../src/index.js'
import { OwnerLaunchApprovals } from '../src/launch-approval.js'
import { createLocalServiceRoute } from '../src/local-service-route.js'
import { LocalServicesCoordinator } from '../src/local-services.js'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'
import { createCompanionTools } from '../src/agent-tools.js'
import { linuxState } from '../src/client/local-services.js'
import type { LinuxServiceDto } from '../src/client/api.js'
import { browserAuth } from './auth-fixture.js'

test('record-bound owner HTTP review authorizes start/restart while snapshots and API Peers stay restricted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-native-http-'))
  const { ServiceStore } = await import(new URL('../../dev-services/src/store.mjs', import.meta.url).href)
  const { createFacade } = await import(new URL('../../dev-services/src/facade.mjs', import.meta.url).href)
  const store = new ServiceStore(join(root, 'services.sqlite'))
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const baseAuth = browserAuth()
  const apiPeer = { ...baseAuth.browserPeer, id: 'fixture-api' as typeof baseAuth.browserPeer.id }
  const auth: typeof baseAuth = { browserPeer: baseAuth.browserPeer, admit: req => {
    const cookie = req.headers instanceof Headers ? req.headers.get('cookie') : req.headers.cookie
    const api = req.headers instanceof Headers ? req.headers.get('authorization') : req.headers.authorization
    return cookie === 'browser=test' ? { peer: baseAuth.browserPeer } : api ? { peer: apiPeer } : { rejection: 401 }
  } }
  let running = false
  let starts = 0
  let stops = 0
  let dev: any
  const approvals = new OwnerLaunchApprovals(auth, () => dev)
  dev = createFacade({ store, backend: {
    inspect: async () => ({ exists: running, state: running ? 'active' : 'inactive' }),
    start: async () => { running = true; starts++ }, stop: async () => { running = false; stops++ },
    logs: async () => 'fixture-log',
  }, options: { portFree: async () => undefined, health: async (_record: unknown, runtime: { exists: boolean }) => ({ state: runtime.exists ? 'ready' : 'not_ready', reason: 'fixture' }) },
  approveLaunch: (review: any, authority: any) => approvals.approveLaunch(review, authority) })
  const companion = await CompanionService.create(new MemoryCompanionStateStore())
  const route = createLocalServiceRoute(new LocalServicesCoordinator(companion, () => dev), () => dev, auth, approvals)
  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const origin = 'http://127.0.0.1:' + address.port
  const post = (operation: string, body: object) => fetch(origin + '/api/local-services/' + operation, { method: 'POST', headers: { cookie: 'browser=test', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const created = await post('create', { workspace_path: root, name: 'Fixture', executable: '/bin/true', args: ['review-only-marker'], workdir: root, port: 45179, protocol: 'http' })
  assert.equal(created.status, 200)
  const id = ((await created.json()) as any).result.id
  assert.equal((await fetch(origin + '/api/local-services/review?service_id=' + id)).status, 401)
  assert.equal((await fetch(origin + '/api/local-services/review?service_id=' + id, { headers: { authorization: 'Bearer api' } })).status, 403)
  const reviewResponse = await fetch(origin + '/api/local-services/review?service_id=' + id, { headers: { cookie: 'browser=test' } })
  assert.equal(reviewResponse.headers.get('cache-control'), 'no-store')
  const review = ((await reviewResponse.json()) as any).review
  assert.deepEqual(review.args, ['review-only-marker'])
  const snapshot = await fetch(origin + '/api/local-services/snapshot', { headers: { cookie: 'browser=test' } })
  assert.doesNotMatch(await snapshot.text(), /review-only-marker|\/bin\/true|configurationDigest/)
  assert.equal((await post('start', { service_id: id })).status, 400)
  assert.equal(starts, 0)
  assert.equal((await post('start', { service_id: id, configuration_digest: review.configurationDigest })).status, 200)
  assert.equal(starts, 1)
  assert.equal((await post('restart', { service_id: id, configuration_digest: review.configurationDigest })).status, 200)
  assert.equal(stops, 1); assert.equal(starts, 2)
  const changed = store.get(id); changed.args = ['changed']; store.save(changed)
  assert.equal((await post('restart', { service_id: id, configuration_digest: review.configurationDigest })).status, 400)
  assert.equal(stops, 1, 'stale approval must fail before stopping')
})

test('opaque approval rejects forged objects, changed operations and reuse after completion', async () => {
  const auth = browserAuth()
  const review = { serviceId: 's', configurationDigest: 'digest' }
  const gate = new OwnerLaunchApprovals(auth, () => ({ reviewLaunch: async () => review } as any))
  const controller = new AbortController()
  const approval = await gate.approve({ serviceId: 's', configurationDigest: 'digest', operation: 'restart', request: { headers: {} } as IncomingMessage, signal: controller.signal })
  const authority = { ...approval.authority, operation: 'restart' }
  assert.equal(gate.approveLaunch(review, authority), true)
  assert.equal(gate.approveLaunch(review, authority), true, 'restart checks before stop and again before start')
  assert.equal(gate.approveLaunch(review, { ...authority, operatorLaunchProof: {} }), false)
  assert.equal(gate.approveLaunch(review, { ...authority, operation: 'start' }), false)
  assert.equal(gate.approveLaunch({ ...review, configurationDigest: 'changed' }, authority), false)
  approval.release()
  assert.equal(gate.approveLaunch(review, authority), false)
})

test('real Cordis providers publish managed and operator capabilities and dispose cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-native-cordis-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const context = new Context()
  const routes = new Set<string>()
  t.after(async () => {
    await context.fiber.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  const provider = context.plugin((scope: Context) => {
    const provide = (name: string, value: unknown) => Reflect.apply(scope.provide, scope, [name, value])
    provide('connection', browserAuth())
    provide('tools', { register: () => () => undefined })
    provide('systemPrompt', { section: () => () => undefined })
    provide('webServer', { port: 34567, register: (route: { path: string }) => { routes.add(route.path); return () => routes.delete(route.path) }, registerUpgrade: () => () => undefined })
  })
  await provider
  const plugin = context.plugin({ inject, apply: (scope: Context) => apply(scope as unknown as HostContext) })
  await plugin
  assert.equal(typeof Reflect.apply(context.get, context, ['companionManagedServices']).ensure, 'function')
  assert.equal(typeof Reflect.apply(context.get, context, ['devServicesOperatorApproval']).approveLaunch, 'function')
  assert.ok(routes.has('/api/local-services'))
  await plugin.dispose()
  assert.equal(routes.size, 0)
})

test('managed forwarding uses the calling Workspace and legacy unregister cannot retire it', async () => {
  const service = await CompanionService.create(new MemoryCompanionStateStore())
  const managed = await service.ensureManagedService({ owner: { provider: 'dsh-dev-services', namespace: 'test', id: 'owned' }, name: 'Owned', port: 45177, protocol: 'http', workspacePath: '/project/a' })
  const ticket = await service.createPairingTicket()
  const paired = await service.pairDevice({ code: ticket.code, installationId: 'fixture', name: 'Fixture Mac', osVersion: '15', architecture: 'arm64', companionVersion: 'test', capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true } })
  const tools = createCompanionTools(service, async (record, exec) => { if (record.workspacePath !== exec.agent?.session.header.cwd) throw new Error('Other Workspace') })
  const invoke = (name: string, args: object, cwd: string) => tools.find(tool => tool.name === name)!.execute!(args as never, { agent: { session: { header: { cwd } } } } as never)
  await assert.rejects(invoke('task_service_unregister', { service_id: managed.id }, '/project/a'), /dev_service_remove/)
  await assert.rejects(invoke('task_forward_open', { service_id: managed.id, device_id: paired.device.id }, '/project/b'), /Other Workspace/)
  await invoke('task_forward_open', { service_id: managed.id, device_id: paired.device.id }, '/project/a')
  const lease = service.snapshot().leases[0]!
  await assert.rejects(invoke('task_forward_close', { lease_id: lease.id }, '/project/b'), /Other Workspace/)
  assert.equal(service.snapshot().leases[0]!.desiredState, 'open')
  await invoke('task_forward_close', { lease_id: lease.id }, '/project/a')
  assert.equal(service.snapshot().leases[0]!.desiredState, 'closed')
})

test('cancelled Linux launch creates no new forwarding authorization', async () => {
  const service = await CompanionService.create(new MemoryCompanionStateStore())
  let inspected = 0
  const coordinator = new LocalServicesCoordinator(service, () => ({ get: async () => { inspected++; throw new Error('must not inspect after cancellation') } } as any))
  const controller = new AbortController()
  await assert.rejects(coordinator.launch({ service_id: 's', authorize_forward: true }, async () => { controller.abort() }, controller.signal), { name: 'AbortError' })
  assert.equal(inspected, 0)
  assert.equal(service.snapshot().leases.length, 0)
})

test('stopped intent is not reported as a confirmed stopped process', () => {
  const view = { desired: 'stopped', runtime: { exists: true, state: 'active' } } as LinuxServiceDto
  assert.equal(linuxState(view), '停止待确认')
  assert.equal(linuxState({ ...view, runtime: { state: 'unknown' } }), '停止待确认')
  assert.equal(linuxState({ ...view, runtime: { exists: false, state: 'inactive' } }), '已停止')
})
