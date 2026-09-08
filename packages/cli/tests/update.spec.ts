import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { companionPaths, type CompanionConfig } from '../src/config.js'
import { renderLaunchAgent } from '../src/launchd.js'
import type { CommandRunner } from '../src/command.js'
import { update, type UpdateDependencies } from '../src/update.js'

const OLD = '// old local bundle\n'
const NEW = '// new local bundle\n'

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'companion-update-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const uid = process.getuid?.() ?? 0
  const paths = companionPaths(home, uid)
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  await mkdir(dirname(paths.launchAgent), { recursive: true, mode: 0o700 })
  const runtimePath = await realpath(process.execPath)
  const config: CompanionConfig = { version: 1, serverUrl: 'https://dsh.example', sshHost: 'devbox', deviceId: 'device_fixture', installationId: 'install_fixture', authorityEpoch: 'authority_fixture', runtimePath, installedAt: '2026-09-08T00:00:00.000Z' }
  await writeFile(paths.config, JSON.stringify({ ...config, futureField: 'preserve raw config bytes' }, null, 2), { mode: 0o600 })
  await writeFile(paths.bundle, OLD, { mode: 0o700 })
  await writeFile(paths.launchAgent, renderLaunchAgent(paths, runtimePath), { mode: 0o600 })
  await writeFile(paths.runtimeState, '{"retryAttempt":5,"lease":"preserve-runtime-byte-for-byte"}', { mode: 0o600 })
  const source = join(home, 'downloaded.mjs')
  await writeFile(source, NEW, { mode: 0o600 })
  const originals = await Promise.all([paths.config, paths.launchAgent, paths.runtimeState].map(path => readFile(path, 'utf8')))
  const calls: { file: string; args: readonly string[] }[] = []
  const state = { loaded: true, unknown: false, probeFailure: false, runtimeFailure: false, installedVersion: undefined as string | undefined, readyMode: 'ready', fixedBootId: randomUUID(), activePid: 424242, lastBootContent: OLD, stops: 0, boots: 0, keychainCalls: 0, networkCalls: 0,
    failStops: new Set<number>(), failBoots: new Set<number>(), invisibleNew: false,
    beforeProbe: undefined as (() => Promise<void>) | undefined,
    afterBootstrap: undefined as (() => Promise<void>) | undefined,
    bootedContents: [] as string[] }
  const ready = async (version = '0.1.3', bootId = randomUUID()) => {
    await mkdir(join(paths.root, 'daemon.lock'), { mode: 0o700, recursive: true })
    await writeFile(join(paths.root, 'daemon.lock', 'pid'), String(state.activePid), { mode: 0o600 })
    await writeFile(join(paths.root, 'daemon.lock', 'nonce'), randomUUID(), { mode: 0o600 })
    if (state.readyMode === 'missing' && state.lastBootContent === NEW) return
    await writeFile(join(paths.root, 'daemon-status.json'), JSON.stringify({
      state: state.readyMode === 'stopped' && state.lastBootContent === NEW ? 'stopped' : 'ready',
      deviceId: state.readyMode === 'wrong-device' && state.lastBootContent === NEW ? 'foreign' : config.deviceId,
      companionVersion: state.readyMode === 'wrong-version' && state.lastBootContent === NEW ? '9.9.9' : version,
      bootId: state.readyMode === 'stale' && state.lastBootContent === NEW ? state.fixedBootId : bootId,
      pid: state.readyMode === 'wrong-pid' && state.lastBootContent === NEW ? state.activePid + 1 : state.activePid,
    }), { mode: 0o600 })
  }
  const runner: CommandRunner = { async run(file, args) {
    calls.push({ file, args })
    if (args.length === 1 && args[0] === '--version') return { code: state.runtimeFailure ? 1 : 0, stdout: 'v22.20.0\n', stderr: '' }
    if (args.length === 2 && args[1] === '--version') {
      if (args[0] === paths.bundle) {
        const version = state.installedVersion ?? ((await readFile(paths.bundle, 'utf8')) === OLD ? '0.1.2' : '0.1.3')
        return { code: 0, stdout: 'dsh-companion ' + version + '\n', stderr: '' }
      }
      await state.beforeProbe?.()
      assert.equal(file, runtimePath)
      assert.ok(args[0]!.endsWith('.mjs'))
      assert.notEqual(args[0], source)
      assert.equal(await readFile(args[0]!, 'utf8'), await readFile(source, 'utf8'))
      return { code: state.probeFailure ? 1 : 0, stdout: state.probeFailure ? '' : 'dsh-companion ' + deps.version + '\n', stderr: 'RAW_SECRET_MUST_NOT_ESCAPE' }
    }
    assert.equal(file, '/bin/launchctl')
    if (args[0] === 'print') return { code: state.unknown ? 5 : state.loaded ? 0 : 3, stdout: '', stderr: 'RAW_SECRET_MUST_NOT_ESCAPE' }
    if (args[0] === 'bootout') {
      assert.equal(args[1], 'gui/' + uid + '/dev.deepseek.dsh-companion')
      state.stops++
      if (state.failStops.has(state.stops)) return { code: 5, stdout: '', stderr: 'RAW_SECRET_MUST_NOT_ESCAPE' }
      state.loaded = false
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'bootstrap') {
      await assert.rejects(lstat(join(paths.root, 'daemon.lock.reclaim')), { code: 'ENOENT' })
      assert.deepEqual(args, ['bootstrap', 'gui/' + uid, paths.launchAgent])
      state.boots++
      const content = await readFile(paths.bundle, 'utf8')
      state.bootedContents.push(content)
      state.activePid++
      state.lastBootContent = content
      state.loaded = !(state.invisibleNew && content === NEW)
      await ready(content === OLD ? '0.1.2' : '0.1.3')
      await state.afterBootstrap?.()
      return { code: state.failBoots.has(state.boots) ? 5 : 0, stdout: '', stderr: 'RAW_SECRET_MUST_NOT_ESCAPE' }
    }
    throw new Error('Unexpected updater command')
  } }
  const creds = async () => { state.keychainCalls++; throw new Error('Updater must not touch Keychain') }
  const deps: UpdateDependencies = { paths, runner, bundleSource: source, platform: 'darwin', uid, version: '0.1.3', readyTimeoutMs: 30, isProcessAlive: pid => state.loaded && pid === state.activePid && !(state.readyMode === 'dead' && state.lastBootContent === NEW),
    fetch: async () => { state.networkCalls++; throw new Error('Updater must not access network') },
    keychain: { read: creds, store: creds, remove: creds } }
  const unchanged = async () => {
    assert.deepEqual(await Promise.all([paths.config, paths.launchAgent, paths.runtimeState].map(path => readFile(path, 'utf8'))), originals)
    assert.equal(state.keychainCalls, 0)
    assert.equal(state.networkCalls, 0)
  }
  return { home, paths, source, state, calls, deps, unchanged, config, ready }
}

// Real temporary filesystem; launchctl/Node results are injected, not a macOS claim.
test('local update replaces bundle, preserves pairing and runtime bytes, and proves local readiness not WSS health', async t => {
  const f = await fixture(t)
  const result = await update(f.deps)
  assert.equal(result.version, '0.1.3')
  assert.equal(result.changed, true)
  assert.equal(result.registration, 'loaded')
  assert.match(result.note, /not.*(online|connectivity|WSS)/i)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), NEW)
  assert.equal((await stat(f.paths.bundle)).mode & 0o777, 0o700)
  assert.equal(f.state.stops, 1)
  assert.equal(f.state.boots, 1)
  await f.unchanged()
  await assert.rejects(stat(join(f.paths.root, 'update-journal.json')), { code: 'ENOENT' })
})

test('unified launch can request a fresh process even when installed bytes already match', async t => {
  const f = await fixture(t)
  await writeFile(f.paths.bundle,NEW)
  await f.ready()
  await update({...f.deps,forceRestart:true})
  assert.equal(f.state.stops,1)
  assert.equal(f.state.boots,1)
  await f.unchanged()
})

test('a changed pairing config is refused under the update lock before any stop', async t => {
  const f = await fixture(t)
  await assert.rejects(update({...f.deps,expectedConfigHash:'0'.repeat(64)}),/Installation changed/)
  assert.equal(f.state.stops,0)
  assert.equal(f.state.boots,0)
  assert.equal(await readFile(f.paths.bundle,'utf8'),OLD)
  await f.unchanged()
})

test('same content is idempotent without bootout, bootstrap or bundle replacement', async t => {
  const f = await fixture(t)
  await writeFile(f.paths.bundle, NEW)
  await f.ready()
  const before = await stat(f.paths.bundle)
  const result = await update(f.deps)
  const after = await stat(f.paths.bundle)
  assert.equal(result.changed, false)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(f.state.stops, 0)
  assert.equal(f.state.boots, 0)
  await f.unchanged()
})

test('same-content stopped installation repairs registration without replacing the bundle or bootout', async t => {
  const f = await fixture(t)
  f.state.loaded = false
  await writeFile(f.paths.bundle, NEW)
  const result = await update(f.deps)
  assert.equal(result.registration, 'loaded')
  assert.equal(result.changed, false)
  assert.equal(f.state.stops, 0)
  assert.equal(f.state.boots, 1)
  assert.equal(result.localReady, true)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), NEW)
})

test('journal recovery validates the saved Node runtime before any additional stop', async t => {
  const f = await fixture(t)
  f.state.failBoots.add(1); f.state.failStops.add(2)
  await assert.rejects(update(f.deps))
  const stops = f.state.stops
  f.state.failBoots.clear(); f.state.failStops.clear(); f.state.runtimeFailure = true
  await assert.rejects(update(f.deps))
  assert.equal(f.state.stops, stops)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), NEW)
})

test('committed journal cleanup recovery does not stop an already registered same-content version', async t => {
  const f = await fixture(t)
  f.state.failBoots.add(1); f.state.failStops.add(2)
  await assert.rejects(update(f.deps))
  const path = join(f.paths.root, 'update-journal.json')
  const journal = JSON.parse(await readFile(path, 'utf8'))
  journal.phase = 'committed'
  await writeFile(path, JSON.stringify(journal))
  const stops = f.state.stops
  f.state.failBoots.clear(); f.state.failStops.clear()
  const result = await update(f.deps)
  assert.equal(result.recovered, true)
  assert.equal(result.changed, false)
  assert.equal(f.state.stops, stops)
})

test('candidate local readiness must be fresh, correct and alive or original is restored', async t => {
  for (const mode of ['missing', 'stale', 'wrong-version', 'wrong-device', 'wrong-pid', 'dead', 'stopped']) {
    const f = await fixture(t)
    await f.ready('0.1.2', f.state.fixedBootId)
    f.state.readyMode = mode
    await assert.rejects(update(f.deps), /restored/i)
    assert.equal(await readFile(f.paths.bundle, 'utf8'), OLD, mode)
    assert.equal(f.state.loaded, true)
    await f.unchanged()
  }
})

test('loaded same-content registration with missing proof or an old running version is restarted for repair', async t => {
  for (const oldStatus of [false, true]) {
    const f = await fixture(t)
    await writeFile(f.paths.bundle, NEW)
    if (oldStatus) await f.ready('0.1.2')
    const result = await update(f.deps)
    assert.equal(result.changed, false)
    assert.equal(result.localReady, true)
    assert.equal(result.registrationRepaired, true)
    assert.equal(f.state.stops, 1)
    assert.equal(f.state.boots, 1)
  }
})

test('newer or unverifiable installed version is never silently downgraded', async t => {
  for (const version of ['0.1.4', '1.0.0', 'unknown', '0.1.4-beta']) {
    const f = await fixture(t)
    f.state.installedVersion = version
    await assert.rejects(update(f.deps), /version|downgrade/i)
    assert.equal(f.state.stops, 0)
    assert.equal(await readFile(f.paths.bundle, 'utf8'), OLD)
  }
})

test('atomic replacement failure after confirmed stop automatically restores original registration', async t => {
  const f = await fixture(t)
  const original = fs.promises.rename
  let failed = false
  fs.promises.rename = async (from, to) => {
    if (!failed && String(from).includes('.update-') && String(to) === f.paths.bundle) {
      failed = true
      throw Object.assign(new Error('injected rename failure'), { code: 'EIO' })
    }
    return original(from, to)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(update(f.deps), /restored/i) }
  finally { fs.promises.rename = original; syncBuiltinESMExports() }
  assert.equal(failed, true)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), OLD)
  assert.deepEqual(f.state.bootedContents, [OLD])
  assert.equal(f.state.loaded, true)
  await f.unchanged()
})

test('missing or partial installation never stops an agent', async t => {
  for (const field of ['config', 'bundle', 'launchAgent'] as const) {
    const f = await fixture(t)
    await rm(f.paths[field])
    await assert.rejects(update(f.deps))
    assert.equal(f.state.stops, 0)
    assert.equal(f.state.boots, 0)
  }
  const f = await fixture(t)
  await writeFile(f.paths.launchAgent, renderLaunchAgent(f.paths, f.config.runtimePath).replace('<string>daemon</string>', '<string>other</string>'))
  await assert.rejects(update(f.deps), /contract|installation/i)
  assert.equal(f.state.stops, 0)
})

test('symlink and nonprivate installed files fail before stop', async t => {
  for (const field of ['config', 'bundle', 'launchAgent', 'runtimeState'] as const) {
    const f = await fixture(t)
    const target = join(f.home, 'foreign')
    await writeFile(target, await readFile(f.paths[field]), { mode: 0o600 })
    await rm(f.paths[field]); await symlink(target, f.paths[field])
    await assert.rejects(update(f.deps))
    assert.equal(f.state.stops, 0)
  }
  const f = await fixture(t)
  await chmod(f.paths.config, 0o644)
  await assert.rejects(update(f.deps))
  assert.equal(f.state.stops, 0)
})

test('candidate version probe failure leaves old program and no remote or stop effects', async t => {
  const f = await fixture(t)
  f.state.probeFailure = true
  await assert.rejects(update(f.deps), error => {
    assert.ok(error instanceof Error)
    assert.ok(!error.message.includes('RAW_SECRET'))
    return true
  })
  assert.equal(f.state.stops, 0)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), OLD)
  await f.unchanged()
})

test('unknown LaunchAgent status refuses even same-content update', async t => {
  const f = await fixture(t)
  f.state.unknown = true
  await writeFile(f.source, OLD)
  await assert.rejects(update(f.deps), /unverifiable|unknown|registration/i)
  assert.equal(f.state.stops, 0)
})

test('bootout failure never replaces old bundle and retains bounded recovery journal', async t => {
  const f = await fixture(t)
  f.state.failStops.add(1)
  await assert.rejects(update(f.deps), /retained|recovery/i)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), OLD)
  assert.equal(f.state.boots, 0)
  const journal = await readFile(join(f.paths.root, 'update-journal.json'), 'utf8')
  assert.ok(journal.length < 16 * 1024)
  assert.ok(!journal.includes('RAW_SECRET'))
  await f.unchanged()
})

test('new bootstrap failure stops partial registration before restoring original bundle', async t => {
  const f = await fixture(t)
  f.state.failBoots.add(1)
  await assert.rejects(update(f.deps), /restored/i)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), OLD)
  assert.deepEqual(f.state.bootedContents, [NEW, OLD])
  assert.equal(f.state.stops, 2)
  assert.equal(f.state.loaded, true)
  await f.unchanged()
})

test('failed registration verification also restores original program', async t => {
  const f = await fixture(t)
  f.state.invisibleNew = true
  await assert.rejects(update(f.deps), /restored/i)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), OLD)
  assert.equal(f.state.loaded, true)
})

test('rollback stop failure does not replace potentially live new bundle and preserves backup', async t => {
  const f = await fixture(t)
  f.state.failBoots.add(1); f.state.failStops.add(2)
  await assert.rejects(update(f.deps), /retained|recovery/i)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), NEW)
  const names = await readdir(f.paths.root)
  const backup = names.find(name => name.startsWith('.backup-') && name.endsWith('.mjs'))
  assert.ok(backup)
  assert.equal(await readFile(join(f.paths.root, backup), 'utf8'), OLD)
  await stat(join(f.paths.root, 'update-journal.json'))
  await f.unchanged()
})

test('durable interrupted-cutover journal recovers before a same-content shortcut', async t => {
  const f = await fixture(t)
  f.state.failBoots.add(1); f.state.failStops.add(2)
  await assert.rejects(update(f.deps))
  assert.equal(await readFile(f.paths.bundle, 'utf8'), NEW)
  f.state.failBoots.clear(); f.state.failStops.clear()
  const result = await update(f.deps)
  assert.equal(result.recovered, true)
  assert.equal(result.changed, true)
  assert.deepEqual(f.state.bootedContents, [NEW, OLD, NEW])
  await assert.rejects(stat(join(f.paths.root, 'update-journal.json')), { code: 'ENOENT' })
  await f.unchanged()
})

test('tampered journal identity or backup hash is never trusted for recovery', async t => {
  for (const tamper of ['journal', 'backup'] as const) {
    const f = await fixture(t)
    f.state.failBoots.add(1); f.state.failStops.add(2)
    await assert.rejects(update(f.deps))
    const before = f.state.stops
    if (tamper === 'journal') {
      const path = join(f.paths.root, 'update-journal.json')
      const value = JSON.parse(await readFile(path, 'utf8'))
      value.installationId = 'foreign-installation'
      await writeFile(path, JSON.stringify(value))
    } else {
      const backup = (await readdir(f.paths.root)).find(name => name.startsWith('.backup-') && name.endsWith('.mjs'))!
      await writeFile(join(f.paths.root, backup), 'foreign backup')
    }
    await assert.rejects(update(f.deps), /recovery|identity|hash|journal/i)
    assert.equal(f.state.stops, before)
    assert.equal(await readFile(f.paths.bundle, 'utf8'), NEW)
  }
})

test('concurrent update is refused while the first candidate is being verified', async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.state.beforeProbe = async () => { entered(); await gate }
  const first = update(f.deps)
  await waiting
  try { await assert.rejects(update(f.deps), /lock|Another|concurrent/i) }
  finally { release() }
  await first
  assert.equal(f.state.stops, 1)
})

test('atomic status replacement during readiness read is retried, not treated as startup failure', async t => {
  const f = await fixture(t)
  f.deps.readyTimeoutMs = 300
  const original = fs.promises.open
  const statusPath = join(f.paths.root, 'daemon-status.json')
  let replaced = false
  fs.promises.open = async (path, flags, mode) => {
    if (!replaced && f.state.boots === 1 && String(path) === statusPath) {
      replaced = true
      const temporary = statusPath + '.test-replacement'
      await writeFile(temporary, await readFile(statusPath), { mode: 0o600 })
      await fs.promises.rename(temporary, statusPath)
    }
    return original(path, flags, mode)
  }
  syncBuiltinESMExports()
  try { assert.equal((await update(f.deps)).localReady, true) }
  finally { fs.promises.open = original; syncBuiltinESMExports() }
  assert.equal(replaced, true)
  assert.equal(f.state.stops, 1)
  assert.equal(f.state.boots, 1)
})

test('ambiguous PID liveness is not accepted as ready and cannot authorize rollback replacement', async t => {
  const f = await fixture(t)
  f.deps.isProcessAlive = () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) }
  await assert.rejects(update(f.deps), /recovery|retained/i)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), NEW)
  await stat(join(f.paths.root, 'update-journal.json'))
  const backup = (await readdir(f.paths.root)).find(name => name.startsWith('.backup-') && name.endsWith('.mjs'))!
  assert.equal(await readFile(join(f.paths.root, backup), 'utf8'), OLD)
})

test('live daemon ownership after bootout refuses replacement and retains recovery material', async t => {
  const f = await fixture(t)
  await mkdir(join(f.paths.root, 'daemon.lock'), { mode: 0o700 })
  await writeFile(join(f.paths.root, 'daemon.lock', 'pid'), '12345', { mode: 0o600 })
  await writeFile(join(f.paths.root, 'daemon.lock', 'nonce'), '550e8400-e29b-41d4-a716-446655440000', { mode: 0o600 })
  f.deps.isProcessAlive = () => true
  await assert.rejects(update(f.deps), /retained|recovery/i)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), OLD)
  assert.equal(f.state.boots, 0)
  await stat(join(f.paths.root, 'update-journal.json'))
})
