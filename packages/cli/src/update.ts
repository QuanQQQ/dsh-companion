import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { atomicPrivateWrite, LAUNCH_AGENT_LABEL, parseConfig, type CompanionConfig } from './config.js'
import { launchAgentStatus, renderLaunchAgent, stopLaunchAgent } from './launchd.js'
import { dependencies, verifyNodeRuntime, withInstallLock, withStoppedDaemonLock, type LifecycleDependencies } from './setup.js'

const JOURNAL = 'update-journal.json'
const MAX_BUNDLE = 8 * 1024 * 1024
const MAX_METADATA = 64 * 1024
class ReadChangedError extends Error { constructor() { super('Private file changed during observation') } }
const NOTE = 'Local initialization readiness is not proof of WSS connectivity or online forwarding; legacy rollback proves registration only.'
const PHASES = ['preparing', 'prepared', 'stopping', 'cutover', 'starting', 'restored', 'committed'] as const
type Phase = typeof PHASES[number]
type Dependencies = ReturnType<typeof dependencies> & { readyTimeoutMs: number }
export interface UpdateDependencies extends LifecycleDependencies { readyTimeoutMs?: number }
interface Journal {
  schema: 1
  id: string
  phase: Phase
  uid: number
  rootDev: string
  rootIno: string
  installationId: string
  deviceId: string
  authorityEpoch: string
  configHash: string
  plistHash: string
  oldHash: string
  oldVersion: string
  newHash: string
  targetVersion: string
}
interface Installation {
  config: CompanionConfig
  configHash: string
  plistHash: string
  rootDev: string
  rootIno: string
  bundle: Buffer
}
export interface UpdateResult {
  version: string
  changed: boolean
  recovered: boolean
  registration: 'loaded'
  registrationRepaired?: boolean
  localReady: boolean
  note: string
}

/** Local-only update from the currently running downloaded bundle; never pairs or fetches. */
export async function update(deps: UpdateDependencies = {}): Promise<UpdateResult> {
  const d: Dependencies = { ...dependencies(deps), readyTimeoutMs: deps.readyTimeoutMs ?? 10_000 }
  if (!Number.isSafeInteger(d.readyTimeoutMs) || d.readyTimeoutMs < 1 || d.readyTimeoutMs > 60_000) throw new Error('Invalid bounded readiness timeout')
  if (d.platform !== 'darwin') throw new Error('Companion local update requires macOS')
  numericVersion(d.version)
  validatePaths(d)
  await ownedDirectory(d.paths.root, d.uid)
  return withInstallLock(d.paths, async () => {
    let installed = await installation(d)
    const runtime = await verifyNodeRuntime(installed.config.runtimePath, d.runner)
    if (runtime !== installed.config.runtimePath) throw new Error('Saved Node runtime identity changed; installation retained')
    await rejectDowngrade(d, runtime)
    const journalPath = join(d.paths.root, JOURNAL)
    let recovered = false
    if (await exists(journalPath)) {
      const journal = await loadJournal(d)
      await recover(d, journal, installed)
      recovered = true
      installed = await installation(d)
    }
    const oldVersion = await rejectDowngrade(d, runtime)
    const source = resolve(d.bundleSource)
    if (!source.endsWith('.mjs')) throw new Error('Update requires the downloaded single .mjs bundle')
    await ownedFile(source, d.uid, MAX_BUNDLE, false)
    const candidate = await ownedFile(await realpath(source), d.uid, MAX_BUNDLE, false)
    await registration(d)
    const journal: Journal = {
      schema: 1, id: randomUUID(), phase: 'preparing', uid: d.uid,
      rootDev: installed.rootDev, rootIno: installed.rootIno,
      installationId: installed.config.installationId, deviceId: installed.config.deviceId,
      authorityEpoch: installed.config.authorityEpoch, configHash: installed.configHash, plistHash: installed.plistHash,
      oldHash: digest(installed.bundle), oldVersion, newHash: digest(candidate), targetVersion: d.version,
    }
    await saveJournal(d, journal)
    try {
      await durableBundle(stagePath(d, journal), candidate)
      await durableBundle(backupPath(d, journal), installed.bundle)
      await assertHash(stagePath(d, journal), journal.newHash, d.uid)
      await assertHash(backupPath(d, journal), journal.oldHash, d.uid)
      let probe
      try { probe = await d.runner.run(runtime, [stagePath(d, journal), '--version'], { timeoutMs: 10_000 }) }
      catch { throw new Error('Candidate version probe failed') }
      if (probe.code !== 0 || probe.stdout.trim() !== 'dsh-companion ' + d.version) throw new Error('Candidate version probe failed')
      await assertIdentity(d, journal)
      journal.phase = 'prepared'
      await saveJournal(d, journal)
    } catch {
      // No stop is allowed before the prepared journal is durable.
      try { await cleanupPreStop(d, journal) }
      catch { throw recoveryError() }
      throw new Error('Local update candidate verification failed before stop; original installation retained')
    }

    const beforeStop = await registration(d)
    const alreadyReady = beforeStop === 'loaded' && (!hasReadyContract(d.version) || await localReady(d, d.version, journal.deviceId))
    if (journal.oldHash === journal.newHash && alreadyReady) {
      await cleanup(d, journal)
      return { version: d.version, changed: false, recovered, registration: 'loaded', localReady: hasReadyContract(d.version), note: NOTE }
    }
    journal.phase = 'stopping'
    await saveJournal(d, journal)
    let confirmedStopped = false
    try {
      await stopKnownAgent(d)
      await withStoppedDaemonLock(d.paths, d.uid, d.isProcessAlive, async () => {
        confirmedStopped = true
        await assertIdentity(d, journal)
        await assertHash(d.paths.bundle, journal.oldHash, d.uid)
        await assertHash(backupPath(d, journal), journal.oldHash, d.uid)
        await assertHash(stagePath(d, journal), journal.newHash, d.uid)
        // Write intent before rename; recovery accepts only old/new hashes at the fixed destination.
        journal.phase = 'cutover'
        await saveJournal(d, journal)
        if (journal.oldHash !== journal.newHash) {
          await rename(stagePath(d, journal), d.paths.bundle)
          await syncDirectory(d.paths.root)
        }
      })
    } catch {
      if (!confirmedStopped) throw recoveryError()
      try { await restore(d, journal) }
      catch { throw recoveryError() }
      throw new Error('Update cutover failed; previous bundle restored and LaunchAgent registered. Pairing retained')
    }

    try {
      journal.phase = 'starting'
      await saveJournal(d, journal)
      await bootstrap(d, journal.newHash, journal.targetVersion, journal.deviceId)
      journal.phase = 'committed'
      await saveJournal(d, journal)
    } catch {
      try { await restore(d, journal) }
      catch { throw recoveryError() }
      throw new Error('Update startup failed; previous bundle restored and LaunchAgent registered. Pairing retained; registration is not an online health claim')
    }
    try { await cleanup(d, journal) }
    catch { throw recoveryError() }
    return { version: d.version, changed: journal.oldHash !== journal.newHash, recovered, registration: 'loaded', registrationRepaired: beforeStop === 'not_loaded' || (journal.oldHash === journal.newHash && !alreadyReady), localReady: hasReadyContract(d.version), note: NOTE }
  })
}

async function recover(d: Dependencies, journal: Journal, installed: Installation): Promise<void> {
  matchIdentity(d, journal, installed)
  const current = digest(installed.bundle)
  if (current !== journal.oldHash && current !== journal.newHash) throw recoveryError()
  if ((journal.phase === 'preparing' || journal.phase === 'prepared') && current === journal.oldHash) {
    await registration(d)
    await cleanup(d, journal)
    return
  }
  const completedHash = journal.phase === 'committed' ? journal.newHash : journal.phase === 'restored' ? journal.oldHash : undefined
  const completedVersion = journal.phase === 'committed' ? journal.targetVersion : journal.oldVersion
  if (completedHash && current === completedHash && await registration(d) === 'loaded' &&
      (!hasReadyContract(completedVersion) || await localReady(d, completedVersion, journal.deviceId))) {
    await cleanup(d, journal)
    return
  }
  await restore(d, journal)
}

async function restore(d: Dependencies, journal: Journal): Promise<void> {
  const installed = await assertIdentity(d, journal)
  const current = digest(installed.bundle)
  if (current !== journal.oldHash && current !== journal.newHash) throw recoveryError()
  // Verify recovery authority and original bytes BEFORE stopping a potentially live candidate.
  await assertHash(backupPath(d, journal), journal.oldHash, d.uid)
  await stopKnownAgent(d)
  await withStoppedDaemonLock(d.paths, d.uid, d.isProcessAlive, async () => {
    const latest = await assertIdentity(d, journal)
    if (![journal.oldHash, journal.newHash].includes(digest(latest.bundle))) throw recoveryError()
    const original = await assertHash(backupPath(d, journal), journal.oldHash, d.uid)
    await durableBundle(d.paths.bundle, original)
    journal.phase = 'restored'
    await saveJournal(d, journal)
  })
  // Reclaim mutex must be released before launchd starts a daemon that acquires it.
  await bootstrap(d, journal.oldHash, journal.oldVersion, journal.deviceId)
  await cleanup(d, journal)
}

function numericVersion(value: string): number[] {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value)
  if (!match) throw new Error('Companion update requires a verifiable numeric release version')
  const parts = match.slice(1).map(Number)
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Companion version is invalid')
  return parts
}
async function rejectDowngrade(d: Dependencies, runtime: string): Promise<string> {
  let probe
  try { probe = await d.runner.run(runtime, [d.paths.bundle, '--version'], { timeoutMs: 10_000 }) }
  catch { throw new Error('Installed Companion version is unverifiable; installation retained') }
  if (probe.code !== 0 || !probe.stdout.trim().startsWith('dsh-companion ')) throw new Error('Installed Companion version is unverifiable; installation retained')
  const installedText = probe.stdout.trim().slice('dsh-companion '.length)
  const installed = numericVersion(installedText)
  const candidate = numericVersion(d.version)
  for (let i = 0; i < 3; i++) {
    if (installed[i]! > candidate[i]!) throw new Error('Refusing local Companion downgrade; installed version is newer')
    if (installed[i]! < candidate[i]!) return installedText
  }
  return installedText
}

async function bootstrap(d: Dependencies, expectedHash: string, version: string, deviceId: string): Promise<void> {
  await assertHash(d.paths.bundle, expectedHash, d.uid)
  const baseline = hasReadyContract(version) ? (await statusValue(d))?.bootId : undefined
  let result
  try { result = await d.runner.run('/bin/launchctl', ['bootstrap', 'gui/' + d.uid, d.paths.launchAgent]) }
  catch { throw new Error('LaunchAgent bootstrap failed') }
  if (result.code !== 0 || await registration(d) !== 'loaded') throw new Error('LaunchAgent registration verification failed')
  if (hasReadyContract(version)) await waitForReady(d, version, deviceId, typeof baseline === 'string' ? baseline : undefined)
  await assertHash(d.paths.bundle, expectedHash, d.uid)
}

function hasReadyContract(version: string): boolean {
  const [major, minor, patch] = numericVersion(version)
  return major! > 0 || minor! > 1 || (minor === 1 && patch! >= 3)
}
async function statusValue(d: Dependencies): Promise<Record<string, unknown> | undefined> {
  const path = join(d.paths.root, 'daemon-status.json')
  if (!await exists(path)) return undefined
  let text: string
  try { text = (await ownedFile(path, d.uid, 16 * 1024)).toString('utf8') }
  catch (error) { if (error instanceof ReadChangedError) return undefined; throw error }
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}
async function localReady(d: Dependencies, version: string, deviceId: string, previousBootId?: string): Promise<boolean> {
  const state = await statusValue(d)
  if (!state || state.companionVersion !== version || state.deviceId !== deviceId ||
      typeof state.bootId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state.bootId) || state.bootId === previousBootId ||
      !Number.isSafeInteger(state.pid) || Number(state.pid) < 1 ||
      !['ready', 'connecting', 'connected', 'reconnecting', 'needs_attention'].includes(String(state.state))) return false
  const lock = join(d.paths.root, 'daemon.lock')
  if (!await exists(lock)) return false
  await ownedDirectory(lock, d.uid)
  try {
    const pid = (await ownedFile(join(lock, 'pid'), d.uid, 128)).toString('utf8')
    const nonce = (await ownedFile(join(lock, 'nonce'), d.uid, 128)).toString('utf8')
    if (pid !== String(state.pid) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(nonce)) return false
    return d.isProcessAlive(Number(state.pid))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function waitForReady(d: Dependencies, version: string, deviceId: string, previousBootId?: string): Promise<void> {
  const deadline = performance.now() + d.readyTimeoutMs
  do {
    if (await localReady(d, version, deviceId, previousBootId)) return
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, remaining)))
  } while (performance.now() <= deadline)
  throw new Error('Companion local initialization readiness timed out; WSS health was not tested')
}

async function stopKnownAgent(d: Dependencies): Promise<void> {
  const state = await registration(d)
  if (state === 'loaded') {
    try { await stopLaunchAgent(d.paths, d.runner, d.uid) }
    catch { throw recoveryError() }
  }
  if (await registration(d) !== 'not_loaded') throw recoveryError()
}
async function registration(d: Dependencies): Promise<'loaded' | 'not_loaded'> {
  let state
  try { state = await launchAgentStatus(d.runner, d.uid) }
  catch { throw new Error('LaunchAgent registration is unverifiable; installation retained') }
  if (state === 'unknown') throw new Error('LaunchAgent registration is unknown; installation retained')
  return state
}

function validatePaths(d: Dependencies): void {
  for (const path of [d.paths.root, d.paths.bundle, d.paths.config, d.paths.runtimeState, d.paths.launchAgent]) {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Unsafe installation paths')
  }
  if (d.paths.bundle !== join(d.paths.root, 'dsh-companion.mjs') || d.paths.config !== join(d.paths.root, 'config.json') ||
      d.paths.runtimeState !== join(d.paths.root, 'runtime-state.json') || basename(d.paths.launchAgent) !== LAUNCH_AGENT_LABEL + '.plist') {
    throw new Error('Unexpected installation path contract')
  }
}
async function installation(d: Dependencies): Promise<Installation> {
  try {
    const root = await ownedDirectory(d.paths.root, d.uid)
    const rawConfig = await ownedFile(d.paths.config, d.uid, MAX_METADATA)
    const config = parseConfig(JSON.parse(rawConfig.toString('utf8')))
    const plist = await ownedFile(d.paths.launchAgent, d.uid, MAX_METADATA)
    if (plist.toString('utf8') !== renderLaunchAgent(d.paths, config.runtimePath)) throw new Error('Unexpected plist contract')
    const bundle = await ownedFile(d.paths.bundle, d.uid, MAX_BUNDLE)
    if (await exists(d.paths.runtimeState)) await ownedFile(d.paths.runtimeState, d.uid, MAX_BUNDLE)
    return { config, bundle, configHash: digest(rawConfig), plistHash: digest(plist), rootDev: root.dev.toString(), rootIno: root.ino.toString() }
  } catch { throw new Error('Complete private owned installation and exact LaunchAgent contract are required; installation retained') }
}
async function assertIdentity(d: Dependencies, journal: Journal): Promise<Installation> {
  const installed = await installation(d)
  matchIdentity(d, journal, installed)
  return installed
}
function matchIdentity(d: Dependencies, journal: Journal, installed: Installation): void {
  if (journal.uid !== d.uid || journal.rootDev !== installed.rootDev || journal.rootIno !== installed.rootIno ||
      journal.installationId !== installed.config.installationId || journal.deviceId !== installed.config.deviceId ||
      journal.authorityEpoch !== installed.config.authorityEpoch || journal.configHash !== installed.configHash || journal.plistHash !== installed.plistHash) {
    throw new Error('Update journal identity does not match installation; recovery retained')
  }
}

async function loadJournal(d: Dependencies): Promise<Journal> {
  try {
    const value: unknown = JSON.parse((await ownedFile(join(d.paths.root, JOURNAL), d.uid, 16 * 1024)).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw recoveryError()
    const record = value as Record<string, unknown>
    const keys = ['schema', 'id', 'phase', 'uid', 'rootDev', 'rootIno', 'installationId', 'deviceId', 'authorityEpoch', 'configHash', 'plistHash', 'oldHash', 'oldVersion', 'newHash', 'targetVersion']
    if (Object.keys(record).sort().join(',') !== keys.sort().join(',')) throw recoveryError()
    if (record.schema !== 1 || !Number.isSafeInteger(record.uid) || Number(record.uid) < 0 ||
        typeof record.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record.id) ||
        !PHASES.includes(record.phase as Phase)) throw recoveryError()
    for (const key of ['rootDev', 'rootIno', 'installationId', 'deviceId', 'authorityEpoch', 'oldVersion', 'targetVersion']) {
      if (typeof record[key] !== 'string' || !(record[key] as string).length || (record[key] as string).length > 1024 || /[\x00-\x1f\x7f]/.test(record[key] as string)) throw recoveryError()
    }
    for (const key of ['configHash', 'plistHash', 'oldHash', 'newHash']) if (typeof record[key] !== 'string' || !/^[0-9a-f]{64}$/.test(record[key] as string)) throw recoveryError()
    numericVersion(record.oldVersion as string)
    numericVersion(record.targetVersion as string)
    return record as unknown as Journal
  } catch { throw new Error('Update journal is invalid or unsafe; recovery retained') }
}
async function saveJournal(d: Dependencies, journal: Journal): Promise<void> {
  const text = JSON.stringify(journal) + '\n'
  if (Buffer.byteLength(text) > 16 * 1024) throw recoveryError()
  await atomicPrivateWrite(join(d.paths.root, JOURNAL), text)
}
async function cleanupPreStop(d: Dependencies, journal: Journal): Promise<void> {
  const installed = await assertIdentity(d, journal)
  if (digest(installed.bundle) !== journal.oldHash) throw recoveryError()
  await cleanup(d, journal)
}
async function cleanup(d: Dependencies, journal: Journal): Promise<void> {
  await assertIdentity(d, journal)
  for (const [path, hash] of [[stagePath(d, journal), journal.newHash], [backupPath(d, journal), journal.oldHash]] as const) {
    if (await exists(path)) { await assertHash(path, hash, d.uid); await rm(path) }
  }
  await rm(join(d.paths.root, JOURNAL))
  await syncDirectory(d.paths.root)
}
function stagePath(d: Dependencies, journal: Journal): string { return join(d.paths.root, '.update-' + journal.id + '.mjs') }
function backupPath(d: Dependencies, journal: Journal): string { return join(d.paths.root, '.backup-' + journal.id + '.mjs') }
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function recoveryError(): Error { return new Error('Update safety or startup is uncertain; original backup and recovery journal retained. Rerun downloaded CLI update after resolving the reported lifecycle/lock failure') }
async function assertHash(path: string, hash: string, uid: number): Promise<Buffer> {
  const bytes = await ownedFile(path, uid, MAX_BUNDLE)
  if (digest(bytes) !== hash) throw new Error('Update recovery hash mismatch; recovery retained')
  return bytes
}
async function ownedDirectory(path: string, uid: number) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(uid) || (Number(info.mode) & 0o077) !== 0) throw new Error('Private owned installation directory required')
  return info
}
async function ownedFile(path: string, uid: number, limit: number, privateMode = true): Promise<Buffer> {
  const info = await lstat(path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.uid !== BigInt(uid) ||
      (Number(info.mode) & (privateMode ? 0o077 : 0o022)) !== 0 || info.size > BigInt(limit)) throw new Error('Unsafe private installation or recovery file')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (opened.uid !== BigInt(uid) || opened.nlink > 1n || (Number(opened.mode) & (privateMode ? 0o077 : 0o022)) !== 0) throw new Error('Unsafe private installation or recovery file')
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new ReadChangedError()
    const data = Buffer.alloc(limit + 1)
    let length = 0
    while (length <= limit) {
      const result = await handle.read(data, length, data.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (after.uid !== BigInt(uid) || after.nlink > 1n || (Number(after.mode) & (privateMode ? 0o077 : 0o022)) !== 0) throw new Error('Unsafe private installation or recovery file')
    if (length > limit || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.nlink !== 1n || length !== Number(info.size)) throw new ReadChangedError()
    return data.subarray(0, length)
  } finally { await handle.close() }
}
async function durableBundle(path: string, bytes: Buffer): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    const file = await open(temporary, 'wx', 0o700)
    try { await file.writeFile(bytes); await file.chmod(0o700); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally { await rm(temporary, { force: true }) }
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
