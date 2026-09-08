import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CompanionError, DEFAULT_LEASE_TTL_MS } from '../src/domain.js'
import { CompanionService, type CompanionClock, type CompanionIds } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'

class FakeClock implements CompanionClock {
  constructor(public value = Date.parse('2026-09-07T00:00:00.000Z')) {}
  now(): number { return this.value }
  advance(milliseconds: number): void { this.value += milliseconds }
}

class FakeIds implements CompanionIds {
  sequence = 0
  randomId(prefix: string): string { return `${prefix}_${++this.sequence}` }
  randomSecret(prefix: string): string { return `${prefix}_secret_${++this.sequence}` }
}

async function setup() {
  const clock = new FakeClock()
  const ids = new FakeIds()
  const service = await CompanionService.create(new MemoryCompanionStateStore(), { clock, ids })
  return { service, clock, ids }
}

async function pair(service: CompanionService, installationId: string, name: string) {
  const ticket = await service.createPairingTicket()
  return service.pairDevice({
    code: ticket.code,
    installationId,
    name,
    osVersion: '15.6',
    architecture: 'arm64',
    companionVersion: '0.1.0',
    capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true },
  })
}

async function registerVite(service: CompanionService, taskId = 'task-a') {
  return service.registerTaskService({
    taskId,
    name: 'Vite dev server',
    port: 5173,
    protocol: 'http',
    source: 'agent',
    evidence: 'Local http://localhost:5173/',
  })
}

function expectCompanionCode(error: unknown, code: CompanionError['code']): boolean {
  return error instanceof CompanionError && error.code === code
}

describe('pairing and Device identity', () => {
  it('consumes a pairing code once, hashes credentials, and authenticates the Device token', async () => {
    const { service } = await setup()
    const ticket = await service.createPairingTicket()
    const paired = await service.pairDevice({
      code: ticket.code,
      installationId: 'install-a',
      name: 'Jeff MacBook Pro',
      osVersion: '15.6',
      architecture: 'arm64',
      companionVersion: '0.1.0',
      capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true },
    })

    assert.equal(service.authenticateDevice(paired.token).id, paired.device.id)
    assert.equal('tokenHash' in paired.device, false)
    assert.notEqual(service.snapshot().devices[0]?.tokenHash, paired.token)
    await assert.rejects(
      service.pairDevice({
        code: ticket.code,
        installationId: 'install-b',
        name: 'Second Mac',
        osVersion: '15.6',
        architecture: 'arm64',
        companionVersion: '0.1.0',
        capabilities: { protocolVersion: 1, localForward: true, tcpProbe: false },
      }),
      error => expectCompanionCode(error, 'PAIRING_CODE_USED'),
    )
  })

  it('revokes trust and closes every open Lease without migrating it', async () => {
    const { service } = await setup()
    const device = (await pair(service, 'install-a', 'Mac A')).device
    const taskService = await registerVite(service)
    const lease = await service.openLease({ taskId: 'task-a', serviceId: taskService.id, deviceId: device.id })

    await service.revokeDevice(device.id)

    const closed = service.snapshot().leases.find(item => item.id === lease.id)
    assert.equal(closed?.desiredState, 'closed')
    assert.equal(closed?.closeReason, 'device_revoked')
    assert.equal(closed?.generation, 2)
    assert.equal(service.listDevices()[0]?.online, false)
  })
})

describe('Task Service and Forward Lease boundaries', () => {
  it('registers a Task Service without creating authorization or a runtime instance', async () => {
    const { service } = await setup()
    await registerVite(service)

    const snapshot = service.listTask('task-a')
    assert.equal(snapshot.services.length, 1)
    assert.equal(snapshot.leases.length, 0)
    assert.equal(snapshot.instances.length, 0)
  })

  it('creates independent same-port Leases for different Devices', async () => {
    const { service } = await setup()
    const first = (await pair(service, 'install-a', 'Mac A')).device
    const second = (await pair(service, 'install-b', 'Mac B')).device
    const taskService = await registerVite(service)

    const leaseA = await service.openLease({ taskId: 'task-a', serviceId: taskService.id, deviceId: first.id })
    const leaseB = await service.openLease({ taskId: 'task-a', serviceId: taskService.id, deviceId: second.id })

    assert.notEqual(leaseA.id, leaseB.id)
    assert.equal(leaseA.localPort, 5173)
    assert.equal(leaseA.remotePort, 5173)
    assert.equal(leaseB.localPort, 5173)
    assert.equal(leaseB.remotePort, 5173)
  })

  it('treats a Device local port as global and never remaps a conflict', async () => {
    const { service } = await setup()
    const device = (await pair(service, 'install-a', 'Mac A')).device
    const first = await registerVite(service, 'task-a')
    const second = await service.registerTaskService({
      taskId: 'task-b',
      name: 'Another Vite',
      port: 5173,
      protocol: 'http',
      source: 'manual',
    })
    await service.openLease({ taskId: 'task-a', serviceId: first.id, deviceId: device.id })

    await assert.rejects(
      service.openLease({ taskId: 'task-b', serviceId: second.id, deviceId: device.id }),
      error => expectCompanionCode(error, 'LOCAL_PORT_IN_USE'),
    )
    assert.equal(service.snapshot().leases.length, 1)
    assert.equal(service.snapshot().leases[0]?.localPort, 5173)
  })

  it('keeps an already-open Lease idempotent and does not extend its TTL', async () => {
    const { service, clock } = await setup()
    const device = (await pair(service, 'install-a', 'Mac A')).device
    const taskService = await registerVite(service)
    const first = await service.openLease({ taskId: 'task-a', serviceId: taskService.id, deviceId: device.id })
    clock.advance(20_000)
    const second = await service.openLease({ taskId: 'task-a', serviceId: taskService.id, deviceId: device.id })

    assert.equal(second.id, first.id)
    assert.equal(second.expiresAt, first.expiresAt)
    assert.equal(service.snapshot().operations.length, 1)
  })
})

describe('generation fencing and reconciliation', () => {
  it('restarts through close/open generations while preserving Lease identity and expiry', async () => {
    const { service } = await setup()
    const device = (await pair(service, 'install-a', 'Mac A')).device
    const taskService = await registerVite(service)
    const opened = await service.openLease({ taskId: 'task-a', serviceId: taskService.id, deviceId: device.id })

    const restarted = await service.restartLease(opened.id)
    const operations = service.pendingOperations(device.id)

    assert.equal(restarted.id, opened.id)
    assert.equal(restarted.expiresAt, opened.expiresAt)
    assert.equal(restarted.generation, 3)
    assert.deepEqual(operations.map(operation => [operation.kind, operation.generation]), [
      ['close', 2],
    ])
    await service.acknowledgeOperation(device.id, operations[0]!.id, { ok: true })
    assert.deepEqual(service.pendingOperations(device.id).map(operation => [operation.kind, operation.generation]), [['open', 3]])
    assert.equal(service.snapshot().operations.find(operation => operation.generation === 1)?.errorCode, 'SUPERSEDED')
  })

  it('ignores a stale observation after a newer generation exists', async () => {
    const { service } = await setup()
    const device = (await pair(service, 'install-a', 'Mac A')).device
    const taskService = await registerVite(service)
    const opened = await service.openLease({ taskId: 'task-a', serviceId: taskService.id, deviceId: device.id })
    const restarted = await service.restartLease(opened.id)

    const staleAccepted = await service.observeInstance(device.id, {
      leaseId: opened.id,
      deviceId: device.id,
      generation: 1,
      state: 'running',
      sshChild: 'running',
      listener: 'owned',
      remoteProbe: 'healthy',
    })
    const currentAccepted = await service.observeInstance(device.id, {
      leaseId: opened.id,
      deviceId: device.id,
      generation: restarted.generation,
      state: 'running',
      sshChild: 'running',
      listener: 'owned',
      remoteProbe: 'healthy',
    })

    assert.equal(staleAccepted, false)
    assert.equal(currentAccepted, true)
    assert.equal(service.snapshot().instances[0]?.generation, 3)
  })

  it('expires authorization while the Device is offline and retains a close tombstone', async () => {
    const { service, clock } = await setup()
    const device = (await pair(service, 'install-a', 'Mac A')).device
    const taskService = await registerVite(service)
    const opened = await service.openLease({
      taskId: 'task-a',
      serviceId: taskService.id,
      deviceId: device.id,
      ttlMs: DEFAULT_LEASE_TTL_MS,
    })
    clock.advance(DEFAULT_LEASE_TTL_MS + 1)

    assert.equal(await service.expireLeases(), 1)
    const expired = service.snapshot().leases.find(lease => lease.id === opened.id)
    assert.equal(expired?.desiredState, 'closed')
    assert.equal(expired?.closeReason, 'expired')
    assert.equal(expired?.expiresAt, opened.expiresAt)
    assert.equal(service.snapshot().tombstones.find(item => item.leaseId === opened.id)?.generation, 2)
    assert.deepEqual(service.pendingOperations(device.id).at(-1)?.kind, 'close')
  })

  it('fences an orphan Instance above its reported generation', async () => {
    const { service } = await setup()
    const device = (await pair(service, 'install-a', 'Mac A')).device

    assert.equal(await service.reconcileDeviceReport(device.id, [{
      leaseId: 'lost-lease',
      deviceId: device.id,
      generation: 7,
      state: 'running',
      sshChild: 'running',
      listener: 'owned',
      remoteProbe: 'unknown',
    }]), 1)

    const tombstone = service.snapshot().tombstones[0]
    const operation = service.pendingOperations(device.id)[0]
    assert.equal(tombstone?.leaseId, 'lost-lease')
    assert.equal(tombstone?.generation, 8)
    assert.equal(operation?.kind, 'close')
    assert.equal(operation?.generation, 8)
  })

  it('fails closed when a Device reports a generation ahead of Host state', async () => {
    const { service } = await setup()
    const device = (await pair(service, 'install-a', 'Mac A')).device
    const taskService = await registerVite(service)
    const lease = await service.openLease({ taskId: 'task-a', serviceId: taskService.id, deviceId: device.id })

    await service.reconcileDeviceReport(device.id, [{
      leaseId: lease.id,
      deviceId: device.id,
      generation: 9,
      state: 'running',
      sshChild: 'running',
      listener: 'owned',
      remoteProbe: 'healthy',
    }])

    const fenced = service.snapshot().leases[0]
    assert.equal(fenced?.desiredState, 'closed')
    assert.equal(fenced?.closeReason, 'reconciliation_conflict')
    assert.equal(fenced?.generation, 10)
  })

  it('maps non-retryable port conflicts to needs_attention without changing the port', async () => {
    const { service } = await setup()
    const device = (await pair(service, 'install-a', 'Mac A')).device
    const taskService = await registerVite(service)
    const lease = await service.openLease({ taskId: 'task-a', serviceId: taskService.id, deviceId: device.id })

    await service.observeInstance(device.id, {
      leaseId: lease.id,
      deviceId: device.id,
      generation: lease.generation,
      state: 'recovering',
      sshChild: 'exited',
      listener: 'conflict',
      remoteProbe: 'unknown',
      errorCode: 'LOCAL_PORT_IN_USE',
      errorMessage: '127.0.0.1:5173 is already in use',
    })

    const observed = service.snapshot().instances[0]
    assert.equal(observed?.state, 'needs_attention')
    assert.equal(service.snapshot().leases[0]?.localPort, 5173)
  })
})
