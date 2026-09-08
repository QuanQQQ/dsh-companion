import { access, lstat, mkdir, open, readdir, readFile, realpath, rm, rmdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { arch, hostname, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { absoluteRuntimePath, companionPaths, createInstallationId, normalizeServerUrl, readConfig, validateSshHost, writeConfig, type CompanionConfig, type CompanionPaths } from './config.js'
import { systemCommandRunner, type CommandRunner } from './command.js'
import { MacKeychain } from './keychain.js'
import { VERSION } from './version.js'
import { currentUid, installBundle, installLaunchAgent, launchAgentStatus, stopLaunchAgent } from './launchd.js'

export interface CredentialStore {
  store(deviceId: string, token: string): Promise<void>
  read(deviceId: string): Promise<string>
  remove(deviceId: string): Promise<void>
}
export interface SetupOptions {
  serverUrl: string
  sshHost: string
  pairCode: string
  name?: string
  runtimePath?: string
  allowInsecureHttp?: boolean
}
export interface LifecycleDependencies {
  paths?: CompanionPaths
  runner?: CommandRunner
  keychain?: CredentialStore
  fetch?: typeof globalThis.fetch
  bundleSource?: string
  platform?: NodeJS.Platform
  uid?: number
  version?: string
  isProcessAlive?: (pid: number) => boolean
}

/** Requires an externally installed Node 22+; the package does not contain a native runtime. */
export async function verifyNodeRuntime(path: string, runner: CommandRunner = systemCommandRunner): Promise<string> {
  absoluteRuntimePath(path)
  const resolved = await realpath(path)
  await access(resolved, constants.X_OK)
  const result = await runner.run(resolved, ['--version'])
  const match = /^v(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/.exec(result.stdout)
  if (result.code !== 0 || !match || Number(match[1]) < 22) throw new Error('An installed Node.js 22 or newer runtime is required (not bundled)')
  return resolved
}

export async function setup(options: SetupOptions, deps: LifecycleDependencies = {}): Promise<CompanionConfig> {
  const d = dependencies(deps)
  requireMac(d.platform)
  const serverUrl = normalizeServerUrl(options.serverUrl, options.allowInsecureHttp)
  const sshHost = validateSshHost(options.sshHost)
  const code = required(options.pairCode, 'pair code', 256)
  const name = required(options.name ?? hostname(), 'Device name', 256)
  const runtimePath = await verifyNodeRuntime(options.runtimePath ?? process.execPath, d.runner)
  const source = await realpath(d.bundleSource)
  if (!source.endsWith('.mjs')) throw new Error('Run setup from the built single .mjs bundle, not TypeScript source')
  await access(source, constants.R_OK)
  return withInstallLock(d.paths, async () => {
    if (await exists(join(d.paths.root, 'rebind-journal.json'))) throw new Error('An interrupted pairing transition needs recovery; rerun the unified launch command')
    if (await exists(join(d.paths.root, 'update-journal.json'))) throw new Error('An interrupted update needs recovery; run update from the downloaded CLI before setup')
    for (const path of [d.paths.config, d.paths.bundle, d.paths.launchAgent, d.paths.runtimeState, join(d.paths.root, 'daemon-status.json'), join(d.paths.root, 'daemon.lock'), join(d.paths.root, 'daemon.lock.reclaim')]) {
      if (await exists(path)) throw new Error('Existing or partial Companion installation found; setup will not overwrite it. Inspect status and uninstall explicitly first')
    }
    const state = await launchAgentStatus(d.runner, d.uid)
    if (state !== 'not_loaded') throw new Error('Existing or unverifiable LaunchAgent; refusing setup without changing it')
    let paired: PairingResponse | undefined
    let pairingAttempted = false
    let credentialStored = false
    let credentialAttempted = false
    let bundleInstalled = false
    let configWritten = false
    let launchAttempted = false
    try {
      // Copy before consuming a one-time ticket so a bad source cannot strand pairing.
      await installBundle(source, d.paths.bundle)
      bundleInstalled = true
      const installationId = createInstallationId()
      pairingAttempted = true
      paired = await pair(d.fetch, serverUrl, {
        code, installationId, name, osVersion: release(), architecture: arch(), companionVersion: d.version,
        capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true },
      })
      credentialAttempted = true
      await d.keychain.store(paired.device.id, paired.token)
      credentialStored = true
      const config: CompanionConfig = {
        version: 1, serverUrl, sshHost, installationId, deviceId: paired.device.id,
        authorityEpoch: paired.authorityEpoch, runtimePath, installedAt: new Date().toISOString(),
        allowInsecureHttp: options.allowInsecureHttp === true,
      }
      configWritten = true
      await writeConfig(d.paths.config, config)
      launchAttempted = true
      await installLaunchAgent(d.paths, runtimePath, d.runner, d.uid)
      return config
    } catch (error) {
      const pending: string[] = []
      if (credentialAttempted && !credentialStored) pending.push('Keychain storage/verification did not complete; inspect the Device credential for partial creation')
      let stopped = true
      if (launchAttempted) {
        try { await stopLaunchAgent(d.paths, d.runner, d.uid) }
        catch { stopped = false; pending.push('LaunchAgent stop failed; local files and credential retained for recovery') }
      }
      if (stopped) {
        if (credentialStored && paired) {
          try { await d.keychain.remove(paired.device.id) }
          catch { stopped = false; pending.push('Keychain credential removal failed; local recovery files retained') }
        }
        for (const [owned, path] of [[launchAttempted, d.paths.launchAgent], [configWritten, d.paths.config], [bundleInstalled, d.paths.bundle]] as const) {
          if (stopped && owned) try { await rm(path, { force: true }) } catch { pending.push('Local file cleanup failed: ' + path) }
        }
      }
      // Neither a timeout nor local rollback can unconsume a ticket or revoke a Host Device.
      const remote = pairingAttempted ? ' Host pairing may have been created; revoke the Device in DSH and obtain a new pair code before retrying.' : ''
      const reason = error instanceof Error ? error.message : 'unknown failure'
      throw new Error('Setup failed: ' + reason + '. ' + (pending.length ? 'Partial rollback: ' + pending.join('; ') : 'Local rollback completed') + remote)
    }
  })
}

export async function uninstall(deps: LifecycleDependencies = {}): Promise<void> {
  const d = dependencies(deps)
  requireMac(d.platform)
  await withInstallLock(d.paths, async () => {
    if (await exists(join(d.paths.root, 'rebind-journal.json'))) throw new Error('An interrupted pairing transition needs recovery; rerun the unified launch command')
    if (await exists(join(d.paths.root, 'update-journal.json'))) throw new Error('An interrupted update needs recovery; run update from the downloaded CLI before uninstall')
    const config = await readConfig(d.paths.config)
    await stopLaunchAgent(d.paths, d.runner, d.uid)
    await withStoppedDaemonLock(d.paths, d.uid, d.isProcessAlive, async () => {
      // Retain config if Keychain deletion fails: a later uninstall can retry the same id.
      await d.keychain.remove(config.deviceId)
      for (const path of [d.paths.launchAgent, d.paths.bundle, d.paths.runtimeState, join(d.paths.root, 'daemon-status.json'), d.paths.config]) await rm(path, { force: true })
      // Logs and controlDirectory are retained; only a verified daemon.lock is removed recursively.
    })
  })
}

export async function status(deps: LifecycleDependencies = {}): Promise<Record<string, unknown>> {
  const d = dependencies(deps)
  const installed = await exists(d.paths.config)
  const config = installed ? await readConfig(d.paths.config) : undefined
  const agent = d.platform === 'darwin' ? await launchAgentStatus(d.runner, d.uid) : 'unsupported_platform'
  // launchctl loaded != online/reconciled. Never print credentials or raw daemon logs.
  return { installed, launchAgent: agent, bundlePresent: await exists(d.paths.bundle),
    runtime: 'external Node.js 22+', runtimePath: config?.runtimePath,
    deviceId: config?.deviceId, authorityEpoch: config?.authorityEpoch, serverUrl: config?.serverUrl,
    configPath: d.paths.config, logDirectory: d.paths.logDirectory,
    daemonObservation: await readDaemonObservation(join(d.paths.root, 'daemon-status.json'), config?.deviceId),
    note: 'Persisted daemon observation may be stale; loaded does not mean connected. Restart preserves reconnect budget.' }
}

export async function withStoppedDaemonLock<T>(paths: CompanionPaths, uid: number, alive: (pid: number) => boolean, action: () => Promise<T>): Promise<T> {
  const recovery = 'Daemon lock ownership or liveness is uncertain; installation retained. Inspect daemon.lock and daemon.lock.reclaim for manual recovery'
  const root = await lstat(paths.root)
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== uid || (root.mode & 0o077) !== 0) throw new Error(recovery)
  const lockPath = join(paths.root, 'daemon.lock')
  const reclaimPath = join(paths.root, 'daemon.lock.reclaim')
  // Use the daemon's own acquisition mutex. Never reclaim an existing mutex:
  // it may belong to a live acquisition, or need operator recovery after a crash.
  try { await mkdir(reclaimPath, { mode: 0o700 }) }
  catch { throw new Error('daemon.lock.reclaim exists or cannot be acquired; installation retained. Inspect it for manual recovery') }
  const mutex = await lstat(reclaimPath)
  try {
    if (await exists(lockPath)) {
      const lock = await lstat(lockPath)
      if (!lock.isDirectory() || lock.isSymbolicLink() || lock.uid !== uid || (lock.mode & 0o077) !== 0) throw new Error(recovery)
      const names = (await readdir(lockPath)).sort()
      if (names.join(',') !== 'nonce,pid') throw new Error(recovery)
      for (const name of names) {
        const info = await lstat(join(lockPath, name))
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > 64) throw new Error(recovery)
      }
      const pidText = await readFile(join(lockPath, 'pid'), 'utf8')
      const nonce = await readFile(join(lockPath, 'nonce'), 'utf8')
      const pid = Number(pidText)
      if (pidText !== pidText.trim() || nonce !== nonce.trim() || !/^[1-9][0-9]*$/.test(pidText) || !Number.isSafeInteger(pid) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(nonce)) throw new Error(recovery)
      try { if (alive(pid)) throw new Error(recovery) } catch { throw new Error(recovery) }
      // Fail closed if ownership changed during the signal-0 probe. Never stop a process by saved PID.
      const current = await lstat(lockPath)
      if (current.dev !== lock.dev || current.ino !== lock.ino || await readFile(join(lockPath, 'nonce'), 'utf8') !== nonce) throw new Error(recovery)
      await rm(lockPath, { recursive: true })
    }
    return await action()
  } finally {
    const current = await lstat(reclaimPath)
    if (current.dev !== mutex.dev || current.ino !== mutex.ino) throw new Error(recovery)
    // Only remove our still-owned empty mutex, never recurse into a foreign directory.
    await rmdir(reclaimPath)
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}

async function readDaemonObservation(path: string, deviceId?: string): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'invalid' }
    const value = raw as Record<string, unknown>
    const states = ['needs_pairing', 'ready', 'connected', 'reconnecting', 'needs_attention', 'cleanup_failed', 'stopped', 'starting', 'connecting']
    if (value.deviceId !== deviceId || typeof value.state !== 'string' || !states.includes(value.state)) return { state: 'invalid_or_different_device' }
    return { state: value.state, ...(value.pairingRequired === true ? { pairingRequired: true, action: 'Run unified launch and approve this Mac on the intended Host' } : {}), reconnectAttempts: Number.isSafeInteger(value.reconnectAttempts) ? value.reconnectAttempts : null,
      pid: Number.isSafeInteger(value.pid) ? value.pid : null,
      ...(typeof value.companionVersion === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.companionVersion) ? { companionVersion: value.companionVersion } : {}),
      ...(typeof value.bootId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.bootId) ? { bootId: value.bootId } : {}),
      updatedAt: typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) ? new Date(value.updatedAt).toISOString() : null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { state: 'unreadable' }
  }
}

interface PairingResponse { device: { id: string }; token: string; authorityEpoch: string }
async function pair(fetcher: typeof globalThis.fetch, serverUrl: string, body: unknown): Promise<PairingResponse> {
  let response: Response
  try { response = await fetcher(serverUrl + '/api/companion/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  }) } catch { throw new Error('Pairing request failed (network, redirect, or timeout)') }
  if (!response.ok) throw new Error('Pairing refused (HTTP ' + response.status + ')')
  let value: unknown
  try { value = await response.json() } catch { throw new Error('Invalid pairing response') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pairing response')
  const record = value as Record<string, unknown>
  const device = record.device as Record<string, unknown> | undefined
  if (record.ok !== true || !device) throw new Error('Invalid pairing response')
  return { device: { id: required(device.id, 'Device id', 256) },
    token: required(record.token, 'Device token', 1_024), authorityEpoch: required(record.authorityEpoch, 'authority epoch', 256) }
}
function required(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid ' + field)
  return value
}
export function dependencies(deps: LifecycleDependencies) {
  const runner = deps.runner ?? systemCommandRunner
  return { paths: deps.paths ?? companionPaths(), runner, keychain: deps.keychain ?? new MacKeychain(runner),
    fetch: deps.fetch ?? globalThis.fetch, bundleSource: deps.bundleSource ?? fileURLToPath(import.meta.url),
    platform: deps.platform ?? process.platform, uid: deps.uid ?? currentUid(), version: deps.version ?? VERSION,
    isProcessAlive: deps.isProcessAlive ?? processAlive }
}
function requireMac(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') throw new Error('Companion setup/install/uninstall requires macOS and external Node.js 22+')
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
export async function withInstallLock<T>(paths: CompanionPaths, action: () => Promise<T>): Promise<T> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  const path = join(paths.root, '.install.lock')
  let lock
  try { lock = await open(path, 'wx', 0o600) }
  catch { throw new Error('Another install/uninstall or stale .install.lock exists; inspect before retrying') }
  try { return await action() }
  finally { await lock.close(); await rm(path, { force: true }) }
}
