export const STATE_VERSION = 2 as const
export const LOOPBACK_HOST = '127.0.0.1' as const
export const MIN_LEASE_TTL_MS = 60 * 1_000
export const MAX_LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const DEFAULT_LEASE_TTL_MS = MAX_LEASE_TTL_MS

export type ApplicationProtocol = 'http' | 'https' | 'tcp'
export type ServiceSource = 'manual' | 'agent' | 'process'
/** @deprecated Compatibility alias for consumers compiled before services became Host-global. */
export type TaskServiceSource = ServiceSource
export type DesiredState = 'open' | 'closed'
export type ForwardOperationKind = 'open' | 'close'
export type ForwardInstanceState = 'starting' | 'running' | 'recovering' | 'needs_attention' | 'closed'
export type ProbeState = 'unknown' | 'healthy' | 'failed' | 'disabled'
export type ProcessState = 'unknown' | 'running' | 'exited'
export type ListenerState = 'unknown' | 'owned' | 'missing' | 'conflict'
export type CloseReason = 'user' | 'expired' | 'device_revoked' | 'task_archived' | 'service_archived' | 'reconciliation_conflict'

export interface DeviceCapabilities {
  protocolVersion: 1
  localForward: true
  tcpProbe: boolean
}

export interface Device {
  id: string
  installationIdHash: string
  tokenHash: string
  name: string
  platform: 'macos'
  osVersion: string
  architecture: string
  companionVersion: string
  capabilities: DeviceCapabilities
  createdAt: string
  updatedAt: string
  lastSeenAt?: string | undefined
  revokedAt?: string | undefined
}

export interface PairingTicket {
  id: string
  codeHash: string
  createdAt: string
  expiresAt: string
  consumedAt?: string | undefined
}

export interface RegisteredService {
  id: string
  name: string
  port: number
  protocol: ApplicationProtocol
  source: ServiceSource
  evidence?: string | undefined
  createdAt: string
  updatedAt: string
  archivedAt?: string | undefined
}
/** @deprecated Compatibility alias for consumers compiled before services became Host-global. */
export type TaskService = RegisteredService

export interface ForwardLease {
  id: string
  serviceId: string
  deviceId: string
  localHost: typeof LOOPBACK_HOST
  localPort: number
  remoteHost: typeof LOOPBACK_HOST
  remotePort: number
  desiredState: DesiredState
  generation: number
  createdAt: string
  updatedAt: string
  expiresAt: string
  closedAt?: string | undefined
  closeReason?: CloseReason | undefined
}

export interface CloseTombstone {
  leaseId: string
  deviceId: string
  generation: number
  reason: CloseReason | 'orphaned'
  createdAt: string
  updatedAt: string
}

export interface ForwardOperation {
  id: string
  leaseId: string
  deviceId: string
  generation: number
  kind: ForwardOperationKind
  createdAt: string
  acknowledgedAt?: string | undefined
  /** Host delivery budget survives reconnects and restarts; never sent on the wire. */
  attemptCount?: number | undefined
  lastSentAt?: string | undefined
  protocol?: ApplicationProtocol | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export interface ForwardInstanceObservation {
  leaseId: string
  deviceId: string
  generation: number
  state: ForwardInstanceState
  sshChild: ProcessState
  listener: ListenerState
  remoteProbe: ProbeState
  processId?: number | undefined
  retryAttempt?: number | undefined
  retryAt?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  observedAt: string
}

export interface CompanionState {
  version: typeof STATE_VERSION
  authorityEpoch: string
  pairings: PairingTicket[]
  devices: Device[]
  services: RegisteredService[]
  leases: ForwardLease[]
  tombstones: CloseTombstone[]
  operations: ForwardOperation[]
  instances: ForwardInstanceObservation[]
}

export interface PublicDevice extends Omit<Device, 'installationIdHash' | 'tokenHash'> {
  online: boolean
}

export interface CompanionSnapshot {
  services: RegisteredService[]
  leases: ForwardLease[]
  instances: ForwardInstanceObservation[]
  devices: PublicDevice[]
}
/** @deprecated Compatibility alias for consumers compiled before the snapshot became Host-global. */
export type TaskSnapshot = CompanionSnapshot

export type CompanionErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'PAIRING_CODE_INVALID'
  | 'PAIRING_CODE_EXPIRED'
  | 'PAIRING_CODE_USED'
  | 'INSTALLATION_EXISTS'
  | 'DEVICE_REVOKED'
  | 'DEVICE_NOT_PAIRED'
  | 'LEASE_EXPIRED'
  | 'LEASE_CLOSED'
  | 'GENERATION_MISMATCH'
  | 'UNAUTHORIZED'
  | 'LOCAL_PORT_IN_USE'

export class CompanionError extends Error {
  constructor(
    readonly code: CompanionErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'CompanionError'
  }
}

export function emptyState(): CompanionState {
  return {
    version: STATE_VERSION,
    authorityEpoch: `authority_${crypto.randomUUID()}`,
    pairings: [],
    devices: [],
    services: [],
    leases: [],
    tombstones: [],
    operations: [],
    instances: [],
  }
}

export function assertPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new CompanionError('VALIDATION_ERROR', 'port must be an integer between 1 and 65535')
  }
  return value
}

export function assertTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_TTL_MS || value > MAX_LEASE_TTL_MS) {
    throw new CompanionError(
      'VALIDATION_ERROR',
      `ttlMs must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}`,
    )
  }
  return value
}

export function assertNonEmpty(value: string, field: string, maxLength = 200): string {
  if (typeof value !== 'string') throw new CompanionError('VALIDATION_ERROR', `${field} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) {
    throw new CompanionError('VALIDATION_ERROR', `${field} must contain 1-${maxLength} characters`)
  }
  return normalized
}

export function isLeaseExpired(lease: ForwardLease, nowMs: number): boolean {
  return !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= nowMs
}

export function isNeedsAttentionCode(code: string | undefined): boolean {
  return code === 'LOCAL_PORT_IN_USE'
    || code === 'SSH_AUTH_FAILED'
    || code === 'HOST_KEY_FAILED'
    || code === 'DEVICE_REVOKED'
    || code === 'POLICY_DENIED'
    || code === 'LEASE_EXPIRED'
}
