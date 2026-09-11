import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStore } from '../src/runtime-state.js'
import { ForwardController, type TunnelExecutor } from '../src/controller.js'
import type { ForwardOpen, ForwardClose } from '../src/wire.js'

class FakeSsh implements TunnelExecutor {
  owned = new Set<string>()
  starts = 0
  code = ''
  async start(id: string) {
    this.starts++
    if (this.code) throw Object.assign(new Error('fixture failure'), { code: this.code })
    this.owned.add(id)
    return { pid: 100, controlPath: '/tmp/test/socket' }
  }
  async stop(id: string) { this.owned.delete(id) }
  async stopAll() { this.owned.clear() }
  async isOwned(id: string) { return this.owned.has(id) }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'companion-controller-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await RuntimeStore.open(join(dir, 'state.json'), 'authority')
  const ssh = new FakeSsh()
  let now = Date.parse('2026-09-07T00:00:00.000Z')
  let mono = 0
  const controller = new ForwardController(store, ssh, { wall: () => now, monotonic: () => mono })
  const hello = { v: 1 as const, type: 'host.hello' as const, authorityEpoch: 'authority', sessionEpoch: 'session', heartbeatMs: 1000, serverTime: new Date(now).toISOString() }
  controller.connect(hello)
  const command: ForwardOpen = { v: 1, type: 'forward.open', authorityEpoch: 'authority', sessionEpoch: 'session', leaseId: 'lease', operationId: 'open-1',
    digest: 'a'.repeat(64), generation: 1, port: 5173, protocol: 'http', expiresAt: new Date(now + 60_000).toISOString() }
  return { controller, ssh, store, command, hello, advance(ms: number) { now += ms; mono += ms }, rewind(ms: number) { now -= ms; mono += ms } }
}
it('close tombstone prevents earlier operation from reopening the listener', async t => {
  const f = await fixture(t)
  assert.equal((await f.controller.execute(f.command)).ok, true)
  const close: ForwardClose = { v: 1, type: 'forward.close', authorityEpoch: 'authority', sessionEpoch: 'session', leaseId: 'lease', operationId: 'close-2', digest: 'b'.repeat(64), generation: 2, reason: 'user' }
  await f.controller.execute(close)
  await f.controller.execute(f.command)
  assert.equal(f.ssh.starts, 1)
  assert.equal(f.ssh.owned.size, 0)
  assert.equal(f.store.observations()[0]?.state, 'closed')
})

it('disconnect closes listeners and reconnect requires a fresh Host operation', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  await f.controller.disconnect()
  assert.equal(f.ssh.owned.size, 0)
  f.controller.connect({ ...f.hello, sessionEpoch: 'next' })
  await f.controller.tick()
  assert.equal(f.ssh.starts, 1)
  await assert.rejects(f.controller.execute(f.command), /Stale/)
  await f.controller.execute({ ...f.command, sessionEpoch: 'next', operationId: 'reconcile', digest: 'c'.repeat(64) })
  assert.equal(f.ssh.starts, 2)
})

it('monotonic deadline closes TTL even when the wall clock moves backwards', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  f.rewind(60_001)
  await f.controller.tick()
  assert.equal(f.ssh.owned.size, 0)
  assert.equal(f.store.observations()[0]?.errorCode, 'LEASE_EXPIRED')
})

it('automatic transient recovery continues past the old retry limit and resets after success', async t => {
  const f = await fixture(t)
  f.ssh.code = 'SSH_EXITED'
  f.command.expiresAt = '2026-09-07T02:00:00.000Z'
  await f.controller.execute(f.command)
  for (let i = 0; i < 9; i++) { f.advance(30_000); await f.controller.tick() }
  assert.equal(f.ssh.starts, 10)
  assert.equal(f.store.observations()[0]?.state, 'recovering')
  assert.equal(f.store.observations()[0]?.errorCode, 'SSH_EXITED')
  f.ssh.code = ''
  f.advance(30_000)
  await f.controller.tick()
  assert.equal(f.ssh.starts, 11)
  assert.equal(f.store.observations()[0]?.state, 'running')
  assert.equal(f.store.observations()[0]?.retryAttempt, 0)

  const second = await fixture(t)
  second.ssh.code = 'SSH_AUTH_FAILED'
  await second.controller.execute(second.command)
  second.advance(10_000)
  await second.controller.tick()
  assert.equal(second.ssh.starts, 1)
})

it('executor Host Key and port conflict codes never trigger automatic retry', async t => {
  for (const code of ['SSH_HOST_KEY_FAILED', 'SSH_PORT_IN_USE', 'SSH_CONFIG_UNSAFE']) {
    const f = await fixture(t)
    f.ssh.code = code
    await f.controller.execute(f.command)
    f.advance(10_000)
    await f.controller.tick()
    assert.equal(f.ssh.starts, 1, code)
    assert.equal(f.store.observations()[0]?.state, 'needs_attention')
  }
})

it('normal disconnect clears recovered control paths so daemon can restart safely', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  await f.controller.disconnect()
  const restarted = new ForwardController(f.store, {
    start: f.ssh.start.bind(f.ssh), stop: f.ssh.stop.bind(f.ssh), stopAll: f.ssh.stopAll.bind(f.ssh), isOwned: f.ssh.isOwned.bind(f.ssh),
    recover: async () => { throw new Error('stopped executor already removed this control path') },
  })
  await restarted.initialize()
})

it('loss of ownership evidence stops the known child before reporting failure', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  f.ssh.isOwned = async () => false
  await f.controller.tick()
  assert.equal(f.ssh.owned.size, 0)
})

it('disconnect during asynchronous ownership checks cannot spawn a new child', async t => {
  const f = await fixture(t)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { entered = resolve })
  f.ssh.isOwned = async () => { entered(); await gate; return false }
  const applying = f.controller.execute(f.command)
  await waiting
  const stopping = f.controller.disconnect()
  release()
  await applying
  await stopping
  assert.equal(f.ssh.starts, 0)
})

it('TTL cancellation is independent of another Lease slow SSH startup', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const start = f.ssh.start.bind(f.ssh)
  f.ssh.start = async id => { if (id === 'other') { entered(); await gate } return start(id) }
  const applying = f.controller.execute({ ...f.command, leaseId: 'other', operationId: 'other-open', digest: 'f'.repeat(64), port: 5174, expiresAt: '2026-09-07T01:00:00.000Z' })
  await waiting
  f.advance(60_001)
  try {
    await f.controller.expireNow()
    assert.equal(f.ssh.owned.has('lease'), false)
  } finally { release(); await applying }
})
