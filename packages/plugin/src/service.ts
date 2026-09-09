import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  CompanionError,
  DEFAULT_LEASE_TTL_MS,
  LOOPBACK_HOST,
  assertNonEmpty,
  assertPort,
  assertTtl,
  isLeaseExpired,
  isNeedsAttentionCode,
  type ApplicationProtocol,
  type CloseReason,
  type CompanionState,
  type Device,
  type DeviceCapabilities,
  type ForwardInstanceObservation,
  type ForwardLease,
  type ForwardOperation,
  type PublicDevice,
  type TaskService,
  type TaskServiceSource,
  type TaskSnapshot,
} from './domain.js'
import { normalizeState, type CompanionStateStore } from './store.js'

export const MAX_OPERATION_ATTEMPTS = 3
export const OPERATION_RETRY_MS = 15_000

export interface CompanionClock {
  now(): number
}

export interface CompanionIds {
  randomId(prefix: string): string
  randomSecret(prefix: string): string
}

export interface PairDeviceInput {
  /** Browser enrollment never rotates an existing installation or inherits its leases. */
  rejectExistingInstallation?: boolean
  code: string
  installationId: string
  name: string
  osVersion: string
  architecture: string
  companionVersion: string
  capabilities: DeviceCapabilities
}

export interface RegisterTaskServiceInput {
  taskId: string
  name: string
  port: number
  protocol: ApplicationProtocol
  source: TaskServiceSource
  evidence?: string | undefined
}

export interface OpenLeaseInput {
  taskId: string
  serviceId: string
  deviceId: string
  ttlMs?: number | undefined
}

export interface ObserveInstanceInput extends Omit<ForwardInstanceObservation, 'observedAt'> {
  observedAt?: string | undefined
}

export interface PairingResult {
  device: PublicDevice
  token: string
  authorityEpoch: string
}

export interface PairingTicketResult {
  id: string
  code: string
  expiresAt: string
}

const systemClock: CompanionClock = { now: () => Date.now() }
const systemIds: CompanionIds = {
  randomId: prefix => `${prefix}_${randomUUID()}`,
  randomSecret: prefix => `${prefix}_${randomBytes(24).toString('base64url')}`,
}

export class CompanionService {
  private state: CompanionState
  private tail: Promise<void> = Promise.resolve()
  private readonly onlineDevices = new Set<string>()
  private readonly listeners = new Set<() => void>()

  private constructor(
    private readonly store: CompanionStateStore,
    state: CompanionState,
    private readonly clock: CompanionClock,
    private readonly ids: CompanionIds,
  ) {
    this.state = state
  }

  static async create(
    store: CompanionStateStore,
    options: { clock?: CompanionClock; ids?: CompanionIds } = {},
  ): Promise<CompanionService> {
    return new CompanionService(
      store,
      normalizeState(await store.load()),
      options.clock ?? systemClock,
      options.ids ?? systemIds,
    )
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get authorityEpoch(): string { return this.state.authorityEpoch }

  snapshot(): CompanionState {
    return structuredClone(this.state)
  }

  listDevices(): PublicDevice[] {
    return this.state.devices.map(device => this.publicDevice(device))
  }

  listTask(taskId: string): TaskSnapshot {
    const normalizedTaskId = assertNonEmpty(taskId, 'taskId')
    const services = this.state.services.filter(service => service.taskId === normalizedTaskId && !service.archivedAt)
    // Archived services still need observable close delivery and recovery diagnostics.
    const leases = this.state.leases.filter(lease => lease.taskId === normalizedTaskId)
    const leaseIds = new Set(leases.map(lease => lease.id))
    return {
      taskId: normalizedTaskId,
      services: structuredClone(services),
      leases: structuredClone(leases),
      instances: structuredClone(this.state.instances.filter(instance => leaseIds.has(instance.leaseId))),
      devices: this.listDevices(),
    }
  }

  async createPairingTicket(ttlMs = 10 * 60 * 1_000): Promise<PairingTicketResult> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 60 * 1_000) {
      throw new CompanionError('VALIDATION_ERROR', 'pairing ticket ttl must be between 1 and 30 minutes')
    }
    const now = this.clock.now()
    const code = this.ids.randomSecret('dshp')
    const ticket = {
      id: this.ids.randomId('pair'),
      codeHash: hashSecret(code),
      createdAt: iso(now),
      expiresAt: iso(now + ttlMs),
    }
    await this.transact(state => {
      state.pairings = state.pairings.filter(item => Date.parse(item.expiresAt) > now - 24 * 60 * 60 * 1_000)
      state.pairings.push(ticket)
    })
    return { id: ticket.id, code, expiresAt: ticket.expiresAt }
  }

  async pairDevice(input: PairDeviceInput): Promise<PairingResult> {
    const codeHash = hashSecret(assertNonEmpty(input.code, 'code', 256))
    const now = this.clock.now()
    const installationIdHash = hashSecret(assertNonEmpty(input.installationId, 'installationId', 256))
    const token = this.ids.randomSecret('dsht')
    let paired!: Device
    await this.transact(state => {
      const ticket = state.pairings.find(item => safeHashEqual(item.codeHash, codeHash))
      if (!ticket) throw new CompanionError('PAIRING_CODE_INVALID', 'pairing code is invalid', 401)
      if (ticket.consumedAt) throw new CompanionError('PAIRING_CODE_USED', 'pairing code has already been used', 409)
      if (Date.parse(ticket.expiresAt) <= now) throw new CompanionError('PAIRING_CODE_EXPIRED', 'pairing code has expired', 410)
      ticket.consumedAt = iso(now)

      if (input.rejectExistingInstallation && state.devices.some(device => device.installationIdHash === installationIdHash)) {
        throw new CompanionError('INSTALLATION_EXISTS', 'enrollment requires a fresh installation identity', 409)
      }
      const existing = state.devices.find(device => device.installationIdHash === installationIdHash && !device.revokedAt)
      const common = {
        installationIdHash,
        tokenHash: hashSecret(token),
        name: assertNonEmpty(input.name, 'name'),
        platform: 'macos' as const,
        osVersion: assertNonEmpty(input.osVersion, 'osVersion'),
        architecture: assertNonEmpty(input.architecture, 'architecture'),
        companionVersion: assertNonEmpty(input.companionVersion, 'companionVersion'),
        capabilities: validateCapabilities(input.capabilities),
        updatedAt: iso(now),
      }
      if (existing) {
        Object.assign(existing, common)
        paired = existing
      } else {
        paired = { id: this.ids.randomId('dev'), createdAt: iso(now), ...common }
        state.devices.push(paired)
      }
    })
    return { device: this.publicDevice(paired), token, authorityEpoch: this.state.authorityEpoch }
  }

  authenticateDevice(token: string): PublicDevice {
    const tokenHash = hashSecret(assertNonEmpty(token, 'token', 256))
    const device = this.state.devices.find(item => safeHashEqual(item.tokenHash, tokenHash))
    if (!device) throw new CompanionError('UNAUTHORIZED', 'device token is invalid', 401)
    if (device.revokedAt) throw new CompanionError('DEVICE_REVOKED', 'device pairing was revoked', 403)
    return this.publicDevice(device)
  }

  async markDeviceConnected(deviceId: string): Promise<void> {
    const now = this.clock.now()
    await this.transact(state => {
      const device = requireDevice(state, deviceId)
      if (device.revokedAt) throw new CompanionError('DEVICE_REVOKED', 'device pairing was revoked', 403)
      device.lastSeenAt = iso(now)
      device.updatedAt = iso(now)
    })
    this.onlineDevices.add(deviceId)
    this.emit()
  }

  async markDeviceDisconnected(deviceId: string): Promise<void> {
    this.onlineDevices.delete(deviceId)
    const now = this.clock.now()
    await this.transact(state => {
      const device = state.devices.find(item => item.id === deviceId)
      if (device) {
        device.lastSeenAt = iso(now)
        device.updatedAt = iso(now)
      }
    })
  }

  async revokeDevice(deviceId: string): Promise<PublicDevice> {
    const now = this.clock.now()
    let revoked!: Device
    await this.transact(state => {
      revoked = requireDevice(state, deviceId)
      if (!revoked.revokedAt) {
        revoked.revokedAt = iso(now)
        revoked.updatedAt = iso(now)
        for (const lease of state.leases) {
          if (lease.deviceId === deviceId && lease.desiredState === 'open') {
            closeLeaseInState(state, lease, 'device_revoked', now, this.ids)
          }
        }
      }
    })
    this.onlineDevices.delete(deviceId)
    return this.publicDevice(revoked)
  }

  async registerTaskService(input: RegisterTaskServiceInput): Promise<TaskService> {
    const taskId = assertNonEmpty(input.taskId, 'taskId')
    const name = assertNonEmpty(input.name, 'name')
    const port = assertPort(input.port)
    const protocol = validateProtocol(input.protocol)
    const source = validateSource(input.source)
    const evidence = input.evidence?.trim().slice(0, 2_000) || undefined
    const now = this.clock.now()
    let result!: TaskService
    await this.transact(state => {
      const existing = state.services.find(service => service.taskId === taskId && service.port === port && !service.archivedAt)
      if (existing) {
        existing.name = name
        existing.protocol = protocol
        existing.source = source
        existing.evidence = evidence
        existing.updatedAt = iso(now)
        result = existing
      } else {
        result = {
          id: this.ids.randomId('svc'),
          taskId,
          name,
          port,
          protocol,
          source,
          evidence,
          createdAt: iso(now),
          updatedAt: iso(now),
        }
        state.services.push(result)
      }
    })
    return structuredClone(result)
  }

  async unregisterTaskService(taskId: string, serviceId: string): Promise<TaskService> {
    const normalizedTaskId = assertNonEmpty(taskId, 'taskId')
    let result!: TaskService
    await this.transact(state => {
      const service = requireService(state, serviceId)
      if (service.taskId !== normalizedTaskId) throw new CompanionError('NOT_FOUND', 'Task Service does not belong to the requested Task', 404)
      const now = this.clock.now()
      if (!service.archivedAt) {
        service.archivedAt = iso(now)
        service.updatedAt = iso(now)
      }
      for (const lease of state.leases) {
        if (lease.serviceId === service.id && lease.desiredState === 'open') {
          closeLeaseInState(state, lease, 'service_archived', now, this.ids)
        }
      }
      result = service
    })
    return structuredClone(result)
  }

  async openLease(input: OpenLeaseInput): Promise<ForwardLease> {
    const ttlMs = assertTtl(input.ttlMs ?? DEFAULT_LEASE_TTL_MS)
    const now = this.clock.now()
    let result!: ForwardLease
    await this.transact(state => {
      const service = requireService(state, input.serviceId)
      if (service.taskId !== input.taskId || service.archivedAt) {
        throw new CompanionError('NOT_FOUND', 'Task Service does not belong to the requested Task', 404)
      }
      const device = requireDevice(state, input.deviceId)
      if (device.revokedAt) throw new CompanionError('DEVICE_REVOKED', 'device pairing was revoked', 403)

      const existing = newestLease(state, service.id, device.id)
      if (existing?.desiredState === 'open' && !isLeaseExpired(existing, now)) {
        result = existing
        return
      }
      const portOwner = state.leases.find(lease => lease.deviceId === device.id
        && lease.desiredState === 'open'
        && !isLeaseExpired(lease, now)
        && lease.localPort === service.port
        && lease.serviceId !== service.id)
      if (portOwner) {
        throw new CompanionError('LOCAL_PORT_IN_USE', `Device port ${service.port} is already leased`, 409)
      }

      result = {
        id: this.ids.randomId('lease'),
        taskId: service.taskId,
        serviceId: service.id,
        deviceId: device.id,
        localHost: LOOPBACK_HOST,
        localPort: service.port,
        remoteHost: LOOPBACK_HOST,
        remotePort: service.port,
        desiredState: 'open',
        generation: 1,
        createdAt: iso(now),
        updatedAt: iso(now),
        expiresAt: iso(now + ttlMs),
      }
      state.leases.push(result)
      state.operations.push({ ...makeOperation(result, 'open', now, this.ids), protocol: service.protocol })
    })
    return structuredClone(result)
  }

  async closeLease(leaseId: string, reason: CloseReason = 'user', taskId?: string): Promise<ForwardLease> {
    const now = this.clock.now()
    let result!: ForwardLease
    await this.transact(state => {
      const lease = requireLease(state, leaseId)
      if (taskId !== undefined && lease.taskId !== taskId) throw new CompanionError('NOT_FOUND', 'Forward Lease does not belong to the current Task', 404)
      if (lease.desiredState === 'open') closeLeaseInState(state, lease, reason, now, this.ids)
      result = lease
    })
    return structuredClone(result)
  }

  async restartLease(leaseId: string): Promise<ForwardLease> {
    const now = this.clock.now()
    let result!: ForwardLease
    await this.transact(state => {
      const lease = requireLease(state, leaseId)
      const device = requireDevice(state, lease.deviceId)
      if (device.revokedAt) throw new CompanionError('DEVICE_REVOKED', 'device pairing was revoked', 403)
      if (lease.desiredState !== 'open') throw new CompanionError('LEASE_CLOSED', 'closed Lease cannot be restarted', 409)
      if (isLeaseExpired(lease, now)) throw new CompanionError('LEASE_EXPIRED', 'expired Lease cannot be restarted', 410)

      supersedePendingOperations(state, lease.id, now)
      const closeGeneration = lease.generation + 1
      state.operations.push(makeOperation({ ...lease, generation: closeGeneration }, 'close', now, this.ids))
      lease.generation = closeGeneration + 1
      lease.updatedAt = iso(now)
      state.operations.push({ ...makeOperation(lease, 'open', now, this.ids), protocol: requireService(state, lease.serviceId).protocol })
      result = lease
    })
    return structuredClone(result)
  }

  async recheckLease(leaseId: string): Promise<ForwardLease> {
    const now = this.clock.now()
    let result!: ForwardLease
    await this.transact(state => {
      const lease = requireLease(state, leaseId)
      if (lease.desiredState === 'open' && isLeaseExpired(lease, now)) {
        closeLeaseInState(state, lease, 'expired', now, this.ids)
      } else {
        const barrier = state.operations.filter(item => item.leaseId === lease.id && item.kind === 'close' && item.generation === lease.generation - 1).at(-1)
        if (lease.desiredState === 'open' && barrier && (!barrier.acknowledgedAt || barrier.errorCode)) {
          queueOperationIfMissing(state, lease.id, lease.deviceId, barrier.generation, 'close', now, this.ids, true)
        }
        queueOperationIfMissing(
          state,
          lease.id,
          lease.deviceId,
          lease.generation,
          lease.desiredState === 'open' ? 'open' : 'close',
          now,
          this.ids,
          true,
        )
      }
      result = lease
    })
    return structuredClone(result)
  }

  async expireLeases(): Promise<number> {
    const now = this.clock.now()
    let count = 0
    await this.transact(state => {
      for (const lease of state.leases) {
        if (lease.desiredState === 'open' && isLeaseExpired(lease, now)) {
          closeLeaseInState(state, lease, 'expired', now, this.ids)
          count += 1
        }
      }
    })
    return count
  }

  async reconcileActiveTasks(activeTaskIds: ReadonlySet<string>): Promise<number> {
    const now = this.clock.now()
    let count = 0
    await this.transact(state => {
      for (const lease of state.leases) {
        if (lease.desiredState === 'open' && !activeTaskIds.has(lease.taskId)) {
          closeLeaseInState(state, lease, 'task_archived', now, this.ids)
          count += 1
        }
      }
    }, activeTaskIds.size === 0 && this.state.leases.length === 0)
    return count
  }

  pendingOperations(deviceId: string): ForwardOperation[] {
    return structuredClone(this.state.operations
      .filter(operation => operation.deviceId === deviceId && isDispatchable(this.state, operation, this.clock.now()))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)))
  }

  /** Persist the send budget before transport delivery. A crash may consume an attempt, never reset it. */
  async claimOperation(deviceId: string, operationId: string): Promise<ForwardOperation | undefined> {
    return this.transact(state => {
      const now = this.clock.now()
      const operation = state.operations.find(item => item.id === operationId && item.deviceId === deviceId)
      if (!operation || !isDispatchable(state, operation, now)) return undefined
      if (operation.lastSentAt && now - Date.parse(operation.lastSentAt) < OPERATION_RETRY_MS) return undefined
      if ((operation.attemptCount ?? 0) >= MAX_OPERATION_ATTEMPTS) {
        operation.acknowledgedAt = iso(now)
        operation.errorCode = 'DELIVERY_EXHAUSTED'
        operation.errorMessage = 'Delivery budget exhausted; explicit recheck or restart required'
        recordOperationFailure(state, operation, now)
        return undefined
      }
      operation.attemptCount = (operation.attemptCount ?? 0) + 1
      operation.lastSentAt = iso(now)
      if (operation.kind === 'open' && !operation.protocol) {
        const lease = requireLease(state, operation.leaseId)
        operation.protocol = requireService(state, lease.serviceId).protocol
      }
      return structuredClone(operation)
    })
  }

  desiredLeases(deviceId: string): ForwardLease[] {
    return structuredClone(this.state.leases.filter(lease => lease.deviceId === deviceId))
  }

  async reconcileDeviceReport(deviceId: string, reports: ObserveInstanceInput[]): Promise<number> {
    if (reports.length > 1_000) throw new CompanionError('VALIDATION_ERROR', 'Device report is too large')
    const now = this.clock.now()
    let queued = 0
    await this.transact(state => {
      const device = requireDevice(state, deviceId)
      if (device.revokedAt) throw new CompanionError('DEVICE_REVOKED', 'device pairing was revoked', 403)
      for (const lease of state.leases) {
        if (lease.deviceId === deviceId && lease.desiredState === 'open' && isLeaseExpired(lease, now)) closeLeaseInState(state, lease, 'expired', now, this.ids)
      }
      const byLease = new Map<string, ObserveInstanceInput>()
      for (const report of reports) {
        if (report.deviceId !== deviceId) {
          throw new CompanionError('UNAUTHORIZED', 'instance observation belongs to another Device', 403)
        }
        if (!Number.isSafeInteger(report.generation) || report.generation < 1 || report.generation >= Number.MAX_SAFE_INTEGER - 2) {
          throw new CompanionError('VALIDATION_ERROR', 'instance generation must be a positive integer')
        }
        if (byLease.has(report.leaseId)) {
          throw new CompanionError('VALIDATION_ERROR', 'Device report contains duplicate Lease ids')
        }
        byLease.set(report.leaseId, report)
      }

      for (const report of reports) {
        const lease = state.leases.find(item => item.id === report.leaseId && item.deviceId === deviceId)
        if (!lease) {
          if (state.leases.some(item => item.id === report.leaseId)) throw new CompanionError('UNAUTHORIZED', 'Lease belongs to another Device', 403)
          const old = state.tombstones.find(item => item.leaseId === report.leaseId && item.deviceId === deviceId)
          const generation = Math.max(report.generation + 1, old?.generation ?? 1)
          ensureTombstone(state, report.leaseId, deviceId, generation, 'orphaned', now)
          if (queueOperationIfMissing(state, report.leaseId, deviceId, generation, 'close', now, this.ids)) queued += 1
          continue
        }
        if (report.generation > lease.generation) {
          // A Device state ahead of the Host is ambiguous. Regain authority only by closing above it.
          lease.generation = report.generation
          closeLeaseInState(state, lease, 'reconciliation_conflict', now, this.ids)
          queued += 1
          continue
        }
        if (report.generation === lease.generation) {
          const observation: ForwardInstanceObservation = {
            ...report,
            state: isNeedsAttentionCode(report.errorCode) ? 'needs_attention' : report.state,
            observedAt: report.observedAt ?? iso(now),
          }
          const index = state.instances.findIndex(instance => instance.leaseId === lease.id)
          if (index >= 0) state.instances[index] = observation
          else state.instances.push(observation)
        }
      }

      for (const lease of state.leases.filter(item => item.deviceId === deviceId)) {
        const report = byLease.get(lease.id)
        if (lease.desiredState === 'open' && !isLeaseExpired(lease, now)) {
          const converged = report?.generation === lease.generation && ['running', 'starting', 'recovering'].includes(report.state)
          const observed = state.instances.find(item => item.leaseId === lease.id && item.generation === lease.generation)
          const attention = observed?.state === 'needs_attention' || isNeedsAttentionCode(observed?.errorCode)
          if (!converged && !attention && queueOperationIfMissing(state, lease.id, deviceId, lease.generation, 'open', now, this.ids)) queued += 1
        } else if (report && report.state !== 'closed') {
          if (queueOperationIfMissing(state, lease.id, deviceId, lease.generation, 'close', now, this.ids)) queued += 1
        }
      }
      device.lastSeenAt = iso(now)
      device.updatedAt = iso(now)
    })
    return queued
  }

  async acknowledgeOperation(
    deviceId: string,
    operationId: string,
    result: { ok: boolean; errorCode?: string | undefined; errorMessage?: string | undefined },
  ): Promise<ForwardOperation> {
    const now = this.clock.now()
    let acknowledged!: ForwardOperation
    await this.transact(state => {
      acknowledged = state.operations.find(operation => operation.id === operationId && operation.deviceId === deviceId)
        ?? (() => { throw new CompanionError('NOT_FOUND', 'forward operation not found', 404) })()
      if (!acknowledged.acknowledgedAt) {
        acknowledged.acknowledgedAt = iso(now)
        acknowledged.errorCode = result.ok ? undefined : assertNonEmpty(result.errorCode ?? 'UNKNOWN', 'errorCode')
        acknowledged.errorMessage = result.ok ? undefined : (result.errorMessage?.trim().slice(0, 1_000) || 'operation failed')
        if (!result.ok) recordOperationFailure(state, acknowledged, now)
      }
    })
    return structuredClone(acknowledged)
  }

  async observeInstance(deviceId: string, input: ObserveInstanceInput): Promise<boolean> {
    const now = this.clock.now()
    let accepted = false
    await this.transact(state => {
      const lease = requireLease(state, input.leaseId)
      if (lease.deviceId !== deviceId || input.deviceId !== deviceId) {
        throw new CompanionError('UNAUTHORIZED', 'instance observation belongs to another Device', 403)
      }
      if (input.generation < lease.generation) return
      if (input.generation > lease.generation) {
        throw new CompanionError('GENERATION_MISMATCH', 'instance observation is ahead of Host generation', 409)
      }
      const observation: ForwardInstanceObservation = {
        ...input,
        state: isNeedsAttentionCode(input.errorCode) ? 'needs_attention' : input.state,
        observedAt: input.observedAt ?? iso(now),
      }
      const index = state.instances.findIndex(instance => instance.leaseId === lease.id)
      if (index >= 0) state.instances[index] = observation
      else state.instances.push(observation)
      const device = requireDevice(state, deviceId)
      device.lastSeenAt = iso(now)
      device.updatedAt = iso(now)
      accepted = true
    }, false)
    return accepted
  }

  private publicDevice(device: Device): PublicDevice {
    const { installationIdHash: _installationIdHash, tokenHash: _tokenHash, ...publicFields } = device
    return { ...structuredClone(publicFields), online: this.onlineDevices.has(device.id) }
  }

  private transact<T>(mutator: (state: CompanionState) => T, skipSave = false): Promise<T> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.state)
      const result = mutator(draft)
      normalizeState(draft)
      if (!skipSave) await this.store.save(draft)
      this.state = draft
      if (!skipSave) this.emit()
      return result
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function validateCapabilities(value: DeviceCapabilities): DeviceCapabilities {
  if (value?.protocolVersion !== 1 || value.localForward !== true || typeof value.tcpProbe !== 'boolean') {
    throw new CompanionError('VALIDATION_ERROR', 'unsupported Device capabilities')
  }
  return structuredClone(value)
}

function validateProtocol(value: ApplicationProtocol): ApplicationProtocol {
  if (value !== 'http' && value !== 'https' && value !== 'tcp') {
    throw new CompanionError('VALIDATION_ERROR', 'unsupported application protocol')
  }
  return value
}

function validateSource(value: TaskServiceSource): TaskServiceSource {
  if (value !== 'manual' && value !== 'agent' && value !== 'process') {
    throw new CompanionError('VALIDATION_ERROR', 'unsupported Task Service source')
  }
  return value
}

function requireDevice(state: CompanionState, deviceId: string): Device {
  return state.devices.find(device => device.id === deviceId)
    ?? (() => { throw new CompanionError('DEVICE_NOT_PAIRED', 'Device is not paired', 404) })()
}

function requireService(state: CompanionState, serviceId: string): TaskService {
  return state.services.find(service => service.id === serviceId)
    ?? (() => { throw new CompanionError('NOT_FOUND', 'Task Service not found', 404) })()
}

function requireLease(state: CompanionState, leaseId: string): ForwardLease {
  return state.leases.find(lease => lease.id === leaseId)
    ?? (() => { throw new CompanionError('NOT_FOUND', 'Forward Lease not found', 404) })()
}

function newestLease(state: CompanionState, serviceId: string, deviceId: string): ForwardLease | undefined {
  return state.leases.filter(lease => lease.serviceId === serviceId && lease.deviceId === deviceId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}

function closeLeaseInState(
  state: CompanionState,
  lease: ForwardLease,
  reason: CloseReason,
  now: number,
  ids: CompanionIds,
): void {
  supersedePendingOperations(state, lease.id, now)
  lease.desiredState = 'closed'
  lease.generation += 1
  lease.updatedAt = iso(now)
  lease.closedAt = iso(now)
  lease.closeReason = reason
  ensureTombstone(state, lease.id, lease.deviceId, lease.generation, reason, now)
  state.operations.push(makeOperation(lease, 'close', now, ids))
}

function ensureTombstone(
  state: CompanionState,
  leaseId: string,
  deviceId: string,
  generation: number,
  reason: CloseReason | 'orphaned',
  now: number,
): void {
  const existing = state.tombstones.find(item => item.leaseId === leaseId && item.deviceId === deviceId)
  if (existing) {
    if (generation > existing.generation) existing.generation = generation
    existing.reason = reason
    existing.updatedAt = iso(now)
  } else {
    state.tombstones.push({ leaseId, deviceId, generation, reason, createdAt: iso(now), updatedAt: iso(now) })
  }
}

function supersedePendingOperations(state: CompanionState, leaseId: string, now: number): void {
  for (const operation of state.operations) {
    if (operation.leaseId === leaseId && !operation.acknowledgedAt) {
      operation.acknowledgedAt = iso(now)
      operation.errorCode = 'SUPERSEDED'
      operation.errorMessage = 'A newer Desired State generation superseded this operation'
    }
  }
}

function queueOperationIfMissing(
  state: CompanionState,
  leaseId: string,
  deviceId: string,
  generation: number,
  kind: 'open' | 'close',
  now: number,
  ids: CompanionIds,
  explicit = false,
): boolean {
  const latest = state.operations.filter(operation => operation.leaseId === leaseId
    && operation.deviceId === deviceId && operation.generation === generation && operation.kind === kind).at(-1)
  if (latest && (!latest.acknowledgedAt || (!explicit && !!latest.errorCode))) return false
  const operation = makeOperation({ id: leaseId, deviceId, generation }, kind, now, ids)
  if (kind === 'open') operation.protocol = requireService(state, requireLease(state, leaseId).serviceId).protocol
  state.operations.push(operation)
  return true
}

function makeOperation(
  lease: Pick<ForwardLease, 'id' | 'deviceId' | 'generation'>,
  kind: 'open' | 'close',
  now: number,
  ids: CompanionIds,
): ForwardOperation {
  return {
    id: ids.randomId('op'),
    leaseId: lease.id,
    deviceId: lease.deviceId,
    generation: lease.generation,
    kind,
    createdAt: iso(now),
  }
}

function recordOperationFailure(state: CompanionState, operation: ForwardOperation, now: number): void {
  const lease = state.leases.find(item => item.id === operation.leaseId && item.deviceId === operation.deviceId)
  if (!lease || (operation.generation !== lease.generation && !(operation.kind === 'close' && operation.generation === lease.generation - 1))) return
  const observation: ForwardInstanceObservation = { leaseId: lease.id, deviceId: lease.deviceId, generation: lease.generation,
    state: 'needs_attention', sshChild: 'unknown', listener: 'unknown', remoteProbe: 'unknown', observedAt: iso(now),
    errorCode: operation.errorCode, errorMessage: operation.errorMessage }
  const index = state.instances.findIndex(item => item.leaseId === lease.id)
  if (index >= 0) state.instances[index] = observation
  else state.instances.push(observation)
}

function isDispatchable(state: CompanionState, operation: ForwardOperation, now: number): boolean {
  if (operation.acknowledgedAt) return false
  if (operation.kind === 'close') return true
  const lease = state.leases.find(item => item.id === operation.leaseId && item.deviceId === operation.deviceId)
  if (!lease || lease.desiredState !== 'open' || lease.generation !== operation.generation || isLeaseExpired(lease, now)) return false
  if (state.devices.find(item => item.id === lease.deviceId)?.revokedAt) return false
  if (requireService(state, lease.serviceId).archivedAt) return false
  // Restart opens depend on a successful close ACK, not merely dispatch or a snapshot.
  const close = state.operations.filter(item => item.leaseId === lease.id && item.deviceId === lease.deviceId
    && item.kind === 'close' && item.generation === operation.generation - 1).at(-1)
  return operation.generation === 1 || (!!close?.acknowledgedAt && !close.errorCode)
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}
