import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { VERSION } from './version.js'
import { daemonLock } from './daemon-lock.js'
import { join } from 'node:path'
import { WebSocket, type RawData } from 'ws'
import { companionPaths, readConfig, atomicPrivateWrite } from './config.js'
import { MacKeychain } from './keychain.js'
import { RuntimeStore } from './runtime-state.js'
import { ForwardController } from './controller.js'
import { SshExecutor } from './ssh.js'
import { encodeDeviceFrame, parseHostFrame, type Fence, type DeviceFrame } from './wire.js'

/** No SSH tunnel is retained after the authenticated control channel is lost. */
export async function runDaemon(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('The Companion daemon requires macOS')
  const bootId = randomUUID()
  const paths = companionPaths()
  const config = await readConfig(paths.config)
  const unlock = await daemonLock(join(paths.root, 'daemon.lock'))
  const ssh = new SshExecutor(config.sshHost, paths.controlDirectory)
  const store = await RuntimeStore.open(paths.runtimeState, config.authorityEpoch)
  const controller = new ForwardController(store, ssh)
  const statusFile = join(paths.root, 'daemon-status.json')
  let statusTail = Promise.resolve()
  const previous = await readConnectionState(statusFile, config.deviceId)
  let attempts = previous.attempts
  let pairingRequired = previous.pairingRequired
  let stopping = false
  let socket: WebSocket | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let watchdog: NodeJS.Timeout | undefined
  let connectedAt = 0
  let lastFrameAt = 0
  let heartbeatMs = 15_000
  let fence: Fence | undefined
  let queued = 0
  let connecting: Promise<void> | undefined
  let cleanup = Promise.resolve()
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const status = (state: string) => {
    statusTail = statusTail.then(() => atomicPrivateWrite(statusFile, JSON.stringify({
      state, reconnectAttempts: attempts, pairingRequired, deviceId: config.deviceId, pid: process.pid, companionVersion: VERSION, bootId,
      updatedAt: new Date().toISOString(),
    }) + '\n'))
    return statusTail
  }
  const send = (ws: WebSocket, frame: DeviceFrame) => {
    if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(encodeDeviceFrame(frame))
  }
  const invalidate = (ws: WebSocket) => {
    if (socket !== ws) return
    socket = undefined
    fence = undefined
    clearInterval(watchdog)
    // disconnect invalidates synchronously even while an SSH start is pending.
    cleanup = controller.disconnect()
    ws.terminate()
  }
  const schedule = async (permanent: boolean) => {
    try { await cleanup } catch { await status('cleanup_failed'); return }
    if (stopping) return
    attempts += 1
    await status(pairingRequired ? 'needs_pairing' : permanent || attempts > 5 ? 'needs_attention' : 'reconnecting')
    if (pairingRequired || permanent || attempts > 5) return
    retryTimer = setTimeout(() => { void connect().catch(() => status('needs_attention')) }, Math.min(30_000, 1000 * 2 ** attempts))
  }
  const connect = (): Promise<void> => {
    if (connecting) return connecting
    connecting = doConnect().finally(() => { connecting = undefined })
    return connecting
  }
  const doConnect = async () => {
    await cleanup
    if (socket) return
    if (pairingRequired) { await status('needs_pairing'); return }
    if (stopping || attempts > 5) { await status('needs_attention'); return }
    const token = await new MacKeychain().read(config.deviceId)
    if (stopping || socket) return
    const url = new URL('/api/companion/device', config.serverUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + token },
      maxPayload: 64 * 1024, handshakeTimeout: 10_000, followRedirects: false })
    socket = ws
    let terminal = false
    const settle = (permanent = false) => {
      if (terminal) return
      terminal = true
      invalidate(ws)
      void schedule(permanent).catch(() => { /* remain stopped if status persistence fails */ })
    }
    ws.on('error', () => settle())
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      if (res.statusCode === 401 || res.statusCode === 403) pairingRequired = true
      settle(pairingRequired)
    })
    ws.on('close', code => {
      if (code === 4003) pairingRequired = true
      settle(code === 4001 || code === 4003 || code === 1008)
    })
    ws.on('message', (raw: RawData, binary: boolean) => {
      if (stopping || socket !== ws || terminal) return
      try {
        if (binary) throw new Error('Binary frame forbidden')
        const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
        const frame = parseHostFrame(data)
        lastFrameAt = Date.now()
        if (frame.type === 'host.hello') {
          if (fence) throw new Error('Duplicate hello')
          if (frame.authorityEpoch !== config.authorityEpoch) { pairingRequired = true; settle(true); return }
          controller.connect(frame)
          fence = { authorityEpoch: frame.authorityEpoch, sessionEpoch: frame.sessionEpoch }
          connectedAt = Date.now()
          heartbeatMs = frame.heartbeatMs
          send(ws, { v: 1, type: 'device.hello', ...fence, companionVersion: VERSION })
          void status('connected').catch(() => settle(true))
          return
        }
        if (!fence || frame.authorityEpoch !== fence.authorityEpoch || frame.sessionEpoch !== fence.sessionEpoch) throw new Error('Stale fence')
        if (frame.type === 'ping') {
          send(ws, { v: 1, type: 'pong', ...fence, nonce: frame.nonce })
          return
        }
        if (frame.type === 'forward.list') {
          send(ws, { v: 1, type: 'forward.list', ...fence, requestId: frame.requestId, instances: store.observations() })
          return
        }
        if (++queued > 256) throw new Error('Command queue capacity')
        const captured = { ...fence }
        void controller.execute(frame).then(result => {
          send(ws, { v: 1, type: 'forward.result', ...captured, operationId: frame.operationId, digest: frame.digest, ...result })
        }).catch(() => settle(true)).finally(() => { queued -= 1 })
      } catch { settle(true) }
    })
    lastFrameAt = Date.now()
    watchdog = setInterval(() => {
      if (!fence && Date.now() - lastFrameAt > 10_000) { settle(); return }
      if (Date.now() - lastFrameAt > heartbeatMs * 3) { settle(); return }
      if (fence && attempts > 0 && Date.now() - connectedAt >= 60_000) { attempts = 0; void status('connected').catch(() => settle(true)) }
    }, 1000)
  }
  let ticking = false
  const tickTimer = setInterval(() => {
    if (stopping) return
    void controller.expireNow().catch(() => { if (socket) invalidate(socket); void status('needs_attention') })
    if (ticking) return
    ticking = true
    void controller.tick().catch(() => { if (socket) invalidate(socket); void status('needs_attention') }).finally(() => { ticking = false })
  }, 1000)
  const stop = () => {
    if (stopping) return
    stopping = true
    clearTimeout(retryTimer)
    clearInterval(watchdog)
    clearInterval(tickTimer)
    if (socket) invalidate(socket)
    else cleanup = controller.disconnect()
    void cleanup.then(() => finish(), () => finish())
  }
  const retry = () => {
    if (stopping || socket || connecting) return
    clearTimeout(retryTimer)
    attempts = 0
    pairingRequired = false // Explicit local retry probes again; only Host authentication can restore trust.
    void status('reconnecting').then(connect).catch(() => status('needs_attention'))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.on('SIGHUP', retry)
  try {
    await controller.initialize()
    await status(pairingRequired ? 'needs_pairing' : 'ready')
    await connect().catch(() => status('needs_attention'))
    await done
    await status('stopped')
  } finally {
    clearInterval(tickTimer)
    clearInterval(watchdog)
    clearTimeout(retryTimer)
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    process.off('SIGHUP', retry)
    await ssh.stopAll()
    await unlock()
  }
}

export async function readConnectionState(path: string, deviceId: string): Promise<{attempts:number;pairingRequired:boolean}> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { reconnectAttempts?: unknown; pairingRequired?:unknown; state?:unknown; deviceId?:unknown }
    if (value.deviceId !== deviceId) throw new Error('Daemon observation belongs to a different Device; use unified launch to recover pairing')
    if (!Number.isSafeInteger(value.reconnectAttempts) || (value.reconnectAttempts as number) < 0) throw new Error('Invalid reconnect state')
    return { attempts: value.reconnectAttempts as number, pairingRequired: value.pairingRequired === true || value.state === 'needs_pairing' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {attempts:0,pairingRequired:false}
    throw error
  }
}

