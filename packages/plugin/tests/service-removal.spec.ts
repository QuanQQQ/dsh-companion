import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'

async function fixture() {
  const store = new MemoryCompanionStateStore()
  const service = await CompanionService.create(store)
  const app = await service.registerService({ name: 'App', port: 5173, protocol: 'http', source: 'agent' })
  const leases = []
  for (const installationId of ['one', 'two']) {
    const ticket = await service.createPairingTicket()
    const { device } = await service.pairDevice({ code: ticket.code, installationId, name: installationId,
      osVersion: '15', architecture: 'arm64', companionVersion: 'test',
      capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true } })
    leases.push(await service.openLease({ serviceId: app.id, deviceId: device.id }))
  }
  return { service, store, app, leases }
}

test('unregister atomically closes all Devices, retains diagnostics and survives reload', async () => {
  const { service, store, app, leases } = await fixture()
  await service.restartLease(leases[0]!.id)
  const before = service.snapshot()
  const removed = await service.unregisterService(app.id)
  assert.ok(removed.archivedAt)
  assert.equal(service.list().services.length, 0)
  assert.equal(service.list().leases.length, 2)
  for (const lease of service.list().leases) {
    assert.equal(lease.desiredState, 'closed')
    assert.equal(lease.closeReason, 'service_archived')
    assert.equal(lease.generation, before.leases.find(item => item.id === lease.id)!.generation + 1)
    assert.equal(service.pendingOperations(lease.deviceId).length, 1)
    assert.equal(service.pendingOperations(lease.deviceId)[0]!.kind, 'close')
  }
  assert.equal(service.snapshot().tombstones.length, 2)
  const closed = service.snapshot()
  assert.deepEqual(await service.unregisterService(app.id), removed)
  assert.deepEqual(service.snapshot(), closed)
  const restored = await CompanionService.create(store)
  assert.deepEqual(restored.list(), service.list())
  await assert.rejects(restored.openLease({ serviceId: app.id, deviceId: leases[0]!.deviceId }), /no longer registered/)
  const fresh = await restored.registerService({ name: 'New app', port: 5173, protocol: 'http', source: 'manual' })
  assert.notEqual(fresh.id, app.id)
  assert.equal(restored.list().leases.filter(item => item.serviceId === fresh.id).length, 0)
})

test('close retains the global declaration and is idempotent', async () => {
  const { service, app, leases } = await fixture()
  const closed = await service.closeLease(leases[0]!.id)
  assert.equal(service.list().services[0]!.id, app.id)
  assert.equal(service.list().leases[1]!.desiredState, 'open')
  assert.deepEqual(await service.closeLease(closed.id), closed)
  await service.unregisterService(app.id)
  assert.deepEqual(service.list().leases[0], closed)
})

test('failed persistence leaves the service, leases and pending commands unchanged', async () => {
  const { service, store, app } = await fixture()
  const before = service.snapshot()
  store.save = async () => { throw new Error('disk full') }
  await assert.rejects(service.unregisterService(app.id), /disk full/)
  assert.deepEqual(service.snapshot(), before)
})

test('concurrent open and unregister cannot leave an archived service authorized', async () => {
  const { service, app, leases } = await fixture()
  await Promise.allSettled([
    service.unregisterService(app.id),
    service.openLease({ serviceId: app.id, deviceId: leases[0]!.deviceId }),
  ])
  assert.equal(service.list().services.length, 0)
  assert.ok(service.list().leases.every(lease => lease.desiredState === 'closed'))
})
