import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { CompanionError, type ForwardOperation } from './domain.js'
import {
  COMPANION_PROTOCOL_VERSION,
  encodeHostFrame,
  makeForwardCloseFor,
  makeForwardOpen,
  makeHostHello,
  parseDeviceFrame,
  type EpochFence,
  type ForwardCloseFrame,
  type ForwardOpenFrame,
  type HostFrame,
  type WireInstanceObservation,
} from './protocol.js'
import type { CompanionService, ObserveInstanceInput } from './service.js'
import { isTrustedCompanionRequest } from './trust.js'

export const COMPANION_DEVICE_WS_PATH = '/api/companion/device'
export const DEFAULT_HEARTBEAT_MS = 15_000

export interface CompanionUpgradeRoute {
  path: string
  handler(req: IncomingMessage, socket: Duplex, head: Buffer): void
}

interface DeviceConnection {
  deviceId: string
  ws: WebSocket
  fence: EpochFence
  helloReceived: boolean
  reconciled: boolean
  flushing: boolean
  tokenHash: string
  listRequestedAt?: number | undefined
  lastPongAt: number
  expectedPong?: string | undefined
  expectedList?: string | undefined
  sent: Map<string, ForwardOpenFrame | ForwardCloseFrame>
  messageTail: Promise<void>
  heartbeat: NodeJS.Timeout
  helloTimeout: NodeJS.Timeout
}

export class CompanionDeviceHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  private readonly connections = new Map<string, DeviceConnection>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(
    private readonly service: CompanionService,
    private readonly trustedHosts: readonly string[],
    private readonly heartbeatMs = DEFAULT_HEARTBEAT_MS,
    private readonly reconcileTasks?: (() => Promise<void>) | undefined,
  ) {
    this.unsubscribe = service.subscribe(() => this.flushAll())
  }

  route(): CompanionUpgradeRoute {
    return {
      path: COMPANION_DEVICE_WS_PATH,
      handler: (req, socket, head) => this.handleUpgrade(req, socket, head),
    }
  }

  isConnected(deviceId: string): boolean {
    return this.connections.get(deviceId)?.ws.readyState === WebSocket.OPEN
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const connection of this.connections.values()) this.closeConnection(connection, 1001, 'Host shutting down')
    this.connections.clear()
    this.wss.close()
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      if (this.disposed || !isTrustedCompanionRequest(req, this.trustedHosts)) {
        socket.destroy()
        return
      }
      const token = bearerToken(req.headers.authorization)
      const device = this.service.authenticateDevice(token)
      this.wss.handleUpgrade(req, socket, head, ws => this.attach(device.id, ws, token))
    } catch {
      socket.destroy()
    }
  }

  private attach(deviceId: string, ws: WebSocket, token: string): void {
    this.service.authenticateDevice(token)
    const replaced = this.connections.get(deviceId)
    if (replaced) this.closeConnection(replaced, 4001, 'Replaced by a newer Device session')

    const fence = {
      authorityEpoch: this.service.snapshot().authorityEpoch,
      sessionEpoch: `session_${randomUUID()}`,
    }
    const connection = {} as DeviceConnection
    connection.deviceId = deviceId
    connection.ws = ws
    connection.fence = fence
    connection.helloReceived = false
    connection.reconciled = false
    connection.flushing = false
    connection.tokenHash = this.service.snapshot().devices.find(item => item.id === deviceId)!.tokenHash
    connection.lastPongAt = Date.now()
    connection.sent = new Map()
    connection.messageTail = Promise.resolve()
    connection.helloTimeout = setTimeout(() => this.closeConnection(connection, 1008, 'Device hello timeout'), 10_000)
    connection.heartbeat = setInterval(() => this.heartbeat(connection), this.heartbeatMs)
    this.connections.set(deviceId, connection)

    ws.on('message', (data, isBinary) => {
      connection.messageTail = connection.messageTail
        .then(() => this.onMessage(connection, data, isBinary))
        .catch(error => {
          console.error('dsh-companion: Device frame failed', error)
          this.closeConnection(connection, 1008, 'Invalid Device frame')
        })
    })
    ws.on('close', () => void this.detach(connection))
    ws.on('error', error => console.error('dsh-companion: Device WebSocket error', error))
    this.send(connection, makeHostHello(fence, this.heartbeatMs, new Date().toISOString()))
  }

  private async onMessage(connection: DeviceConnection, raw: RawData, isBinary: boolean): Promise<void> {
    if (!this.isCurrent(connection)) return
    if (isBinary) throw new CompanionError('VALIDATION_ERROR', 'binary Device frames are forbidden')
    const frame = parseDeviceFrame(rawBuffer(raw))
    if (frame.authorityEpoch !== connection.fence.authorityEpoch
      || frame.sessionEpoch !== connection.fence.sessionEpoch) {
      throw new CompanionError('UNAUTHORIZED', 'stale authority or Connection Session', 403)
    }

    if (frame.type === 'device.hello') {
      if (connection.helloReceived) throw new CompanionError('VALIDATION_ERROR', 'duplicate Device hello')
      connection.helloReceived = true
      clearTimeout(connection.helloTimeout)
      const requestId = `list_${randomUUID()}`
      connection.expectedList = requestId
      connection.listRequestedAt = Date.now()
      await this.service.markDeviceConnected(connection.deviceId, frame.companionVersion)
      if (!this.isCurrent(connection)) return
      this.send(connection, { v: COMPANION_PROTOCOL_VERSION, type: 'forward.list', ...connection.fence, requestId })
      return
    }
    if (!connection.helloReceived) throw new CompanionError('UNAUTHORIZED', 'Device hello is required first', 403)

    if (frame.type === 'pong') {
      if (frame.nonce !== connection.expectedPong) throw new CompanionError('UNAUTHORIZED', 'pong nonce mismatch', 403)
      connection.expectedPong = undefined
      connection.lastPongAt = Date.now()
      return
    }
    if (frame.type === 'forward.list') {
      if (frame.requestId !== connection.expectedList) throw new CompanionError('UNAUTHORIZED', 'forward.list request mismatch', 403)
      connection.expectedList = undefined
      connection.reconciled = false
      await this.reconcileTasks?.()
      if (!this.isCurrent(connection)) return
      await this.service.reconcileDeviceReport(
        connection.deviceId,
        frame.instances.map(observation => toServiceObservation(connection.deviceId, observation)),
      )
      connection.reconciled = true
      await this.flush(connection)
      return
    }
    if (frame.type === 'forward.result') {
      const sent = connection.sent.get(frame.operationId)
      if (!sent || sent.digest !== frame.digest) {
        throw new CompanionError('UNAUTHORIZED', 'operation result digest mismatch', 403)
      }
      if (frame.observation && (frame.observation.leaseId !== sent.leaseId || frame.observation.generation !== sent.generation)) {
        throw new CompanionError('UNAUTHORIZED', 'operation observation does not match Lease and generation', 403)
      }
      if (frame.ok && sent.type === 'forward.close' && frame.observation && frame.observation.state !== 'closed') {
        throw new CompanionError('VALIDATION_ERROR', 'successful close must report a closed Instance')
      }
      if (this.service.snapshot().operations.find(item => item.id === frame.operationId)?.acknowledgedAt) return
      await this.service.acknowledgeOperation(connection.deviceId, frame.operationId, {
        ok: frame.ok,
        errorCode: frame.errorCode,
        errorMessage: frame.errorMessage,
      })
      // Keep a bounded duplicate-ACK window; never grow transport memory indefinitely.
      if (connection.sent.size > 256) {
        const acknowledged = new Set(this.service.snapshot().operations.filter(item => item.acknowledgedAt).map(item => item.id))
        for (const id of connection.sent.keys()) {
          if (connection.sent.size <= 256) break
          if (acknowledged.has(id)) connection.sent.delete(id)
        }
      }
      if (frame.observation) {
        const exists = this.service.snapshot().leases.some(lease => lease.id === frame.observation?.leaseId)
        if (exists) await this.service.observeInstance(
          connection.deviceId,
          toServiceObservation(connection.deviceId, frame.observation),
        )
      }
    }
  }

  private flushAll(): void {
    for (const connection of this.connections.values()) void this.flush(connection).catch(() => this.closeConnection(connection, 1011, 'Operation delivery failed'))
  }

  private isCurrent(connection: DeviceConnection): boolean {
    if (this.connections.get(connection.deviceId) !== connection || connection.ws.readyState !== WebSocket.OPEN) return false
    const device = this.service.snapshot().devices.find(item => item.id === connection.deviceId)
    if (!device || device.revokedAt || device.tokenHash !== connection.tokenHash) {
      this.closeConnection(connection, 4003, 'Device credentials changed')
      return false
    }
    return true
  }

  private async flush(connection: DeviceConnection): Promise<void> {
    if (!this.isCurrent(connection) || !connection.reconciled || connection.flushing) return
    connection.flushing = true
    try {
      for (const pending of this.service.pendingOperations(connection.deviceId)) {
        const operation = await this.service.claimOperation(connection.deviceId, pending.id)
        if (!operation || !this.isCurrent(connection) || !connection.reconciled) continue
        // Recheck after persistence: expiry, close, or revocation may have overtaken us.
        if (!this.service.pendingOperations(connection.deviceId).some(item => item.id === operation.id)) continue
        const frame = operationFrame(this.service.snapshot(), operation, connection.fence)
        if (!frame) continue
        connection.sent.set(operation.id, frame)
        this.send(connection, frame)
      }
    } finally { connection.flushing = false }
  }

  private heartbeat(connection: DeviceConnection): void {
    if (!this.isCurrent(connection)) return
    if (connection.expectedList && Date.now() - (connection.listRequestedAt ?? 0) > this.heartbeatMs * 2) {
      this.closeConnection(connection, 4000, 'Snapshot timeout')
      return
    }
    if (connection.helloReceived && !connection.expectedList) {
      connection.expectedList = 'list_' + randomUUID()
      connection.listRequestedAt = Date.now()
      this.send(connection, { v: 1, type: 'forward.list', ...connection.fence, requestId: connection.expectedList })
    }
    this.flushAll()
    if (connection.expectedPong) {
      if (Date.now() - connection.lastPongAt > this.heartbeatMs * 2) {
        this.closeConnection(connection, 4000, 'Heartbeat timeout')
      }
      return
    }
    const nonce = `ping_${randomUUID()}`
    connection.expectedPong = nonce
    this.send(connection, { v: 1, type: 'ping', ...connection.fence, nonce })
  }

  private send(connection: DeviceConnection, frame: HostFrame): void {
    if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(encodeHostFrame(frame))
  }

  private closeConnection(connection: DeviceConnection, code: number, reason: string): void {
    connection.reconciled = false
    clearInterval(connection.heartbeat)
    clearTimeout(connection.helloTimeout)
    if (connection.ws.readyState === WebSocket.OPEN || connection.ws.readyState === WebSocket.CONNECTING) {
      connection.ws.close(code, reason.slice(0, 120))
    }
  }

  private async detach(connection: DeviceConnection): Promise<void> {
    clearInterval(connection.heartbeat)
    clearTimeout(connection.helloTimeout)
    if (this.connections.get(connection.deviceId) !== connection) return
    this.connections.delete(connection.deviceId)
    try { await this.service.markDeviceDisconnected(connection.deviceId) }
    catch (error) { console.error('dsh-companion: failed to record Device disconnect', error) }
  }
}

function operationFrame(
  state: ReturnType<CompanionService['snapshot']>,
  operation: ForwardOperation,
  fence: EpochFence,
): ForwardOpenFrame | ForwardCloseFrame | undefined {
  const lease = state.leases.find(item => item.id === operation.leaseId && item.deviceId === operation.deviceId)
  if (operation.kind === 'open') {
    if (!lease || lease.desiredState !== 'open' || lease.generation !== operation.generation) return undefined
    const service = state.services.find(item => item.id === lease.serviceId && !item.archivedAt)
    if (!service) return undefined
    return makeForwardOpen(fence, lease, operation, operation.protocol ?? service.protocol)
  }
  const tombstone = state.tombstones.find(item => item.leaseId === operation.leaseId
    && item.deviceId === operation.deviceId
    && item.generation === operation.generation)
  return makeForwardCloseFor(fence, {
    leaseId: operation.leaseId,
    generation: operation.generation,
    reason: tombstone?.reason ?? (lease?.desiredState === 'open' ? 'restart' : lease?.closeReason ?? 'reconcile'),
  }, operation)
}

function toServiceObservation(deviceId: string, observation: WireInstanceObservation): ObserveInstanceInput {
  return { ...observation, deviceId }
}

function bearerToken(value: string | undefined): string {
  if (!value?.startsWith('Bearer ') || value.length <= 7) {
    throw new CompanionError('UNAUTHORIZED', 'Bearer Device token is required', 401)
  }
  return value.slice(7)
}

function rawBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw
  if (Array.isArray(raw)) return Buffer.concat(raw)
  return Buffer.from(raw)
}
