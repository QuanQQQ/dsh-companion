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

export interface TaskServiceDto {
  id: string
  taskId: string
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
  taskId: string
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

export interface TaskSnapshotDto {
  taskId: string
  services: TaskServiceDto[]
  leases: ForwardLeaseDto[]
  instances: InstanceDto[]
  devices: DeviceDto[]
}

export interface TaskSummaryDto {
  id: string
  title: string
  objective: string
  status: string
  workspacePath: string
}

export async function listTasks(signal?: AbortSignal): Promise<TaskSummaryDto[]> {
  const payload = await requestJson('/api/task-workspace/tasks', signal ? { signal } : {})
  const record = asRecord(payload)
  const tasks = record.tasks ?? record.data
  if (!Array.isArray(tasks)) throw new Error('Task Workspace 返回内容无效')
  return tasks.map(value => {
    const task = asRecord(value)
    return {
      id: String(task.id ?? ''),
      title: String(task.title ?? task.id ?? ''),
      objective: String(task.objective ?? ''),
      status: String(task.status ?? ''),
      workspacePath: String(task.workspacePath ?? task.workspace_path ?? ''),
    }
  })
}

export async function getTaskSnapshot(taskId: string, signal?: AbortSignal): Promise<TaskSnapshotDto> {
  const payload = asRecord(await requestJson(`/api/companion/tasks/${encodeURIComponent(taskId)}`, signal ? { signal } : {}))
  return payload.snapshot as TaskSnapshotDto
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

export async function registerService(
  taskId: string,
  input: { name: string; port: number; protocol: Protocol },
): Promise<void> {
  await requestJson(`/api/companion/tasks/${encodeURIComponent(taskId)}/services`, jsonPost(input))
}

export async function unregisterService(taskId: string, serviceId: string): Promise<void> {
  await requestJson(`/api/companion/tasks/${encodeURIComponent(taskId)}/services/${encodeURIComponent(serviceId)}/unregister`, jsonPost({}))
}

export async function openLease(taskId: string, serviceId: string, deviceId: string, ttlMinutes: number): Promise<void> {
  await requestJson(
    `/api/companion/tasks/${encodeURIComponent(taskId)}/services/${encodeURIComponent(serviceId)}/leases`,
    jsonPost({ deviceId, ttlMs: ttlMinutes * 60_000 }),
  )
}

export async function leaseAction(leaseId: string, action: 'close' | 'restart' | 'recheck'): Promise<void> {
  await requestJson(`/api/companion/leases/${encodeURIComponent(leaseId)}/${action}`, jsonPost({}))
}

export function matchTask(tasks: readonly TaskSummaryDto[], cwd: string | undefined): TaskSummaryDto | undefined {
  const current = normalizePath(cwd)
  if (!current) return undefined
  return [...tasks]
    .filter(task => {
      const workspace = normalizePath(task.workspacePath)
      return workspace !== '' && (current === workspace || current.startsWith(`${workspace}/`))
    })
    .sort((left, right) => normalizePath(right.workspacePath).length - normalizePath(left.workspacePath).length)[0]
}

function normalizePath(value: string | undefined): string {
  const normalized = (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || (value?.startsWith('/') ? '/' : '')
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
