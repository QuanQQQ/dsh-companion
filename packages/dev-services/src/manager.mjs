import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { authorizeWorkspace, parseCreate, resolveWorkdir, publicError } from './spec.mjs'
import { assertPortFree, serviceHealth } from './health.mjs'

/** Host owns bounded operations, never the lifetime of independently owned units. */
export class DevServiceManager {
  constructor(store, backend, options = {}) {
    this.store = store
    this.backend = backend
    this.health = options.health ?? serviceHealth
    this.portFree = options.portFree ?? assertPortFree
    this.companion = options.companion
    this.signal = options.signal
    this.authorizeLaunch = options.authorizeLaunch ?? (() => { throw new Error('Independent execution is not authorized') })
    this.validateWorkdir = options.validateWorkdir ?? ((workspace, path) => resolveWorkdir(workspace.workspacePath, path))
    this.startupMs = options.startupMs ?? 30000
    this.pollMs = options.pollMs ?? 100
    for (const value of [this.startupMs, this.pollMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 600000) throw new Error('Invalid readiness timing')
  }

  record(workspace, id, operation) {
    const record = this.store.get(id)
    if (!(workspace?.kind === 'owner-browser' && !record.workspacePath && ['status', 'logs', 'stop', 'remove'].includes(operation))) authorizeWorkspace(workspace, record, operation)
    if (record.desired === 'removed' && ['start', 'restart'].includes(operation)) throw new Error('Service is retired')
    return record
  }

  async create(workspace, input) {
    authorizeWorkspace(workspace, undefined, 'create')
    const spec = parseCreate(input)
    spec.workdir = await this.validateWorkdir(workspace, spec.workdir)
    return await this.store.locked(async () => {
      this.signal?.throwIfAborted()
      if (this.store.list().some(item => item.port === spec.port)) throw new Error('Port is reserved, including retired service tombstones')
      await this.portFree(spec.port)
      const record = { ...spec, id: `svc_${randomUUID()}`, workspaceId: workspace.id ?? null, workspacePath: workspace.workspacePath, ownership: randomBytes(32).toString('hex'), desired: 'stopped', companion: { state: 'none' }, createdAt: new Date().toISOString() }
      this.store.insert(record)
      return await this.view(record)
    })
  }
  async list(workspace) {
    if (workspace) authorizeWorkspace(workspace, undefined, 'list')
    return await Promise.all(this.store.list().filter(item => !workspace || item.workspacePath === workspace.workspacePath).map(item => this.view(item)))
  }
  async get(id) { return await this.view(this.store.get(id)) }
  async status(workspace, id) { return await this.view(this.record(workspace, id, 'status')) }
  async logs(workspace, id, lines) { return await this.backend.logs(this.record(workspace, id, 'logs'), lines) }

  /** Explicit owner claim only; never derive authority from legacyTaskId or cwd. */
  async claim(workspace, id) {
    if (workspace?.kind !== 'owner-browser') throw new Error('Only an explicit owner-browser operation may claim a legacy service')
    authorizeWorkspace(workspace, undefined, 'claim')
    return await this.store.locked(async () => {
      const record = this.store.get(id)
      if (record.workspacePath) throw new Error('Service is already claimed; reassignment is not permitted')
      if (await this.validateWorkdir(workspace, record.workdir) !== record.workdir) throw new Error('Legacy workdir canonical identity changed')
      record.workspaceId = workspace.id ?? null
      record.workspacePath = workspace.workspacePath
      record.claimedAt = new Date().toISOString()
      record.claimedBy = 'owner-browser'
      record.claimAudit = { from: 'unclaimed', legacyTaskId: record.legacyTaskId, workspacePath: record.workspacePath, workspaceId: record.workspaceId, at: record.claimedAt, actor: record.claimedBy }
      this.store.save(record)
      return await this.view(record)
    })
  }

  async start(workspace, id) {
    return await this.store.locked(async () => await this.startUnlocked(workspace, this.record(workspace, id, 'start')))
  }
  async startUnlocked(workspace, record) {
    this.signal?.throwIfAborted()
    await this.authorizeLaunch(workspace)
    const canonical = await this.validateWorkdir(workspace, record.workdir)
    if (canonical !== record.workdir) throw new Error('Service workdir canonical identity changed')
    const observed = await this.backend.inspect(record)
    if (!observed.exists || !['active', 'activating'].includes(observed.state)) await this.portFree(record.port)
    this.signal?.throwIfAborted()
    record.desired = 'running'
    record.readiness = { state: 'starting', reason: 'Waiting for owned loopback listener' }
    delete record.lastError
    this.store.save(record)
    try {
      // No AbortSignal is passed to the supervisor: cancellation only ends waiting.
      await this.backend.start(record)
      const deadline = Date.now() + this.startupMs
      while (true) {
        this.signal?.throwIfAborted()
        const runtime = await this.backend.inspect(record)
        const health = await this.health(record, runtime)
        record.readiness = { state: health.state === 'ready' ? 'ready' : 'starting', reason: health.state === 'ready' ? 'Owned listener accepts loopback TCP connections' : 'Waiting for owned loopback listener' }
        this.store.save(record)
        if (health.state === 'ready') break
        if (health.state === 'unsafe' || runtime.state === 'failed' || !runtime.exists || Date.now() >= deadline) {
          record.readiness = { state: 'not_ready', reason: runtime.state === 'failed' ? 'Supervisor reports failed; inspect bounded restart budget' : 'Readiness not established; owned process is not stopped' }
          this.store.save(record)
          break
        }
        await delay(this.pollMs, undefined, { signal: this.signal })
      }
    } catch (error) {
      // A timeout, canceled Agent or unloading Host does NOT authorize stopping.
      // Unknown start results retain running intent and exact signed unit identity.
      record.readiness = { state: 'not_ready', reason: this.signal?.aborted ? 'Readiness wait canceled; owned process is not stopped' : 'Supervisor result unknown; owned process is not stopped' }
      record.lastError = publicError(error)
      this.store.save(record)
    }
    if (!this.signal?.aborted) await this.sync(record)
    return await this.view(record)
  }

  async stop(workspace, id) {
    return await this.store.locked(async () => {
      const record = this.record(workspace, id, 'stop')
      if (record.desired !== 'removed') record.desired = 'stopped'
      record.readiness = { state: 'not_ready', reason: 'Explicit stop requested' }
      this.store.save(record)
      await this.backend.stop(record)
      return await this.view(record)
    })
  }
  async restart(workspace, id) {
    return await this.store.locked(async () => {
      const record = this.record(workspace, id, 'restart')
      // Validate permission AND immutable workdir before the stop side effect.
      await this.authorizeLaunch(workspace)
      if (await this.validateWorkdir(workspace, record.workdir) !== record.workdir) throw new Error('Service workdir canonical identity changed')
      this.signal?.throwIfAborted()
      record.desired = 'stopped'
      this.store.save(record)
      await this.backend.stop(record)
      return await this.startUnlocked(workspace, record)
    })
  }
  async remove(workspace, id) {
    return await this.store.locked(async () => {
      const record = this.record(workspace, id, 'remove')
      record.desired = 'removed'
      this.store.save(record)
      await this.backend.stop(record)
      await this.sync(record)
      return await this.view(record)
    })
  }
  async synchronize(workspace, id) {
    return await this.store.locked(async () => {
      const record = this.record(workspace, id, 'synchronize')
      await this.sync(record)
      return await this.view(record)
    })
  }
  async sync(record) {
    if (record.desired === 'removed' && !record.companion.attempted && !record.companion.id) {
      record.companion = { state: 'retired' }
    } else if (record.companion.state === 'detached') return
    else if (!this.companion) record.companion = { ...record.companion, state: 'unavailable' }
    else if (!record.workspacePath && record.desired !== 'removed') return
    else {
      const previous = record.companion
      record.companion = { ...previous, attempted: true, state: 'pending' }
      this.store.save(record)
      try {
        const result = record.desired === 'removed' ? await this.companion.retire(this.store.namespace, record) : await this.companion.ensure(this.store.namespace, record)
        record.companion = { state: result.state, ...(result.id ? { id: result.id } : {}), attempted: true }
      } catch { record.companion = { ...previous, attempted: true, state: 'error', error: 'Declaration synchronization failed; retry explicitly' } }
    }
    this.store.save(record)
  }

  /** Strict allowlists: supervisor transports and persisted records are not views. */
  async view(record) {
    let observed, checked
    try { observed = await this.backend.inspect(record); checked = await this.health(record, observed) }
    catch { observed = { state: 'unknown' }; checked = { state: 'unknown', reason: 'Cannot verify owned supervisor state' } }
    const runtime = {
      ...(typeof observed.exists === 'boolean' ? { exists: observed.exists } : {}),
      state: ['active', 'activating', 'inactive', 'deactivating', 'failed', 'stopped', 'unknown'].includes(observed.state) ? observed.state : 'unknown',
      ...(typeof observed.unit === 'string' && /^dsh-dev-services-[a-f0-9]{64}\.service$/.test(observed.unit) ? { unit: observed.unit } : {}),
      ...(typeof observed.subState === 'string' && /^[a-z-]{1,64}$/.test(observed.subState) ? { subState: observed.subState } : {}),
      ...(Number.isSafeInteger(observed.pid) && observed.pid >= 0 ? { pid: observed.pid } : {}),
      ...(typeof observed.cgroup === 'string' && /^dsh-dev-services-[a-f0-9]{64}\.service$/.test(observed.unit ?? '') && observed.cgroup.startsWith('/') && observed.cgroup.endsWith(`/${observed.unit}`) ? { cgroup: observed.cgroup } : {}),
      ...(typeof observed.result === 'string' && /^[a-z-]{1,64}$/.test(observed.result) ? { result: observed.result } : {}),
      ...(Number.isSafeInteger(observed.restarts) && observed.restarts >= 0 ? { restarts: observed.restarts } : {}),
    }
    const reasons = { ready: 'Owned listener accepts active loopback TCP connections', starting: 'Waiting for owned loopback listener', not_ready: 'Readiness not established; process is not automatically stopped', unavailable: 'Process is not active', unsafe: 'Listener ownership or loopback reachability is not verified', unknown: 'Cannot verify owned service readiness' }
    const state = Object.hasOwn(reasons, checked.state) ? checked.state : 'unknown'
    const health = { state, reason: reasons[state], ...(checked.warning && state === 'ready' ? { warning: 'Service listens on 0.0.0.0 and may be reachable through non-loopback interfaces' } : {}) }
    const companion = Object.fromEntries(['state', 'id', 'attempted'].filter(key => record.companion[key] !== undefined).map(key => [key, record.companion[key]]))
    if (companion.state === 'error') companion.error = 'Declaration synchronization failed; retry explicitly'
    return {
      id: record.id, workspaceId: record.workspaceId, workspacePath: record.workspacePath,
      ...(record.legacyTaskId ? { legacyTaskId: record.legacyTaskId } : {}),
      ...(record.claimedAt ? { claimedAt: record.claimedAt, claimedBy: 'owner-browser' } : {}),
      name: record.name, port: record.port, protocol: record.protocol, desired: record.desired,
      runtime, health, companion,
      ...(record.readiness ? { readiness: { state: ['ready', 'starting', 'not_ready'].includes(record.readiness.state) ? record.readiness.state : 'not_ready', reason: reasons[record.readiness.state] ?? reasons.not_ready } } : {}),
      ...(record.lastError ? { lastError: 'Service operation incomplete; inspect owned supervisor state' } : {}),
      removalComplete: record.desired === 'removed' && (!runtime.exists && runtime.state !== 'unknown' || ['inactive', 'failed'].includes(runtime.state)) && ['retired', 'detached'].includes(companion.state),
    }
  }
}
