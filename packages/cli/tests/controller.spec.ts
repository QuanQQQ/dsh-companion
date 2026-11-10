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
  probes = 0
  probeResult: 'healthy' | 'failed' | 'unknown' = 'healthy'
  listenerResult: 'missing' | 'conflict' | 'unknown' = 'missing'
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
  async probe() { this.probes++; return this.probeResult }
  async listenerState() { return this.listenerResult }
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

it('tick refreshes actual owned TCP samples; cached lists only age evidence with monotonic time', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  const first = f.controller.observations()[0]!
  assert.equal(first.remoteProbe, 'healthy')
  assert.equal(first.probeAgeMs, 0)
  assert.equal(f.ssh.probes, 1)
  f.rewind(31_000)
  const cached = f.controller.observations()[0]!
  assert.equal(cached.sampledAt, first.sampledAt)
  assert.equal(cached.probeAgeMs, 31_000)
  assert.equal(f.ssh.probes, 1, 'list serialization cannot refresh a sample')
  await f.controller.tick()
  assert.equal(f.ssh.probes, 2)
  assert.equal(f.controller.observations()[0]!.probeAgeMs, 0)
  assert.notEqual(f.controller.observations()[0]!.sampledAt, first.sampledAt)
})

it('an upgraded daemon cannot authenticate persisted old healthy as a new sample', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  await f.store.patch('lease', { sampledAt: '2026-09-07T00:00:00.000Z', probeAgeMs: 0 })
  const restarted = new ForwardController(f.store, f.ssh)
  restarted.connect(f.hello)
  assert.equal(restarted.observations()[0]?.remoteProbe, 'unknown')
  assert.equal(restarted.observations()[0]?.sampledAt, undefined)
  assert.equal(restarted.observations()[0]?.probeAgeMs, undefined)
})

it('disconnect during in-flight probe or persistence cannot restore healthy into a new session', async t => {
  for (const phase of ['probe', 'persist']) {
    const f = await fixture(t)
    await f.controller.execute(f.command)
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(done => { entered = done })
    const gate = new Promise<void>(done => { release = done })
    if (phase === 'probe') f.ssh.probe = async () => { entered(); await gate; return 'healthy' }
    else {
      const patch = f.store.patch.bind(f.store)
      f.store.patch = async (id, value) => {
        if (value.remoteProbe === 'healthy') { entered(); await gate }
        return patch(id, value)
      }
    }
    const ticking = f.controller.tick()
    await waiting
    const disconnected = f.controller.disconnect()
    assert.equal(f.controller.observations()[0]?.remoteProbe, 'unknown', phase)
    release()
    await ticking
    await disconnected
    f.controller.connect({ ...f.hello, sessionEpoch: 'next' })
    assert.equal(f.controller.observations()[0]?.remoteProbe, 'unknown', phase)
    assert.equal(f.controller.observations()[0]?.probeAgeMs, undefined, phase)
  }
})

it('failed TCP probe preserves owned SSH and clears old healthy on the next tick', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  f.ssh.probeResult = 'failed'
  f.advance(1000)
  await f.controller.tick()
  const observed = f.controller.observations()[0]!
  assert.equal(observed.remoteProbe, 'failed')
  assert.equal(observed.listener, 'owned')
  assert.equal(observed.sshChild, 'running')
  assert.equal(observed.state, 'running')
  assert.equal(f.ssh.owned.has('lease'), true)
  assert.equal(f.ssh.starts, 1)
})

it('legacy executor without probe reports disabled with no actual sample', async t => {
  const f = await fixture(t)
  const legacy: TunnelExecutor = { start: f.ssh.start.bind(f.ssh), stop: f.ssh.stop.bind(f.ssh),
    stopAll: f.ssh.stopAll.bind(f.ssh), isOwned: f.ssh.isOwned.bind(f.ssh) }
  const controller = new ForwardController(f.store, legacy)
  controller.connect(f.hello)
  await controller.execute({ ...f.command, expiresAt: '2099-01-01T00:00:00.000Z' })
  assert.equal(controller.observations()[0]!.remoteProbe, 'disabled')
  assert.equal(controller.observations()[0]!.probeAgeMs, undefined)
})

it('disconnect invalidates healthy immediately even if stop fails, and persists unknown', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  f.ssh.stopAll = async () => { throw new Error('SSH_STOP_TIMEOUT') }
  const disconnected = f.controller.disconnect()
  assert.equal(f.controller.observations()[0]!.remoteProbe, 'unknown')
  assert.equal(f.controller.observations()[0]!.probeAgeMs, undefined)
  await assert.rejects(disconnected, /SSH_STOP_TIMEOUT/)
  assert.equal(f.store.observations()[0]!.remoteProbe, 'unknown')
  assert.equal(f.store.observations()[0]!.sshChild, 'unknown')
})

it('close only reports missing after listener scan; foreign residual and absent port stay unconfirmed', async t => {
  for (const listener of ['missing', 'conflict', 'unknown'] as const) {
    const f = await fixture(t)
    await f.controller.execute(f.command)
    f.ssh.listenerResult = listener
    const result = await f.controller.execute({ v: 1, type: 'forward.close', authorityEpoch: 'authority', sessionEpoch: 'session',
      leaseId: 'lease', operationId: 'close', digest: 'b'.repeat(64), generation: 2, reason: 'user' })
    assert.equal(result.observation?.state, 'closed')
    assert.equal(result.observation?.sshChild, 'exited')
    assert.equal(result.observation?.listener, listener)
    assert.equal(result.observation?.remoteProbe, 'unknown')
    assert.equal(result.observation?.probeAgeMs, listener === 'unknown' ? undefined : 0)
    assert.equal(f.ssh.owned.size, 0)
  }
  const f = await fixture(t)
  const result = await f.controller.execute({ v: 1, type: 'forward.close', authorityEpoch: 'authority', sessionEpoch: 'session',
    leaseId: 'unknown', operationId: 'close', digest: 'b'.repeat(64), generation: 2, reason: 'user' })
  assert.equal(result.observation?.listener, 'unknown', 'placeholder port is not listener evidence')
})

it('closed tick rechecks the listener instead of fresh-stamping cached missing evidence', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  await f.controller.execute({ v: 1, type: 'forward.close', authorityEpoch: 'authority', sessionEpoch: 'session',
    leaseId: 'lease', operationId: 'close', digest: 'b'.repeat(64), generation: 2, reason: 'user' })
  const first = f.controller.observations()[0]!
  f.advance(31_000)
  assert.equal(f.controller.observations()[0]?.sampledAt, first.sampledAt)
  assert.equal(f.controller.observations()[0]?.probeAgeMs, 31_000)
  f.ssh.listenerResult = 'conflict'
  await f.controller.tick()
  assert.equal(f.controller.observations()[0]?.listener, 'conflict')
  assert.notEqual(f.controller.observations()[0]?.sampledAt, first.sampledAt)
  assert.equal(f.controller.observations()[0]?.probeAgeMs, 0)
})

it('close waits for verified stop and never acknowledges an unexited SSH child as closed/missing', async t => {
  const f = await fixture(t)
  await f.controller.execute(f.command)
  f.ssh.stop = async () => { throw new Error('SSH_STOP_TIMEOUT') }
  await assert.rejects(f.controller.execute({ v: 1, type: 'forward.close', authorityEpoch: 'authority', sessionEpoch: 'session',
    leaseId: 'lease', operationId: 'close', digest: 'b'.repeat(64), generation: 2, reason: 'user' }), /SSH_STOP_TIMEOUT/)
  assert.equal(f.controller.observations()[0]?.sshChild, 'unknown')
  assert.equal(f.controller.observations()[0]?.listener, 'unknown')
  assert.equal(f.controller.observations()[0]?.probeAgeMs, undefined)
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
