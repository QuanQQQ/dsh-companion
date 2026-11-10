import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseListeners, serviceHealth, cgroupDirectory } from '../src/health.mjs'
import { ServiceStore } from '../src/store.mjs'
import { SystemdBackend } from '../src/systemd.mjs'
import { DevServiceManager } from '../src/manager.mjs'

async function port(t) {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { if (server.listening) server.close() })
  return { port: server.address().port, server }
}

test('listener parser selects only the requested listening port', () => {
  const rows = 'header\n 0: 0100007F:1435 00000000:0000 0A 0 0 0 1000 0 123\n 1: 0100007F:1435 00000000:0000 01 0 0 0 1000 0 124\n'
  assert.deepEqual(parseListeners(rows, 5173), [{ address: '0100007F', inode: '123' }])
})

test('cgroup mount resolution supports v1, v2, and scoped mount roots', () => {
  assert.equal(cgroupDirectory('30 29 0:26 / /sys/fs/cgroup/systemd rw - cgroup cgroup rw,name=systemd', '/user.slice/app'), '/sys/fs/cgroup/systemd/user.slice/app')
  assert.equal(cgroupDirectory('30 29 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw', '/user.slice/app'), '/sys/fs/cgroup/user.slice/app')
  assert.equal(cgroupDirectory('30 29 0:26 /user.slice /sys/fs/cgroup rw - cgroup2 cgroup rw', '/user.slice/app'), '/sys/fs/cgroup/app')
  assert.throws(() => cgroupDirectory('', '/x'), /not mounted/)
})

test('active process alone is not proof of readiness', async () => {
  assert.equal((await serviceHealth({ port: 5173 }, { exists: true, state: 'active' })).state, 'unknown')
})

for (const bindHost of ['127.0.0.1', '0.0.0.0']) test(`real listener ownership and bind warning: ${bindHost}`, { skip: process.env.DEV_SERVICES_SYSTEMD_TEST !== '1', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dev-services-health-'))
  const store = new ServiceStore(join(root, 'services.sqlite'))
  const backend = new SystemdBackend(store.namespace)
  const manager = new DevServiceManager(store, backend, { authorizeLaunch: () => {} })
  const reservation = await port(t)
  await new Promise(resolve => reservation.server.close(resolve))
  const task = { id: 'health-task', status: 'active', workspacePath: root }
  let service
  t.after(async () => {
    if (service) await manager.remove(task, service.id)
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  service = await manager.create(task, {
    name: 'TCP test', port: reservation.port, protocol: 'tcp', executable: process.execPath, workdir: root,
    args: ['-e', `require('node:net').createServer().listen(Number(process.env.PORT), ${JSON.stringify(bindHost)})`],
  })
  const ready = await manager.start(task, service.id)
  assert.equal(ready.health.state, 'ready')
  if (bindHost === '0.0.0.0') assert.match(ready.health.warning, /non-loopback interfaces/)
  else assert.equal(ready.health.warning, undefined)
  // An unrelated unit's cgroup must not be credited for the same port.
  assert.equal((await serviceHealth({ port: reservation.port }, { ...ready.runtime, cgroup: `/missing/${ready.runtime.unit}` })).state, 'unknown')
})
