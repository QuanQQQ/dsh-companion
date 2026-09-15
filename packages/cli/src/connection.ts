import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { WebSocket, type RawData } from 'ws'
import type { CompanionConfig } from './config.js'
import type { ForwardController } from './controller.js'
import type { RuntimeStore } from './runtime-state.js'
import { VERSION } from './version.js'
import { encodeDeviceFrame, parseHostFrame, type Fence, type DeviceFrame } from './wire.js'

export interface ConnectionState extends ConnectionDetails { attempts: number; pairingRequired: boolean; automaticRetryBlocked: boolean }
export interface ConnectionClock {
  now(): number
  after(action: () => void, milliseconds: number): () => void
  every(action: () => void, milliseconds: number): () => void
}
const systemClock: ConnectionClock = {
  now: () => Date.now(),
  after(action, ms) { const timer = setTimeout(action, ms); return () => clearTimeout(timer) },
  every(action, ms) { const timer = setInterval(action, ms); return () => clearInterval(timer) },
}
export const CONNECTION_REASONS = ['NETWORK_ERROR', 'TLS_ERROR', 'PROTOCOL_ERROR', 'HTTP_ERROR', 'AUTHENTICATION_REJECTED', 'AUTHORITY_CHANGED', 'REMOTE_CLOSE', 'HOST_HELLO_TIMEOUT', 'HEARTBEAT_TIMEOUT', 'CREDENTIAL_UNAVAILABLE', 'CLEANUP_FAILED', 'LOCAL_ERROR', 'STATUS_WRITE_FAILED'] as const
export type ConnectionReason = typeof CONNECTION_REASONS[number]
export const CLEANUP_ERROR_CODES = ['SSH_STOP_TIMEOUT', 'SSH_STOP_FAILED', 'SSH_OWNERSHIP_UNVERIFIED', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM', 'EACCES', 'ENOSPC', 'EIO', 'UNKNOWN'] as const
export type CleanupErrorCode = typeof CLEANUP_ERROR_CODES[number]
export interface ConnectionDetails {
  lastDisconnectReason?: ConnectionReason
  lastCleanupErrorCode?: CleanupErrorCode
  lastDisconnectAt?: string
  lastConnectedAt?: string
  lastCloseCode?: number
  lastHttpStatus?: number
  nextReconnectAt?: string
}
export function connectionDetails(value: Record<string, unknown>): ConnectionDetails {
  const result: ConnectionDetails = {}
  if (CONNECTION_REASONS.includes(value.lastDisconnectReason as ConnectionReason)) result.lastDisconnectReason = value.lastDisconnectReason as ConnectionReason
  if (CLEANUP_ERROR_CODES.includes(value.lastCleanupErrorCode as CleanupErrorCode)) result.lastCleanupErrorCode = value.lastCleanupErrorCode as CleanupErrorCode
  for (const key of ['lastDisconnectAt', 'lastConnectedAt', 'nextReconnectAt'] as const) {
    const date = value[key]
    if (typeof date === 'string' && date.length <= 32 && Number.isFinite(Date.parse(date))) result[key] = new Date(date).toISOString()
  }
  for (const [key, min, max] of [['lastCloseCode', 1000, 4999], ['lastHttpStatus', 100, 599]] as const) {
    const code = value[key]
    if (typeof code === 'number' && Number.isSafeInteger(code) && code >= min && code <= max) result[key] = code
  }
  return result
}
export function reconnectDelay(attempts: number, random = Math.random()): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(1, attempts)))
  return Math.round(base * (0.8 + 0.2 * Math.min(1, Math.max(0, random))))
}
function transportErrorReason(error: unknown): ConnectionReason {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code.startsWith('WS_ERR_')) return 'PROTOCOL_ERROR'
  if (code.startsWith('ERR_TLS_') || ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_NOT_YET_VALID', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code)) return 'TLS_ERROR'
  return 'NETWORK_ERROR'
}
function cleanupErrorCode(error: unknown): CleanupErrorCode {
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const code = cleanupErrorCode(nested)
      if (code !== 'UNKNOWN' && code !== 'SSH_STOP_FAILED') return code
    }
  }
  const candidate = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) :
    error instanceof Error ? error.message : ''
  return CLEANUP_ERROR_CODES.includes(candidate as CleanupErrorCode) ? candidate as CleanupErrorCode : 'UNKNOWN'
}

export interface ConnectionOptions {
  config: Pick<CompanionConfig, 'deviceId' | 'authorityEpoch' | 'serverUrl'>
  controller: Pick<ForwardController, 'initialize' | 'connect' | 'disconnect' | 'execute' | 'expireNow' | 'tick'>
  observations(): ReturnType<RuntimeStore['observations']>
  readToken(): Promise<string>
  writeStatus(value: Record<string, unknown>): Promise<void>
  previous: ConnectionState
  clock?: ConnectionClock
  random?: () => number
  signals?: Pick<EventEmitter, 'on' | 'off'>
  socketFactory?: (url: URL, options: WebSocket.ClientOptions) => WebSocket
}

/** Control-channel reconnection has no attempt limit; SSH retry budgets remain in ForwardController. */
export async function runControlChannel(options: ConnectionOptions): Promise<void> {
  const { config, controller } = options
  const clock = options.clock ?? systemClock
  const signals = options.signals ?? process
  const bootId = randomUUID()
  let attempts = options.previous.attempts
  let pairingRequired = options.previous.pairingRequired
  let automaticRetryBlocked = options.previous.automaticRetryBlocked
  let stopping = false
  let socket: WebSocket | undefined
  let cancelRetry: (() => void) | undefined
  let cancelWatchdog: (() => void) | undefined
  let retryGeneration = 0
  let retryArmed = false
  let nextReconnectAt: number | undefined
  let connectedAt = 0
  let lastFrameAt = 0
  let heartbeatMs = 15_000
  let fence: Fence | undefined
  let queued = 0
  let connecting: Promise<void> | undefined
  let scheduling = false
  let cleanup = Promise.resolve()
  let statusTail = Promise.resolve()
  let lastDisconnectReason = options.previous.lastDisconnectReason
  let lastCleanupErrorCode = options.previous.lastCleanupErrorCode
  let lastDisconnectAt = options.previous.lastDisconnectAt
  let lastCloseCode = options.previous.lastCloseCode
  let lastHttpStatus = options.previous.lastHttpStatus
  let lastConnectedAt = options.previous.lastConnectedAt
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const status = (state: string) => {
    // Snapshot before awaiting IO. Never persist tokens, response bodies, close reason text or raw errors.
    const value = { state, reconnectAttempts: attempts, pairingRequired, automaticRetryBlocked,
      deviceId: config.deviceId, pid: process.pid, companionVersion: VERSION, bootId,
      updatedAt: new Date(clock.now()).toISOString(), lastDisconnectReason, lastCleanupErrorCode, lastDisconnectAt,
      lastCloseCode, lastHttpStatus, lastConnectedAt,
      nextReconnectAt: nextReconnectAt === undefined ? undefined : new Date(nextReconnectAt).toISOString() }
    statusTail = statusTail.then(() => options.writeStatus(value))
    return statusTail
  }
  const clearRetry = () => { retryGeneration++; retryArmed = false; nextReconnectAt = undefined; cancelRetry?.(); cancelRetry = undefined }
  const recordDisconnect = (reason: ConnectionReason, closeCode?: number, httpStatus?: number) => {
    lastDisconnectReason = reason; lastCleanupErrorCode = undefined; lastDisconnectAt = new Date(clock.now()).toISOString()
    lastCloseCode = closeCode; lastHttpStatus = httpStatus
  }
  const invalidate = (ws: WebSocket) => {
    if (socket !== ws) return
    socket = undefined; fence = undefined; cancelWatchdog?.(); cancelWatchdog = undefined
    cleanup = controller.disconnect() // Invalidate authorization synchronously, before queued work.
    void cleanup.catch(() => {})
    ws.terminate()
  }
  const failClosed = (reason: ConnectionReason) => {
    automaticRetryBlocked = true; clearRetry(); recordDisconnect(reason)
    if (socket) invalidate(socket)
    void status('needs_attention').catch(() => {})
  }
  const schedule = async (permanent: boolean) => {
    clearRetry()
    const generation = retryGeneration
    automaticRetryBlocked ||= permanent
    try { await cleanup } catch (error) {
      if (stopping || generation !== retryGeneration) return
      automaticRetryBlocked = true; recordDisconnect('CLEANUP_FAILED'); lastCleanupErrorCode = cleanupErrorCode(error)
      await status('cleanup_failed'); return
    }
    if (stopping || generation !== retryGeneration) return
    attempts = Math.min(Number.MAX_SAFE_INTEGER, attempts + 1)
    if (pairingRequired || automaticRetryBlocked) { await status(pairingRequired ? 'needs_pairing' : 'needs_attention'); return }
    const delay = reconnectDelay(attempts, options.random?.() ?? Math.random())
    nextReconnectAt = clock.now() + delay
    await status('reconnecting')
    if (stopping || generation !== retryGeneration) return
    retryArmed = true
    cancelRetry = clock.after(() => launchReconnect(), Math.max(0, nextReconnectAt! - clock.now()))
  }
  const requestSchedule = (permanent: boolean) => {
    if (stopping || scheduling) return
    scheduling = true
    void schedule(permanent).catch(() => failClosed('STATUS_WRITE_FAILED')).finally(() => { scheduling = false })
  }
  const recoverLocal = () => {
    if (stopping || pairingRequired || automaticRetryBlocked || scheduling) return
    if (!socket && (retryArmed || connecting)) return
    recordDisconnect('LOCAL_ERROR')
    if (socket) invalidate(socket)
    requestSchedule(false)
  }
  const launchReconnect = () => {
    if (!retryArmed || stopping || socket || connecting || pairingRequired || automaticRetryBlocked) return
    clearRetry()
    void connect().catch(recoverLocal)
  }
  const connect = (): Promise<void> => {
    if (connecting) return connecting
    connecting = doConnect().finally(() => { connecting = undefined })
    return connecting
  }
  const doConnect = async () => {
    await cleanup
    if (stopping || socket) return
    if (pairingRequired || automaticRetryBlocked) { await status(pairingRequired ? 'needs_pairing' : 'needs_attention'); return }
    await status('connecting')
    let token: string
    try { token = await options.readToken() } catch { failClosed('CREDENTIAL_UNAVAILABLE'); return }
    if (stopping || socket) return
    const url = new URL('/api/companion/device', config.serverUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = (options.socketFactory ?? ((u, opts) => new WebSocket(u, opts)))(url, {
      headers: { Authorization: 'Bearer ' + token }, maxPayload: 64 * 1024, handshakeTimeout: 10_000, followRedirects: false,
    })
    socket = ws
    let terminal = false
    const send = (frame: DeviceFrame) => { if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(encodeDeviceFrame(frame)) }
    const settle = (permanent = false, reason: ConnectionReason = 'NETWORK_ERROR', closeCode?: number, httpStatus?: number) => {
      if (terminal || socket !== ws) return
      terminal = true; recordDisconnect(reason, closeCode, httpStatus); invalidate(ws)
      requestSchedule(permanent)
    }
    ws.on('error', error => { const reason = transportErrorReason(error); settle(reason !== 'NETWORK_ERROR', reason) })
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      if (terminal || socket !== ws) return
      const code = res.statusCode ?? 0
      if (code === 401 || code === 403) pairingRequired = true
      // Retry overload and server outages, not redirects or permanent request/authentication failures.
      settle(pairingRequired || (code >= 300 && code < 500 && code !== 408 && code !== 429), pairingRequired ? 'AUTHENTICATION_REJECTED' : 'HTTP_ERROR', undefined, code)
    })
    ws.on('close', code => {
      if (terminal || socket !== ws) return
      if (code === 4003) pairingRequired = true
      settle([4001, 4003, 1002, 1003, 1007, 1008, 1009, 1010].includes(code), 'REMOTE_CLOSE', code)
    })
    ws.on('message', (raw: RawData, binary: boolean) => {
      if (stopping || socket !== ws || terminal) return
      try {
        if (binary) throw new Error('Binary frame forbidden')
        const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
        const frame = parseHostFrame(data)
        lastFrameAt = clock.now()
        if (frame.type === 'host.hello') {
          if (fence) throw new Error('Duplicate hello')
          if (frame.authorityEpoch !== config.authorityEpoch) { pairingRequired = true; settle(true, 'AUTHORITY_CHANGED'); return }
          controller.connect(frame)
          fence = { authorityEpoch: frame.authorityEpoch, sessionEpoch: frame.sessionEpoch }
          connectedAt = clock.now(); lastConnectedAt = new Date(connectedAt).toISOString(); heartbeatMs = frame.heartbeatMs
          send({ v: 1, type: 'device.hello', ...fence, companionVersion: VERSION })
          void status('connected').catch(() => settle(true, 'STATUS_WRITE_FAILED'))
          return
        }
        if (!fence || frame.authorityEpoch !== fence.authorityEpoch || frame.sessionEpoch !== fence.sessionEpoch) throw new Error('Stale fence')
        if (frame.type === 'ping') { send({ v: 1, type: 'pong', ...fence, nonce: frame.nonce }); return }
        if (frame.type === 'forward.list') { send({ v: 1, type: 'forward.list', ...fence, requestId: frame.requestId, instances: options.observations() }); return }
        if (++queued > 256) throw new Error('Command queue capacity')
        const captured = { ...fence }
        void controller.execute(frame).then(result => {
          send({ v: 1, type: 'forward.result', ...captured, operationId: frame.operationId, digest: frame.digest, ...result })
        }).catch(() => settle(false, 'LOCAL_ERROR')).finally(() => { queued -= 1 })
      } catch { settle(true, 'PROTOCOL_ERROR') }
    })
    lastFrameAt = clock.now()
    cancelWatchdog = clock.every(() => {
      if (!fence && clock.now() - lastFrameAt > 10_000) { settle(false, 'HOST_HELLO_TIMEOUT'); return }
      if (clock.now() - lastFrameAt > heartbeatMs * 3) { settle(false, 'HEARTBEAT_TIMEOUT'); return }
      if (fence && attempts > 0 && clock.now() - connectedAt >= 60_000) { attempts = 0; void status('connected').catch(() => settle(true, 'STATUS_WRITE_FAILED')) }
    }, 1000)
  }
  let ticking = false
  const cancelTick = clock.every(() => {
    if (stopping) return
    // On resume, service an overdue retry without waiting another full suspended timeout.
    if (retryArmed && nextReconnectAt !== undefined && clock.now() >= nextReconnectAt) launchReconnect()
    void controller.expireNow().catch(recoverLocal)
    if (ticking) return
    ticking = true
    void controller.tick().catch(recoverLocal).finally(() => { ticking = false })
  }, 1000)
  const stop = () => {
    if (stopping) return
    stopping = true; clearRetry(); cancelWatchdog?.(); cancelTick()
    if (socket) invalidate(socket)
    else { cleanup = controller.disconnect(); void cleanup.catch(() => {}) }
    void cleanup.then(() => finish(), () => finish())
  }
  const retry = () => {
    if (stopping || socket || connecting) return
    clearRetry(); attempts = 0; pairingRequired = false; automaticRetryBlocked = false
    // An explicit retry may reattempt cleanup, but can never bypass its successful completion.
    cleanup = cleanup.catch(() => controller.disconnect())
    void status('reconnecting').then(connect).catch(recoverLocal)
  }
  signals.on('SIGTERM', stop); signals.on('SIGINT', stop); signals.on('SIGHUP', retry)
  try {
    await controller.initialize()
    if (!stopping) await connect().catch(recoverLocal)
    await done
    await status('stopped')
  } finally {
    clearRetry(); cancelWatchdog?.(); cancelTick()
    signals.off('SIGTERM', stop); signals.off('SIGINT', stop); signals.off('SIGHUP', retry)
    if (socket) invalidate(socket)
    await cleanup
    await statusTail
  }
}
