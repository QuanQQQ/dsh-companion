import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { CompanionState } from '../src/domain.js'
import { CompanionEnrollmentService } from '../src/enrollment.js'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'

const input = { installationId: 'installation-mac-fixture', name: 'Mac fixture', osVersion: '24.0.0', architecture: 'arm64', companionVersion: '0.1.4' }

async function fixture(t: TestContext, options: { ttlMs?: number; maxRecords?: number } = {}) {
  let now = Date.now(), monotonic = 0
  const store = new MemoryCompanionStateStore()
  const service = await CompanionService.create(store, { clock: { now: () => now } })
  const enrollment = new CompanionEnrollmentService(service, { ...options, now: () => now, monotonicNow: () => monotonic })
  t.after(() => enrollment.dispose())
  return { enrollment, service, store, advance: (ms: number) => { now += ms }, monotonic: (ms: number) => { monotonic += ms } }
}

const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected

test('atomic existing-installation guard survives a legacy pairing interleaved after approval precheck', async t => {
  const f = await fixture(t)
  const createTicket = f.service.createPairingTicket.bind(f.service)
  let originalToken = ''
  f.service.createPairingTicket = async ttl => {
    const other = await createTicket()
    const paired = await f.service.pairDevice({ ...input, code: other.code, capabilities: { protocolVersion: 1, localForward: true, tcpProbe: false } })
    originalToken = paired.token
    return createTicket(ttl)
  }
  const request = f.enrollment.start(input)
  await assert.rejects(f.enrollment.approve(request.requestId), code('INSTALLATION_EXISTS'))
  assert.equal(f.service.listDevices().length, 1)
  assert.equal(f.service.authenticateDevice(originalToken).id, f.service.listDevices()[0]!.id)
  assert.equal(f.service.snapshot().pairings.filter(value => value.consumedAt).length, 1)
  assert.equal(f.enrollment.poll(request).status, 'denied')
})

test('a failed Device save never exposes a credential or consumes its approved ticket', async t => {
  class FailSecondSave extends MemoryCompanionStateStore {
    calls = 0
    override async save(state: CompanionState): Promise<void> {
      if (++this.calls === 2) throw new Error('PRIVATE PERSISTENCE FAILURE')
      await super.save(state)
    }
  }
  const service = await CompanionService.create(new FailSecondSave())
  const enrollment = new CompanionEnrollmentService(service)
  t.after(() => enrollment.dispose())
  const request = enrollment.start(input)
  await assert.rejects(enrollment.approve(request.requestId), code('APPROVAL_FAILED'))
  assert.equal(service.listDevices().length, 0)
  assert.equal(service.snapshot().pairings.length, 1)
  assert.equal(service.snapshot().pairings[0]!.consumedAt, undefined)
  assert.equal(enrollment.poll(request).status, 'denied')
})

test('expiration or disposal while ticket save is pending cannot proceed to Device creation', async t => {
  for (const mode of ['expired', 'disposed']) {
    let now = Date.now()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const arrived = new Promise<void>(resolve => { entered = resolve })
    class DelayedStore extends MemoryCompanionStateStore {
      override async save(state: CompanionState): Promise<void> { entered(); await gate; await super.save(state) }
    }
    const service = await CompanionService.create(new DelayedStore(), { clock: { now: () => now } })
    const enrollment = new CompanionEnrollmentService(service, { now: () => now, ttlMs: 1000, maxRecords: 1 })
    t.after(() => enrollment.dispose())
    const request = enrollment.start(input)
    const approval = enrollment.approve(request.requestId)
    await arrived
    if (mode === 'expired') {
      now += 1001
      assert.throws(() => enrollment.start({ ...input, installationId: 'next' }), code('ENROLLMENT_CAPACITY'))
    } else enrollment.dispose()
    release()
    await assert.rejects(approval, code('ENROLLMENT_EXPIRED'))
    assert.equal(service.listDevices().length, 0)
    if (mode === 'expired') assert.ok(enrollment.start(input))
  }
})

test('expiry after committed approval withholds the late credential without automatically revoking the approved Device', async t => {
  let now = Date.now()
  class ExpireAfterCommit extends MemoryCompanionStateStore {
    calls = 0
    override async save(state: CompanionState): Promise<void> { await super.save(state); if (++this.calls === 2) now += 1001 }
  }
  const service = await CompanionService.create(new ExpireAfterCommit(), { clock: { now: () => now } })
  const enrollment = new CompanionEnrollmentService(service, { now: () => now, ttlMs: 1000 })
  t.after(() => enrollment.dispose())
  const request = enrollment.start(input)
  await assert.rejects(enrollment.approve(request.requestId), code('ENROLLMENT_EXPIRED'))
  assert.deepEqual(enrollment.poll(request), { status: 'expired' })
  assert.equal(service.listDevices().length, 1)
  assert.equal(service.listDevices()[0]!.revokedAt, undefined)
  assert.equal(enrollment.list().length, 0)
})


test('poll authorization cannot be substituted with userCode, requestId, or another request token', async t => {
  const f = await fixture(t)
  const first = f.enrollment.start(input)
  const second = f.enrollment.start({ ...input, installationId: 'other-installation' })
  for (const token of ['', first.userCode, first.requestId, 'A'.repeat(43), second.pollToken, 'A'.repeat(5000)]) {
    assert.throws(() => f.enrollment.poll({ requestId: first.requestId, pollToken: token }), code('UNAUTHORIZED'))
  }
  await f.enrollment.approve(first.requestId)
  assert.throws(() => f.enrollment.poll({ requestId: first.requestId, pollToken: second.pollToken }), code('UNAUTHORIZED'))
  assert.equal(f.enrollment.poll(first).status, 'ready')
})

test('concurrent approval is idempotent and concurrent polling delivers a token to exactly one caller', async t => {
  const f = await fixture(t)
  const request = f.enrollment.start(input)
  const approved = await Promise.all(Array.from({ length: 20 }, () => f.enrollment.approve(request.requestId)))
  assert.ok(approved.every(value => value.status === 'ready' && value.deviceId === approved[0]!.deviceId))
  assert.equal(f.service.listDevices().length, 1)
  assert.equal(f.service.snapshot().pairings.length, 1)
  const results = await Promise.all(Array.from({ length: 20 }, async () => f.enrollment.poll(request)))
  assert.equal(results.filter(result => result.status === 'ready').length, 1)
  assert.equal(results.filter(result => result.status === 'delivered').length, 19)
  assert.equal((await f.enrollment.approve(request.requestId)).status, 'delivered')
  assert.equal(f.service.snapshot().pairings.length, 1)
})

test('same installation concurrent requests cannot rotate the first approved Device token', async t => {
  const f = await fixture(t)
  const first = f.enrollment.start(input), second = f.enrollment.start(input)
  const results = await Promise.allSettled([f.enrollment.approve(first.requestId), f.enrollment.approve(second.requestId)])
  assert.equal(results[0]!.status, 'fulfilled')
  assert.equal(results[1]!.status, 'rejected')
  assert.equal(f.service.listDevices().length, 1)
  const result = f.enrollment.poll(first)
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') throw new Error('not ready')
  assert.equal(f.service.authenticateDevice(result.pairing.token).id, result.pairing.device.id)
  assert.equal(f.enrollment.poll(second).status, 'denied')
})

test('an existing Device and its leases are never revoked or rotated by a new enrollment', async t => {
  const f = await fixture(t)
  const ticket = await f.service.createPairingTicket()
  const original = await f.service.pairDevice({ ...input, code: ticket.code, capabilities: { protocolVersion: 1, localForward: true, tcpProbe: false } })
  const service = await f.service.registerTaskService({ taskId: 'task_fixture', name: 'Vite', port: 5173, protocol: 'http', source: 'manual' })
  const lease = await f.service.openLease({ taskId: 'task_fixture', serviceId: service.id, deviceId: original.device.id })
  const request = f.enrollment.start(input)
  await assert.rejects(f.enrollment.approve(request.requestId), code('INSTALLATION_EXISTS'))
  assert.equal(f.service.authenticateDevice(original.token).id, original.device.id)
  assert.equal(f.service.snapshot().leases.find(value => value.id === lease.id)!.desiredState, 'open')
  await f.service.revokeDevice(original.device.id)
  const duplicate = f.enrollment.start(input)
  await assert.rejects(f.enrollment.approve(duplicate.requestId), code('INSTALLATION_EXISTS'))
  const fresh = f.enrollment.start({ ...input, installationId: 'fresh-installation' })
  await f.enrollment.approve(fresh.requestId)
  const freshResult = f.enrollment.poll(fresh)
  assert.equal(freshResult.status, 'ready')
  if (freshResult.status !== 'ready') throw new Error('not ready')
  assert.notEqual(freshResult.pairing.device.id, original.device.id)
  assert.equal(f.service.snapshot().leases.filter(value => value.deviceId === freshResult.pairing.device.id).length, 0)
})

test('denial is idempotent and cannot race an approval into a second authorization', async t => {
  const f = await fixture(t)
  const denied = f.enrollment.start(input)
  await f.enrollment.deny(denied.requestId)
  assert.equal((await f.enrollment.deny(denied.requestId)).status, 'denied')
  await assert.rejects(f.enrollment.approve(denied.requestId), code('ENROLLMENT_DECIDED'))
  assert.deepEqual(f.enrollment.poll(denied), { status: 'denied' })
  const request = f.enrollment.start({ ...input, installationId: 'next-installation' })
  const approving = f.enrollment.approve(request.requestId)
  await assert.rejects(f.enrollment.deny(request.requestId), code('ENROLLMENT_DECIDED'))
  await approving
  assert.equal(f.service.listDevices().length, 1)
})

test('capacity is bounded and expired requests cannot grant or retain a slot', async t => {
  const f = await fixture(t, { ttlMs: 1000, maxRecords: 2 })
  const first = f.enrollment.start(input)
  f.enrollment.start({ ...input, installationId: 'other' })
  assert.throws(() => f.enrollment.start(input), code('ENROLLMENT_CAPACITY'))
  f.advance(1001)
  assert.deepEqual(f.enrollment.poll(first), { status: 'expired' })
  await assert.rejects(f.enrollment.approve(first.requestId), code('ENROLLMENT_EXPIRED'))
  assert.equal(f.enrollment.list().length, 0)
  assert.ok(f.enrollment.start(input))
  assert.equal(f.service.listDevices().length, 0)
})

test('wall-clock rollback does not extend enrollment authorization lifetime', async t => {
  const f = await fixture(t, { ttlMs: 1000 })
  const request = f.enrollment.start(input)
  f.advance(-3_600_000)
  f.monotonic(1001)
  assert.deepEqual(f.enrollment.poll(request), { status: 'expired' })
  await assert.rejects(f.enrollment.approve(request.requestId), code('ENROLLMENT_EXPIRED'))
})

test('ready credentials expire without a second delivery or new device creation', async t => {
  const f = await fixture(t, { ttlMs: 1000 })
  const request = f.enrollment.start(input)
  await f.enrollment.approve(request.requestId)
  f.advance(1001)
  assert.equal(f.enrollment.poll(request).status, 'expired')
  assert.equal(f.enrollment.list().length, 0)
  assert.equal(f.service.listDevices().length, 1)
})

test('failed persistence produces no credential and does not expose underlying failure data', async t => {
  class FailingStore extends MemoryCompanionStateStore {
    override async save(_state: CompanionState): Promise<void> { throw new Error('PRIVATE FAILURE DATA') }
  }
  const service = await CompanionService.create(new FailingStore())
  const enrollment = new CompanionEnrollmentService(service)
  t.after(() => enrollment.dispose())
  const request = enrollment.start(input)
  await assert.rejects(enrollment.approve(request.requestId), error => code('APPROVAL_FAILED')(error) && !String(error).includes('PRIVATE'))
  assert.equal(enrollment.poll(request).status, 'denied')
  assert.equal(enrollment.list()[0]!.status, 'failed')
  assert.equal(service.listDevices().length, 0)
  assert.equal(service.snapshot().pairings.length, 0)
  await assert.rejects(enrollment.approve(request.requestId), code('ENROLLMENT_DECIDED'))
})

test('Host teardown discards ephemeral enrollment but existing Device tokens survive service recreation', async t => {
  const f = await fixture(t)
  const request = f.enrollment.start(input)
  await f.enrollment.approve(request.requestId)
  const result = f.enrollment.poll(request)
  if (result.status !== 'ready') throw new Error('not ready')
  const pending = f.enrollment.start({ ...input, installationId: 'pending' })
  f.enrollment.dispose()
  assert.throws(() => f.enrollment.poll(pending), code('ENROLLMENT_EXPIRED'))
  const restartedService = await CompanionService.create(f.store)
  const restarted = new CompanionEnrollmentService(restartedService)
  t.after(() => restarted.dispose())
  assert.equal(restarted.poll(pending).status, 'expired')
  assert.equal(restartedService.authenticateDevice(result.pairing.token).id, result.pairing.device.id)
})

test('public metadata shape and size are validated before allocating enrollment slots', async t => {
  const f = await fixture(t, { maxRecords: 1 })
  for (const value of [null, { ...input, extra: 'not-allowed' }, { ...input, installationId: '' }, { ...input, name: 'A'.repeat(257) }, { ...input, name: 'bad\nname' }, { ...input, architecture: 'unknown' }, { ...input, companionVersion: 'not-a-version' }]) {
    assert.throws(() => f.enrollment.start(value as typeof input), code('VALIDATION_ERROR'))
  }
  assert.equal(f.enrollment.list().length, 0)
  assert.ok(f.enrollment.start(input))
})


test('public enrollment cannot grant a Device until explicit browser approval and token is delivered once', async t => {
  const service = await CompanionService.create(new MemoryCompanionStateStore())
  const enrollment = new CompanionEnrollmentService(service)
  t.after(() => enrollment.dispose())
  const request = enrollment.start(input)
  assert.match(request.pollToken, /^[A-Za-z0-9_-]{43}$/)
  assert.match(request.userCode, /^[A-F0-9]{5}-[A-F0-9]{5}$/)
  assert.deepEqual(enrollment.poll(request), { status: 'pending' })
  assert.equal(service.listDevices().length, 0)
  assert.equal(service.snapshot().pairings.length, 0)
  const approved = await enrollment.approve(request.requestId)
  assert.equal(approved.status, 'ready')
  assert.ok(!JSON.stringify(approved).includes(request.pollToken))
  assert.ok(!JSON.stringify(enrollment.list()).includes('dsht_'))
  const result = enrollment.poll(request)
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') throw new Error('not paired')
  assert.equal(result.pairing.authorityEpoch, service.snapshot().authorityEpoch)
  assert.equal(service.authenticateDevice(result.pairing.token).id, result.pairing.device.id)
  assert.deepEqual(enrollment.poll(request), { status: 'delivered' })
  assert.ok(!JSON.stringify(service.snapshot()).includes(result.pairing.token))
})
