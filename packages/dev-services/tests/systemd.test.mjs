import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { SystemdBackend, boundedLogs } from '../src/systemd.mjs'

const record = () => ({ id: `svc_${randomUUID()}`, ownership: randomBytes(32).toString('hex'), executable: process.execPath, args: [], workdir: tmpdir(), port: 5173 })

async function until(check) {
  const deadline = Date.now() + 10000
  while (true) {
    try { return await check() } catch (error) {
      if (Date.now() >= deadline) throw error
      await delay(40)
    }
  }
}

test('logs obey total byte and line bounds even for multibyte output', () => {
  for (const text of ['a\n'.repeat(1000), '界'.repeat(100000), 'a\n'.repeat(1000) + '界'.repeat(100000)]) {
    for (const lines of [1, 80, 500]) {
      const output = boundedLogs(text, lines)
      assert.ok(Buffer.byteLength(output) <= 65536)
      assert.ok(output.split('\n').length <= lines)
    }
  }
})

test('foreign unit is never signalled or read', async () => {
  const calls = []
  const backend = new SystemdBackend('test', { run: async (file, args) => {
    calls.push([file, args])
    return { code: 0, stdout: 'LoadState=loaded\nDescription=foreign\nActiveState=active\n', stderr: '' }
  } })
  for (const method of ['start', 'stop', 'logs']) await assert.rejects(backend[method](record()), /ownership mismatch/)
  assert.ok(calls.every(([file, args]) => file === 'systemctl' && args.includes('show')))
})

test('missing manager is an error, not an absent unit', async () => {
  const backend = new SystemdBackend('test', { run: async () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus' }) })
  await assert.rejects(backend.start(record()), /Cannot observe/)
})

test('application args use one encoded payload and no ambient credentials', async () => {
  const calls = []
  const backend = new SystemdBackend('test', { run: async (file, args) => {
    calls.push([file, args])
    return { code: 0, stdout: 'LoadState=not-found\n', stderr: '' }
  } })
  const spec = record()
  spec.args = ['${TOKEN}', '%n', ';hello', 'space here']
  await backend.start(spec)
  const args = calls.find(([file]) => file === 'systemd-run')[1]
  const decoded = JSON.parse(Buffer.from(args.at(-1), 'base64url').toString())
  assert.deepEqual(decoded.args, spec.args)
  assert.deepEqual(Object.keys(decoded.env).sort(), ['HOME', 'HOST', 'LANG', 'PATH', 'PORT'])
  assert.ok(args.includes('-i'))
  assert.ok(args.includes('--property=KillMode=control-group'))
  assert.ok(args.includes('--property=SuccessExitStatus=SIGTERM'))
})

test('a service survives termination of its launching Host unit and reconnects by identity', { skip: process.env.DEV_SERVICES_SYSTEMD_TEST !== '1', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dev-services-host-survival-'))
  const namespace = `test-${randomUUID()}`
  const backend = new SystemdBackend(namespace)
  const host = record()
  const app = record()
  const ready = join(root, 'ready')
  app.args = ['-e', 'setInterval(()=>{},1000)']
  const moduleUrl = new URL('../src/systemd.mjs', import.meta.url).href
  host.args = ['--input-type=module', '-e', `
    import { SystemdBackend } from ${JSON.stringify(moduleUrl)};
    import { writeFileSync } from 'node:fs';
    process.env.XDG_RUNTIME_DIR = '/run/user/' + process.getuid();
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + process.env.XDG_RUNTIME_DIR + '/bus';
    await new SystemdBackend(${JSON.stringify(namespace)}).start(${JSON.stringify(app)});
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(()=>{},1000);
  `]
  t.after(async () => { await backend.stop(host); await backend.stop(app); await rm(root, { recursive: true, force: true }) })
  await backend.start(host)
  await until(async () => assert.equal(await readFile(ready, 'utf8'), 'ready'))
  const before = await backend.inspect(app)
  assert.equal(before.state, 'active')
  await backend.stop(host)
  const reconnected = await new SystemdBackend(namespace).inspect(app)
  assert.equal(reconnected.state, 'active')
  assert.equal(reconnected.pid, before.pid)
})

test('failure restarts are bounded and a stopped service can explicitly restart', { skip: process.env.DEV_SERVICES_SYSTEMD_TEST !== '1', timeout: 30000 }, async t => {
  const backend = new SystemdBackend(`test-${randomUUID()}`, { policy: { restartDelaySeconds: 1, restartBurst: 2, restartIntervalSeconds: 60 } })
  const spec = record()
  spec.args = ['-e', 'process.exit(1)']
  t.after(() => backend.stop(spec))
  await backend.start(spec)
  await until(async () => {
    const state = await backend.inspect(spec)
    assert.equal(state.state, 'failed')
    assert.equal(state.restarts, 2)
    assert.equal(state.pid, 0)
    // systemd 252 retains exit-code when restart admission hits the limit.
    assert.match(await backend.logs(spec), /Start request repeated too quickly/)
  })
  const cleared = await backend.stop(spec)
  assert.equal(cleared.exists, false)
  assert.equal(cleared.state, 'stopped')
  await backend.start(spec)
  await backend.stop(spec)
})

test('real systemd unit isolates cgroup, preserves argv, sanitizes env, and stops descendants', { skip: process.env.DEV_SERVICES_SYSTEMD_TEST !== '1', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dev-services-systemd-'))
  const backend = new SystemdBackend(`test-${randomUUID()}`)
  const spec = record()
  const output = join(root, 'observed.json')
  spec.args = ['--input-type=module', '-e', `
    import { writeFileSync, readFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(output)}, JSON.stringify({ pid: process.pid, child: child.pid, args: process.argv.slice(1), env: process.env, cgroup: readFileSync('/proc/self/cgroup', 'utf8') }));
    console.log('dev-services-real-test');
    setInterval(()=>{},1000);
  `, '${HOME}', '%n', '; no-shell', 'space here']
  t.after(async () => { await backend.stop(spec); await rm(root, { recursive: true, force: true }) })
  const started = await backend.start(spec)
  assert.equal(started.state, 'active')
  const observed = await until(async () => JSON.parse(await readFile(output, 'utf8')))
  assert.deepEqual(observed.args, ['${HOME}', '%n', '; no-shell', 'space here'])
  assert.equal(observed.env.PORT, '5173')
  assert.equal(observed.env.NODE_OPTIONS, undefined)
  assert.equal(observed.env.DSH_HOME, undefined)
  assert.equal(observed.env.DEEPSEEK_API_KEY, undefined)
  assert.notEqual(observed.cgroup, await readFile('/proc/self/cgroup', 'utf8'))
  assert.ok(observed.cgroup.includes(started.unit))
  assert.ok((await until(async () => { const logs = await backend.logs(spec); assert.match(logs, /dev-services-real-test/); return logs })).length)
  const stopped = await backend.stop(spec)
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.exists, false)
  await until(async () => {
    for (const pid of [observed.pid, observed.child]) {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
        // Zombies hold no running process resources and cannot serve requests.
        assert.match(stat, /\) Z /)
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  })
})
