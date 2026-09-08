import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test, { type TestContext } from 'node:test'
import { companionPaths, type CompanionConfig } from '../src/config.js'
import { renderLaunchAgent } from '../src/launchd.js'
import { launch, type LaunchDependencies } from '../src/launch.js'

async function fixture(t: TestContext, installed = true) {
  const home = await mkdtemp(join(tmpdir(), 'companion-launch-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = companionPaths(home)
  const runtimePath = await realpath(process.execPath)
  const config: CompanionConfig = { version: 1, serverUrl: 'https://old.example', sshHost: 'devbox', deviceId: 'old-device', installationId: 'old-install', authorityEpoch: 'old-epoch', runtimePath, installedAt: '2026-09-08T00:00:00.000Z' }
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  await mkdir(dirname(paths.launchAgent), { recursive: true, mode: 0o700 })
  if (installed) {
    await writeFile(paths.config, JSON.stringify(config), { mode: 0o600 })
    await writeFile(paths.bundle, '// old bundle', { mode: 0o700 })
    await writeFile(paths.launchAgent, renderLaunchAgent(paths, runtimePath), { mode: 0o600 })
    await writeFile(paths.runtimeState, JSON.stringify({ version: 1, authorityEpoch: 'old-epoch', operations: [], instances: [], oldLease: 'must-not-migrate' }), { mode: 0o600 })
  }
  const source = join(home, 'new.mjs')
  await writeFile(source, '// new bundle', { mode: 0o600 })
  const credentials = new Map(installed ? [['old-device', 'old-secret']] : [])
  const calls: { url: string; init?: RequestInit | undefined }[] = []
  const state = { epoch: installed ? 'old-epoch' : 'new-epoch', verifyCode: 200, verifyError: '', updates: 0, loaded: installed, stops: 0, boots: 0, failBoot: false, failStop: false, failReady: false, networkFailure: false, polls: 0, pollStatus: 'ready', approvalIds: [] as string[], approvals: [] as unknown[], confirmed: true, prompts: [] as unknown[], activePid: 999001, afterApproval: undefined as (() => Promise<void>) | undefined }
  const deps: LaunchDependencies = {
    paths, bundleSource: source, platform: 'darwin', uid: process.getuid?.() ?? 0, version: '0.1.4', readyTimeoutMs: 30, stopTimeoutMs: 500, pollIntervalMs: 1, enrollmentTimeoutMs: 500,
    isProcessAlive: pid => state.loaded && pid === state.activePid,
    promptSshHost: async () => 'devbox',
    confirmRepair: async p => { state.prompts.push(p); return state.confirmed },
    showApproval: async p => { state.approvals.push(p); await state.afterApproval?.() },
    update: async () => { state.updates++; return { version: '0.1.4', changed: true, recovered: false, registration: 'loaded', localReady: true, note: '' } },
    keychain: { read: async id => { const v = credentials.get(id); if (!v) throw new Error('unavailable'); return v }, store: async (id, v) => { if (credentials.has(id)) throw new Error('no overwrite'); credentials.set(id, v) }, remove: async id => { credentials.delete(id) } },
    fetch: async (input, init) => {
      const url = String(input); calls.push({ url, init })
      if (state.networkFailure) throw new Error('network unavailable with secret')
      const path = new URL(url).pathname
      if (path.endsWith('/identity')) return Response.json({ ok: true, authorityEpoch: state.epoch })
      if (path.endsWith('/device/verify')) return state.verifyCode === 200 ? Response.json({ ok: true, deviceId: new Headers(init?.headers).get('authorization') === 'Bearer new-secret' ? 'new-device' : config.deviceId, authorityEpoch: state.epoch }) : Response.json({ok:false,error:{code:state.verifyError}},{status:state.verifyCode})
      if (path.endsWith('/enrollments/start')) {
        state.approvalIds.push(JSON.parse(String(init?.body)).installationId)
        return Response.json({ ok: true, request: { requestId: 'request-new', userCode: 'ABCD-1234', pollToken: 'poll-secret', expiresAt: new Date(Date.now() + 60000).toISOString() } })
      }
      if (path.endsWith('/enrollments/poll')) { state.polls++; return Response.json({ ok: true, status: state.pollStatus, ...(state.pollStatus === 'ready' ? { pairing: { device: { id: 'new-device' }, token: 'new-secret', authorityEpoch: state.epoch } } : {}) }) }
      throw new Error('Unexpected URL ' + url)
    },
    runner: { run: async (file, args) => {
      if (args.length === 1 && args[0] === '--version') return { code: 0, stdout: 'v22.20.0', stderr: '' }
      if (args.length === 2 && args[1] === '--version') return { code: 0, stdout: 'dsh-companion 0.1.4', stderr: '' }
      assert.equal(file, '/bin/launchctl')
      if (args[0] === 'print') return { code: state.loaded ? 0 : 3, stdout: '', stderr: '' }
      if (args[0] === 'kill') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'enable') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'bootout') { state.stops++; if (state.failStop) return { code: 5, stdout: '', stderr: 'secret' }; state.loaded = false; await rm(join(paths.root, 'daemon.lock'), { recursive: true, force: true }); return { code: 0, stdout: '', stderr: '' } }
      if (args[0] === 'bootstrap') {
        state.boots++; state.loaded = true; state.activePid++
        const current = JSON.parse(await readFile(paths.config, 'utf8')) as CompanionConfig
        await mkdir(join(paths.root, 'daemon.lock'), { mode: 0o700, recursive: true })
        await writeFile(join(paths.root, 'daemon.lock', 'pid'), String(state.activePid), { mode: 0o600 })
        await writeFile(join(paths.root, 'daemon.lock', 'nonce'), randomUUID(), { mode: 0o600 })
        if (!state.failReady || current.deviceId === config.deviceId) await writeFile(join(paths.root, 'daemon-status.json'), JSON.stringify({ deviceId: current.deviceId, companionVersion: '0.1.4', bootId: randomUUID(), pid: state.activePid, state: 'ready' }), { mode: 0o600 })
        return { code: state.failBoot && current.deviceId !== config.deviceId ? 5 : 0, stdout: '', stderr: '' }
      }
      throw new Error('Unexpected command')
    } },
  }
  return { home, paths, config, source, credentials, calls, state, deps }
}

test('first launch enrolls through browser approval using the exact saved installation id', async t => {
  const f = await fixture(t, false)
  const result = await launch({ serverUrl: 'https://new.example' }, f.deps)
  assert.equal(result.action, 'installed')
  assert.equal(f.state.approvals.length, 1)
  assert.equal(f.state.approvalIds[0], result.config.installationId)
  assert.equal(result.config.deviceId, 'new-device')
  assert.equal(f.credentials.get('new-device'), 'new-secret')
  assert.ok(!JSON.stringify(f.state.approvals).includes('poll-secret'))
  assert.ok(!f.calls.some(c => c.url.endsWith('/pair')))
  assert.ok(f.calls.every(c => !new Headers(c.init?.headers).has('authorization')))
})

test('changed Host requires consent and browser approval then rebinds with no old leases or token disclosure', async t => {
  const f = await fixture(t)
  f.state.epoch = 'new-epoch'
  const result = await launch({ serverUrl: 'https://new.example' }, f.deps)
  assert.equal(result.action, 'rebound')
  assert.notEqual(result.config.installationId, f.config.installationId)
  assert.equal(result.config.installationId, f.state.approvalIds[0])
  assert.equal(result.config.authorityEpoch, 'new-epoch')
  assert.ok(f.calls.every(c => !new Headers(c.init?.headers).has('authorization')))
  assert.equal(f.credentials.get('new-device'), 'new-secret')
  assert.equal(f.credentials.has('old-device'), false)
  const runtime = JSON.parse(await readFile(f.paths.runtimeState, 'utf8'))
  assert.deepEqual(runtime, { version: 1, authorityEpoch: 'new-epoch', operations: [], instances: [] })
  assert.ok(!(await readdir(f.paths.root)).includes('rebind-journal.json'))
})

test('same Host and verified pairing only updates without new approval', async t => {
  const f = await fixture(t)
  const result = await launch({ serverUrl: f.config.serverUrl }, f.deps)
  assert.equal(result.action, 'updated')
  assert.equal(f.state.updates, 1)
  assert.equal(f.state.approvals.length, 0)
  assert.equal(f.state.prompts.length, 0)
  assert.equal(f.calls.length, 2)
  assert.equal(new Headers(f.calls[1]?.init?.headers).get('authorization'), 'Bearer old-secret')
})

test('authority reset at the same origin does not receive the previous credential', async t => {
  const f = await fixture(t)
  f.state.epoch = 'new-epoch'
  await launch({ serverUrl: f.config.serverUrl }, f.deps)
  assert.equal((f.state.prompts[0] as { reason: string }).reason, 'authority_reset')
  assert.ok(f.calls.every(c => !new Headers(c.init?.headers).has('authorization')))
})

test('approved rebind waits for delayed launchd unregistration', async t => {
  const f = await fixture(t)
  const run = f.deps.runner!.run.bind(f.deps.runner)
  let remaining=2
  f.deps.runner={run:async(file,args,options)=>{
    if(args[0]==='print' && f.state.stops===1 && f.state.boots===0 && remaining-->0) return {code:0,stdout:'',stderr:''}
    return run(file,args,options)
  }}
  const result=await launch({serverUrl:'https://new.example'},f.deps)
  assert.equal(result.action,'rebound')
  assert.equal(f.state.stops,1)
  assert.equal(f.state.boots,1)
})

test('401 requires explicit replacement and never transfers old Device leases', async t => {
  const f = await fixture(t)
  f.state.verifyCode = 401
  const result = await launch({ serverUrl: f.config.serverUrl }, f.deps)
  assert.equal((f.state.prompts[0] as { reason: string }).reason, 'credential_invalid')
  assert.notEqual(result.config.deviceId, f.config.deviceId)
  assert.ok(!(await readFile(f.paths.runtimeState, 'utf8')).includes('must-not-migrate'))
})

test('explicitly revoked credentials need new approval, but a generic forbidden policy does not re-pair', async t => {
  const f = await fixture(t)
  f.state.verifyCode = 403; f.state.verifyError = 'DEVICE_REVOKED'
  const result = await launch({serverUrl:f.config.serverUrl},f.deps)
  assert.equal(result.action,'rebound')
  assert.equal((f.state.prompts[0] as {reason:string}).reason,'credential_invalid')
  assert.notEqual(result.config.deviceId,f.config.deviceId)
  const policy = await fixture(t)
  policy.state.verifyCode=403; policy.state.verifyError='FORBIDDEN'
  await assert.rejects(launch({serverUrl:policy.config.serverUrl},policy.deps))
  assert.equal(policy.state.approvals.length,0)
  assert.equal(policy.state.prompts.length,0)
})

test('declined repair preserves the original installation without enrollment or stop', async t => {
  const f = await fixture(t)
  f.state.confirmed = false
  const original = await readFile(f.paths.config, 'utf8')
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /not approved/)
  assert.equal(f.state.approvals.length, 0)
  assert.equal(f.state.updates, 0)
  assert.equal(f.state.stops, 0)
  assert.equal(await readFile(f.paths.config, 'utf8'), original)
  assert.equal(f.credentials.get('old-device'), 'old-secret')
})

test('network and non-401 Host failures do not turn into re-pairing', async t => {
  for (const failure of ['network', '500'] as const) {
    const f = await fixture(t)
    if (failure === 'network') f.state.networkFailure = true
    else f.state.verifyCode = 500
    await assert.rejects(launch({ serverUrl: f.config.serverUrl }, f.deps), error => error instanceof Error && !error.message.includes('with secret'))
    assert.equal(f.state.prompts.length, 0)
    assert.equal(f.state.updates, 0)
    assert.equal(f.state.approvals.length, 0)
    assert.equal(f.credentials.get('old-device'), 'old-secret')
  }
})

test('denied, expired, delivered or timed-out enrollment never replaces an existing pairing', async t => {
  for (const outcome of ['denied', 'expired', 'delivered', 'pending']) {
    const f = await fixture(t)
    f.state.pollStatus = outcome
    f.deps.enrollmentTimeoutMs = 20
    await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /approval/)
    assert.equal(f.state.updates, 0)
    assert.equal(f.state.stops, 0)
    assert.equal(f.credentials.size, 1)
  }
})

test('cancelling first enrollment runs setup cleanup rather than stranding a partial install', async t => {
  const f = await fixture(t, false)
  const controller = new AbortController()
  f.deps.signal = controller.signal
  f.state.afterApproval = async () => controller.abort()
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps))
  assert.deepEqual(await readdir(f.paths.root), [])
  assert.equal(f.credentials.size, 0)
})

test('failed new bootstrap or readiness rolls back old pairing and runtime', async t => {
  for (const failure of ['boot', 'ready']) {
    const f = await fixture(t)
    const originalConfig = await readFile(f.paths.config, 'utf8')
    const originalRuntime = await readFile(f.paths.runtimeState, 'utf8')
    if (failure === 'boot') f.state.failBoot = true
    else f.state.failReady = true
    await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /old pairing restored/)
    assert.equal(await readFile(f.paths.config, 'utf8'), originalConfig)
    assert.equal(await readFile(f.paths.runtimeState, 'utf8'), originalRuntime)
    assert.equal(f.credentials.get('old-device'), 'old-secret')
    assert.equal(f.credentials.has('new-device'), false)
    assert.ok(!(await readdir(f.paths.root)).includes('rebind-journal.json'))
  }
})

test('refused stop leaves current config and old credential untouched', async t => {
  const f = await fixture(t)
  const original = await readFile(f.paths.config, 'utf8')
  f.state.failStop = true
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /old pairing restored/)
  assert.equal(await readFile(f.paths.config, 'utf8'), original)
  assert.equal(f.credentials.get('old-device'), 'old-secret')
  assert.equal(f.credentials.has('new-device'), false)
})

test('failed rollback keeps both identities and same launch command later restores and retries safely', async t => {
  const f = await fixture(t)
  const run = f.deps.runner!.run
  f.state.failBoot = true
  f.deps.runner!.run = async (...args) => {
    const result = await run(...args)
    if (args[1][0] === 'bootstrap' && JSON.parse(await readFile(f.paths.config, 'utf8')).deviceId === 'new-device') f.state.failStop = true
    return result
  }
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /both identities/)
  assert.equal(f.credentials.size, 2)
  assert.ok((await readdir(f.paths.root)).includes('rebind-journal.json'))
  f.deps.runner!.run = run
  f.state.failBoot = false; f.state.failStop = false
  const result = await launch({ serverUrl: 'https://new.example' }, f.deps)
  assert.equal(result.action, 'rebound')
  assert.equal(f.credentials.has('old-device'), false)
  assert.ok(!(await readdir(f.paths.root)).includes('rebind-journal.json'))
})

test('committed credential cleanup resumes without asking for another browser approval', async t => {
  const f = await fixture(t)
  const remove = f.deps.keychain!.remove
  let fail = true
  f.deps.keychain!.remove = async id => { if (id === 'old-device' && fail) throw new Error('locked'); return remove(id) }
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /locked/)
  assert.ok((await readdir(f.paths.root)).includes('rebind-journal.json'))
  fail = false
  const result = await launch({ serverUrl: 'https://new.example' }, f.deps)
  assert.equal(result.action, 'updated')
  assert.equal(f.state.approvals.length, 1)
  assert.equal(f.credentials.has('old-device'), false)
  assert.ok(!(await readdir(f.paths.root)).includes('rebind-journal.json'))
})

test('valid launch forces restart behind an exact configuration fingerprint', async t => {
  const f = await fixture(t)
  const original = await readFile(f.paths.config, 'utf8')
  const updater = f.deps.update!
  f.deps.update = async d => {
    assert.equal(d.forceRestart, true)
    assert.equal(d.expectedConfigHash, createHash('sha256').update(original).digest('hex'))
    return updater(d)
  }
  await launch({ serverUrl: f.config.serverUrl }, f.deps)
})

test('concurrent pairing changes during approval are never overwritten', async t => {
  const f = await fixture(t)
  const changed = JSON.stringify({ ...f.config, deviceId: 'other-device', installationId: 'other-install' })
  f.state.afterApproval = async () => { await writeFile(f.paths.config, changed) }
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /changed while waiting/)
  assert.equal(await readFile(f.paths.config, 'utf8'), changed)
  assert.equal(f.credentials.has('new-device'), false)
  assert.equal(f.state.stops, 0)
})

test('unverifiable daemon reclaim mutex is retained along with both approved identities', async t => {
  const f = await fixture(t)
  await mkdir(join(f.paths.root, 'daemon.lock.reclaim'), { mode: 0o700 })
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /both identities/)
  assert.ok((await readdir(f.paths.root)).includes('daemon.lock.reclaim'))
  assert.ok((await readdir(f.paths.root)).includes('rebind-journal.json'))
  assert.equal(f.credentials.size, 2)
  assert.equal(JSON.parse(await readFile(f.paths.config, 'utf8')).deviceId, 'old-device')
})

test('symlinked configuration is refused before Host requests or local mutation', async t => {
  const f = await fixture(t)
  const target = join(f.home, 'outside.json')
  const original = await readFile(f.paths.config, 'utf8')
  await writeFile(target, original, { mode: 0o600 })
  await rm(f.paths.config)
  await symlink(target, f.paths.config)
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /Unsafe/)
  assert.equal(f.calls.length, 0)
  assert.equal(await readFile(target, 'utf8'), original)
})

test('an existing credential id from another approved response is not overwritten', async t => {
  const f = await fixture(t)
  const fetcher = f.deps.fetch!
  f.deps.fetch = async (input, init) => {
    const result = await fetcher(input, init)
    if (String(input).endsWith('/enrollments/poll')) {
      const data = await result.json() as { pairing: { device: { id: string } } }
      data.pairing.device.id = 'old-device'
      return Response.json(data)
    }
    return result
  }
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /reused the existing Device id/)
  assert.equal(f.state.updates, 0)
  assert.equal(f.credentials.get('old-device'), 'old-secret')
})

test('recovery refuses changed backups rather than inventing an old authority', async t => {
  const f = await fixture(t)
  f.state.failBoot = true
  const run = f.deps.runner!.run
  f.deps.runner!.run = async (...args) => {
    const result = await run(...args)
    if (args[1][0] === 'bootstrap') f.state.failStop = true
    return result
  }
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /both identities/)
  const journal = JSON.parse(await readFile(join(f.paths.root, 'rebind-journal.json'), 'utf8')) as { id: string }
  await writeFile(join(f.paths.root, '.rebind-' + journal.id + '-config.bak'), '{}')
  f.deps.runner!.run = run; f.state.failStop = false; f.state.failBoot = false
  await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps), /backup hash mismatch/)
  assert.equal(f.credentials.size, 2)
  assert.equal(JSON.parse(await readFile(f.paths.config, 'utf8')).deviceId, 'new-device')
})

test('a newer caller recovers the journal using the installed bundle version before upgrading', async t => {
  for (const phase of ['switching', 'committed']) {
    const f = await fixture(t)
    const run = f.deps.runner!.run
    const remove = f.deps.keychain!.remove
    if (phase === 'switching') {
      f.state.failBoot = true
      f.deps.runner!.run = async (...args) => {
        const result = await run(...args)
        if (args[1][0] === 'bootstrap') f.state.failStop = true
        return result
      }
    } else {
      f.deps.keychain!.remove = async id => { if (id === 'old-device') throw new Error('cleanup unavailable'); return remove(id) }
    }
    await assert.rejects(launch({ serverUrl: 'https://new.example' }, f.deps))
    const updater = f.deps.update!
    f.deps.version = '0.1.5'
    f.deps.update = async d => { assert.equal(d.version, '0.1.5'); return { ...await updater(d), version: '0.1.5' } }
    f.deps.runner!.run = run; f.deps.keychain!.remove = remove
    f.state.failBoot = false; f.state.failStop = false
    const result = await launch({ serverUrl: phase === 'switching' ? f.config.serverUrl : 'https://new.example' }, f.deps)
    assert.equal(result.action, 'updated')
    assert.equal(f.state.approvals.length, 1)
    assert.equal(f.credentials.size, 1)
    assert.ok(!(await readdir(f.paths.root)).includes('rebind-journal.json'))
  }
})
