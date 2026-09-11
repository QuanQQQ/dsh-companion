import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isTrustedCompanionRequest } from '../src/trust.js'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { it, type TestContext } from 'node:test'
import { WebSocket } from 'ws'
import { CompanionDeviceHub } from '../src/device-hub.js'
import { CompanionService, OPERATION_RETRY_MS } from '../src/service.js'
import { MemoryCompanionStateStore, normalizeState } from '../src/store.js'
import { createCompanionHttpRoute } from '../src/http-route.js'
import type { HostFrame, WireInstanceObservation } from '../src/protocol.js'

async function setup() {
  const clock = { value: Date.now(), now() { return this.value } }
  const store = new MemoryCompanionStateStore()
  const service = await CompanionService.create(store, { clock })
  const pair = async () => service.pairDevice({
    code: (await service.createPairingTicket()).code, installationId: 'install-a', name: 'Mac', osVersion: '15', architecture: 'arm64', companionVersion: '0.1.0',
    capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true },
  })
  const paired = await pair()
  const registered = await service.registerService({ name: 'App', port: 5173, protocol: 'http', source: 'manual' })
  const lease = await service.openLease({ deviceId: paired.device.id, serviceId: registered.id, ttlMs: 60_000 })
  return { clock, store, service, pair, paired, registered, lease }
}
const running = (leaseId: string, generation = 1): WireInstanceObservation => ({ leaseId, generation, state: 'running', sshChild: 'running', listener: 'owned', remoteProbe: 'healthy' })

async function hubSetup(t: TestContext, heartbeatMs = 1000, reconcileBeforeSnapshot?: () => Promise<void>, companionVersion = '0.1.0') {
  const base = await setup()
  const hub = new CompanionDeviceHub(base.service, [], heartbeatMs, reconcileBeforeSnapshot)
  const server = createServer()
  server.on('upgrade', hub.route().handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/companion/device', { headers: { authorization: 'Bearer ' + base.paired.token } })
  const frames: HostFrame[] = []
  ws.on('message', raw => {
    const frame = JSON.parse(raw.toString()) as HostFrame
    frames.push(frame)
    if (frame.type === 'ping') ws.send(JSON.stringify({ v: 1, type: 'pong', authorityEpoch: frame.authorityEpoch, sessionEpoch: frame.sessionEpoch, nonce: frame.nonce }))
  })
  t.after(async () => { ws.terminate(); hub.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const next = async <K extends HostFrame['type']>(type: K, after = 0): Promise<Extract<HostFrame, { type: K }>> => {
    const available = frames.slice(after).find(frame => frame.type === type)
    if (available) return available as Extract<HostFrame, { type: K }>
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('timed out awaiting ' + type)) }, 2000)
      const listener = (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as HostFrame
        if (frame.type === type) { clearTimeout(timer); ws.off('message', listener); resolve(frame as Extract<HostFrame, { type: K }>) }
      }
      ws.on('message', listener)
    })
  }
  const hello = await next('host.hello')
  const fence = { authorityEpoch: hello.authorityEpoch, sessionEpoch: hello.sessionEpoch }
  const send = (frame: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...fence, ...frame }))
  send({ type: 'device.hello', companionVersion })
  const list = await next('forward.list')
  const snapshot = (instances: WireInstanceObservation[] = [], requestId = list.requestId) => send({ type: 'forward.list', requestId, instances })
  return { ...base, hub, ws, frames, next, send, snapshot }
}

it('persists the authenticated runtime version reported by Device hello', async t => {
  const h = await hubSetup(t, 1000, undefined, '0.1.9')
  assert.equal(h.paired.device.companionVersion, '0.1.0')
  assert.equal(h.service.listDevices()[0]?.companionVersion, '0.1.9')
})

it('hub sends no open before initial snapshot reconciliation and waits for restart close ACK', async t => {
  const h = await hubSetup(t)
  await h.service.createPairingTicket() // subscriber flush must not bypass initial snapshot
  await delay(20)
  assert.equal(h.frames.some(frame => frame.type === 'forward.open'), false)
  h.snapshot()
  const opened = await h.next('forward.open')
  h.send({ type: 'forward.result', operationId: opened.operationId, digest: opened.digest, ok: true, observation: running(h.lease.id) })
  await delay(20)
  const offset = h.frames.length
  await h.service.restartLease(h.lease.id)
  const close = await h.next('forward.close', offset)
  await delay(20)
  assert.equal(h.frames.slice(offset).some(frame => frame.type === 'forward.open'), false)
  h.send({ type: 'forward.result', operationId: close.operationId, digest: close.digest, ok: true, observation: { ...running(h.lease.id, close.generation), state: 'closed', sshChild: 'exited', listener: 'missing' } })
  const restarted = await h.next('forward.open', offset)
  assert.equal(restarted.generation, 3)
  assert.equal(restarted.expiresAt, h.lease.expiresAt)
})

it('hub does not send open while pre-snapshot reconciliation is still pending', async t => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const h = await hubSetup(t, 1000, () => pending)
  h.snapshot()
  await delay(20)
  await h.service.createPairingTicket()
  assert.equal(h.frames.some(frame => frame.type === 'forward.open'), false)
  release()
  await h.next('forward.open')
})

for (const mismatch of ['lease', 'generation'] as const) it('rejects result observation with mismatched ' + mismatch + ' before ACK', async t => {
  const h = await hubSetup(t)
  h.snapshot()
  const opened = await h.next('forward.open')
  const closed = once(h.ws, 'close')
  h.send({ type: 'forward.result', operationId: opened.operationId, digest: opened.digest, ok: true,
    observation: running(mismatch === 'lease' ? 'another-lease' : h.lease.id, mismatch === 'generation' ? 2 : 1) })
  const [code] = await closed
  assert.equal(code, 1008)
  assert.equal(h.service.snapshot().operations.find(item => item.id === opened.operationId)?.acknowledgedAt, undefined)
  assert.equal(h.service.snapshot().instances.length, 0)
})

it('pairing token rotation closes an already authenticated connection', async t => {
  const h = await hubSetup(t)
  const closed = once(h.ws, 'close')
  const replacement = await h.pair()
  assert.equal(replacement.device.id, h.paired.device.id)
  assert.notEqual(replacement.token, h.paired.token)
  assert.equal((await closed)[0], 4003)
  assert.throws(() => h.service.authenticateDevice(h.paired.token), /invalid/)
})

it('heartbeat requests fresh snapshots and expiry cannot replay pending opens', async t => {
  const h = await hubSetup(t, 1000)
  h.clock.value += 60_001
  h.snapshot()
  await h.next('forward.close')
  assert.equal(h.frames.some(frame => frame.type === 'forward.open'), false)
  assert.equal(h.service.snapshot().leases[0]?.closeReason, 'expired')
  const offset = h.frames.length
  await h.next('forward.list', offset)
})

it('expired authorization is not dispatchable even before the expiry sweep', async () => {
  const h = await setup()
  const operation = h.service.pendingOperations(h.paired.device.id)[0]!
  h.clock.value += 60_001
  assert.equal(h.service.snapshot().leases[0]?.desiredState, 'open')
  assert.equal(h.service.pendingOperations(h.paired.device.id).length, 0)
  assert.equal(await h.service.claimOperation(h.paired.device.id, operation.id), undefined)
})

it('hub retransmits the identical fenced operation past the old three-attempt budget', async t => {
  const h = await hubSetup(t)
  h.snapshot()
  const original = await h.next('forward.open')
  for (let attempt = 2; attempt <= 4; attempt++) {
    const offset = h.frames.length
    h.clock.value += OPERATION_RETRY_MS
    await h.service.createPairingTicket()
    const retried = await h.next('forward.open', offset)
    assert.equal(retried.operationId, original.operationId)
    assert.equal(retried.digest, original.digest)
    assert.equal(h.service.snapshot().operations[0]?.attemptCount, attempt)
  }
  assert.equal(h.service.snapshot().operations[0]?.acknowledgedAt, undefined)
  assert.equal(h.service.snapshot().operations[0]?.errorCode, undefined)
  assert.equal(h.frames.filter(frame => frame.type === 'forward.open').length, 4)
})

it('failed restart close never releases the open barrier', async () => {
  const h = await setup()
  await h.service.restartLease(h.lease.id)
  const close = h.service.pendingOperations(h.paired.device.id)[0]!
  await h.service.acknowledgeOperation(h.paired.device.id, close.id, { ok: false, errorCode: 'POLICY_DENIED' })
  await h.service.reconcileDeviceReport(h.paired.device.id, [])
  assert.equal(h.service.pendingOperations(h.paired.device.id).length, 0)
})

it('operation retransmission count persists across reload without exhausting authority', async () => {
  const h = await setup()
  let service = h.service
  const operation = service.pendingOperations(h.paired.device.id)[0]!
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.equal((await service.claimOperation(h.paired.device.id, operation.id))?.attemptCount, attempt)
    assert.equal(await service.claimOperation(h.paired.device.id, operation.id), undefined)
    h.clock.value += OPERATION_RETRY_MS
    service = await CompanionService.create(h.store, { clock: h.clock })
  }
  assert.equal(service.snapshot().operations.length, 1)
  assert.equal(service.snapshot().operations[0]?.acknowledgedAt, undefined)
  assert.equal(service.snapshot().operations[0]?.errorCode, undefined)
  assert.equal(service.snapshot().leases[0]?.expiresAt, h.lease.expiresAt)
})

it('permanent failures do not create automatic operations but explicit recheck is allowed', async () => {
  const h = await setup()
  const operation = h.service.pendingOperations(h.paired.device.id)[0]!
  await h.service.acknowledgeOperation(h.paired.device.id, operation.id, { ok: false, errorCode: 'SSH_AUTH_FAILED' })
  for (let i = 0; i < 5; i++) await h.service.reconcileDeviceReport(h.paired.device.id, [])
  assert.equal(h.service.snapshot().operations.length, 1)
  await h.service.recheckLease(h.lease.id)
  assert.equal(h.service.snapshot().operations.length, 2)
  assert.equal(h.service.snapshot().leases[0]?.generation, 1)
})

it('legacy RETRY_EXHAUSTED snapshots automatically receive a fresh fenced Open', async () => {
  const h = await setup()
  await h.service.acknowledgeOperation(h.paired.device.id, h.service.pendingOperations(h.paired.device.id)[0]!.id, { ok: true })
  await h.service.reconcileDeviceReport(h.paired.device.id, [{ ...running(h.lease.id), deviceId: h.paired.device.id, state: 'needs_attention', errorCode: 'RETRY_EXHAUSTED' }])
  assert.equal(h.service.snapshot().operations.length, 2)
  assert.deepEqual(h.service.pendingOperations(h.paired.device.id).map(item => item.kind), ['open'])
  await h.service.reconcileDeviceReport(h.paired.device.id, [])
  assert.equal(h.service.snapshot().operations.length, 2)
})

for (const rejection of [401, 403] as const) it('management HTTP enforces Connection authentication rejection ' + rejection, async t => {
  const h = await setup()
  let checks = 0
  const route = createCompanionHttpRoute(h.service, [], undefined, undefined, undefined, { requestRejection(request) {
    checks++
    assert.equal(request.headers.cookie, undefined)
    return rejection
  } })
  const server = createServer((req, res) => void route.handler(req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/companion'
  for (const path of ['/devices', '/tasks/task-a', '/downloads/cli.mjs']) assert.equal((await fetch(base + path)).status, rejection)
  assert.equal((await fetch(base + '/pairings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, rejection)
  assert.equal(checks, 4)
  assert.equal(h.service.snapshot().pairings.length, 1)
})

it('missing Connection auth fails management closed but one-use pairing remains independently authenticated', async t => {
  const h = await setup()
  const route = createCompanionHttpRoute(h.service, [])
  const server = createServer((req, res) => void route.handler(req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/companion'
  assert.equal((await fetch(base + '/devices')).status, 503)
  const code = (await h.service.createPairingTicket()).code
  const body = { code, installationId: 'new-install', name: 'New Mac', osVersion: '15', architecture: 'arm64', companionVersion: '0.1.0', capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true } }
  const post = (value: unknown) => fetch(base + '/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  assert.equal((await post({ ...body, code: 'invalid-code' })).status, 401)
  assert.equal((await post(body)).status, 201)
  assert.equal((await post(body)).status, 409)
})

it('global management is independent of Task existence while legacy paths stay compatible', async t => {
  const h = await setup()
  const route = createCompanionHttpRoute(h.service, [], undefined, undefined, undefined, { requestRejection: () => undefined })
  const server = createServer((req, res) => void route.handler(req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/companion'
  const post = (path: string, body = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await fetch(base + '/snapshot')).status, 200)
  assert.equal((await fetch(base + '/tasks/nonexistent-or-archived')).status, 200)
  assert.equal((await post('/tasks/nonexistent-or-archived/services', { name: 'Legacy client', port: 1000, protocol: 'http' })).status, 201)
  assert.equal((await post('/tasks/nonexistent-or-archived/services/' + h.registered.id + '/leases', { deviceId: h.paired.device.id })).status, 201)
  assert.equal((await post('/leases/' + h.lease.id + '/restart')).status, 200)
  assert.equal((await post('/leases/' + h.lease.id + '/recheck')).status, 200)
  assert.equal((await post('/leases/' + h.lease.id + '/close')).status, 200)
  assert.equal(h.service.list().services.length, 2)
})

it('persisted state rejects malformed fields, authority relationships and duplicate identities', async () => {
  const h = await setup()
  const valid = h.service.snapshot()
  assert.deepEqual(normalizeState(valid), valid)
  const corruptions: Array<(state: any) => void> = [
    s => { s.authorityEpoch = '' }, s => { s.devices[0].tokenHash = 'plaintext' }, s => { s.devices.push(s.devices[0]) },
    s => { s.leases[0].remoteHost = '0.0.0.0' }, s => { s.leases[0].remotePort = 9999 }, s => { s.leases[0].taskId = 'another-task' },
    s => { s.leases[0].expiresAt = 'not-a-date' }, s => { s.leases[0].generation = 0 }, s => { s.leases[0].generation = 3 }, s => { s.leases[0].generation = Number.MAX_SAFE_INTEGER },
    s => { s.leases[0].desiredState = 'whatever' }, s => { s.leases[0].deviceId = 'missing' }, s => { s.operations[0].deviceId = 'missing' },
    s => { s.operations[0].attemptCount = -1 }, s => { s.services[0].sshArgs = ['-R'] }, s => { s.devices[0].capabilities.localForward = false },
    s => { s.instances.push({ ...running(s.leases[0].id, 2), deviceId: s.devices[0].id, observedAt: s.leases[0].createdAt }) },
  ]
  for (const corrupt of corruptions) { const state = structuredClone(valid); corrupt(state); assert.throws(() => normalizeState(state), /invalid/) }
})

it('trust fence rejects authority userinfo, paths and malformed browser origins', () => {
  for (const host of ['evil@127.0.0.1', '127.0.0.1/path', '127.0.0.1#evil', '127.0.0.1?evil', '127.0.0.1\\evil']) {
    assert.equal(isTrustedCompanionRequest({ headers: { host } }, []), false)
  }
  for (const origin of ['ftp://127.0.0.1', 'http://evil@127.0.0.1', 'http://127.0.0.1/path']) {
    assert.equal(isTrustedCompanionRequest({ headers: { host: '127.0.0.1', origin } }, []), false)
  }
  assert.equal(isTrustedCompanionRequest({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }, []), true)
})

it('CLI download serves only the packaged local file with safe headers and missing bundle returns 503', async t => {
  const h = await setup()
  const directory = await mkdtemp(join(tmpdir(), 'companion-download-'))
  const file = join(directory, 'companion-cli.mjs')
  const route = createCompanionHttpRoute(h.service, [], undefined, undefined, pathToFileURL(file), { requestRejection: () => undefined })
  const server = createServer((req, res) => void route.handler(req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/companion/downloads/cli.mjs'
  const absent = await fetch(url)
  assert.equal(absent.status, 503)
  assert.equal((await absent.json() as { error: { code: string } }).error.code, 'CLI_NOT_PACKAGED')
  await writeFile(file, 'console.log("local CLI")\n')
  const response = await fetch(url)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="dsh-companion.mjs"')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type')!, /^application\/javascript/)
  assert.equal(await response.text(), 'console.log("local CLI")\n')
  assert.equal((await fetch(url, { headers: { origin: 'https://attacker.invalid' } })).status, 403)
})

