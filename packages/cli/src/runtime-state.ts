import { readFile } from 'node:fs/promises'
import { atomicPrivateWrite } from './config.js'
import type { ForwardCommand, InstanceObservation, Protocol } from './wire.js'

export const RUNTIME_STATE_VERSION = 1 as const

export interface RuntimeInstance extends InstanceObservation {
  desiredState: 'open' | 'closed'
  port: number
  protocol: Protocol
  expiresAt: string
  controlPath: string
}

export interface OperationEntry {
  operationId: string
  leaseId: string
  generation: number
  kind: 'open' | 'close'
  digest: string
  status: 'intent' | 'applied'
  updatedAt: string
}

export interface RuntimeState {
  version: typeof RUNTIME_STATE_VERSION
  authorityEpoch: string
  operations: OperationEntry[]
  instances: RuntimeInstance[]
}

export class RuntimeStore {
  private tail: Promise<void> = Promise.resolve()
  private constructor(readonly path: string, private state: RuntimeState) {}

  static async open(path: string, authorityEpoch: string): Promise<RuntimeStore> {
    let state: RuntimeState
    try { state = parseRuntimeState(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
      state = { version: RUNTIME_STATE_VERSION, authorityEpoch, operations: [], instances: [] }
    }
    if (state.authorityEpoch !== authorityEpoch) throw new Error('runtime authority epoch does not match Device pairing')
    return new RuntimeStore(path, state)
  }

  snapshot(): RuntimeState { return structuredClone(this.state) }
  observations(): InstanceObservation[] {
    return this.state.instances.map(({ desiredState: _desired, port: _port, protocol: _protocol,
      expiresAt: _expires, controlPath: _control, ...observation }) => structuredClone(observation))
  }

  async begin(command: ForwardCommand): Promise<'apply' | 'duplicate' | 'stale'> {
    let decision: 'apply' | 'duplicate' | 'stale' = 'apply'
    await this.transact(state => {
      const current = state.instances.find(item => item.leaseId === command.leaseId)
      const prior = state.operations.find(item => item.operationId === command.operationId)
      if (prior && prior.digest !== command.digest) throw new Error('operationId was reused with a different canonical payload')
      if (current && command.generation < current.generation) { decision = 'stale'; return }
      if (prior) {
        if (prior.digest !== command.digest) throw new Error('operationId was reused with a different canonical payload')
        decision = prior.status === 'applied' ? 'duplicate' : 'apply'
        return
      }
      if (state.operations.length >= 10_000) throw new Error('operation ledger capacity reached; explicit maintenance is required')
      if (current && command.generation === current.generation) {
        const requested = command.type === 'forward.open' ? 'open' : 'closed'
        if (requested !== current.desiredState) throw new Error('same generation attempted to reverse Desired State')
      }
      state.operations.push({
        operationId: command.operationId, leaseId: command.leaseId, generation: command.generation,
        kind: command.type === 'forward.open' ? 'open' : 'close', digest: command.digest,
        status: decision === 'stale' ? 'applied' : 'intent', updatedAt: new Date().toISOString(),
      })

    })
    return decision
  }

  async upsert(instance: RuntimeInstance): Promise<void> {
    await this.transact(state => {
      const index = state.instances.findIndex(item => item.leaseId === instance.leaseId)
      if (index >= 0) state.instances[index] = structuredClone(instance)
      else {
        if (state.instances.length >= 1_000) throw new Error('Instance/tombstone capacity reached')
        state.instances.push(structuredClone(instance))
      }
    })
  }

  async patch(leaseId: string, patch: Partial<RuntimeInstance>): Promise<RuntimeInstance | undefined> {
    let result: RuntimeInstance | undefined
    await this.transact(state => {
      const instance = state.instances.find(item => item.leaseId === leaseId)
      if (!instance) return
      Object.assign(instance, patch)
      result = structuredClone(instance)
    })
    return result
  }

  async patchOpen(leaseId: string, generation: number, patch: Partial<RuntimeInstance>): Promise<void> {
    await this.transact(state => {
      const item = state.instances.find(item => item.leaseId === leaseId && item.generation === generation && item.desiredState === 'open')
      if (item) Object.assign(item, patch)
    })
  }

  async complete(operationId: string): Promise<void> {
    await this.transact(state => {
      const operation = state.operations.find(item => item.operationId === operationId)
      if (!operation) throw new Error('cannot complete an unknown operation')
      operation.status = 'applied'
      operation.updatedAt = new Date().toISOString()
    })
  }

  private transact(mutator: (state: RuntimeState) => void): Promise<void> {
    const run = this.tail.then(async () => {
      const draft = structuredClone(this.state)
      mutator(draft)
      await atomicPrivateWrite(this.path, `${JSON.stringify(draft, null, 2)}\n`)
      this.state = draft
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

function parseRuntimeState(value: unknown): RuntimeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime state is invalid')
  const record = value as Record<string, unknown>
  if (record.version !== RUNTIME_STATE_VERSION || typeof record.authorityEpoch !== 'string'
    || !Array.isArray(record.operations) || !Array.isArray(record.instances)) throw new Error('runtime state is invalid')
  if (!record.authorityEpoch || record.operations.length > 10_000 || record.instances.length > 1_000) throw new Error('runtime state limits exceeded')
  const ids = new Set<string>()
  for (const raw of record.instances) {
    const item = object(raw)
    if (typeof item.leaseId !== 'string' || !item.leaseId || ids.has(item.leaseId)) throw new Error('invalid or duplicated Lease id')
    ids.add(item.leaseId)
    positive(item.generation)
    positive(item.port)
    if ((item.port as number) > 65_535) throw new Error('invalid port')
    if (!['open', 'closed'].includes(String(item.desiredState)) || !['http', 'https', 'tcp'].includes(String(item.protocol))) throw new Error('invalid Desired State')
    if (!['starting','running','recovering','needs_attention','closed'].includes(String(item.state))) throw new Error('invalid Instance state')
    if (typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt)) || typeof item.controlPath !== 'string') throw new Error('invalid Lease deadline or control path')
    if (item.retryAttempt !== undefined && (!Number.isSafeInteger(item.retryAttempt) || (item.retryAttempt as number) < 0)) throw new Error('invalid retry count')
    if (item.processId !== undefined) positive(item.processId)
    if (!['unknown','running','exited'].includes(String(item.sshChild)) || !['unknown','owned','missing','conflict'].includes(String(item.listener))
      || !['unknown','healthy','failed','disabled'].includes(String(item.remoteProbe))) throw new Error('invalid health observation')
  }
  const operations = new Set<string>()
  for (const raw of record.operations) {
    const operation = object(raw)
    if (typeof operation.operationId !== 'string' || operations.has(operation.operationId) || typeof operation.leaseId !== 'string') throw new Error('invalid operation identity')
    operations.add(operation.operationId)
    positive(operation.generation)
    if (!['open','close'].includes(String(operation.kind)) || !['intent','applied'].includes(String(operation.status))
      || typeof operation.digest !== 'string' || !/^[a-f0-9]{64}$/.test(operation.digest)) throw new Error('invalid operation payload')
  }
  return structuredClone(value) as RuntimeState
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid runtime state row')
  return value as Record<string, unknown>
}
function positive(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('invalid positive integer')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
