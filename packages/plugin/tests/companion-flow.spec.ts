import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { it, type TestContext } from 'node:test'
import { WebSocket } from 'ws'
import { CompanionService } from '../src/service.js'
import { isForwardCloseConfirmed } from '../src/closure.js'
import { CompanionDeviceHub } from '../src/device-hub.js'
import { MemoryCompanionStateStore } from '../src/store.js'
import { createCompanionHttpRoute } from '../src/http-route.js'
import { encodeHostFrame, parseDeviceFrame } from '../src/protocol.js'
import { parseHostFrame, encodeDeviceFrame, type DeviceFrame, type HostFrame, type ForwardCommand } from '../../cli/src/wire.js'
import { RuntimeStore } from '../../cli/src/runtime-state.js'
import { ForwardController, type TunnelExecutor } from '../../cli/src/controller.js'

// Actual HTTP/WebSocket transport and both production protocol parsers. Only the
// local tunnel executor is fake: this is not a macOS/Keychain/SSH lifecycle test.
class FakeTunnelExecutor implements TunnelExecutor {
  readonly owned = new Set<string>()
  readonly starts: { leaseId: string; port: number }[] = []
  constructor(private readonly directory: string) {}
  async start(leaseId: string, port: number) {
    this.starts.push({ leaseId, port })
    this.owned.add(leaseId)
    return { pid: 1000 + this.starts.length, controlPath: join(this.directory, leaseId + '.sock') }
  }
  async stop(leaseId: string) { this.owned.delete(leaseId) }
  async stopAll() { this.owned.clear() }
  async isOwned(leaseId: string) { return this.owned.has(leaseId) }
}

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out: ' + description)
    await delay(5)
  }
}

async function pairOverHttp(port: number, code: string) {
  const body = JSON.stringify({ code, installationId: 'cross-package-install', name: 'Contract fake Mac',
    osVersion: 'test', architecture: 'arm64', companionVersion: '0.1.0',
    capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true } })
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/api/companion/pair', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
  assert.equal(result.status, 201)
  const paired = JSON.parse(result.body) as { ok: boolean; device: { id: string }; token: string; authorityEpoch: string }
  assert.equal(paired.ok, true)
  assert.ok(paired.device.id && paired.token && paired.authorityEpoch)
  return paired
}

async function fixture(t: TestContext, ttlMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-wire-contract-'))
  const hostStore = new MemoryCompanionStateStore()
  const service = await CompanionService.create(hostStore)
  const hub = new CompanionDeviceHub(service, [], 1000)
  const httpRoute = createCompanionHttpRoute(service, [])
  const server = createServer((req, res) => { void httpRoute.handler(req, res) })
  server.on('upgrade', hub.route().handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  let ws: WebSocket | undefined
  let controller: ForwardController | undefined
  let disconnect: Promise<void> = Promise.resolve()
  t.after(async () => {
    ws?.terminate()
    hub.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await disconnect
    await controller?.disconnect()
    await rm(directory, { recursive: true, force: true })
  })
  const ticket = await service.createPairingTicket()
  const paired = await pairOverHttp(port, ticket.code)
  assert.equal(service.authenticateDevice(paired.token).id, paired.device.id)
  assert.equal(service.snapshot().authorityEpoch, paired.authorityEpoch)
  assert.ok(service.snapshot().pairings.find(item => item.id === ticket.id)?.consumedAt)
  const app = await service.registerService({ name: 'Contract app', port: 5173, protocol: 'http', source: 'manual' })
  const lease = await service.openLease({ serviceId: app.id, deviceId: paired.device.id, ttlMs })
  const statePath = join(directory, 'runtime-state.json')
  const store = await RuntimeStore.open(statePath, paired.authorityEpoch)
  const executor = new FakeTunnelExecutor(directory)
  controller = new ForwardController(store, executor)
  await controller.initialize()
  const deviceController = controller
  const frames: HostFrame[] = []
  const transmitted: string[] = []
  const transportErrors: Error[] = []
  let closedCode: number | undefined
  ws = new WebSocket('ws://127.0.0.1:' + port + '/api/companion/device', {
    headers: { authorization: 'Bearer ' + paired.token },
  })
  const socket = ws
  const send = (frame: DeviceFrame) => {
    const encoded = encodeDeviceFrame(frame)
    // No test-side projection/adaptation: send the production CLI payload as-is.
    // Hub parses it again from the actual socket before acknowledging anything.
    parseDeviceFrame(encoded)
    transmitted.push(encoded)
    socket.send(encoded)
  }
  socket.on('error', error => { transportErrors.push(error) })
  socket.on('close', code => { closedCode = code; disconnect = deviceController.disconnect() })
  socket.on('message', (raw, isBinary) => {
    try {
      assert.equal(isBinary, false)
      const frame = parseHostFrame(raw.toString())
      frames.push(frame)
      if (frame.type === 'ping') send({ v: 1, type: 'pong', authorityEpoch: frame.authorityEpoch,
        sessionEpoch: frame.sessionEpoch, nonce: frame.nonce })
    } catch (error) { transportErrors.push(error as Error) }
  })
  const next = async <K extends HostFrame['type']>(type: K, offset = 0): Promise<Extract<HostFrame, { type: K }>> => {
    await until(() => transportErrors.length > 0 || closedCode !== undefined || frames.slice(offset).some(frame => frame.type === type), 'Host ' + type)
    assert.deepEqual(transportErrors, [])
    assert.equal(closedCode, undefined, 'unexpected socket close while awaiting ' + type)
    return frames.slice(offset).find(frame => frame.type === type) as Extract<HostFrame, { type: K }>
  }
  const hello = await next('host.hello')
  assert.equal(hello.authorityEpoch, paired.authorityEpoch)
  const fence = { authorityEpoch: hello.authorityEpoch, sessionEpoch: hello.sessionEpoch }
  deviceController.connect(hello)
  send({ v: 1, type: 'device.hello', ...fence, companionVersion: '0.1.0' })
  const list = await next('forward.list')
  const sendSnapshot = (requestId = list.requestId) => send({ v: 1, type: 'forward.list', ...fence, requestId, instances: store.observations() })
  const execute = async (command: ForwardCommand) => {
    const outcome = await deviceController.execute(command)
    return { v: 1 as const, type: 'forward.result' as const, ...fence,
      operationId: command.operationId, digest: command.digest, ...outcome }
  }
  const ack = async (command: ForwardCommand) => {
    const result = await execute(command)
    send(result)
    await until(() => service.snapshot().operations.some(op => op.id === command.operationId && !!op.acknowledgedAt), 'Host ACK ' + command.operationId)
    return result
  }
  const observed = async (leaseId: string, generation: number, state: string) => {
    await until(() => service.snapshot().instances.some(item => item.leaseId === leaseId && item.generation === generation && item.state === state), 'Host observation ' + state)
  }
  return { service, hub, paired, app, lease, store, statePath, executor, controller: deviceController,
    socket, frames, transmitted, transportErrors, next, hello, fence, send, sendSnapshot, execute, ack, observed,
    waitClosed: async () => { await until(() => closedCode !== undefined, 'revocation socket close'); await disconnect; return closedCode } }
}

it('reopening waits for the old close ACK and late old commands cannot stop the new tunnel', async t => {
  const h = await fixture(t)
  h.sendSnapshot()
  const first = await h.next('forward.open')
  await h.ack(first)
  await h.observed(h.lease.id, 1, 'running')
  const offset = h.frames.length
  await h.service.closeLease(h.lease.id)
  const close = await h.next('forward.close', offset)
  await h.execute(close) // Local termination is not yet a Host ACK.
  const fresh = await h.service.openLease({ serviceId: h.app.id, deviceId: h.paired.device.id })
  assert.notEqual(fresh.id, h.lease.id)
  assert.equal(h.service.pendingOperations(h.paired.device.id).some(op => op.leaseId === fresh.id), false)
  assert.equal(h.executor.starts.length, 1)
  await h.ack(close)
  const reopened = await h.next('forward.open', offset)
  assert.equal(reopened.leaseId, fresh.id)
  await h.ack(reopened)
  await h.observed(fresh.id, 1, 'running')
  await h.execute(close)
  assert.equal((await h.execute(first)).errorCode, 'STALE_GENERATION')
  assert.equal(h.executor.owned.has(fresh.id), true)
  assert.equal(h.executor.starts.length, 2)
})

it('the existing CLI accepts a seven-day deadline over the real WebSocket protocol', async t => {
  const h = await fixture(t, 604_800_000)
  h.sendSnapshot()
  const open = await h.next('forward.open')
  assert.equal(open.expiresAt, h.lease.expiresAt)
  assert.equal(Date.parse(open.expiresAt) - Date.parse(h.lease.createdAt), 604_800_000)
  assert.equal((await h.ack(open)).ok, true)
  await h.observed(h.lease.id, 1, 'running')
  assert.equal(h.store.snapshot().instances[0]!.expiresAt, h.lease.expiresAt)
})

it('real Host/CLI wire flow enforces list and restart ACK barriers, close tombstones survive reload', async t => {
  const h = await fixture(t)
  assert.equal(h.frames[0]?.type, 'host.hello')
  assert.equal(h.frames[1]?.type, 'forward.list')
  await h.service.createPairingTicket() // A subscriber flush must not bypass the list barrier.
  await delay(25)
  assert.equal(h.frames.some(frame => frame.type === 'forward.open'), false)
  assert.equal(h.executor.starts.length, 0)
  h.sendSnapshot()
  const first = await h.next('forward.open')
  assert.equal(first.leaseId, h.lease.id)
  assert.equal(first.generation, 1)
  const running = await h.ack(first)
  assert.equal(running.ok, true)
  assert.equal(running.observation?.state, 'running')
  await h.observed(h.lease.id, 1, 'running')
  assert.equal(h.executor.starts.length, 1)
  assert.equal(h.executor.owned.has(h.lease.id), true)

  // The CLI controller result and RuntimeStore list must expose only wire fields.
  const privateFields = ['desiredState', 'port', 'protocol', 'expiresAt', 'controlPath']
  for (const field of privateFields) assert.ok(!(field in running.observation!))
  assert.ok(h.store.snapshot().instances[0]?.controlPath, 'fixture actually has private local state')
  const snapshotWire = encodeDeviceFrame({ v: 1, type: 'forward.list', ...h.fence, requestId: 'list-contract-check', instances: h.store.observations() })
  const parsedSnapshot = parseDeviceFrame(snapshotWire)
  assert.equal(parsedSnapshot.type, 'forward.list')
  for (const field of privateFields) assert.ok(!(field in h.store.observations()[0]!))

  const restartOffset = h.frames.length
  const restartedLease = await h.service.restartLease(h.lease.id)
  assert.equal(restartedLease.generation, 3)
  const close = await h.next('forward.close', restartOffset)
  assert.equal(close.generation, 2)
  // Execute termination locally but deliberately withhold its successful ACK.
  const closeResult = await h.execute(close)
  assert.equal(closeResult.ok, true)
  assert.equal(closeResult.observation?.state, 'closed')
  assert.equal(h.executor.owned.size, 0)
  await h.service.createPairingTicket()
  await delay(25)
  assert.equal(h.frames.slice(restartOffset).some(frame => frame.type === 'forward.open'), false)
  assert.equal(h.executor.starts.length, 1)
  h.send(closeResult)
  const second = await h.next('forward.open', restartOffset)
  assert.equal(second.generation, 3)
  assert.equal(second.expiresAt, first.expiresAt, 'restart cannot extend Lease TTL')
  await h.ack(second)
  await h.observed(h.lease.id, 3, 'running')
  assert.equal(h.executor.starts.length, 2)

  const endOffset = h.frames.length
  await h.service.closeLease(h.lease.id)
  const finalClose = await h.next('forward.close', endOffset)
  assert.equal(finalClose.generation, 4)
  await h.ack(finalClose)
  await h.observed(h.lease.id, 4, 'closed')
  assert.equal(h.executor.owned.size, 0)
  // Replay actual Host-produced frames through the strict CLI parser: old opens
  // cannot resurrect the persisted close, including after a RuntimeStore reload.
  for (const prior of [first, second]) {
    const replay = parseHostFrame(encodeHostFrame(prior))
    assert.equal(replay.type, 'forward.open')
    if (replay.type !== 'forward.open') throw new Error('fixture command type')
    assert.equal((await h.controller.execute(replay)).errorCode, 'STALE_GENERATION')
  }
  assert.equal(h.executor.starts.length, 2)
  await h.controller.disconnect()
  const reloaded = await RuntimeStore.open(h.statePath, h.paired.authorityEpoch)
  const afterRestart = new ForwardController(reloaded, h.executor)
  await afterRestart.initialize()
  afterRestart.connect(h.hello)
  assert.equal((await afterRestart.execute(first)).errorCode, 'STALE_GENERATION')
  assert.equal(h.executor.starts.length, 2)
  assert.equal(reloaded.observations()[0]?.state, 'closed')
  await afterRestart.disconnect()
  assert.deepEqual(h.transportErrors, [])
  assert.ok(h.transmitted.some(raw => raw.includes('"state":"running"')))
})

it('unregister delivers a real close frame and retains confirmation after the card is gone', async t => {
  const h = await fixture(t)
  h.sendSnapshot()
  const open = await h.next('forward.open')
  await h.ack(open)
  await h.observed(h.lease.id, 1, 'running')
  const offset = h.frames.length
  await h.service.unregisterService(h.app.id)
  const snapshot = h.service.list()
  assert.equal(snapshot.services.length, 0)
  assert.equal(isForwardCloseConfirmed(snapshot.leases[0]!, snapshot.instances[0]), false)
  const close = await h.next('forward.close', offset)
  await h.ack(close)
  await h.observed(h.lease.id, close.generation, 'closed')
  const confirmed = h.service.list()
  assert.equal(isForwardCloseConfirmed(confirmed.leases[0]!, confirmed.instances[0]), true)
  assert.equal(h.executor.owned.size, 0)
  assert.equal((await h.controller.execute(open)).errorCode, 'STALE_GENERATION')
  assert.equal(h.executor.starts.length, 1)
})

it('real Host revocation closes authenticated socket and fake tunnels; old op and credential cannot revive it', async t => {
  const h = await fixture(t)
  h.sendSnapshot()
  const opened = await h.next('forward.open')
  await h.ack(opened)
  await h.observed(h.lease.id, 1, 'running')
  assert.equal(h.executor.owned.size, 1)
  const offset = h.frames.length
  await h.service.revokeDevice(h.paired.device.id)
  assert.equal(await h.waitClosed(), 4003)
  assert.equal(h.hub.isConnected(h.paired.device.id), false)
  assert.equal(h.executor.owned.size, 0)
  assert.equal(h.service.snapshot().leases.find(item => item.id === h.lease.id)?.desiredState, 'closed')
  assert.equal(h.service.snapshot().leases.find(item => item.id === h.lease.id)?.closeReason, 'device_revoked')
  assert.throws(() => h.service.authenticateDevice(h.paired.token), /revoked/)
  await assert.rejects(h.service.openLease({ serviceId: h.app.id, deviceId: h.paired.device.id }), /revoked/)
  await assert.rejects(h.controller.execute(opened), /Stale Connection Session/)
  await h.controller.tick()
  assert.equal(h.executor.starts.length, 1)
  assert.equal(h.frames.slice(offset).some(frame => frame.type === 'forward.open'), false)
  assert.deepEqual(h.transportErrors, [])
})
