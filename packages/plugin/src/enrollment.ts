import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { CompanionService, type PairingResult } from './service.js'

export interface EnrollmentStartInput {
  installationId: string
  name: string
  osVersion: string
  architecture: string
  companionVersion: string
}
export interface EnrollmentRequest { requestId: string; userCode: string; pollToken: string; expiresAt: string }
export type EnrollmentStatus = 'pending' | 'approving' | 'ready' | 'denied' | 'delivered' | 'expired' | 'failed'
export interface EnrollmentView {
  requestId: string
  userCode: string
  name: string
  osVersion: string
  architecture: string
  companionVersion: string
  createdAt: string
  expiresAt: string
  status: EnrollmentStatus
  deviceId?: string
  errorCode?: 'INSTALLATION_EXISTS' | 'APPROVAL_FAILED'
}
export type EnrollmentPollResult = { status: 'pending' | 'denied' | 'expired' | 'delivered' } | { status: 'ready'; pairing: PairingResult }
export interface EnrollmentOptions { now?: () => number; monotonicNow?: () => number; ttlMs?: number; maxRecords?: number }
export class EnrollmentError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'EnrollmentError' }
}
interface RecordState {
  input: EnrollmentStartInput
  view: EnrollmentView
  pollHash: Buffer
  expiresAtMs: number
  expiresMonotonic: number
  timer: ReturnType<typeof setTimeout>
  approval?: Promise<EnrollmentView> | undefined
  pairing?: PairingResult | undefined
}
const EMPTY_HASH = Buffer.alloc(32)

/** Public start/poll never authorize. The HTTP owner MUST authenticate list/approve/deny. */
export class CompanionEnrollmentService {
  private readonly records = new Map<string, RecordState>()
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private readonly ttlMs: number
  private readonly maxRecords: number
  private tail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly service: CompanionService, options: EnrollmentOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.ttlMs = options.ttlMs ?? 5 * 60_000
    this.maxRecords = options.maxRecords ?? 16
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1000 || this.ttlMs > 5 * 60_000 ||
        !Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 64) throw new EnrollmentError('VALIDATION_ERROR', 'Invalid bounded enrollment options')
  }

  start(input: EnrollmentStartInput): EnrollmentRequest {
    this.assertActive()
    const validated = validate(input)
    this.sweep()
    if (this.records.size >= this.maxRecords) throw new EnrollmentError('ENROLLMENT_CAPACITY', 'Too many enrollment requests; retry after expiry', 429)
    const requestId = 'enroll_' + randomUUID()
    let userCode: string
    do { const raw = randomBytes(5).toString('hex').toUpperCase(); userCode = raw.slice(0, 5) + '-' + raw.slice(5) }
    while ([...this.records.values()].some(record => record.view.userCode === userCode))
    const pollToken = randomBytes(32).toString('base64url')
    const now = this.now(), expiresAtMs = now + this.ttlMs
    const view: EnrollmentView = { requestId, userCode, name: validated.name, osVersion: validated.osVersion,
      architecture: validated.architecture, companionVersion: validated.companionVersion,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(expiresAtMs).toISOString(), status: 'pending' }
    const timer = setTimeout(() => { const record = this.records.get(requestId); if (record) this.expire(record) }, this.ttlMs)
    timer.unref()
    this.records.set(requestId, { input: validated, view, pollHash: digest(pollToken), expiresAtMs,
      expiresMonotonic: this.monotonicNow() + this.ttlMs, timer })
    return { requestId, userCode, pollToken, expiresAt: view.expiresAt }
  }

  poll(input: { requestId: string; pollToken: string }): EnrollmentPollResult {
    this.assertActive()
    if (!input || typeof input !== 'object' || !validId(input.requestId) || typeof input.pollToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.pollToken)) {
      throw new EnrollmentError('UNAUTHORIZED', 'Invalid enrollment poll authorization', 401)
    }
    const record = this.records.get(input.requestId)
    // Hashing keeps timingSafeEqual inputs fixed length, including unknown request ids.
    const matches = timingSafeEqual(record?.pollHash ?? EMPTY_HASH, digest(input.pollToken))
    if (!record) return { status: 'expired' }
    if (!matches) throw new EnrollmentError('UNAUTHORIZED', 'Invalid enrollment poll authorization', 401)
    if (this.expired(record)) { this.expire(record); return { status: 'expired' } }
    if (record.view.status === 'ready' && record.pairing) {
      const pairing = record.pairing
      record.pairing = undefined
      record.view.status = 'delivered'
      // At-most-once delivery: a lost HTTP response requires a fresh explicitly approved enrollment.
      return { status: 'ready', pairing: structuredClone(pairing) }
    }
    if (record.view.status === 'denied' || record.view.status === 'failed') return { status: 'denied' }
    if (record.view.status === 'delivered') return { status: 'delivered' }
    if (record.view.status === 'expired') return { status: 'expired' }
    return { status: 'pending' }
  }

  list(): EnrollmentView[] {
    this.assertActive()
    this.sweep()
    return [...this.records.values()].map(record => structuredClone(record.view))
  }

  /** Caller authentication is mandatory; possession of requestId/userCode is not authorization. */
  async approve(requestId: string): Promise<EnrollmentView> {
    const record = this.requireRecord(requestId)
    if (record.approval) return record.approval
    if (record.view.status === 'ready' || record.view.status === 'delivered') return Promise.resolve(structuredClone(record.view))
    if (record.view.status !== 'pending') return Promise.reject(new EnrollmentError('ENROLLMENT_DECIDED', 'Enrollment is no longer awaiting approval', 409))
    record.view.status = 'approving'
    const operation = this.tail.then(async () => {
      this.ensureLive(record)
      const installationHash = digest(record.input.installationId).toString('hex')
      if (this.service.snapshot().devices.some(device => device.installationIdHash === installationHash)) {
        throw new EnrollmentError('INSTALLATION_EXISTS', 'Installation already has a Device; explicitly revoke it and enroll a new installation identity', 409)
      }
      const ticket = await this.service.createPairingTicket(60_000)
      this.ensureLive(record)
      const pairing = await this.service.pairDevice({ ...record.input, code: ticket.code, rejectExistingInstallation: true,
        capabilities: { protocolVersion: 1, localForward: true, tcpProbe: false } })
      record.view.deviceId = pairing.device.id
      this.ensureLive(record)
      record.pairing = pairing
      record.view.status = 'ready'
      return structuredClone(record.view)
    }).catch((error: unknown) => {
      record.pairing = undefined
      if (this.disposed || this.expired(record)) {
        this.expire(record)
        throw new EnrollmentError('ENROLLMENT_EXPIRED', 'Enrollment expired before credential delivery; start a new approval', 410)
      }
      record.view.status = 'failed'
      const installationExists = !!error && typeof error === 'object' && 'code' in error && error.code === 'INSTALLATION_EXISTS'
      record.view.errorCode = installationExists ? 'INSTALLATION_EXISTS' : 'APPROVAL_FAILED'
      throw new EnrollmentError(record.view.errorCode, installationExists ? 'Installation already has a Device; enroll a fresh installation identity after explicit browser review' : 'Enrollment approval failed; no credential will be delivered', installationExists ? 409 : 503)
    }).finally(() => { record.approval = undefined; if (this.expired(record)) this.expire(record) })
    record.approval = operation
    this.tail = operation.then(() => {}, () => {})
    return operation
  }

  async deny(requestId: string): Promise<EnrollmentView> {
    const record = this.requireRecord(requestId)
    if (record.view.status === 'denied') return Promise.resolve(structuredClone(record.view))
    if (record.view.status !== 'pending') return Promise.reject(new EnrollmentError('ENROLLMENT_DECIDED', 'Approval is in progress or already decided; use Device revocation after approval', 409))
    record.view.status = 'denied'
    return Promise.resolve(structuredClone(record.view))
  }

  /** Host teardown drops pending approvals and undelivered secrets, never persisted credentials. */
  dispose(): void {
    this.disposed = true
    for (const record of this.records.values()) { clearTimeout(record.timer); record.pairing = undefined; record.view.status = 'expired' }
    this.records.clear()
  }

  private assertActive(): void { if (this.disposed) throw new EnrollmentError('ENROLLMENT_EXPIRED', 'Enrollment service is closed', 410) }
  private requireRecord(requestId: string): RecordState {
    this.assertActive()
    if (!validId(requestId)) throw new EnrollmentError('NOT_FOUND', 'Enrollment request not found', 404)
    const record = this.records.get(requestId)
    if (!record) throw new EnrollmentError('ENROLLMENT_EXPIRED', 'Enrollment request expired or no longer exists', 410)
    this.ensureLive(record)
    return record
  }
  private ensureLive(record: RecordState): void {
    this.assertActive()
    if (this.expired(record)) { this.expire(record); throw new EnrollmentError('ENROLLMENT_EXPIRED', 'Enrollment request expired', 410) }
  }
  private expired(record: RecordState): boolean {
    return record.view.status === 'expired' || this.now() >= record.expiresAtMs || this.monotonicNow() >= record.expiresMonotonic
  }
  private expire(record: RecordState): void {
    record.pairing = undefined
    record.view.status = 'expired'
    clearTimeout(record.timer)
    if (!record.approval) this.records.delete(record.view.requestId)
  }
  private sweep(): void { for (const record of this.records.values()) if (this.expired(record)) this.expire(record) }
}
function digest(value: string): Buffer { return createHash('sha256').update(value).digest() }
function validId(value: unknown): value is string { return typeof value === 'string' && /^enroll_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) }
function validate(input: EnrollmentStartInput): EnrollmentStartInput {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== ['installationId', 'name', 'osVersion', 'architecture', 'companionVersion'].sort().join(',')) {
    throw new EnrollmentError('VALIDATION_ERROR', 'Invalid enrollment fields')
  }
  const text = (value: unknown, max: number): string => {
    if (typeof value !== 'string' || !value.length || value !== value.trim() || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value)) throw new EnrollmentError('VALIDATION_ERROR', 'Invalid enrollment metadata')
    return value
  }
  const value = { installationId: text(input.installationId, 256), name: text(input.name, 256), osVersion: text(input.osVersion, 64),
    architecture: text(input.architecture, 32), companionVersion: text(input.companionVersion, 64) }
  if (!['arm64', 'x64'].includes(value.architecture) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(value.companionVersion)) throw new EnrollmentError('VALIDATION_ERROR', 'Invalid enrollment platform or version')
  return value
}
