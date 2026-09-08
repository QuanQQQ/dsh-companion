import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, realpath, rm } from 'node:fs/promises'
import { arch, hostname, release } from 'node:os'
import { join } from 'node:path'
import { atomicPrivateWrite, createInstallationId, LAUNCH_AGENT_LABEL, normalizeServerUrl, parseConfig, validateSshHost, type CompanionConfig } from './config.js'
import { dependencies, setup, withInstallLock, withStoppedDaemonLock, type LifecycleDependencies } from './setup.js'
import { launchAgentStatus, renderLaunchAgent, stopLaunchAgent, waitForLaunchAgentStop } from './launchd.js'
import { update, type UpdateDependencies, type UpdateResult } from './update.js'

export interface LaunchOptions { serverUrl: string; allowInsecureHttp?: boolean; sshHost?: string; runtimePath?: string; name?: string }
export interface RepairPrompt { reason: 'host_changed' | 'authority_reset' | 'credential_invalid' | 'credential_unavailable'; oldServer: string; newServer: string }
export interface LaunchDependencies extends LifecycleDependencies {
  promptSshHost?: (current?: string) => Promise<string>
  confirmRepair?: (prompt: RepairPrompt) => Promise<boolean>
  showApproval?: (approval: { serverUrl: string; userCode: string; expiresAt: string }) => void | Promise<void>
  update?: (deps: UpdateDependencies) => Promise<UpdateResult>
  pollIntervalMs?: number
  enrollmentTimeoutMs?: number
  readyTimeoutMs?: number
  stopTimeoutMs?: number
  signal?: AbortSignal
}
export interface LaunchResult { action: 'installed' | 'updated' | 'rebound'; config: CompanionConfig }
type Dependencies = ReturnType<typeof dependencies> & LaunchDependencies
interface Pairing { device: { id: string }; token: string; authorityEpoch: string }
const REBIND_JOURNAL = 'rebind-journal.json'

export async function launch(options: LaunchOptions, deps: LaunchDependencies = {}): Promise<LaunchResult> {
  const d: Dependencies = { ...deps, ...dependencies(deps) }
  d.stopTimeoutMs ??= 10_000
  if (!Number.isSafeInteger(d.stopTimeoutMs) || d.stopTimeoutMs < 1 || d.stopTimeoutMs > 60_000) throw new Error('Invalid bounded stop timeout')
  if (d.platform !== 'darwin') throw new Error('Companion launch requires macOS')
  const serverUrl = normalizeServerUrl(options.serverUrl, options.allowInsecureHttp)
  d.signal?.throwIfAborted()
  if (await exists(d.paths.root)) await ownedDirectory(d.paths.root, d.uid)
  if (await exists(join(d.paths.root, REBIND_JOURNAL))) await withInstallLock(d.paths, () => recoverRebind(d))
  let previous: CompanionConfig | undefined
  let previousHash: string | undefined
  if (await exists(d.paths.config)) {
    await ownedDirectory(d.paths.root, d.uid)
    const original = await privateText(d.paths.config, d.uid)
    previous = parseConfig(JSON.parse(original))
    previousHash = hash(original)
  }
  if (previous && options.runtimePath !== undefined && await realpath(options.runtimePath) !== previous.runtimePath) throw new Error('Existing Node runtime cannot be silently replaced during launch')
  if (previous && previous.serverUrl === serverUrl && options.sshHost !== undefined && validateSshHost(options.sshHost) !== previous.sshHost) throw new Error('Existing SSH alias cannot be silently retargeted during launch')
  const identity = await jsonRequest(d, serverUrl, '/api/companion/identity')
  const authorityEpoch = text(identity.authorityEpoch, 'Host identity')
  if (!previous) {
    const sshHost = await sshAlias(options, d)
    const config = await setup({ serverUrl, sshHost,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.runtimePath === undefined ? {} : { runtimePath: options.runtimePath }),
      ...(options.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: options.allowInsecureHttp }),
      pairCode: 'browser-approved-enrollment' }, {
      ...d, fetch: async (input, init) => {
        if (String(input) !== serverUrl + '/api/companion/pair' || init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('Unexpected enrollment adapter request')
        const body = JSON.parse(init.body) as Record<string, unknown>
        const pairing = await enroll(d, serverUrl, authorityEpoch, text(body.installationId, 'installation id'), text(body.name, 'Device name'))
        return Response.json({ ok: true, ...pairing })
      },
    })
    const installedText = await privateText(d.paths.config, d.uid)
    if (JSON.stringify(parseConfig(JSON.parse(installedText))) !== JSON.stringify(parseConfig(config))) throw new Error('Fresh installation changed before startup verification')
    await (d.update ?? update)({ ...d, forceRestart: true, expectedConfigHash: hash(installedText) })
    d.signal?.throwIfAborted()
    return { action: 'installed', config }
  }
  let reason: RepairPrompt['reason'] | undefined
  if (previous.serverUrl !== serverUrl) reason = 'host_changed'
  else if (previous.authorityEpoch !== authorityEpoch) reason = 'authority_reset'
  else {
    let token: string | undefined
    try { token = text(await d.keychain.read(previous.deviceId), 'Device credential') }
    catch { reason = 'credential_unavailable' }
    if (token) {
      const verified = await jsonRequest(d, serverUrl, '/api/companion/device/verify', {}, token, true)
      if (verified.unauthorized === true) reason = 'credential_invalid'
      else if (verified.deviceId !== previous.deviceId || verified.authorityEpoch !== previous.authorityEpoch) throw new Error('Host verification identity mismatch; existing pairing retained')
    }
  }
  if (!reason) {
    await (d.update ?? update)({ ...d, forceRestart: true, expectedConfigHash: previousHash! })
    d.signal?.throwIfAborted()
    const result = await d.runner.run('/bin/launchctl', ['kill', 'SIGHUP', 'gui/' + d.uid + '/' + LAUNCH_AGENT_LABEL])
    if (result.code !== 0) throw new Error('Companion updated but could not request reconnection; pairing retained')
    return { action: 'updated', config: previous }
  }
  if (!await d.confirmRepair?.({ reason, oldServer: previous.serverUrl, newServer: serverUrl })) throw new Error('Pairing replacement not approved; existing installation retained')
  const sshHost = await sshAlias(options, d, previous.sshHost)
  const installationId = createInstallationId()
  const pairing = await enroll(d, serverUrl, authorityEpoch, installationId, text(options.name ?? hostname(), 'Device name', 256))
  if (pairing.device.id === previous.deviceId) throw new Error('New approval reused the existing Device id; old credential retained')
  d.signal?.throwIfAborted()
  await (d.update ?? update)({ ...d, forceRestart: true, expectedConfigHash: previousHash! })
  const config = parseConfig({ version: 1, serverUrl, sshHost, installationId,
    deviceId: pairing.device.id, authorityEpoch: pairing.authorityEpoch, runtimePath: previous.runtimePath,
    installedAt: new Date().toISOString(), allowInsecureHttp: options.allowInsecureHttp === true })
  await rebind(d, previous, previousHash!, config, pairing.token)
  return { action: 'rebound', config }
}

type BackupKey = 'config' | 'runtime' | 'status'
interface RebindJournal {
  schema: 1; id: string; uid: number; rootDev: string; rootIno: string
  phase: 'prepared' | 'switching' | 'committed' | 'rolled_back'
  oldConfig: CompanionConfig; newConfig: CompanionConfig
  oldConfigHash: string; newConfigHash: string; bundleHash: string; bundleVersion: string; plistHash: string; newTokenHash: string
  backups: Record<BackupKey, string | null>
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function backupPath(d: Dependencies, j: RebindJournal, key: BackupKey): string { return join(d.paths.root, '.rebind-' + j.id + '-' + key + '.bak') }
function journalPath(d: Dependencies): string { return join(d.paths.root, REBIND_JOURNAL) }
function destination(d: Dependencies, key: BackupKey): string { return key === 'config' ? d.paths.config : key === 'runtime' ? d.paths.runtimeState : join(d.paths.root, 'daemon-status.json') }
async function saveRebind(d: Dependencies, journal: RebindJournal): Promise<void> { await atomicPrivateWrite(journalPath(d), JSON.stringify(journal)) }
async function completeInstallation(d: Dependencies, expectedHash?: string): Promise<{ root: Awaited<ReturnType<typeof ownedDirectory>>; config: string; bundle: string; plist: string }> {
  const root = await ownedDirectory(d.paths.root, d.uid)
  if (d.paths.config !== join(d.paths.root, 'config.json') || d.paths.bundle !== join(d.paths.root, 'dsh-companion.mjs') || d.paths.runtimeState !== join(d.paths.root, 'runtime-state.json')) throw new Error('Unsafe Companion installation paths')
  const config = await privateText(d.paths.config, d.uid)
  if (expectedHash !== undefined && hash(config) !== expectedHash) throw new Error('Existing pairing changed while waiting; launch cancelled without replacing it')
  const parsed = parseConfig(JSON.parse(config))
  const bundle = await privateText(d.paths.bundle, d.uid)
  const plist = await privateText(d.paths.launchAgent, d.uid)
  if (plist !== renderLaunchAgent(d.paths, parsed.runtimePath)) throw new Error('LaunchAgent contract does not match the owned installation')
  return { root, config, bundle, plist }
}
async function rebind(d: Dependencies, previous: CompanionConfig, previousHash: string, config: CompanionConfig, token: string): Promise<void> {
  await withInstallLock(d.paths, async () => {
    d.signal?.throwIfAborted()
    if (await exists(journalPath(d)) || await exists(join(d.paths.root, 'update-journal.json'))) throw new Error('A previous lifecycle transaction needs recovery before pairing replacement')
    const old = await completeInstallation(d, previousHash)
    const j: RebindJournal = { schema: 1, id: randomUUID(), uid: d.uid, rootDev: String(old.root.dev), rootIno: String(old.root.ino),
      phase: 'prepared', oldConfig: previous, newConfig: config, oldConfigHash: hash(old.config), newConfigHash: hash(JSON.stringify(config)),
      bundleHash: hash(old.bundle), bundleVersion: d.version, plistHash: hash(old.plist), newTokenHash: hash(token), backups: { config: hash(old.config), runtime: null, status: null } }
    // The no-overwrite credential store must succeed before a journal can claim ownership of its account.
    // The old account is deliberately not deleted until the newly approved identity is locally ready.
    try { await d.keychain.store(config.deviceId, token) }
    catch { throw new Error('New credential storage failed; old pairing retained. Browser approval may remain unused') }
    try {
      await atomicPrivateWrite(backupPath(d, j, 'config'), old.config)
      await saveRebind(d, j)
    } catch {
      try { await d.keychain.remove(config.deviceId) } catch { throw new Error('Credential cleanup incomplete; old pairing retained') }
      await rm(backupPath(d, j, 'config'), { force: true })
      throw new Error('Pairing recovery preparation failed; old pairing retained')
    }
    try {
      d.signal?.throwIfAborted()
      await stopOwned(d)
      await withStoppedDaemonLock(d.paths, d.uid, d.isProcessAlive, async () => {
        await assertJournalIdentity(d, j)
        d.signal?.throwIfAborted()
        // Capture the final stopped observations, never an active daemon snapshot.
        const raw = new Map<BackupKey, string>()
        for (const key of ['runtime', 'status'] as const) {
          if (await exists(destination(d, key))) { const value = await privateText(destination(d, key), d.uid); raw.set(key, value); j.backups[key] = hash(value) }
        }
        await saveRebind(d, j)
        for (const [key, value] of raw) await atomicPrivateWrite(backupPath(d, j, key), value)
        await verifyBackups(d, j)
        j.phase = 'switching'
        await saveRebind(d, j)
        await atomicPrivateWrite(d.paths.config, JSON.stringify(config))
        await atomicPrivateWrite(d.paths.runtimeState, JSON.stringify({ version: 1, authorityEpoch: config.authorityEpoch, operations: [], instances: [] }))
        await rm(destination(d, 'status'), { force: true })
      }, d.stopTimeoutMs ?? 10_000)
      await bootReady(d, config, true)
    } catch {
      try { await rollbackPairing(d, j) }
      catch { throw new Error('Pairing replacement could not safely roll back; both identities and recovery journal retained. Rerun the same launch command after resolving the lifecycle failure') }
      throw new Error('Pairing replacement failed; old pairing restored. Rerun the same launch command')
    }
    j.phase = 'committed'
    await saveRebind(d, j)
    await finishCommitted(d, j)
  })
}
async function assertJournalIdentity(d: Dependencies, j: RebindJournal): Promise<string> {
  const current = await completeInstallation(d)
  if (j.uid !== d.uid || j.rootDev !== String(current.root.dev) || j.rootIno !== String(current.root.ino) || hash(current.bundle) !== j.bundleHash || hash(current.plist) !== j.plistHash) throw new Error('Pairing recovery installation identity changed')
  const currentHash = hash(current.config)
  if (currentHash !== j.oldConfigHash && currentHash !== j.newConfigHash) throw new Error('Pairing recovery refuses an unrelated current configuration')
  return currentHash
}
async function verifyBackups(d: Dependencies, j: RebindJournal): Promise<void> {
  for (const key of ['config', 'runtime', 'status'] as const) if (j.backups[key] !== null && hash(await privateText(backupPath(d, j, key), d.uid)) !== j.backups[key]) throw new Error('Pairing recovery backup hash mismatch')
}
async function rollbackPairing(d: Dependencies, j: RebindJournal): Promise<void> {
  const currentHash = await assertJournalIdentity(d, j)
  if (j.phase === 'switching') {
    await verifyBackups(d, j)
    await stopOwned(d)
    await withStoppedDaemonLock(d.paths, d.uid, d.isProcessAlive, async () => {
      await assertJournalIdentity(d, j)
      await verifyBackups(d, j)
      for (const key of ['config', 'runtime', 'status'] as const) {
        if (j.backups[key] === null) await rm(destination(d, key), { force: true })
        else await atomicPrivateWrite(destination(d, key), await privateText(backupPath(d, j, key), d.uid))
      }
    }, d.stopTimeoutMs ?? 10_000)
  } else if (currentHash !== j.oldConfigHash) throw new Error('Unexpected pairing recovery phase')
  const state = await launchAgentStatus(d.runner, d.uid)
  if (state === 'unknown') throw new Error('Cannot verify old LaunchAgent for rollback')
  if (state === 'not_loaded') {
    await withStoppedDaemonLock(d.paths, d.uid, d.isProcessAlive, async () => {}, d.stopTimeoutMs ?? 10_000)
    await bootReady(d, j.oldConfig)
  }
  j.phase = 'rolled_back'
  await saveRebind(d, j)
  await d.keychain.remove(j.newConfig.deviceId)
  await cleanupRebind(d, j)
}
async function finishCommitted(d: Dependencies, j: RebindJournal): Promise<void> {
  if (await assertJournalIdentity(d, j) !== j.newConfigHash) throw new Error('Committed pairing configuration changed; recovery retained')
  if (hash(await d.keychain.read(j.newConfig.deviceId)) !== j.newTokenHash) throw new Error('Committed credential no longer matches approved identity')
  await d.keychain.remove(j.oldConfig.deviceId)
  await cleanupRebind(d, j)
}
async function cleanupRebind(d: Dependencies, j: RebindJournal): Promise<void> {
  for (const key of ['config', 'runtime', 'status'] as const) {
    const path = backupPath(d, j, key)
    if (await exists(path)) {
      if (j.backups[key] === null || hash(await privateText(path, d.uid)) !== j.backups[key]) throw new Error('Unverifiable recovery file retained')
      await rm(path)
    }
  }
  await rm(journalPath(d))
}
async function recoverRebind(d: Dependencies): Promise<void> {
  const raw: unknown = JSON.parse(await privateText(journalPath(d), d.uid, 64 * 1024))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid pairing recovery journal')
  const j = raw as RebindJournal
  const fields = ['schema', 'id', 'uid', 'rootDev', 'rootIno', 'phase', 'oldConfig', 'newConfig', 'oldConfigHash', 'newConfigHash', 'bundleHash', 'bundleVersion', 'plistHash', 'newTokenHash', 'backups']
  if (Object.keys(j).sort().join(',') !== fields.sort().join(',') || j.schema !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(j.id) || !Number.isSafeInteger(j.uid) || !['prepared', 'switching', 'committed', 'rolled_back'].includes(j.phase)) throw new Error('Invalid pairing recovery journal')
  if (typeof j.bundleVersion !== 'string' || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(j.bundleVersion)) throw new Error('Invalid installed recovery version')
  j.oldConfig = parseConfig(j.oldConfig); j.newConfig = parseConfig(j.newConfig)
  if (j.oldConfig.deviceId === j.newConfig.deviceId || j.oldConfig.installationId === j.newConfig.installationId) throw new Error('Recovery identities must be distinct')
  for (const v of [j.oldConfigHash, j.newConfigHash, j.bundleHash, j.plistHash, j.newTokenHash]) if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw new Error('Invalid pairing recovery digest')
  if (!j.backups || Object.keys(j.backups).sort().join(',') !== 'config,runtime,status' || j.backups.config !== j.oldConfigHash) throw new Error('Invalid pairing recovery backups')
  for (const value of Object.values(j.backups)) if (value !== null && (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) throw new Error('Invalid pairing backup digest')
  if (hash(JSON.stringify(j.newConfig)) !== j.newConfigHash) throw new Error('Invalid approved configuration binding')
  await assertJournalIdentity(d, j)
  // Recovery runs before the caller's software update. Its hash-bound installed bundle
  // must prove its own boot version, not the version of a newer fetched launcher.
  const recovery: Dependencies = { ...d, version: j.bundleVersion }
  if (j.phase === 'committed') {
    if (!await localReady(recovery, j.newConfig)) { await stopOwned(recovery); await withStoppedDaemonLock(d.paths, d.uid, d.isProcessAlive, async () => {}, d.stopTimeoutMs ?? 10_000); await bootReady(recovery, j.newConfig) }
    await finishCommitted(recovery, j)
  } else await rollbackPairing(recovery, j)
}
async function stopOwned(d: Dependencies): Promise<void> {
  const state = await launchAgentStatus(d.runner, d.uid)
  if (state === 'unknown') throw new Error('Cannot verify the owned LaunchAgent')
  if (state === 'loaded') await stopLaunchAgent(d.paths, d.runner, d.uid)
  await waitForLaunchAgentStop(d.runner, d.uid, d.stopTimeoutMs ?? 10_000)
}
async function bootReady(d: Dependencies, config: CompanionConfig, honorCancellation = false): Promise<void> {
  let baseline: string | undefined
  try { baseline = (JSON.parse(await privateText(destination(d, 'status'), d.uid, 16 * 1024)) as { bootId?: string }).bootId }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof ObservationChangedError)) throw error }
  const result = await d.runner.run('/bin/launchctl', ['bootstrap', 'gui/' + d.uid, d.paths.launchAgent])
  if (result.code !== 0 || await launchAgentStatus(d.runner, d.uid) !== 'loaded') throw new Error('Companion LaunchAgent bootstrap failed')
  const timeout = d.readyTimeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error('Invalid ready deadline')
  const deadline = performance.now() + timeout
  do {
    if (honorCancellation) d.signal?.throwIfAborted()
    if (await localReady(d, config, baseline)) return
    await pause(Math.min(100, Math.max(1, deadline - performance.now())))
  } while (performance.now() < deadline)
  throw new Error('New pairing daemon initialization timed out')
}
async function localReady(d: Dependencies, config: CompanionConfig, previousBootId?: string): Promise<boolean> {
  try {
    const state = JSON.parse(await privateText(destination(d, 'status'), d.uid, 16 * 1024)) as Record<string, unknown>
    if (state.deviceId !== config.deviceId || state.companionVersion !== d.version || state.bootId === previousBootId || typeof state.bootId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state.bootId) || !Number.isSafeInteger(state.pid) || Number(state.pid) < 1 || !['ready', 'connecting', 'connected', 'reconnecting', 'needs_attention', 'needs_pairing'].includes(String(state.state))) return false
    await ownedDirectory(join(d.paths.root, 'daemon.lock'), d.uid)
    if (await privateText(join(d.paths.root, 'daemon.lock', 'pid'), d.uid, 128) !== String(state.pid)) return false
    const nonce = await privateText(join(d.paths.root, 'daemon.lock', 'nonce'), d.uid, 128)
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(nonce)) return false
    return d.isProcessAlive(Number(state.pid))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof ObservationChangedError) return false
    throw error
  }
}
class ObservationChangedError extends Error { constructor() { super('Companion state changed during inspection') } }

async function sshAlias(options: LaunchOptions, d: Dependencies, current?: string): Promise<string> {
  const value = options.sshHost ?? await d.promptSshHost?.(current)
  if (!value) throw new Error('SSH alias confirmation is required')
  return validateSshHost(value)
}
async function enroll(d: Dependencies, server: string, epoch: string, installationId: string, name: string): Promise<Pairing> {
  const timeout = d.enrollmentTimeoutMs ?? 300_000
  const interval = d.pollIntervalMs ?? 1000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900_000 || !Number.isSafeInteger(interval) || interval < 1 || interval > 30_000) throw new Error('Invalid bounded enrollment timings')
  const response = await jsonRequest(d, server, '/api/companion/enrollments/start', {
    installationId, name, osVersion: release(), architecture: arch(), companionVersion: d.version,
  })
  const request = response.request as Record<string, unknown> | undefined
  if (!request) throw new Error('Invalid enrollment response')
  const requestId = text(request.requestId, 'request id', 256)
  const userCode = text(request.userCode, 'approval code', 256)
  const pollToken = text(request.pollToken, 'poll token')
  const expiresAt = text(request.expiresAt, 'approval expiry')
  const expiresIn = Date.parse(expiresAt) - Date.now()
  if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 900_000) throw new Error('Invalid approval expiry')
  const deadline = performance.now() + Math.min(timeout, expiresIn)
  if (!d.showApproval) throw new Error('Browser approval instructions cannot be displayed')
  await d.showApproval({ serverUrl: server, userCode, expiresAt })
  while (performance.now() < deadline) {
    d.signal?.throwIfAborted()
    const poll = await jsonRequest(d, server, '/api/companion/enrollments/poll', { requestId, pollToken })
    if (poll.status === 'ready') {
      const pairing = poll.pairing as Record<string, unknown> | undefined
      const device = pairing?.device as Record<string, unknown> | undefined
      const result: Pairing = { device: { id: text(device?.id, 'Device id', 256) }, token: text(pairing?.token, 'Device credential'), authorityEpoch: text(pairing?.authorityEpoch, 'authority epoch') }
      if (result.authorityEpoch !== epoch) throw new Error('Host identity changed during approval; rerun launch')
      return result
    }
    if (poll.status !== 'pending') throw new Error('Browser approval denied, expired or already delivered; rerun launch to request approval')
    await pause(Math.min(interval, Math.max(1, deadline - performance.now())), d.signal)
  }
  throw new Error('Browser approval timed out; existing pairing retained')
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, ms)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Launch cancelled')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function jsonRequest(d: Dependencies, server: string, path: string, body?: unknown, token?: string, acceptUnauthorized = false): Promise<Record<string, unknown>> {
  d.signal?.throwIfAborted()
  let response: Response
  try {
    response = await d.fetch(server + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
      signal: d.signal ? AbortSignal.any([d.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    })
  } catch { throw new Error('Companion Host request failed; existing pairing retained (network, redirect, timeout or cancellation)') }
  if (acceptUnauthorized && response.status === 401) { await response.body?.cancel(); return { unauthorized: true } }
  if (!response.ok && !(acceptUnauthorized && response.status === 403)) { await response.body?.cancel(); throw new Error('Companion Host request refused; existing pairing retained (HTTP ' + response.status + ')') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Companion Host response is empty')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > 64 * 1024) throw new Error('response too large')
      chunks.push(next.value)
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid response')
    const record = result as Record<string, unknown>
    if (acceptUnauthorized && response.status === 403 && record.error && typeof record.error === 'object' && !Array.isArray(record.error) && (record.error as Record<string, unknown>).code === 'DEVICE_REVOKED') return { unauthorized: true }
    if (!response.ok || record.ok !== true) throw new Error('Invalid response')
    return record
  } catch { throw new Error('Companion Host response is invalid; existing pairing retained') }
  finally { await reader.cancel().catch(() => {}) }
}
function text(value: unknown, label: string, limit = 1024): string {
  if (typeof value !== 'string' || !value || value.length > limit || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Invalid ' + label)
  return value
}
async function ownedDirectory(path: string, uid: number) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(uid) || (Number(info.mode) & 0o077)) throw new Error('Private owned Companion directory required')
  return info
}
async function privateText(path: string, uid: number, limit = 8 * 1024 * 1024): Promise<string> {
  const info = await lstat(path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.uid !== BigInt(uid) || (Number(info.mode) & 0o077) || info.size > BigInt(limit)) throw new Error('Unsafe Companion state file; existing installation retained')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const first = await file.stat({ bigint: true })
    if (first.dev !== info.dev || first.ino !== info.ino) throw new ObservationChangedError()
    const buffer = Buffer.alloc(Number(info.size) + 1)
    let size = 0
    while (size < buffer.length) { const chunk = await file.read(buffer, size, buffer.length - size, size); if (!chunk.bytesRead) break; size += chunk.bytesRead }
    const after = await file.stat({ bigint: true })
    if (size !== Number(info.size) || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.nlink !== 1n) throw new ObservationChangedError()
    return buffer.subarray(0, size).toString('utf8')
  } finally { await file.close() }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

