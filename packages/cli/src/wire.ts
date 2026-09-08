import { createHash } from 'node:crypto'

export const PROTOCOL_VERSION = 1 as const
export type Protocol = 'http' | 'https' | 'tcp'
export interface Fence { authorityEpoch: string; sessionEpoch: string }

export interface HostHello extends Fence { v: 1; type: 'host.hello'; heartbeatMs: number; serverTime: string }
export interface ForwardOpen extends Fence { v: 1; type: 'forward.open'; operationId: string; leaseId: string; generation: number; port: number; protocol: Protocol; expiresAt: string; digest: string }
export interface ForwardClose extends Fence { v: 1; type: 'forward.close'; operationId: string; leaseId: string; generation: number; reason: string; digest: string }
export interface ForwardListRequest extends Fence { v: 1; type: 'forward.list'; requestId: string }
export interface Ping extends Fence { v: 1; type: 'ping'; nonce: string }
export type HostFrame = HostHello | ForwardOpen | ForwardClose | ForwardListRequest | Ping
export type ForwardCommand = ForwardOpen | ForwardClose

export interface InstanceObservation {
  leaseId: string
  generation: number
  state: 'starting' | 'running' | 'recovering' | 'needs_attention' | 'closed'
  sshChild: 'unknown' | 'running' | 'exited'
  listener: 'unknown' | 'owned' | 'missing' | 'conflict'
  remoteProbe: 'unknown' | 'healthy' | 'failed' | 'disabled'
  processId?: number | undefined
  retryAttempt?: number | undefined
  retryAt?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type DeviceFrame =
  | ({ v: 1; type: 'device.hello'; companionVersion: string } & Fence)
  | ({ v: 1; type: 'forward.result'; operationId: string; digest: string; ok: boolean; observation?: InstanceObservation; errorCode?: string; errorMessage?: string } & Fence)
  | ({ v: 1; type: 'forward.list'; requestId: string; instances: InstanceObservation[] } & Fence)
  | ({ v: 1; type: 'pong'; nonce: string } & Fence)

export function parseHostFrame(raw: string | Buffer): HostFrame {
  let value: unknown
  try { value = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) }
  catch { throw new WireError('Host frame is not valid JSON') }
  const record = requireRecord(value, 'frame')
  if (record.v !== 1) throw new WireError('unsupported protocol version')
  const type = requireString(record.type, 'type')
  const fence = { authorityEpoch: requireString(record.authorityEpoch, 'authorityEpoch'), sessionEpoch: requireString(record.sessionEpoch, 'sessionEpoch') }
  if (type === 'host.hello') {
    exactKeys(record, ['v','type','authorityEpoch','sessionEpoch','heartbeatMs','serverTime'])
    return { v: 1, type, ...fence, heartbeatMs: boundedInteger(record.heartbeatMs, 'heartbeatMs', 1_000, 120_000), serverTime: iso(record.serverTime, 'serverTime') }
  }
  if (type === 'forward.open') {
    exactKeys(record, ['v','type','authorityEpoch','sessionEpoch','operationId','leaseId','generation','port','protocol','expiresAt','digest'])
    const frame: ForwardOpen = {
      v: 1, type, ...fence, operationId: requireString(record.operationId, 'operationId'), leaseId: requireString(record.leaseId, 'leaseId'),
      generation: boundedInteger(record.generation, 'generation', 1, Number.MAX_SAFE_INTEGER), port: boundedInteger(record.port, 'port', 1, 65_535),
      protocol: oneOf(record.protocol, 'protocol', ['http','https','tcp'] as const), expiresAt: iso(record.expiresAt, 'expiresAt'), digest: hexDigest(record.digest),
    }
    if (!verifyDigest(frame)) throw new WireError('operation digest mismatch')
    return frame
  }
  if (type === 'forward.close') {
    exactKeys(record, ['v','type','authorityEpoch','sessionEpoch','operationId','leaseId','generation','reason','digest'])
    const frame: ForwardClose = {
      v: 1, type, ...fence, operationId: requireString(record.operationId, 'operationId'), leaseId: requireString(record.leaseId, 'leaseId'),
      generation: boundedInteger(record.generation, 'generation', 1, Number.MAX_SAFE_INTEGER), reason: requireString(record.reason, 'reason'), digest: hexDigest(record.digest),
    }
    if (!verifyDigest(frame)) throw new WireError('operation digest mismatch')
    return frame
  }
  if (type === 'forward.list') {
    exactKeys(record, ['v','type','authorityEpoch','sessionEpoch','requestId'])
    return { v: 1, type, ...fence, requestId: requireString(record.requestId, 'requestId') }
  }
  if (type === 'ping') {
    exactKeys(record, ['v','type','authorityEpoch','sessionEpoch','nonce'])
    return { v: 1, type, ...fence, nonce: requireString(record.nonce, 'nonce') }
  }
  throw new WireError(`unsupported Host frame type: ${type}`)
}

export function verifyDigest(frame: ForwardCommand): boolean {
  const { digest, sessionEpoch: _deliveryFence, ...semantic } = frame
  return digest === createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex')
}

export function encodeDeviceFrame(frame: DeviceFrame): string { return JSON.stringify(frame) }

export class WireError extends Error { constructor(message: string) { super(message); this.name = 'WireError' } }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}
function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WireError(`${field} must be an object`)
  return value as Record<string, unknown>
}
function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new WireError(`unexpected frame field: ${key}`)
  for (const key of keys) if (!(key in record)) throw new WireError(`missing frame field: ${key}`)
}
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000) throw new WireError(`${field} must be a non-empty string`)
  return value
}
function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new WireError(`${field} is outside bounds`)
  return value as number
}
function oneOf<const T extends readonly string[]>(value: unknown, field: string, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) throw new WireError(`${field} is invalid`)
  return value as T[number]
}
function iso(value: unknown, field: string): string {
  const text = requireString(value, field)
  if (!Number.isFinite(Date.parse(text))) throw new WireError(`${field} must be an ISO timestamp`)
  return text
}
function hexDigest(value: unknown): string {
  const text = requireString(value, 'digest')
  if (!/^[a-f0-9]{64}$/.test(text)) throw new WireError('digest must be SHA-256 hex')
  return text
}
