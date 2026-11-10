import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceStore } from '../src/store.mjs'
import { DevServiceManager } from '../src/manager.mjs'

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dev-services-manager-'))
  const store = new ServiceStore(join(root, 'services.sqlite'))
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const live = new Set(), calls = []
  const backend = {
    inspect: async record => ({ exists: live.has(record.id), state: live.has(record.id) ? 'active' : 'stopped' }),
    start: async record => { calls.push('start'); live.add(record.id) },
    stop: async record => { calls.push('stop'); live.delete(record.id) },
    logs: async () => 'app output',
  }
  const manager = new DevServiceManager(store, backend, {
    portFree: async () => {}, health: async (_record, runtime) => ({ state: runtime.state === 'active' ? 'ready' : 'unavailable' }),
    authorizeLaunch: () => {}, ...options,
  })
  const task = { id: 'task-a', workspacePath: root, status: 'active' }
  const input = { name: 'App', executable: process.execPath, args: ['app.mjs'], workdir: root, port: 5173, protocol: 'http' }
  return { root, store, manager, backend, task, input, calls, live }
}

test('service lifecycle retains identity and port after stop and retirement', async t => {
  const f = await fixture(t)
  const service = await f.manager.create(f.task, f.input)
  assert.equal(service.desired, 'stopped')
  assert.equal((await f.manager.start(f.task, service.id)).health.state, 'ready')
  assert.equal(await f.manager.logs(f.task, service.id), 'app output')
  await f.manager.stop(f.task, service.id)
  await f.manager.restart(f.task, service.id)
  const removed = await f.manager.remove(f.task, service.id)
  assert.equal(removed.removalComplete, true)
  await assert.rejects(f.manager.create(f.task, f.input), /reserved/)
  await assert.rejects(f.manager.start(f.task, service.id), /retired/)
  const secondStore = new ServiceStore(join(f.root, 'services.sqlite'))
  try {
    assert.equal(secondStore.namespace, f.store.namespace)
    assert.equal(secondStore.get(service.id).desired, 'removed')
    assert.equal(secondStore.get(service.id).ownership, f.store.get(service.id).ownership)
  } finally { secondStore.close() }
})

test('cross project access and restricted execution fail before any process side effect', async t => {
  const f = await fixture(t, { authorizeLaunch: () => { throw new Error('restricted deployment') } })
  const service = await f.manager.create(f.task, f.input)
  for (const method of ['status', 'start', 'stop', 'restart', 'logs', 'remove', 'synchronize']) await assert.rejects(f.manager[method]({ ...f.task, id: 'b', workspacePath: `${f.root}-other` }, service.id), /another Workspace/)
  assert.equal((await f.manager.list({ ...f.task, id: 'b', workspacePath: `${f.root}-other` })).length, 0)
  for (const method of ['start', 'restart']) await assert.rejects(f.manager[method](f.task, service.id), /restricted/)
  assert.deepEqual(f.calls, [])
})

test('unverified listener never authorizes stopping any process', async t => {
  const f = await fixture(t, { health: async () => ({ state: 'unsafe', reason: 'foreign listener' }) })
  const service = await f.manager.create(f.task, f.input)
  const result = await f.manager.start(f.task, service.id)
  assert.equal(result.readiness.state, 'not_ready')
  assert.equal(f.store.get(service.id).desired, 'running')
  assert.deepEqual(f.calls, ['start'])
  assert.equal(f.live.has(service.id), true)
})

test('simultaneous managers cannot overlap lifecycle side effects', async t => {
  const f = await fixture(t)
  const secondStore = new ServiceStore(join(f.root, 'services.sqlite'))
  t.after(() => secondStore.close())
  let release
  const pending = f.store.locked(async () => await new Promise(resolve => { release = resolve }))
  await assert.rejects(secondStore.locked(async () => {}), /already in progress/)
  release()
  await pending
  await secondStore.locked(async () => {})
})

test('declaration failure remains retryable and neither stop nor restart grants forwarding', async t => {
  let fail = true
  const events = []
  const companion = {
    ensure: async () => { events.push('ensure'); if (fail) throw new Error('transport lost'); return { state: 'synced', id: 'declaration' } },
    retire: async () => { events.push('retire'); return { state: 'retired', id: 'declaration' } },
  }
  const f = await fixture(t, { companion })
  const service = await f.manager.create(f.task, f.input)
  assert.equal((await f.manager.start(f.task, service.id)).companion.state, 'error')
  fail = false
  assert.equal((await f.manager.synchronize(f.task, service.id)).companion.state, 'synced')
  await f.manager.stop(f.task, service.id)
  assert.deepEqual(events, ['ensure', 'ensure'])
  assert.equal((await f.manager.remove(f.task, service.id)).removalComplete, true)
  assert.deepEqual(events, ['ensure', 'ensure', 'retire'])
})

test('unknown registration followed by unavailable Companion cannot report retirement complete', async t => {
  const f = await fixture(t, { companion: { ensure: async () => { throw new Error('response lost after commit') } } })
  const service = await f.manager.create(f.task, f.input)
  await f.manager.start(f.task, service.id)
  f.manager.companion = undefined
  await f.manager.synchronize(f.task, service.id)
  const removed = await f.manager.remove(f.task, service.id)
  assert.equal(removed.removalComplete, false)
  assert.equal(removed.companion.attempted, true)
})

test('manual declaration retirement is not undone by service restart or sync', async t => {
  let ensures = 0
  const f = await fixture(t, { companion: { ensure: async () => { ensures++; return { state: 'detached', id: 'retired-declaration' } } } })
  const service = await f.manager.create(f.task, f.input)
  await f.manager.start(f.task, service.id)
  await f.manager.restart(f.task, service.id)
  await f.manager.synchronize(f.task, service.id)
  assert.equal(ensures, 1)
})
