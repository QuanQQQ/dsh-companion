import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export interface SshCommandResult { code: number; stdout: string; stderr: string }
export interface SshRunOptions { shell: false; signal: AbortSignal; maxOutputBytes: number }
/** An injected runner must honour signal and reap any processes it creates. */
export interface SshRunner {
  run(file: string, args: readonly string[], options: SshRunOptions): Promise<SshCommandResult>
}
export type SshSpawn = (file: string, args: readonly string[], options: {
  shell: false; stdio: ['ignore', 'pipe', 'pipe']; detached?: boolean
}) => ChildProcess
export interface SshExecutorOptions {
  runner?: SshRunner
  spawn?: SshSpawn
  /** Signals only a live, detached master created by this executor. Test spawns must inject this too. */
  signalGroup?: (child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL') => void
  startupTimeoutMs?: number
  commandTimeoutMs?: number
  terminateTimeoutMs?: number
  pollIntervalMs?: number
  maxInstances?: number
  stderrLimitBytes?: number
}
export class SshError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SshError' }
}
interface Instance {
  leaseId: string
  port: number
  pid: number
  controlPath: string
  directory: string
  child: ChildProcess
  exited: boolean
  ready: boolean
  stopping: boolean
  stderr: Buffer
  exitDone: Promise<void>
  stopPromise?: Promise<void>
}
interface Pending { cancelled: boolean; promise: Promise<{ pid: number; controlPath: string }> }
interface Owner { version?: 2; leaseId: string; sshHost: string; pid: number; port: number; controlPath: string }
const SSH = '/usr/bin/ssh'
const LSOF = process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof'
const MAX_COMMAND_OUTPUT = 256 * 1024
const SECURITY_OPTIONS = [
  'BatchMode=yes', 'StrictHostKeyChecking=yes',
  'ForwardAgent=no', 'ForwardX11=no', 'ForwardX11Trusted=no', 'PermitLocalCommand=no',
  'LocalCommand=none', 'RemoteCommand=none',
  'ControlPersist=no', 'ExitOnForwardFailure=yes',
  'GatewayPorts=no', 'Tunnel=no', 'RequestTTY=no', 'ForkAfterAuthentication=no',
  'ConnectionAttempts=1', 'ServerAliveInterval=15', 'ServerAliveCountMax=2',
]
const optionsArgv = (values: readonly string[]) => values.flatMap(value => ['-o', value])
const fail = (code: string): never => { throw new SshError(code) }
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
function validPort(port: unknown): port is number { return Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535 }
function validLease(value: string): void {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) fail('SSH_INVALID_LEASE')
}
function prefix(leaseId: string): string { return 'l-' + createHash('sha256').update(leaseId).digest('hex').slice(0, 16) + '-' }
function append(previous: Buffer, chunk: unknown, limit: number): Buffer {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  if (bytes.length >= limit) return Buffer.from(bytes.subarray(bytes.length - limit))
  return Buffer.concat([previous.subarray(Math.max(0, previous.length + bytes.length - limit)), bytes])
}
function exitCode(stderr: Buffer): string {
  const text = stderr.toString('utf8')
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return 'SSH_HOST_KEY_FAILED'
  if (/permission denied|authentication failed/i.test(text)) return 'SSH_AUTH_FAILED'
  if (/address already in use|cannot listen to port/i.test(text)) return 'SSH_PORT_IN_USE'
  return 'SSH_EXITED'
}
async function waitBounded(done: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([done.then(() => true), new Promise<false>(r => { timer = setTimeout(() => r(false), ms) })]) }
  finally { if (timer) clearTimeout(timer) }
}

/**
 * Owns only foreground children created by this executor. TCP reachability is never
 * ownership evidence. A successful start requires a private control socket, its
 * master PID, and lsof's exact IPv4 loopback listener to agree.
 *
 * System SSH reads trusted local configuration and owns its connection/authentication logic.
 * The master starts forwarding-free; a hermetic control request adds only the approved port.
 * No remote-provided config, commands, hostnames or bind addresses are accepted.
 */
export class SshExecutor {
  onExit?: (leaseId: string, errorCode: string) => void
  private readonly sshHost: string
  private readonly controlDirectory: string
  private readonly spawn: SshSpawn
  private readonly runner: SshRunner
  private readonly signalGroup: NonNullable<SshExecutorOptions['signalGroup']>
  private readonly settings: Required<Omit<SshExecutorOptions, 'runner' | 'spawn' | 'signalGroup'>>
  private readonly instances = new Map<string, Instance>()
  private readonly pending = new Map<string, Pending>()
  private stoppingAll = false
  private recovery: Promise<void> | undefined

  constructor(sshHost: string, controlDirectory: string, options: SshExecutorOptions = {}) {
    if (typeof sshHost !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(sshHost)) fail('SSH_INVALID_ALIAS')
    if (!controlDirectory || /[\x00-\x1f\x7f%]/.test(controlDirectory)) fail('SSH_INVALID_CONTROL_DIRECTORY')
    this.sshHost = sshHost
    this.controlDirectory = resolve(controlDirectory)
    this.spawn = options.spawn ?? ((file, args, settings) => nodeSpawn(file, [...args], settings))
    this.signalGroup = options.signalGroup ?? ((child, signal) => {
      try { process.kill(-child.pid!, signal) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    })
    this.settings = {
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 2_000,
      terminateTimeoutMs: options.terminateTimeoutMs ?? 1_000,
      pollIntervalMs: options.pollIntervalMs ?? 50,
      maxInstances: options.maxInstances ?? 32,
      stderrLimitBytes: options.stderrLimitBytes ?? 16 * 1024,
    }
    for (const value of Object.values(this.settings)) if (!Number.isSafeInteger(value) || value <= 0) fail('SSH_INVALID_OPTIONS')
    this.runner = options.runner ?? { run: (file, args, settings) => this.runChild(file, args, settings) }
  }

  start(leaseId: string, port: number): Promise<{ pid: number; controlPath: string }> {
    try {
      validLease(leaseId)
      if (!validPort(port)) fail('SSH_INVALID_PORT')
      if (this.stoppingAll) fail('SSH_STOPPING')
      if (this.recovery) fail('SSH_RECOVERING')
      if (this.pending.has(leaseId) || this.instances.has(leaseId)) fail('SSH_LEASE_EXISTS')
      if (new Set([...this.pending.keys(), ...this.instances.keys()]).size >= this.settings.maxInstances) fail('SSH_CAPACITY')
    } catch (error) { return Promise.reject(error) }
    const pending: Pending = { cancelled: false, promise: Promise.resolve({ pid: 0, controlPath: '' }) }
    this.pending.set(leaseId, pending)
    pending.promise = this.startNew(leaseId, port, pending).finally(() => { this.pending.delete(leaseId) })
    return pending.promise
  }

  async isOwned(leaseId: string): Promise<boolean> {
    const instance = this.instances.get(leaseId)
    if (!instance || instance.exited || instance.stopping) return false
    try {
      const owned = await this.verify(instance, this.settings.commandTimeoutMs)
      return owned && !instance.exited && !instance.stopping && this.instances.get(leaseId) === instance
    } catch { return false }
  }

  async stop(leaseId: string): Promise<void> {
    const pending = this.pending.get(leaseId)
    if (pending) pending.cancelled = true
    const instance = this.instances.get(leaseId)
    if (instance) await this.terminate(instance)
    if (pending) await pending.promise.catch(() => undefined)
    const remaining = this.instances.get(leaseId)
    if (remaining) await this.terminate(remaining)
  }

  async stopAll(): Promise<void> {
    this.stoppingAll = true
    try {
      const results = await Promise.allSettled([...new Set([...this.pending.keys(), ...this.instances.keys()])].map(id => this.stop(id)))
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'SSH_STOP_FAILED')
    } finally { this.stoppingAll = false }
  }

  /**
   * Reconcile private owner records even when a crash prevented the controller from
   * persisting start()'s result. Call before accepting any new Host operations.
   * Missing/corrupt records are not evidence that a child is gone: report failure,
   * retain their files, and never signal a recorded PID. Verified peers are still
   * stopped even if another record is corrupt. Absence of the entire root is the
   * only missing-path case treated as a clean first startup.
   */
  recoverAll(): Promise<void> {
    if (this.recovery) return this.recovery
    if (this.instances.size || this.pending.size || this.stoppingAll) return Promise.reject(new SshError('SSH_LEASE_EXISTS'))
    this.recovery = this.recoverDirectory().finally(() => { this.recovery = undefined })
    return this.recovery
  }

  private async recoverDirectory(): Promise<void> {
    try { await lstat(this.controlDirectory) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      return fail('SSH_OWNERSHIP_UNVERIFIED')
    }
    let root: string
    let entries: string[]
    try {
      root = await this.privateRoot(false)
      entries = await readdir(root)
    } catch { return fail('SSH_OWNERSHIP_UNVERIFIED') }
    // A corrupt/unbounded directory is not permission to launch replacement SSH.
    if (entries.length > 1024) fail('SSH_OWNERSHIP_UNVERIFIED')
    let failed = false
    for (const name of entries) {
      try {
        if (!/^l-[0-9a-f]{16}-[A-Za-z0-9]{6}$/.test(name)) fail('SSH_OWNERSHIP_UNVERIFIED')
        const directory = join(root, name)
        await privateEntry(directory, 'directory')
        const metadata = join(directory, 'owner.json')
        await privateEntry(metadata, 'file')
        if ((await lstat(metadata)).size > 8192) fail('SSH_OWNERSHIP_UNVERIFIED')
        const owner = JSON.parse(await readFile(metadata, 'utf8')) as Partial<Owner> | null
        if (!owner || typeof owner.leaseId !== 'string' || typeof owner.pid !== 'number') throw new SshError('SSH_OWNERSHIP_UNVERIFIED')
        // recover revalidates the complete record, hash-bound path, socket and PID.
        await this.recover({ leaseId: owner.leaseId, controlPath: join(directory, 'ctl'), processId: owner.pid })
      } catch { failed = true }
    }
    if (failed) fail('SSH_OWNERSHIP_UNVERIFIED')
  }

  /** Restart reconciliation closes verified stale masters; it never adopts or respawns them. */
  async recover(input: { leaseId: string; controlPath: string; processId?: number }): Promise<void> {
    validLease(input.leaseId)
    if (this.instances.has(input.leaseId) || this.pending.has(input.leaseId)) fail('SSH_LEASE_EXISTS')
    const root = await this.privateRoot(false)
    const directory = dirname(input.controlPath)
    if (input.controlPath !== resolve(input.controlPath) || basename(input.controlPath) !== 'ctl' || dirname(directory) !== root ||
        !new RegExp('^' + prefix(input.leaseId) + '[A-Za-z0-9]{6}$').test(basename(directory))) fail('SSH_OWNERSHIP_UNVERIFIED')
    await privateEntry(directory, 'directory')
    const metadata = join(directory, 'owner.json')
    await privateEntry(metadata, 'file')
    if ((await lstat(metadata)).size > 8192) fail('SSH_OWNERSHIP_UNVERIFIED')
    let owner: Owner
    try { owner = JSON.parse(await readFile(metadata, 'utf8')) as Owner } catch { return fail('SSH_OWNERSHIP_UNVERIFIED') }
    if (!owner || (owner.version !== undefined && owner.version !== 2) || owner.leaseId !== input.leaseId || owner.sshHost !== this.sshHost || owner.controlPath !== input.controlPath ||
        !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !validPort(owner.port) ||
        (input.processId !== undefined && owner.pid !== input.processId)) fail('SSH_OWNERSHIP_UNVERIFIED')
    if (await this.removeExitedOwnerWithoutSocket(owner, directory)) return
    if (!await this.verify(owner, this.settings.commandTimeoutMs, owner.version === 2)) fail('SSH_OWNERSHIP_UNVERIFIED')
    const result = await this.control(owner.controlPath, 'exit', this.settings.commandTimeoutMs)
    if (result.code !== 0) fail('SSH_STOP_FAILED')
    // We have no ChildProcess handle after restart: never send TERM/KILL to a saved PID.
    // Require the old PID to disappear (PID reuse fails closed rather than killing it).
    const deadline = Date.now() + this.settings.terminateTimeoutMs * 2
    do {
      const ps = await this.command('/bin/ps', ['-p', String(owner.pid), '-o', 'pid='], Math.max(1, deadline - Date.now()))
      if (ps.code === 1 && !ps.stdout.trim() && !ps.stderr.trim()) { await rm(directory, { recursive: true, force: true }); return }
      await delay(Math.min(this.settings.pollIntervalMs, Math.max(1, deadline - Date.now())))
    } while (Date.now() < deadline)
    fail('SSH_STOP_TIMEOUT')
  }

  private async startNew(leaseId: string, port: number, pending: Pending): Promise<{ pid: number; controlPath: string }> {
    const deadline = Date.now() + this.settings.startupTimeoutMs
    let directory: string | undefined
    let instance: Instance | undefined
    const remaining = () => {
      if (pending.cancelled) fail('SSH_START_CANCELLED')
      if (Date.now() >= deadline) fail('SSH_START_TIMEOUT')
      return deadline - Date.now()
    }
    try {
      const root = await this.privateRoot(true)
      remaining()
      directory = await mkdtemp(join(root, prefix(leaseId)))
      const controlPath = join(directory, 'ctl')
      // sockaddr_un is only 104 bytes on macOS; reserve space for OpenSSH's temporary suffix.
      if (Buffer.byteLength(controlPath) > 80) fail('SSH_CONTROL_PATH_TOO_LONG')
      // -F is intentionally absent: OpenSSH, not Companion, interprets the user's configuration.
      // ClearAllForwardings also clears CLI -L, so add the authorized listener later via mux.
      const child = this.spawn(SSH, ['-N', '-T', '-M', '-S', controlPath,
        ...optionsArgv([...SECURITY_OPTIONS, 'ClearAllForwardings=yes']), this.sshHost],
      { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      instance = this.track(child, leaseId, port, directory, controlPath)
      this.instances.set(leaseId, instance)
      if (!Number.isSafeInteger(instance.pid) || instance.pid <= 0) fail('SSH_SPAWN_FAILED')
      const owner: Owner = { version: 2, leaseId, sshHost: this.sshHost, pid: instance.pid, port, controlPath }
      await writeFile(join(directory, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
      let forwardingRequested = false
      while (true) {
        remaining()
        if (instance.exited) fail(exitCode(instance.stderr))
        if (!forwardingRequested && await this.verifyMaster(instance, remaining()).catch(() => false)) {
          remaining()
          if (instance.exited) fail(exitCode(instance.stderr))
          const result = await this.command(SSH, ['-F', '/dev/null', '-S', controlPath, '-O', 'forward',
            ...optionsArgv(SECURITY_OPTIONS), '-L', '127.0.0.1:' + port + ':127.0.0.1:' + port, this.sshHost], remaining())
          remaining()
          if (result.code !== 0) fail(exitCode(Buffer.concat([instance.stderr, Buffer.from(result.stderr)])) === 'SSH_PORT_IN_USE' ? 'SSH_PORT_IN_USE' : 'SSH_FORWARD_FAILED')
          forwardingRequested = true
        }
        if (forwardingRequested && await this.verify(instance, remaining()).catch(() => false)) {
          remaining()
          if (instance.exited) fail(exitCode(instance.stderr))
          instance.ready = true
          return { pid: instance.pid, controlPath }
        }
        await delay(Math.min(this.settings.pollIntervalMs, remaining()))
      }
    } catch (error) {
      if (instance) await this.terminate(instance)
      else if (directory) await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  private track(child: ChildProcess, leaseId: string, port: number, directory: string, controlPath: string): Instance {
    let finishExit!: () => void
    const instance: Instance = { child, leaseId, port, directory, controlPath, pid: child.pid ?? 0,
      exited: false, ready: false, stopping: false, stderr: Buffer.alloc(0),
      exitDone: new Promise<void>(done => { finishExit = done }) }
    child.stdout?.on('data', () => { /* Always drain, never retain tunnel stdout. */ })
    child.stderr?.on('data', chunk => { instance.stderr = append(instance.stderr, chunk, this.settings.stderrLimitBytes) })
    child.on('error', () => { if (!child.pid) { instance.exited = true; finishExit() } })
    // Process exit is the listener-release proof. Descendants may keep inherited stdio
    // pipes open and delay ChildProcess 'close' after the owned SSH master is already gone.
    child.once('exit', () => { instance.exited = true; finishExit() })
    child.once('close', () => {
      instance.exited = true
      finishExit()
      if (instance.ready && !instance.stopping) {
        try { this.onExit?.(leaseId, exitCode(instance.stderr)) } catch { /* Caller owns callback failures. */ }
      }
    })
    return instance
  }

  private terminate(instance: Instance): Promise<void> {
    if (instance.stopPromise) return instance.stopPromise
    instance.stopping = true
    instance.stopPromise = (async () => {
      if (!instance.exited && instance.pid > 0) this.signalGroup(instance.child, 'SIGTERM')
      if (!await waitBounded(instance.exitDone, this.settings.terminateTimeoutMs)) {
        if (!instance.exited && instance.pid > 0) this.signalGroup(instance.child, 'SIGKILL')
        if (!await waitBounded(instance.exitDone, this.settings.terminateTimeoutMs)) fail('SSH_STOP_TIMEOUT')
      }
      await rm(instance.directory, { recursive: true, force: true })
      if (this.instances.get(instance.leaseId) === instance) this.instances.delete(instance.leaseId)
    })()
    // Keep unconfirmed children tracked, and permit a later stop retry.
    void instance.stopPromise.catch(() => { delete instance.stopPromise })
    return instance.stopPromise
  }

  private async removeExitedOwnerWithoutSocket(owner: Owner, directory: string): Promise<boolean> {
    try { await lstat(owner.controlPath); return false }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // ForkAfterAuthentication and ControlPersist are disabled, so a missing master PID
    // proves this socket-less metadata cannot represent a surviving authorized listener.
    const ps = await this.command('/bin/ps', ['-p', String(owner.pid), '-o', 'pid='], this.settings.commandTimeoutMs)
    if (ps.code !== 1 || ps.stdout.trim() || ps.stderr.trim()) return false
    await rm(directory, { recursive: true, force: true })
    return true
  }

  private async verifyMaster(owner: Pick<Owner, 'pid' | 'controlPath'>, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout
    await privateEntry(dirname(owner.controlPath), 'directory')
    await privateEntry(owner.controlPath, 'socket')
    const check = await this.control(owner.controlPath, 'check', Math.max(1, deadline - Date.now()))
    const match = /^Master running \(pid=(\d+)\)\s*$/.exec((check.stderr || check.stdout).trim())
    return check.code === 0 && !!match && Number(match[1]) === owner.pid
  }

  private async verify(owner: Pick<Owner, 'pid' | 'port' | 'controlPath'>, timeout: number, allowAbsentListener = false): Promise<boolean> {
    const deadline = Date.now() + timeout
    if (!await this.verifyMaster(owner, timeout)) return false
    const listeners = await this.command(LSOF,
      ['-nP', '-a', '-p', String(owner.pid), '-iTCP', '-sTCP:LISTEN', '-Fpn'], Math.max(1, deadline - Date.now()))
    if (allowAbsentListener && listeners.code === 1 && !listeners.stdout.trim() && !listeners.stderr.trim()) return true
    if (listeners.code !== 0) return false
    const lines = listeners.stdout.trim().split('\n')
    const pids = lines.filter(line => line.startsWith('p'))
    const names = lines.filter(line => line.startsWith('n'))
    return pids.length === 1 && pids[0] === 'p' + owner.pid && names.length === 1 && names[0] === 'n127.0.0.1:' + owner.port
  }

  private control(path: string, operation: 'check' | 'exit', timeout: number): Promise<SshCommandResult> {
    return this.command(SSH, ['-F', '/dev/null', '-S', path, '-O', operation, ...optionsArgv(SECURITY_OPTIONS), this.sshHost], timeout)
  }

  private async privateRoot(create: boolean): Promise<string> {
    if (create) await mkdir(this.controlDirectory, { recursive: true, mode: 0o700 })
    await privateEntry(this.controlDirectory, 'directory')
    // /tmp -> /private/tmp on macOS is legitimate; the root itself must not be a symlink.
    return realpath(this.controlDirectory)
  }

  private async command(file: string, args: readonly string[], timeout: number): Promise<SshCommandResult> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SshError('SSH_COMMAND_TIMEOUT')) }, Math.min(timeout, this.settings.commandTimeoutMs))
    })
    const task = Promise.resolve().then(() => this.runner.run(file, args, { shell: false, signal: controller.signal, maxOutputBytes: MAX_COMMAND_OUTPUT }))
    try {
      const result = await Promise.race([task, expired])
      if (Buffer.byteLength(result.stdout) > MAX_COMMAND_OUTPUT || Buffer.byteLength(result.stderr) > MAX_COMMAND_OUTPUT) fail('SSH_COMMAND_OUTPUT_LIMIT')
      return result
    } finally {
      if (timer) clearTimeout(timer)
      if (controller.signal.aborted) {
        await waitBounded(task.then(() => undefined, () => undefined), this.settings.terminateTimeoutMs * 2 + 10)
      }
    }
  }

  private runChild(file: string, args: readonly string[], options: SshRunOptions): Promise<SshCommandResult> {
    return new Promise((done, reject) => {
      const child = this.spawn(file, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), size = 0
      let failure: Error | undefined
      let exited = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let reapTimer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        options.signal.removeEventListener('abort', abort)
        if (killTimer) clearTimeout(killTimer)
        if (reapTimer) clearTimeout(reapTimer)
      }
      const abort = () => {
        if (killTimer) return
        failure ??= new SshError('SSH_COMMAND_TIMEOUT')
        killTimer = setTimeout(() => {
          if (!exited) child.kill('SIGKILL')
          reapTimer = setTimeout(() => { cleanup(); reject(new SshError('SSH_STOP_TIMEOUT')) }, this.settings.terminateTimeoutMs)
        }, this.settings.terminateTimeoutMs)
        if (!exited) child.kill('SIGTERM')
      }
      const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
        size = Math.min(options.maxOutputBytes + 1, size + chunk.length)
        if (stream === 'stdout') stdout = append(stdout, chunk, options.maxOutputBytes)
        else stderr = append(stderr, chunk, options.maxOutputBytes)
        if (size > options.maxOutputBytes) { failure = new SshError('SSH_COMMAND_OUTPUT_LIMIT'); abort() }
      }
      child.stdout?.on('data', chunk => capture(chunk as Buffer, 'stdout'))
      child.stderr?.on('data', chunk => capture(chunk as Buffer, 'stderr'))
      child.once('error', error => { failure = error })
      child.once('exit', () => { exited = true })
      child.once('close', code => {
        cleanup()
        if (failure) reject(failure)
        else done({ code: code ?? 1, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
      })
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) abort()
    })
  }
}

async function privateEntry(path: string, kind: 'directory' | 'file' | 'socket'): Promise<void> {
  const stat = await lstat(path)
  const uid = process.getuid?.()
  if (uid === undefined || stat.uid !== uid || stat.isSymbolicLink() ||
      (kind === 'directory' ? !stat.isDirectory() || (stat.mode & 0o777) !== 0o700 :
        kind === 'file' ? !stat.isFile() || (stat.mode & 0o777) !== 0o600 : !stat.isSocket())) fail('SSH_OWNERSHIP_UNVERIFIED')
}
