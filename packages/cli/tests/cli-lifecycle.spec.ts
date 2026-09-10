import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { companionPaths, normalizeServerUrl, parseConfig, readConfig, validateSshHost, writeConfig } from '../src/config.js'
import { setup, status, uninstall, verifyNodeRuntime, type LifecycleDependencies } from '../src/setup.js'
import { launchAgentStatus, renderLaunchAgent, stopLaunchAgent } from '../src/launchd.js'
import { main, parseSetupArgs } from '../src/cli.js'
import type { CommandOptions, CommandRunner } from '../src/command.js'

const token = 'dsht_not-a-real-token'
const options = { serverUrl: 'https://dsh.example', sshHost: 'my-devbox', pairCode: 'dshp_pair-secret' }
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'companion-cli-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = companionPaths(home, 501)
  paths.controlDirectory = join(home, 'control')
  const source = join(home, 'cli.mjs')
  await writeFile(source, '// bundled CLI fixture')
  const calls: { file: string; args: readonly string[]; options?: CommandOptions | undefined }[] = []
  const state = { loaded: false, printCode: 3, printStderr: '', bootstrapFailure: false, stopFailure: false, keychainFailure: false, removeFailure: false, requests: 0 }
  const credentials = new Map<string, string>()
  const runner: CommandRunner = { async run(file, args, opts) {
    calls.push({ file, args, options: opts })
    if (args[0] === '--version') return { code: 0, stdout: 'v22.20.0\n', stderr: '' }
    if (args[0] === 'print') return { code: state.loaded ? 0 : state.printCode, stdout: '', stderr: state.printStderr }
    if (args[0] === 'bootstrap') {
      if (state.bootstrapFailure) return { code: 5, stdout: '', stderr: 'do not leak raw stderr' }
      state.loaded = true
    }
    if (args[0] === 'bootout') {
      if (state.stopFailure) return { code: 5, stdout: '', stderr: '' }
      state.loaded = false
    }
    return { code: 0, stdout: '', stderr: '' }
  } }
  const fetcher: typeof fetch = async (input, init) => {
    state.requests++
    assert.equal(input, 'https://dsh.example/api/companion/pair')
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.method, 'POST')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.code, options.pairCode)
    assert.deepEqual(body.capabilities, { protocolVersion: 1, localForward: true, tcpProbe: true })
    return Response.json({ ok: true, device: { id: 'dev_fixture' }, authorityEpoch: 'authority_fixture', token })
  }
  const deps: LifecycleDependencies = { paths, runner, bundleSource: source, platform: 'darwin', uid: process.getuid?.() ?? 0, fetch: fetcher,
    keychain: {
      async store(id, value) { if (state.keychainFailure) throw new Error('Keychain refused'); credentials.set(id, value) },
      async read(id) { const value = credentials.get(id); if (!value) throw new Error('missing'); return value },
      async remove(id) { if (state.removeFailure) throw new Error('Keychain remove failed'); credentials.delete(id) },
    } }
  return { home, paths, source, calls, state, credentials, deps }
}

test('setup accepts the macOS print exit 113 missing-service diagnostic', async t => {
  const f = await fixture(t)
  f.deps.uid = 501
  f.state.printCode = 113
  f.state.printStderr = 'Bad request.\nCould not find service "dev.deepseek.dsh-companion" in domain for user gui: 501\n'
  const config = await setup(options, f.deps)
  assert.equal(config.deviceId, 'dev_fixture')
  assert.equal(f.state.requests, 1)
  assert.equal(f.state.loaded, true)
  assert.equal(f.calls.filter(call => call.args[0] === 'bootout').length, 0)
})

test('ambiguous launchctl failures still block setup before pairing or credential writes', async t => {
  for (const [code, stderr] of [
    [113, 'Bad request.'],
    [113, 'Could not find domain for user gui: 501'],
    [113, 'Bad request.\nCould not find service "other.service" in domain for user gui: 501'],
    [113, 'Bad request.\nCould not find service "dev.deepseek.dsh-companion" in domain for user gui: 502'],
    [113, 'Permission denied\nCould not find service "dev.deepseek.dsh-companion" in domain for user gui: 501'],
    [1, 'Operation not permitted'],
    [5, 'Input/output error'],
  ] as const) {
    const f = await fixture(t)
    f.deps.uid = 501
    f.state.printCode = code
    f.state.printStderr = stderr
    await assert.rejects(setup(options, f.deps), /Existing or unverifiable LaunchAgent/)
    assert.equal(f.state.requests, 0)
    assert.equal(f.credentials.size, 0)
    await assert.rejects(stat(f.paths.bundle), { code: 'ENOENT' })
    assert.equal(f.calls.some(call => ['enable', 'bootstrap', 'bootout'].includes(call.args[0] ?? '')), false)
  }
})

test('exit 113 is print-specific and does not loosen bootout safety', async t => {
  const f = await fixture(t)
  const runner: CommandRunner = { async run() { return { code: 113, stdout: '', stderr: 'Bad request.\nCould not find service "dev.deepseek.dsh-companion" in domain for user gui: 501\n' } } }
  assert.equal(await launchAgentStatus(runner, 501), 'not_loaded')
  await assert.rejects(stopLaunchAgent(f.paths, runner, 501), /installation retained/)
})

test('CLI update dispatches without requesting a pairing code', async () => {
  let updates = 0
  let output = ''
  const result = await main(['update'], {
    runUpdate: async () => { updates++; return { version: '0.1.3', changed: true } },
    readPairCode: async () => { throw new Error('update must not ask for pairing') },
    stdout: text => { output += text }, stderr: () => {},
  })
  assert.equal(result, 0)
  assert.equal(updates, 1)
  assert.match(output, /0.1.3/)
})

test('repeating setup updates the existing installation without reading or consuming another pairing code', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  let updates = 0
  const result = await main(['setup', '--server', options.serverUrl, '--ssh-host', options.sshHost], {
    ...f.deps,
    runUpdate: async () => { updates++; return { version: '0.1.3', changed: true } },
    readPairCode: async () => { throw new Error('existing setup must not ask for pairing') },
    stdout: () => {}, stderr: () => {},
  })
  assert.equal(result, 0)
  assert.equal(updates, 1)
  assert.equal(f.state.requests, 1)
})

test('update entry rejects extra options and repeated setup cannot silently retarget pairing', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  let updates = 0
  const deps = { ...f.deps, runUpdate: async () => { updates++; return { version: '0.1.3', changed: true } },
    readPairCode: async () => { throw new Error('must not read another code') }, stdout: () => {}, stderr: () => {} }
  for (const args of [
    ['update', '--server', 'https://other.example'],
    ['setup', '--server', 'https://other.example', '--ssh-host', options.sshHost],
    ['setup', '--server', options.serverUrl, '--ssh-host', 'other-alias'],
  ]) assert.equal(await main(args, deps), 1)
  assert.equal(updates, 0)
  assert.equal(f.state.requests, 1)
})

test('uninstall preserves a pending update journal and all pairing material before touching launchd', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  await writeFile(join(f.paths.root, 'update-journal.json'), '{}')
  await assert.rejects(uninstall(f.deps), /interrupted update/)
  assert.equal(f.calls.filter(call => call.args[0] === 'bootout').length, 0)
  assert.equal(f.credentials.get('dev_fixture'), token)
  assert.ok(await stat(f.paths.bundle))
})

test('status exposes the new local boot identity without leaking other status fields', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  const bootId = '12345678-1234-1234-1234-123456789abc'
  await writeFile(join(f.paths.root, 'daemon-status.json'), JSON.stringify({
    state: 'ready', deviceId: 'dev_fixture', pid: process.pid, reconnectAttempts: 4,
    companionVersion: '0.1.3', bootId, updatedAt: new Date().toISOString(), token: 'must-not-leak',
  }))
  const result = await status(f.deps)
  const observed = result.daemonObservation as Record<string, unknown>
  assert.equal(observed.state, 'ready')
  assert.equal(observed.companionVersion, '0.1.3')
  assert.equal(observed.bootId, bootId)
  assert.equal(observed.reconnectAttempts, 4)
  assert.ok(!JSON.stringify(result).includes('must-not-leak'))
})

test('HTTPS mandatory except loopback or explicit insecure HTTP; no credential origins', () => {
  for (const origin of ['http://localhost:3080', 'http://127.0.0.1:3080', 'http://127.0.0.2:3080', 'http://[::1]:3080']) assert.equal(normalizeServerUrl(origin), origin)
  assert.throws(() => normalizeServerUrl('http://remote.example'), /HTTPS/)
  assert.equal(normalizeServerUrl('http://remote.example', true), 'http://remote.example')
  for (const value of ['ftp://localhost', 'https://u:password@example.com', 'https://example.com/path', 'https://example.com/?q=1']) assert.throws(() => normalizeServerUrl(value))
})

test('config persists explicit insecure grant, not token or unknown fields', async t => {
  const f = await fixture(t)
  const config = await setup(options, f.deps)
  assert.equal(config.authorityEpoch, 'authority_fixture')
  const raw = await readFile(f.paths.config, 'utf8')
  assert.ok(!raw.includes(token))
  assert.equal((await stat(f.paths.config)).mode & 0o777, 0o600)
  assert.throws(() => parseConfig({ ...config, serverUrl: 'http://remote.example' }), /HTTPS/)
  assert.throws(() => parseConfig({ ...config, runtimePath: 'node' }), /absolute/)
  await writeConfig(f.paths.config, { ...config, token, serverUrl: 'http://remote.example', allowInsecureHttp: true } as typeof config)
  assert.equal((await readConfig(f.paths.config)).allowInsecureHttp, true)
  assert.ok(!(await readFile(f.paths.config, 'utf8')).includes(token))
})

test('setup installs fixed bundle, absolute Node and authority epoch; repeat preserves installation', async t => {
  const f = await fixture(t)
  const config = await setup(options, f.deps)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), '// bundled CLI fixture')
  assert.equal(f.credentials.get(config.deviceId), token)
  const plist = await readFile(f.paths.launchAgent, 'utf8')
  assert.ok(plist.includes(config.runtimePath))
  assert.ok(plist.includes(f.paths.bundle))
  assert.ok(!plist.includes(f.source))
  assert.ok(!plist.includes(token))
  assert.ok(plist.includes('<string>daemon</string>'))
  const original = await readFile(f.paths.config, 'utf8')
  await assert.rejects(setup(options, f.deps), /will not overwrite/)
  assert.equal(await readFile(f.paths.config, 'utf8'), original)
  assert.equal(f.state.requests, 1)
  assert.equal(f.calls.filter(call => call.args[0] === 'bootout').length, 0)
})

test('bootstrap failure rolls back local ownership but reports remote pairing remains', async t => {
  const f = await fixture(t)
  f.state.bootstrapFailure = true
  await assert.rejects(setup(options, f.deps), /Local rollback completed.*revoke the Device/)
  for (const path of [f.paths.config, f.paths.bundle, f.paths.launchAgent]) await assert.rejects(stat(path), { code: 'ENOENT' })
  assert.equal(f.credentials.size, 0)
})

test('failed bootout retains config, bundle and credential and explicitly reports partial rollback', async t => {
  const f = await fixture(t)
  f.state.bootstrapFailure = true
  f.state.stopFailure = true
  await assert.rejects(setup(options, f.deps), /Partial rollback.*retained/)
  assert.equal((await readConfig(f.paths.config)).deviceId, 'dev_fixture')
  assert.equal(f.credentials.size, 1)
  assert.ok(await stat(f.paths.bundle))
})

test('Keychain refusal removes copied bundle and never writes plaintext config', async t => {
  const f = await fixture(t)
  f.state.keychainFailure = true
  await assert.rejects(setup(options, f.deps), /Keychain refused.*revoke the Device/)
  await assert.rejects(stat(f.paths.bundle), { code: 'ENOENT' })
  await assert.rejects(stat(f.paths.config), { code: 'ENOENT' })
})

test('preflight rejects insecure transport, Node20 and Linux without macOS lifecycle', async t => {
  const f = await fixture(t)
  await assert.rejects(setup({ ...options, serverUrl: 'http://remote.example' }, f.deps), /HTTPS/)
  await assert.rejects(setup(options, { ...f.deps, platform: 'linux' }), /requires macOS/)
  assert.equal(f.calls.length, 0)
  await assert.rejects(verifyNodeRuntime(process.execPath, { async run() { return { code: 0, stdout: 'v20.9.0\n', stderr: '' } } }), /22/)
  assert.equal(f.state.requests, 0)
})

test('status is secret-free and uninstall is local, preserves logs, retries Keychain failure', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  await writeFile(f.paths.stdoutLog, 'retained diagnostics')
  const result = await status(f.deps)
  assert.equal(result.launchAgent, 'loaded')
  assert.ok(!JSON.stringify(result).includes(token))
  f.state.removeFailure = true
  await assert.rejects(uninstall(f.deps), /Keychain remove/)
  assert.ok(await readConfig(f.paths.config))
  f.state.removeFailure = false
  await uninstall(f.deps)
  assert.equal(f.credentials.size, 0)
  assert.equal(await readFile(f.paths.stdoutLog, 'utf8'), 'retained diagnostics')
  assert.equal(f.state.requests, 1)
  assert.equal((await status(f.deps)).installed, false)
})

test('LaunchAgent XML escapes paths and rejects relative runtime', async t => {
  const f = await fixture(t)
  assert.ok(renderLaunchAgent(f.paths, '/Node & runtime/node').includes('/Node &amp; runtime/node'))
  assert.throws(() => renderLaunchAgent(f.paths, 'node'), /absolute/)
})

test('CLI rejects argv secrets, dispatches daemon lazily, and install reads injected stdin', async t => {
  const f = await fixture(t)
  const output: string[] = []
  let called = 0
  const deps = { ...f.deps, stdout: (s: string) => { output.push(s) }, stderr: (s: string) => { output.push(s) },
    runDaemon: async () => { called++ }, readPairCode: async (stdinOnly: boolean) => { assert.equal(stdinOnly, true); return options.pairCode } }
  assert.equal(await main(['daemon'], deps), 0)
  assert.equal(called, 1)
  assert.equal(await main(['install', '--server', options.serverUrl, '--ssh-host', options.sshHost, '--pair-code-stdin'], deps), 0)
  assert.equal(await main(['restart'], deps), 0)
  assert.ok(f.calls.some(call => call.args.join(' ') === 'kickstart -k gui/' + (process.getuid?.() ?? 0) + '/dev.deepseek.dsh-companion'))
  assert.equal(await main(['setup', '--pair-code', 'argv-secret'], deps), 1)
  assert.ok(!output.join('').includes('argv-secret'))
  assert.ok(!output.join('').includes(options.pairCode))
  assert.throws(() => parseSetupArgs(['--server', 'x', '--server', 'y']), /duplicate/)
})

test('setup refuses an existing loaded agent or partial bundle before consuming pair code', async t => {
  const f = await fixture(t)
  f.state.loaded = true
  await assert.rejects(setup(options, f.deps), /Existing or unverifiable LaunchAgent/)
  assert.equal(f.state.requests, 0)
  f.state.loaded = false
  await writeFile(f.paths.bundle, 'prior installation')
  await assert.rejects(setup(options, f.deps), /will not overwrite/)
  assert.equal(await readFile(f.paths.bundle, 'utf8'), 'prior installation')
  assert.equal(f.state.requests, 0)
})

test('pairing requires authority epoch and never persists a malformed response', async t => {
  const f = await fixture(t)
  f.deps.fetch = async () => Response.json({ ok: true, token, device: { id: 'dev_fixture' } })
  await assert.rejects(setup(options, f.deps), /authority epoch.*revoke the Device/)
  assert.equal(f.credentials.size, 0)
  await assert.rejects(stat(f.paths.config), { code: 'ENOENT' })
})

test('rollback preserves recovery config when credential deletion fails', async t => {
  const f = await fixture(t)
  f.state.bootstrapFailure = true
  f.state.removeFailure = true
  await assert.rejects(setup(options, f.deps), /Partial rollback.*recovery files retained/)
  assert.equal((await readConfig(f.paths.config)).deviceId, 'dev_fixture')
  assert.equal(f.credentials.size, 1)
})

test('persisted daemon status is whitelisted, labelled stale, and removed on uninstall', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  const statusPath = join(f.paths.root, 'daemon-status.json')
  await writeFile(statusPath, JSON.stringify({ state: 'needs_attention', deviceId: 'dev_fixture', pid: 123, reconnectAttempts: 6,
    updatedAt: '2026-01-01T00:00:00.000Z', token, automaticRetryBlocked: false, lastDisconnectReason: 'NETWORK_ERROR',
    lastDisconnectAt: '2026-01-01T00:00:00.000Z', nextReconnectAt: '2026-01-01T00:00:30.000Z', rawError: token }))
  const report = await status(f.deps)
  assert.deepEqual(report.daemonObservation, { state: 'needs_attention', pid: 123, reconnectAttempts: 6, updatedAt: '2026-01-01T00:00:00.000Z', automaticRetryBlocked: false, lastDisconnectReason: 'NETWORK_ERROR', lastDisconnectAt: '2026-01-01T00:00:00.000Z', nextReconnectAt: '2026-01-01T00:00:30.000Z' })
  assert.ok(String(report.note).includes('stale'))
  assert.ok(!JSON.stringify(report).includes(token))
  await uninstall(f.deps)
  await assert.rejects(stat(statusPath), { code: 'ENOENT' })
})

async function createDaemonDirectory(root: string) {
  const path = join(root, 'daemon.lock')
  await mkdir(path, { mode: 0o700 })
  await writeFile(join(path, 'pid'), '12345', { mode: 0o600 })
  await writeFile(join(path, 'nonce'), '12345678-1234-1234-1234-123456789abc', { mode: 0o600 })
  return path
}

test('setup SSH alias matches executor grammar and rejects targets before consuming a ticket', async t => {
  const f = await fixture(t)
  for (const valid of ['a', 'dev-box_1.example', 'A'.repeat(255)]) assert.equal(validateSshHost(valid), valid)
  for (const sshHost of ['user@host', 'host%user', 'host:22', 'host+suffix', '-alias', '.alias', '_alias', ' alias', 'alias ', 'alias\n', 'alias\r', 'a'.repeat(256)]) {
    assert.throws(() => validateSshHost(sshHost), /human SSH alias/)
    await assert.rejects(setup({ ...options, sshHost }, f.deps), /human SSH alias/)
  }
  assert.equal(f.state.requests, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.credentials.size, 0)
})

test('setup refuses a residual daemon reclaim directory before pairing or overwriting it', async t => {
  const f = await fixture(t)
  await mkdir(f.paths.root, { recursive: true, mode: 0o700 })
  const reclaim = join(f.paths.root, 'daemon.lock.reclaim')
  await mkdir(reclaim, { mode: 0o700 })
  await writeFile(join(reclaim, 'operator-evidence'), 'keep')
  await assert.rejects(setup(options, f.deps), /will not overwrite/)
  assert.equal(f.state.requests, 0)
  assert.equal(await readFile(join(reclaim, 'operator-evidence'), 'utf8'), 'keep')
})

test('uninstall removes an owned dead daemon directory after bootout while holding reclaim mutex', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  const lock = await createDaemonDirectory(f.paths.root)
  let checked = false
  f.deps.isProcessAlive = pid => {
    checked = true
    assert.equal(pid, 12345)
    assert.ok(f.calls.some(call => call.args[0] === 'bootout'), 'bootout must precede any lock removal')
    return false
  }
  const keychain = f.deps.keychain!
  const originalRemove = keychain.remove.bind(keychain)
  keychain.remove = async id => {
    assert.equal((await stat(join(f.paths.root, 'daemon.lock.reclaim'))).isDirectory(), true)
    await originalRemove(id)
  }
  await uninstall(f.deps)
  assert.equal(checked, true)
  await assert.rejects(stat(lock), { code: 'ENOENT' })
  await assert.rejects(stat(join(f.paths.root, 'daemon.lock.reclaim')), { code: 'ENOENT' })
  await assert.rejects(stat(f.paths.config), { code: 'ENOENT' })
})

test('failed bootout does not inspect or recursively delete daemon directory', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  const lock = await createDaemonDirectory(f.paths.root)
  f.state.stopFailure = true
  f.deps.isProcessAlive = () => { throw new Error('must not inspect before successful bootout') }
  await assert.rejects(uninstall(f.deps), /could not stop/)
  assert.equal(await readFile(join(lock, 'pid'), 'utf8'), '12345')
  assert.equal(f.credentials.size, 1)
})

test('live daemon or ambiguous PID liveness retains lock, credential and installation', async t => {
  for (const isProcessAlive of [() => true, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }]) {
    const f = await fixture(t)
    await setup(options, f.deps)
    const lock = await createDaemonDirectory(f.paths.root)
    await assert.rejects(uninstall({ ...f.deps, isProcessAlive }), /manual recovery/)
    assert.equal((await stat(lock)).isDirectory(), true)
    assert.equal(f.credentials.size, 1)
    assert.ok(await readConfig(f.paths.config))
    await assert.rejects(stat(join(f.paths.root, 'daemon.lock.reclaim')), { code: 'ENOENT' })
  }
})

test('pre-existing reclaim mutex is never automatically deleted during uninstall', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  const lock = await createDaemonDirectory(f.paths.root)
  const reclaim = join(f.paths.root, 'daemon.lock.reclaim')
  await mkdir(reclaim, { mode: 0o700 })
  await assert.rejects(uninstall({ ...f.deps, isProcessAlive: () => false }), /reclaim.*manual recovery/)
  assert.ok(await stat(lock))
  assert.ok(await stat(reclaim))
  assert.equal(f.credentials.size, 1)
  assert.ok(await readConfig(f.paths.config))
})

test('uninstall refuses symlink, malformed or unexpectedly populated daemon locks', async t => {
  for (const mode of ['symlink', 'malformed', 'extra-child', 'non-private', 'foreign-owner']) {
    const f = await fixture(t)
    await setup(options, f.deps)
    const outside = join(f.home, 'unrelated')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'unrelated data')
    if (mode === 'symlink') await symlink(outside, join(f.paths.root, 'daemon.lock'))
    else {
      const lock = await createDaemonDirectory(f.paths.root)
      if (mode === 'malformed') await writeFile(join(lock, 'nonce'), 'not-a-valid-nonce')
      if (mode === 'extra-child') await mkdir(join(lock, 'unexpected-directory'))
      if (mode === 'non-private') await chmod(lock, 0o755)
      if (mode === 'foreign-owner') f.deps.uid = (process.getuid?.() ?? 0) + 1
    }
    await assert.rejects(uninstall({ ...f.deps, isProcessAlive: () => false }), /manual recovery/)
    assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'unrelated data')
    assert.equal(f.credentials.size, 1)
    assert.ok(await readConfig(f.paths.config))
  }
})

test('uninstall keeps recursive deletion scoped to daemon.lock, not regular installation paths', async t => {
  const f = await fixture(t)
  await setup(options, f.deps)
  await rm(f.paths.bundle)
  await mkdir(f.paths.bundle)
  await writeFile(join(f.paths.bundle, 'keep'), 'do not recurse')
  await assert.rejects(uninstall(f.deps), { code: 'ERR_FS_EISDIR' })
  assert.equal(await readFile(join(f.paths.bundle, 'keep'), 'utf8'), 'do not recurse')
  assert.ok(await readConfig(f.paths.config))
})


