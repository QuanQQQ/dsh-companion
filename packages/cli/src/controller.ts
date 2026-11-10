import { performance } from 'node:perf_hooks'
import { RuntimeStore, type RuntimeInstance } from './runtime-state.js'
import type { Fence, ForwardCommand, HostHello, InstanceObservation } from './wire.js'

export interface TunnelExecutor {
  start(leaseId: string, port: number): Promise<{ pid: number; controlPath: string }>
  stop(leaseId: string): Promise<void>
  stopAll(): Promise<void>
  recoverAll?(): Promise<void>
  isOwned(leaseId: string): Promise<boolean>
  /** Optional on older executors: absence is unsupported, never healthy. */
  probe?(leaseId: string): Promise<'healthy' | 'failed' | 'unknown'>
  listenerState?(port: number): Promise<'missing' | 'conflict' | 'unknown'>
  recover?(instance: { leaseId: string; controlPath: string; processId?: number }): Promise<void>
}
export interface CommandOutcome { ok: boolean; observation?: InstanceObservation; errorCode?: string; errorMessage?: string }
export interface ControllerClock { wall(): number; monotonic(): number }
const clock: ControllerClock = { wall: Date.now, monotonic: () => performance.now() }
const transient = new Set(['SSH_EXITED', 'SSH_START_TIMEOUT', 'SSH_COMMAND_TIMEOUT', 'LINK_LOST', 'LISTENER_MISSING'])

/** Serializes side effects; connection invalidation is synchronous, ahead of queued work. */
export class ForwardController {
  private fence: Fence | undefined
  private tail: Promise<void> = Promise.resolve()
  private deadlines = new Map<string, number>()
  private enabled = new Set<string>()
  private expirations = new Map<string, Promise<void>>()
  // Ephemeral monotonic samples cannot be restored from runtime JSON after a restart.
  private samples = new Map<string, { generation: number; sampledAt: string; monotonic: number }>()
  private serverOffset = 0
  constructor(readonly store: RuntimeStore, readonly ssh: TunnelExecutor, private time = clock) {}

  async initialize(): Promise<void> {
    this.samples.clear()
    if (this.ssh.recoverAll) await this.ssh.recoverAll()
    for (const instance of this.store.snapshot().instances) {
      if (!this.ssh.recoverAll && instance.controlPath && this.ssh.recover) await this.ssh.recover({
        leaseId: instance.leaseId, controlPath: instance.controlPath,
        ...(instance.processId === undefined ? {} : { processId: instance.processId }),
      })
      // Even a non-recovering injected executor must verify its tracked child has exited.
      await this.ssh.stop(instance.leaseId)
      await this.recordStopped(instance, instance.desiredState === 'closed' ? 'closed' : 'recovering')
    }
  }

  connect(hello: HostHello): void {
    if (hello.authorityEpoch !== this.store.snapshot().authorityEpoch) throw new Error('Authority epoch differs from pairing')
    if (this.fence) throw new Error('Connection Session must be disconnected before replacement')
    this.serverOffset = Math.max(0, Date.parse(hello.serverTime) - this.time.wall())
    this.fence = { authorityEpoch: hello.authorityEpoch, sessionEpoch: hello.sessionEpoch }
  }

  disconnect(): Promise<void> {
    this.fence = undefined
    this.enabled.clear()
    this.samples.clear() // Invalidate old healthy evidence before any queued storage/SSH work.
    const stopping = this.ssh.stopAll()
    // Attach rejection handling immediately; storage serialization may still await an in-flight command.
    const stopped = stopping.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    return this.serial(async () => {
      const result = await stopped
      if (!result.ok) {
        for (const item of this.store.snapshot().instances) await this.store.patch(item.leaseId, {
          state: item.desiredState === 'closed' ? 'closed' : 'recovering', sshChild: 'unknown', listener: 'unknown',
          remoteProbe: 'unknown', sampledAt: undefined, probeAgeMs: undefined,
        })
        throw result.error
      }
      for (const item of this.store.snapshot().instances) {
        await this.recordStopped(item, item.desiredState === 'closed' ? 'closed' : 'recovering')
      }
    })
  }

  execute(command: ForwardCommand): Promise<CommandOutcome> {
    const admitted = this.matches(command)
    return this.serial(async () => {
      if (!admitted || !this.matches(command)) throw new Error('Stale Connection Session')
      const decision = await this.store.begin(command)
      if (decision !== 'apply') return this.outcome(command.leaseId, command.generation, decision === 'stale' ? 'STALE_GENERATION' : undefined)
      let previous = this.instance(command.leaseId)
      if (command.type === 'forward.close') {
        this.enabled.delete(command.leaseId)
        this.samples.delete(command.leaseId)
        // The persisted tombstone precedes termination, so a crash cannot authorize a reopen.
        await this.store.upsert({ leaseId: command.leaseId, generation: command.generation,
          desiredState: 'closed', state: 'closed', sshChild: 'unknown', listener: 'unknown', remoteProbe: 'disabled',
          port: previous?.port ?? 1, portKnown: previous !== undefined && previous.portKnown !== false, protocol: previous?.protocol ?? 'tcp',
          expiresAt: previous?.expiresAt ?? new Date(this.now()).toISOString(), controlPath: previous?.controlPath ?? '' })
        await this.ssh.stop(command.leaseId)
        await this.recordStopped(this.instance(command.leaseId)!, 'closed', previous !== undefined)
        await this.store.complete(command.operationId)
        return this.outcome(command.leaseId, command.generation)
      }
      if (previous && command.generation === previous.generation &&
          (previous.port !== command.port || previous.expiresAt !== command.expiresAt || previous.protocol !== command.protocol)) {
        throw new Error('Same-generation open changed immutable Lease payload')
      }
      if (!previous || previous.generation !== command.generation) {
        this.samples.delete(command.leaseId)
        await this.ssh.stop(command.leaseId)
        previous = undefined
      }
      const retryAttempt = previous?.retryAttempt ?? 0
      await this.store.upsert({ leaseId: command.leaseId, generation: command.generation, desiredState: 'open',
        state: previous?.state ?? 'starting', sshChild: previous?.sshChild ?? 'unknown', listener: previous?.listener ?? 'unknown',
        remoteProbe: previous?.remoteProbe ?? 'unknown', port: command.port, protocol: command.protocol, expiresAt: command.expiresAt,
        controlPath: previous?.controlPath ?? '', retryAttempt,
        ...(previous?.errorCode ? { errorCode: previous.errorCode } : {}) })
      this.setDeadline(command.leaseId, command.expiresAt)
      if (this.matches(command)) {
        this.enabled.add(command.leaseId)
        await this.realize(command.leaseId, command, true)
      }
      await this.store.complete(command.operationId)
      return this.outcome(command.leaseId, command.generation)
    })
  }

  /** Deadline cancellation does not wait behind other Lease SSH starts. */
  expireNow(): Promise<void> {
    const pending: Promise<void>[] = []
    for (const item of this.store.snapshot().instances) {
      if (item.desiredState !== 'open' || !this.expired(item)) continue
      this.enabled.delete(item.leaseId)
      this.samples.delete(item.leaseId)
      let operation = this.expirations.get(item.leaseId)
      if (!operation) {
        operation = this.ssh.stop(item.leaseId).then(async () => {
          const listener = await this.stoppedListener(item.port)
          await this.store.patchOpen(item.leaseId, item.generation, {
            state: 'needs_attention', errorCode: 'LEASE_EXPIRED', sshChild: 'exited', listener,
            remoteProbe: 'unknown', sampledAt: undefined, probeAgeMs: undefined,
            controlPath: '', processId: undefined, retryAt: undefined,
          })
        }).finally(() => { this.expirations.delete(item.leaseId) })
        this.expirations.set(item.leaseId, operation)
      }
      pending.push(operation)
    }
    return Promise.all(pending).then(() => undefined)
  }

  tick(): Promise<void> {
    return this.serial(async () => {
      for (const item of this.store.snapshot().instances) {
        if (item.desiredState !== 'open') {
          // Only re-scan tombstones whose owned SSH stop already completed successfully.
          if (this.fence && item.sshChild === 'exited') await this.recordStopped(item, 'closed')
          continue
        }
        if (this.expired(item)) {
          await this.ssh.stop(item.leaseId)
          await this.fail(item, 'LEASE_EXPIRED')
          continue
        }
        if (!this.fence || !this.enabled.has(item.leaseId)) continue
        if (item.state === 'running') await this.refresh(item.leaseId, this.fence)
        const current = this.instance(item.leaseId)!
        if (current.state === 'recovering' && (!current.retryAt || Date.parse(current.retryAt) <= this.now())) {
          await this.realize(current.leaseId, this.fence)
        }
      }
    })
  }

  private async realize(leaseId: string, fence: Fence, _explicit = false): Promise<void> {
    const item = this.instance(leaseId)!
    if (this.expired(item)) { await this.ssh.stop(leaseId); await this.fail(item, 'LEASE_EXPIRED'); return }
    if (!this.matches(fence)) return
    if (await this.ssh.isOwned(leaseId)) { await this.refresh(leaseId, fence); return }
    const portOwner = this.store.snapshot().instances.find(other => other.leaseId !== leaseId && other.port === item.port
      && other.desiredState === 'open' && !this.expired(other))
    if (portOwner) { await this.ssh.stop(leaseId); await this.fail(item, 'LOCAL_PORT_IN_USE'); return }
    await this.ssh.stop(leaseId)
    await this.store.patch(leaseId, { state: 'starting', retryAttempt: Math.min(Number.MAX_SAFE_INTEGER - 4, (item.retryAttempt ?? 0) + 1) })
    try {
      if (!this.matches(fence) || !this.enabled.has(leaseId)) return
      if (this.expired(item)) { await this.ssh.stop(leaseId); await this.fail(item, 'LEASE_EXPIRED'); return }
      const child = await this.ssh.start(leaseId, item.port)
      if (!this.matches(fence) || this.expired(item)) {
        await this.ssh.stop(leaseId)
        await this.fail(item, this.expired(item) ? 'LEASE_EXPIRED' : 'LINK_LOST')
        return
      }
      if (!await this.ssh.isOwned(leaseId)) throw Object.assign(new Error('Listener ownership not confirmed'), { code: 'LISTENER_MISSING' })
      if (!this.matches(fence) || this.expired(item)) {
        await this.ssh.stop(leaseId)
        await this.fail(item, this.expired(item) ? 'LEASE_EXPIRED' : 'LINK_LOST')
        return
      }
      await this.store.patch(leaseId, { state: 'running', sshChild: 'running', listener: 'owned', remoteProbe: 'unknown', retryAttempt: 0,
        processId: child.pid, controlPath: child.controlPath, errorCode: undefined, errorMessage: undefined, retryAt: undefined })
      await this.refresh(leaseId, fence)
    } catch (error) {
      await this.ssh.stop(leaseId)
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'SSH_FAILED'
      await this.fail(this.instance(leaseId)!, code)
    }
  }
  /** Serialization only ages prior evidence; it never turns a cache read into a probe. */
  observations(): InstanceObservation[] {
    return this.store.observations().map<InstanceObservation>(item => {
      const { sampledAt: _storedTime, probeAgeMs: _storedAge, ...observation } = item
      const sample = this.samples.get(item.leaseId)
      if (item.state !== 'closed' && (!this.fence || !this.enabled.has(item.leaseId))) {
        return { ...observation, remoteProbe: 'unknown' }
      }
      if (!sample || sample.generation !== item.generation) {
        return { ...observation, remoteProbe: item.remoteProbe === 'healthy' ? 'unknown' : item.remoteProbe }
      }
      return { ...observation, sampledAt: sample.sampledAt,
        probeAgeMs: Math.min(Number.MAX_SAFE_INTEGER - 4, Math.max(0, Math.ceil(this.time.monotonic() - sample.monotonic))) }
    })
  }

  private async refresh(leaseId: string, fence: Fence): Promise<void> {
    const item = this.instance(leaseId)!
    const current = () => this.matches(fence) && this.enabled.has(leaseId) &&
      this.instance(leaseId)?.generation === item.generation && !this.expired(item)
    const owned = await this.ssh.isOwned(leaseId)
    if (!current()) return
    if (!owned) {
      this.samples.delete(leaseId)
      await this.ssh.stop(leaseId)
      await this.fail(item, 'SSH_EXITED')
      return
    }
    // Include command/probe elapsed time in the age, not just time after persistence.
    const sample = { generation: item.generation, sampledAt: new Date(this.time.wall()).toISOString(), monotonic: this.time.monotonic() }
    let remoteProbe: InstanceObservation['remoteProbe'] = 'disabled'
    if (this.ssh.probe) {
      try { remoteProbe = await this.ssh.probe(leaseId) } catch { remoteProbe = 'unknown' }
    }
    if (!current()) return
    const remainsOwned = await this.ssh.isOwned(leaseId)
    // Include the final ownership command in the sample's conservative elapsed age.
    if (!remainsOwned) {
      if (!current()) return
      this.samples.delete(leaseId)
      await this.ssh.stop(leaseId)
      await this.fail(item, 'SSH_EXITED')
      return
    }
    if (!current()) return
    // TCP failure is not permission to stop a still-owned SSH transport.
    // Do not attach a new sample to an old healthy row while its failed update awaits IO.
    this.samples.delete(leaseId)
    await this.store.patch(leaseId, { sshChild: 'running', listener: 'owned', remoteProbe,
      sampledAt: undefined, probeAgeMs: undefined })
    if (current() && (remoteProbe === 'healthy' || remoteProbe === 'failed')) this.samples.set(leaseId, sample)
  }

  private async stoppedListener(port: number): Promise<'missing' | 'conflict' | 'unknown'> {
    try { return await this.ssh.listenerState?.(port) ?? 'unknown' } catch { return 'unknown' }
  }

  private async recordStopped(item: RuntimeInstance, state: RuntimeInstance['state'], knownPort = true): Promise<void> {
    this.samples.delete(item.leaseId)
    const sampledAt = new Date(this.time.wall()).toISOString()
    const monotonic = this.time.monotonic()
    const listener = knownPort && item.portKnown !== false ? await this.stoppedListener(item.port) : 'unknown'
    await this.store.patch(item.leaseId, { state, sshChild: 'exited', listener, remoteProbe: 'unknown',
      sampledAt: undefined, probeAgeMs: undefined, processId: undefined, controlPath: '' })
    if (listener !== 'unknown' && this.fence && this.instance(item.leaseId)?.generation === item.generation) {
      this.samples.set(item.leaseId, { generation: item.generation, sampledAt, monotonic })
    }
  }

  private async fail(item: RuntimeInstance, code: string): Promise<void> {
    this.samples.delete(item.leaseId)
    const listener = await this.stoppedListener(item.port)
    const attempts = this.instance(item.leaseId)?.retryAttempt ?? 0
    if (code === 'SSH_PORT_IN_USE') code = 'LOCAL_PORT_IN_USE'
    if (code === 'SSH_HOST_KEY_FAILED') code = 'HOST_KEY_FAILED'
    const attention = !transient.has(code)
    await this.store.patch(item.leaseId, { state: attention ? 'needs_attention' : 'recovering', sshChild: 'exited',
      listener: code === 'LOCAL_PORT_IN_USE' ? 'conflict' : listener, remoteProbe: 'unknown',
      sampledAt: undefined, probeAgeMs: undefined, processId: undefined, controlPath: '',
      errorCode: code,
      errorMessage: 'Forward realization failed; inspect local Companion diagnostics.',
      retryAt: attention ? undefined : new Date(this.now() + Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))).toISOString() })
  }
  private outcome(leaseId: string, generation: number, code?: string): CommandOutcome {
    const observation = this.observations().find(item => item.leaseId === leaseId && item.generation === generation)
    const errorCode = code ?? observation?.errorCode
    return { ok: !errorCode, ...(observation ? { observation } : {}),
      ...(errorCode ? { errorCode, errorMessage: 'Forward operation is not running; see Instance observation.' } : {}) }
  }
  private instance(leaseId: string) { return this.store.snapshot().instances.find(item => item.leaseId === leaseId) }
  private now() { return this.time.wall() + this.serverOffset }
  private setDeadline(leaseId: string, expiresAt: string) {
    const next = this.time.monotonic() + Math.max(0, Date.parse(expiresAt) - this.now())
    this.deadlines.set(leaseId, Math.min(this.deadlines.get(leaseId) ?? Infinity, next))
  }
  private expired(item: RuntimeInstance) {
    return Date.parse(item.expiresAt) <= this.now() || (this.deadlines.get(item.leaseId) ?? Infinity) <= this.time.monotonic()
  }
  private matches(fence: Fence) { return this.fence?.authorityEpoch === fence.authorityEpoch && this.fence?.sessionEpoch === fence.sessionEpoch }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
