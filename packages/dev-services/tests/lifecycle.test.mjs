import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceStore } from '../src/store.mjs'
import { DevServiceManager } from '../src/manager.mjs'
import { serviceHealth, connectLoopback } from '../src/health.mjs'

// Only a temporary self-owned ChildProcess is signalled; no shared systemd changes.
async function childFixture(t, startupMs = 15) {
  const root = await mkdtemp(join(tmpdir(), 'dev-services-linux-child-'))
  const store = new ServiceStore(join(root, 'services.sqlite'))
  let child, stopped = 0, ready
  const backend = {
    inspect: async () => ({ exists: Boolean(child && child.exitCode === null && child.signalCode === null), state: child && child.exitCode === null && child.signalCode === null ? 'active' : 'stopped', commands: 'SECRET_COMMAND', env: { TOKEN: 'SECRET_ENV' } }),
    start: async () => {
      if (child) return
      child = spawn(process.execPath, ['-e', "console.log('owned');setInterval(()=>{},1000)"], { cwd: root, env: {}, stdio: ['ignore', 'pipe', 'ignore'] })
      ready = once(child.stdout, 'data'); await ready
    },
    stop: async () => { stopped++; if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited } },
  }
  const signal = new AbortController()
  const manager = new DevServiceManager(store, backend, { authorizeLaunch: () => {}, portFree: async () => {}, health: async () => ({ state: 'starting' }), startupMs, pollMs: 2, signal: signal.signal })
  const workspace = { workspacePath: root }
  const service = await manager.create(workspace, { name: 'Child', executable: process.execPath, args: ['SECRET_ARG'], workdir: root, port: 5173, protocol: 'tcp' })
  t.after(async () => {
    await backend.stop()
    store.close()
    // The exact mkdtemp root owns this fixture and nothing else.
    await rm(root, { recursive: true, force: true })
  })
  return { root, store, backend, manager, workspace, service, signal, child: () => child, stops: () => stopped }
}

test('Linux slow self-owned child survives readiness timeout and recovers after store reopen', { skip: process.platform !== 'linux' }, async t => {
  const f = await childFixture(t)
  const result = await f.manager.start(f.workspace, f.service.id)
  assert.equal(result.readiness.state, 'not_ready')
  assert.equal(f.store.get(f.service.id).desired, 'running')
  assert.equal(f.child().exitCode, null)
  assert.equal(f.stops(), 0)
  const reopened = new ServiceStore(join(f.root, 'services.sqlite'))
  try {
    assert.equal(reopened.get(f.service.id).readiness.state, 'not_ready')
    assert.equal((await new DevServiceManager(reopened, f.backend, { health: async () => ({ state: 'ready' }) }).get(f.service.id)).health.state, 'ready')
  } finally { reopened.close() }
  assert.ok(!JSON.stringify(result).includes('SECRET'))
  await f.manager.stop(f.workspace, f.service.id)
  assert.equal(f.stops(), 1)
})

test('Host-style unloading cancels long wait but never sends termination to owned child', { skip: process.platform !== 'linux', timeout: 5000 }, async t => {
  const f = await childFixture(t, 600000)
  const start = f.manager.start(f.workspace, f.service.id)
  // Observe our own temporary child through the backend before simulating unload.
  // start is already queued; completion notification is backend launch readiness.
  await new Promise(resolve => {
    const check = () => { if (f.child()) resolve(); else setImmediate(check) }
    check()
  })
  f.signal.abort(new Error('Host unload'))
  const result = await start
  assert.equal(result.readiness.state, 'not_ready')
  assert.equal(f.child().exitCode, null)
  assert.equal(f.stops(), 0)
  assert.equal(f.store.get(f.service.id).desired, 'running')
})

test('Linux real TCP child requires owned inode AND active connect; foreign PID never credited', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['-e', "const s=require('node:net').createServer(c=>c.end());s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { env: {}, stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited } })
  const [output] = await once(child.stdout, 'data')
  const port = Number(output.toString().trim())
  const runtime = { exists: true, state: 'active', cgroup: '/test/owned.service', unit: 'owned.service' }
  const hooks = { readFile: async (path, encoding) => path === '/proc/self/mountinfo' ? '30 29 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw' : readFile(path, encoding), collectPids: async () => [String(child.pid)] }
  assert.equal(await connectLoopback(port), true)
  assert.equal((await serviceHealth({ port }, runtime, hooks)).state, 'ready')
  assert.equal((await serviceHealth({ port }, runtime, { ...hooks, connect: async () => false })).state, 'not_ready')
  assert.equal((await serviceHealth({ port }, runtime, { ...hooks, collectPids: async () => [] })).state, 'unsafe')
  assert.equal(child.exitCode, null)
})
