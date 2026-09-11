import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { emptyState, STATE_VERSION, type CompanionState } from './domain.js'

export interface CompanionStateStore {
  load(): Promise<CompanionState>
  save(state: CompanionState): Promise<void>
}

export class JsonCompanionStateStore implements CompanionStateStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<CompanionState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      const state = normalizeState(parsed)
      if ((parsed as { version?: unknown })?.version !== STATE_VERSION) await this.persist(state, false)
      return state
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.persist(emptyState(), true)
        return normalizeState(JSON.parse(await readFile(this.filePath, 'utf8')))
      }
      throw error
    }
  }

  async save(state: CompanionState): Promise<void> { await this.persist(state, false) }

  private async persist(state: CompanionState, initialize: boolean): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = this.filePath + '.' + randomUUID() + '.tmp'
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(state, null, 2) + '\n'); await file.sync() }
      finally { await file.close() }
      if (initialize) {
        // Publish a complete first authority once; concurrent initializers must not replace it.
        try { await link(temporary, this.filePath) }
        catch (error) { if (!isNodeError(error) || error.code !== 'EEXIST') throw error }
      } else await rename(temporary, this.filePath)
      const directory = await open(dirname(this.filePath), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally { await rm(temporary, { force: true }) }
  }
}

export class MemoryCompanionStateStore implements CompanionStateStore {
  private state: CompanionState

  constructor(initial: CompanionState = emptyState()) {
    this.state = structuredClone(initial)
  }

  async load(): Promise<CompanionState> {
    return structuredClone(this.state)
  }

  async save(state: CompanionState): Promise<void> {
    this.state = structuredClone(state)
  }
}

export function normalizeState(value: unknown): CompanionState {
  value = migrateTaskScopedState(value)
  const record = object(value, 'state')
  fields(record, ['version', 'authorityEpoch', 'pairings', 'devices', 'services', 'leases', 'tombstones', 'operations', 'instances'])
  if (record.version !== STATE_VERSION) throw new Error('unsupported Companion state version')
  text(record.authorityEpoch)
  const schemas: Record<string, Record<string, (value: unknown) => void>> = {
    pairings: { id: text, codeHash: hash, createdAt: date, expiresAt: date, consumedAt: optional(date) },
    devices: { id: text, installationIdHash: hash, tokenHash: hash, name: text, platform: oneOf('macos'), osVersion: text, architecture: text, companionVersion: text,
      capabilities: value => { const r = object(value, 'capabilities'); fields(r, ['protocolVersion', 'localForward', 'tcpProbe']); if (r.protocolVersion !== 1 || r.localForward !== true || typeof r.tcpProbe !== 'boolean') invalid() },
      createdAt: date, updatedAt: date, lastSeenAt: optional(date), revokedAt: optional(date) },
    services: { id: text, name: text, port, protocol, source: oneOf('manual', 'agent', 'process'), evidence: optional(longText), createdAt: date, updatedAt: date, archivedAt: optional(date) },
    leases: { id: text, serviceId: text, deviceId: text, localHost: oneOf('127.0.0.1'), remoteHost: oneOf('127.0.0.1'), localPort: port, remotePort: port,
      desiredState: oneOf('open', 'closed'), generation, createdAt: date, updatedAt: date, expiresAt: date, closedAt: optional(date), closeReason: optional(closeReason) },
    tombstones: { leaseId: text, deviceId: text, generation, reason: oneOf(...closeReasons, 'orphaned'), createdAt: date, updatedAt: date },
    operations: { id: text, leaseId: text, deviceId: text, generation, kind: oneOf('open', 'close'), createdAt: date, acknowledgedAt: optional(date), errorCode: optional(text), errorMessage: optional(longText),
      attemptCount: optional(value => integer(value, 0)), lastSentAt: optional(date), protocol: optional(protocol) },
    instances: { leaseId: text, deviceId: text, generation, state: oneOf('starting', 'running', 'recovering', 'needs_attention', 'closed'), sshChild: oneOf('unknown', 'running', 'exited'),
      listener: oneOf('unknown', 'owned', 'missing', 'conflict'), remoteProbe: oneOf('unknown', 'healthy', 'failed', 'disabled'), processId: optional(value => integer(value, 1)), retryAttempt: optional(value => integer(value, 0)),
      retryAt: optional(date), errorCode: optional(text), errorMessage: optional(longText), observedAt: date },
  }
  for (const [key, schema] of Object.entries(schemas)) {
    const rows = record[key]
    if (!Array.isArray(rows)) invalid()
    const ids = new Set<string>()
    for (const row of rows) {
      const r = object(row, key)
      fields(r, Object.keys(schema))
      for (const [field, validate] of Object.entries(schema)) validate(r[field])
      const id = String(r.id ?? r.leaseId)
      if (ids.has(id)) invalid()
      ids.add(id)
    }
  }
  const state = structuredClone(value) as CompanionState
  const devices = new Map(state.devices.map(item => [item.id, item]))
  const services = new Map(state.services.map(item => [item.id, item]))
  const leases = new Map(state.leases.map(item => [item.id, item]))
  const tokenHashes = new Set<string>()
  for (const device of state.devices) { if (tokenHashes.has(device.tokenHash)) invalid(); tokenHashes.add(device.tokenHash) }
  const activePorts = new Set<number>()
  for (const service of state.services) {
    if (!service.archivedAt) {
      if (activePorts.has(service.port)) invalid()
      activePorts.add(service.port)
    }
  }
  for (const lease of state.leases) {
    const service = services.get(lease.serviceId)
    if (!devices.has(lease.deviceId) || !service || service.port !== lease.localPort || lease.localPort !== lease.remotePort) invalid()
    if (Date.parse(lease.expiresAt) <= Date.parse(lease.createdAt)) invalid()
    if (lease.desiredState === 'closed' && (!lease.closedAt || !lease.closeReason || !state.tombstones.some(item => item.leaseId === lease.id && item.deviceId === lease.deviceId && item.generation === lease.generation))) invalid()
    if (lease.desiredState === 'open' && lease.generation > 1 && !state.operations.some(item => item.leaseId === lease.id && item.deviceId === lease.deviceId && item.kind === 'close' && item.generation === lease.generation - 1)) invalid()
    if (lease.desiredState === 'open' && (lease.closedAt || lease.closeReason || service.archivedAt || devices.get(lease.deviceId)?.revokedAt)) invalid()
  }
  for (const tombstone of state.tombstones) {
    const lease = leases.get(tombstone.leaseId)
    if (!devices.has(tombstone.deviceId) || (lease && (lease.deviceId !== tombstone.deviceId || tombstone.generation > lease.generation))) invalid()
  }
  for (const operation of state.operations) {
    const lease = leases.get(operation.leaseId)
    const tombstone = state.tombstones.find(item => item.leaseId === operation.leaseId && item.deviceId === operation.deviceId)
    if (!devices.has(operation.deviceId) || (lease && (lease.deviceId !== operation.deviceId || operation.generation > lease.generation))) invalid()
    if (!lease && (operation.kind !== 'close' || !tombstone || operation.generation > tombstone.generation)) invalid()
    if (operation.errorCode && !operation.acknowledgedAt) invalid()
    if (((operation.attemptCount ?? 0) > 0) !== !!operation.lastSentAt) invalid()
  }
  for (const instance of state.instances) {
    const lease = leases.get(instance.leaseId)
    if (!lease || lease.deviceId !== instance.deviceId || instance.generation > lease.generation) invalid()
  }
  return state
}

/** Collapse the v1 per-Task declarations into one Host-global declaration per port. */
function migrateTaskScopedState(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { version?: unknown }).version !== 1) return value
  const legacy = structuredClone(value) as Record<string, unknown>
  if (!Array.isArray(legacy.services) || !Array.isArray(legacy.leases)) invalid()
  const groups = new Map<number, Record<string, unknown>[]>()
  for (const candidate of legacy.services) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) invalid()
    const row = candidate as Record<string, unknown>
    if (!Number.isSafeInteger(row.port)) invalid()
    const group = groups.get(row.port as number) ?? []
    group.push(row)
    groups.set(row.port as number, group)
  }
  const serviceIds = new Map<string, string>()
  const services: Record<string, unknown>[] = []
  for (const rows of groups.values()) {
    const active = rows.filter(row => row.archivedAt === undefined)
    const candidates = active.length ? active : rows
    const canonical = candidates.reduce((latest, row) => String(row.updatedAt) >= String(latest.updatedAt) ? row : latest)
    const migrated = { ...canonical }
    delete migrated.taskId
    migrated.createdAt = rows.map(row => String(row.createdAt)).sort()[0]
    migrated.updatedAt = rows.map(row => String(row.updatedAt)).sort().at(-1)
    if (active.length) delete migrated.archivedAt
    services.push(migrated)
    for (const row of rows) serviceIds.set(String(row.id), String(canonical.id))
  }
  const leases = legacy.leases.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) invalid()
    const migrated = { ...(candidate as Record<string, unknown>) }
    delete migrated.taskId
    migrated.serviceId = serviceIds.get(String(migrated.serviceId)) ?? migrated.serviceId
    return migrated
  })
  return { ...legacy, version: STATE_VERSION, services, leases }
}

function invalid(): never { throw new Error('invalid Companion state document') }
function object(value: unknown, _field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function fields(record: Record<string, unknown>, allowed: string[]): void { if (Object.keys(record).some(key => !allowed.includes(key))) invalid() }
function text(value: unknown): void { if (typeof value !== 'string' || !value.trim() || value.length > 200) invalid() }
function longText(value: unknown): void { if (typeof value !== 'string' || value.length > 2_000) invalid() }
function hash(value: unknown): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid() }
function date(value: unknown): void { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid() }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER - 4): void { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid() }
function generation(value: unknown): void { integer(value, 1) }
function port(value: unknown): void { integer(value, 1, 65535) }
function optional(validate: (value: unknown) => void): (value: unknown) => void { return value => { if (value !== undefined) validate(value) } }
function oneOf(...values: string[]): (value: unknown) => void { return value => { if (!values.includes(value as string)) invalid() } }
const protocol = oneOf('http', 'https', 'tcp')
const closeReasons = ['user', 'expired', 'device_revoked', 'task_archived', 'service_archived', 'reconciliation_conflict']
const closeReason = oneOf(...closeReasons)

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
