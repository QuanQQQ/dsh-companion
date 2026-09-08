import { createHash } from 'node:crypto'
import { CompanionError, assertPort, type ApplicationProtocol, type ForwardLease, type ForwardOperation } from './domain.js'

export const COMPANION_PROTOCOL_VERSION = 1 as const

export interface EpochFence {
  authorityEpoch: string
  sessionEpoch: string
}

export interface HostHelloFrame extends EpochFence {
  v: typeof COMPANION_PROTOCOL_VERSION
  type: 'host.hello'
  heartbeatMs: number
  serverTime: string
}

export interface ForwardOpenFrame extends EpochFence {
  v: typeof COMPANION_PROTOCOL_VERSION
  type: 'forward.open'
  operationId: string
  leaseId: string
  generation: number
  port: number
  protocol: ApplicationProtocol
  expiresAt: string
  digest: string
}

export interface ForwardCloseFrame extends EpochFence {
  v: typeof COMPANION_PROTOCOL_VERSION
  type: 'forward.close'
  operationId: string
  leaseId: string
  generation: number
  reason: string
  digest: string
}

export interface ForwardListRequestFrame extends EpochFence {
  v: typeof COMPANION_PROTOCOL_VERSION
  type: 'forward.list'
  requestId: string
}

export interface PingFrame extends EpochFence {
  v: typeof COMPANION_PROTOCOL_VERSION
  type: 'ping'
  nonce: string
}

export type HostFrame = HostHelloFrame | ForwardOpenFrame | ForwardCloseFrame | ForwardListRequestFrame | PingFrame

export interface WireInstanceObservation {
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

export interface DeviceHelloFrame extends EpochFence {
  v: typeof COMPANION_PROTOCOL_VERSION
  type: 'device.hello'
  companionVersion: string
}

export interface ForwardResultFrame extends EpochFence {
  v: typeof COMPANION_PROTOCOL_VERSION
  type: 'forward.result'
  operationId: string
  digest: string
  ok: boolean
  observation?: WireInstanceObservation | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export interface ForwardListResultFrame extends EpochFence {
  v: typeof COMPANION_PROTOCOL_VERSION
  type: 'forward.list'
  requestId: string
  instances: WireInstanceObservation[]
}

export interface PongFrame extends EpochFence {
  v: typeof COMPANION_PROTOCOL_VERSION
  type: 'pong'
  nonce: string
}

export type DeviceFrame = DeviceHelloFrame | ForwardResultFrame | ForwardListResultFrame | PongFrame

export function makeHostHello(fence: EpochFence, heartbeatMs: number, serverTime: string): HostHelloFrame {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 120_000) {
    throw new CompanionError('VALIDATION_ERROR', 'heartbeatMs is outside the protocol bounds')
  }
  assertIsoTime(serverTime, 'serverTime')
  return { v: COMPANION_PROTOCOL_VERSION, type: 'host.hello', ...fence, heartbeatMs, serverTime }
}

export function makeForwardOpen(
  fence: EpochFence,
  lease: ForwardLease,
  operation: ForwardOperation,
  protocol: ApplicationProtocol,
): ForwardOpenFrame {
  if (operation.kind !== 'open' || operation.leaseId !== lease.id || operation.generation !== lease.generation) {
    throw new CompanionError('GENERATION_MISMATCH', 'open operation does not match the current Lease generation')
  }
  const frameWithoutDigest = {
    v: COMPANION_PROTOCOL_VERSION,
    type: 'forward.open' as const,
    ...fence,
    operationId: operation.id,
    leaseId: lease.id,
    generation: lease.generation,
    port: assertPort(lease.localPort),
    protocol,
    expiresAt: lease.expiresAt,
  }
  if (lease.localPort !== lease.remotePort || lease.localHost !== '127.0.0.1' || lease.remoteHost !== '127.0.0.1') {
    throw new CompanionError('VALIDATION_ERROR', 'Lease violates loopback same-port policy')
  }
  return { ...frameWithoutDigest, digest: digestOperation(frameWithoutDigest) }
}

export function makeForwardClose(
  fence: EpochFence,
  lease: ForwardLease,
  operation: ForwardOperation,
): ForwardCloseFrame {
  return makeForwardCloseFor(fence, {
    leaseId: lease.id,
    generation: operation.generation,
    reason: lease.closeReason ?? 'reconcile',
  }, operation)
}

export function makeForwardCloseFor(
  fence: EpochFence,
  target: { leaseId: string; generation: number; reason: string },
  operation: ForwardOperation,
): ForwardCloseFrame {
  if (operation.kind !== 'close'
    || operation.leaseId !== target.leaseId
    || operation.generation !== target.generation) {
    throw new CompanionError('GENERATION_MISMATCH', 'close operation does not match its tombstone')
  }
  const frameWithoutDigest = {
    v: COMPANION_PROTOCOL_VERSION,
    type: 'forward.close' as const,
    ...fence,
    operationId: operation.id,
    leaseId: target.leaseId,
    generation: target.generation,
    reason: target.reason,
  }
  return { ...frameWithoutDigest, digest: digestOperation(frameWithoutDigest) }
}

export function verifyOperationDigest(frame: ForwardOpenFrame | ForwardCloseFrame): boolean {
  const { digest, ...payload } = frame
  return digest === digestOperation(payload)
}

export function digestOperation(
  frame: Omit<ForwardOpenFrame, 'digest'> | Omit<ForwardCloseFrame, 'digest'>,
): string {
  const { sessionEpoch: _deliveryFence, ...semanticPayload } = frame
  return createHash('sha256').update(canonicalJson(semanticPayload), 'utf8').digest('hex')
}

export function parseDeviceFrame(raw: string | Buffer): DeviceFrame {
  let value: unknown
  try {
    value = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
  } catch {
    throw new CompanionError('VALIDATION_ERROR', 'Device frame is not valid JSON')
  }
  const record = requireRecord(value, 'frame')
  if (record.v !== COMPANION_PROTOCOL_VERSION) {
    throw new CompanionError('VALIDATION_ERROR', 'unsupported Companion protocol version')
  }
  const type = requireString(record.type, 'type')
  const fence = parseFence(record)

  if (type === 'device.hello') {
    exactKeys(record, ['v', 'type', 'authorityEpoch', 'sessionEpoch', 'companionVersion'])
    return { v: 1, type, ...fence, companionVersion: requireString(record.companionVersion, 'companionVersion') }
  }
  if (type === 'pong') {
    exactKeys(record, ['v', 'type', 'authorityEpoch', 'sessionEpoch', 'nonce'])
    return { v: 1, type, ...fence, nonce: requireString(record.nonce, 'nonce') }
  }
  if (type === 'forward.list') {
    exactKeys(record, ['v', 'type', 'authorityEpoch', 'sessionEpoch', 'requestId', 'instances'])
    if (!Array.isArray(record.instances) || record.instances.length > 1_000) {
      throw new CompanionError('VALIDATION_ERROR', 'instances must be a bounded array')
    }
    return {
      v: 1,
      type,
      ...fence,
      requestId: requireString(record.requestId, 'requestId'),
      instances: record.instances.map(parseObservation),
    }
  }
  if (type === 'forward.result') {
    exactKeys(record, [
      'v', 'type', 'authorityEpoch', 'sessionEpoch', 'operationId', 'digest', 'ok',
      'observation', 'errorCode', 'errorMessage',
    ], true)
    if (typeof record.ok !== 'boolean') throw new CompanionError('VALIDATION_ERROR', 'ok must be boolean')
    const observation = record.observation === undefined ? undefined : parseObservation(record.observation)
    const errorCode = optionalString(record.errorCode, 'errorCode')
    const errorMessage = optionalString(record.errorMessage, 'errorMessage', 1_000)
    if (record.ok && (errorCode || errorMessage)) {
      throw new CompanionError('VALIDATION_ERROR', 'successful result cannot include an error')
    }
    return {
      v: 1,
      type,
      ...fence,
      operationId: requireString(record.operationId, 'operationId'),
      digest: requireHexDigest(record.digest),
      ok: record.ok,
      ...(observation ? { observation } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    }
  }
  throw new CompanionError('VALIDATION_ERROR', `unsupported Device frame type: ${type}`)
}

export function encodeHostFrame(frame: HostFrame): string {
  return JSON.stringify(frame)
}

function parseFence(record: Record<string, unknown>): EpochFence {
  return {
    authorityEpoch: requireString(record.authorityEpoch, 'authorityEpoch'),
    sessionEpoch: requireString(record.sessionEpoch, 'sessionEpoch'),
  }
}

function parseObservation(value: unknown): WireInstanceObservation {
  const record = requireRecord(value, 'observation')
  exactKeys(record, [
    'leaseId', 'generation', 'state', 'sshChild', 'listener', 'remoteProbe', 'processId',
    'retryAttempt', 'retryAt', 'errorCode', 'errorMessage',
  ], true)
  const generation = requirePositiveInteger(record.generation, 'generation')
  const state = oneOf(record.state, 'state', ['starting', 'running', 'recovering', 'needs_attention', 'closed'] as const)
  const sshChild = oneOf(record.sshChild, 'sshChild', ['unknown', 'running', 'exited'] as const)
  const listener = oneOf(record.listener, 'listener', ['unknown', 'owned', 'missing', 'conflict'] as const)
  const remoteProbe = oneOf(record.remoteProbe, 'remoteProbe', ['unknown', 'healthy', 'failed', 'disabled'] as const)
  const processId = optionalPositiveInteger(record.processId, 'processId')
  const retryAttempt = optionalNonNegativeInteger(record.retryAttempt, 'retryAttempt')
  const retryAt = optionalString(record.retryAt, 'retryAt')
  if (retryAt) assertIsoTime(retryAt, 'retryAt')
  const errorCode = optionalString(record.errorCode, 'errorCode')
  const errorMessage = optionalString(record.errorMessage, 'errorMessage', 1_000)
  return {
    leaseId: requireString(record.leaseId, 'leaseId'),
    generation,
    state,
    sshChild,
    listener,
    remoteProbe,
    ...(processId === undefined ? {} : { processId }),
    ...(retryAttempt === undefined ? {} : { retryAttempt }),
    ...(retryAt ? { retryAt } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanionError('VALIDATION_ERROR', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], allowUndefined = false): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new CompanionError('VALIDATION_ERROR', `unexpected frame field: ${key}`)
  }
  if (!allowUndefined) {
    for (const key of keys) {
      if (!(key in record)) throw new CompanionError('VALIDATION_ERROR', `missing frame field: ${key}`)
    }
  }
}

function requireString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new CompanionError('VALIDATION_ERROR', `${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string, maxLength = 512): string | undefined {
  return value === undefined ? undefined : requireString(value, field, maxLength)
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CompanionError('VALIDATION_ERROR', `${field} must be a positive integer`)
  }
  return value as number
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : requirePositiveInteger(value, field)
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CompanionError('VALIDATION_ERROR', `${field} must be a non-negative integer`)
  }
  return value as number
}

function oneOf<const T extends readonly string[]>(value: unknown, field: string, options: T): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) {
    throw new CompanionError('VALIDATION_ERROR', `${field} is invalid`)
  }
  return value as T[number]
}

function assertIsoTime(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new CompanionError('VALIDATION_ERROR', `${field} must be an ISO timestamp`)
}

function requireHexDigest(value: unknown): string {
  const digest = requireString(value, 'digest', 64)
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new CompanionError('VALIDATION_ERROR', 'digest must be SHA-256 hex')
  return digest
}
