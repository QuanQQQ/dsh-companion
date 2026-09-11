export type Protocol = 'http' | 'https' | 'tcp'
export type InstanceState = 'starting' | 'running' | 'recovering' | 'needs_attention' | 'closed'

export interface DeviceDto {
  id: string
  name: string
  platform: 'macos'
  osVersion: string
  architecture: string
  companionVersion: string
  capabilities: { protocolVersion: 1; localForward: true; tcpProbe: boolean }
  createdAt: string
  updatedAt: string
  lastSeenAt?: string | undefined
  revokedAt?: string | undefined
  online: boolean
}

export interface ServiceDto {
  id: string
  name: string
  port: number
  protocol: Protocol
  source: 'manual' | 'agent' | 'process'
  evidence?: string | undefined
  createdAt: string
  updatedAt: string
}

export interface ForwardLeaseDto {
  id: string
  serviceId: string
  deviceId: string
  localHost: '127.0.0.1'
  localPort: number
  remoteHost: '127.0.0.1'
  remotePort: number
  desiredState: 'open' | 'closed'
  generation: number
  createdAt: string
  updatedAt: string
  expiresAt: string
  closedAt?: string | undefined
  closeReason?: string | undefined
}

export interface InstanceDto {
  leaseId: string
  deviceId: string
  generation: number
  state: InstanceState
  sshChild: 'unknown' | 'running' | 'exited'
  listener: 'unknown' | 'owned' | 'missing' | 'conflict'
  remoteProbe: 'unknown' | 'healthy' | 'failed' | 'disabled'
  processId?: number | undefined
  retryAttempt?: number | undefined
  retryAt?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  observedAt: string
}

export interface CompanionSnapshotDto {
  services: ServiceDto[]
  leases: ForwardLeaseDto[]
  instances: InstanceDto[]
  devices: DeviceDto[]
}

export async function getSnapshot(signal?: AbortSignal): Promise<CompanionSnapshotDto> {
  const payload = asRecord(await requestJson('/api/companion/snapshot', signal ? { signal } : {}))
  return payload.snapshot as CompanionSnapshotDto
}

export interface EnrollmentDto {
  requestId: string; userCode: string; name: string; osVersion: string; architecture: string;
  companionVersion: string; createdAt: string; expiresAt: string; status: string;
  deviceId?: string; errorCode?: string
}
export async function listEnrollments(): Promise<EnrollmentDto[]> {
  return asRecord(await requestJson('/api/companion/enrollments')).requests as EnrollmentDto[]
}
export async function approveEnrollment(id: string): Promise<void> {
  await requestJson('/api/companion/enrollments/'+encodeURIComponent(id)+'/approve',jsonPost({}))
}
export async function denyEnrollment(id: string): Promise<void> {
  await requestJson('/api/companion/enrollments/'+encodeURIComponent(id)+'/deny',jsonPost({}))
}
export async function getCompanionIdentity(): Promise<string> {
  return String(asRecord(await requestJson('/api/companion/identity')).authorityEpoch)
}

export async function listDevices(signal?: AbortSignal): Promise<DeviceDto[]> {
  const payload = asRecord(await requestJson('/api/companion/devices', signal ? { signal } : {}))
  return payload.devices as DeviceDto[]
}

export async function createPairingTicket(): Promise<{ id: string; code: string; expiresAt: string }> {
  const payload = asRecord(await requestJson('/api/companion/pairings', jsonPost({})))
  return payload.ticket as { id: string; code: string; expiresAt: string }
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await requestJson(`/api/companion/devices/${encodeURIComponent(deviceId)}/revoke`, jsonPost({}))
}

export async function registerService(input: { name: string; port: number; protocol: Protocol }): Promise<void> {
  await requestJson('/api/companion/services', jsonPost(input))
}

export async function unregisterService(serviceId: string): Promise<void> {
  await requestJson(`/api/companion/services/${encodeURIComponent(serviceId)}/unregister`, jsonPost({}))
}

export async function openLease(serviceId: string, deviceId: string, ttlMinutes: number): Promise<void> {
  await requestJson(
    `/api/companion/services/${encodeURIComponent(serviceId)}/leases`,
    jsonPost({ deviceId, ttlMs: ttlMinutes * 60_000 }),
  )
}

export async function leaseAction(leaseId: string, action: 'close' | 'restart' | 'recheck'): Promise<void> {
  await requestJson(`/api/companion/leases/${encodeURIComponent(leaseId)}/${action}`, jsonPost({}))
}

function jsonPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }
}

async function requestJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, { ...init, headers: { accept: 'application/json', ...init.headers } })
  const payload: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {}
    throw new Error(String(error.message ?? `请求失败 (${response.status})`))
  }
  return payload
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务返回内容无效')
  return value as Record<string, unknown>
}
