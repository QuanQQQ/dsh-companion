import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'

async function fixture() {
  const store = new MemoryCompanionStateStore()
  const service = await CompanionService.create(store)
  const app = await service.registerTaskService({ taskId: 'a', name: 'App', port: 5173, protocol: 'http', source: 'agent' })
  const leases = []
  for (const installationId of ['one', 'two']) {
    const ticket = await service.createPairingTicket()
    const { device } = await service.pairDevice({ code: ticket.code, installationId, name: installationId,
      osVersion: '15', architecture: 'arm64', companionVersion: 'test',
      capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true } })
    leases.push(await service.openLease({ taskId: 'a', serviceId: app.id, deviceId: device.id }))
  }
  return { service, store, app, leases }
}

test('unregister atomically closes all Devices, retains diagnostics and survives reload', async () => {
  const { service, store, app, leases } = await fixture()
  await service.restartLease(leases[0]!.id)
  const before = service.snapshot()
  const removed = await service.unregisterTaskService('a', app.id)
  assert.ok(removed.archivedAt)
  assert.equal(service.listTask('a').services.length, 0)
  assert.equal(service.listTask('a').leases.length, 2)
  for (const lease of service.listTask('a').leases) {
    assert.equal(lease.desiredState, 'closed')
    assert.equal(lease.closeReason, 'service_archived')
    assert.equal(lease.generation, before.leases.find(item => item.id === lease.id)!.generation + 1)
    assert.equal(service.pendingOperations(lease.deviceId).length, 1)
    assert.equal(service.pendingOperations(lease.deviceId)[0]!.kind, 'close')
  }
  assert.equal(service.snapshot().tombstones.length, 2)
  const closed = service.snapshot()
  assert.deepEqual(await service.unregisterTaskService('a', app.id), removed)
  assert.deepEqual(service.snapshot(), closed)
  const restored = await CompanionService.create(store)
  assert.deepEqual(restored.listTask('a'), service.listTask('a'))
  await assert.rejects(restored.openLease({ taskId: 'a', serviceId: app.id, deviceId: leases[0]!.deviceId }), /Task Service/)
  const fresh = await restored.registerTaskService({ taskId: 'a', name: 'New app', port: 5173, protocol: 'http', source: 'manual' })
  assert.notEqual(fresh.id, app.id)
  assert.equal(restored.listTask('a').leases.filter(item => item.serviceId === fresh.id).length, 0)
})

test('close retains the declaration, is Task-scoped and idempotent', async () => {
  const { service, app, leases } = await fixture()
  const before = service.snapshot()
  await assert.rejects(service.closeLease(leases[0]!.id, 'user', 'other'), /Task/)
  await assert.rejects(service.unregisterTaskService('other', app.id), /Task/)
  assert.deepEqual(service.snapshot(), before)
  const closed = await service.closeLease(leases[0]!.id, 'user', 'a')
  assert.equal(service.listTask('a').services.length, 1)
  assert.equal(service.listTask('a').leases[1]!.desiredState, 'open')
  assert.deepEqual(await service.closeLease(closed.id, 'user', 'a'), closed)
  await service.unregisterTaskService('a', app.id)
  assert.deepEqual(service.listTask('a').leases[0], closed)
})

test('failed persistence leaves the service, leases and pending commands unchanged', async () => {
  const { service, store, app } = await fixture()
  const before = service.snapshot()
  store.save = async () => { throw new Error('disk full') }
  await assert.rejects(service.unregisterTaskService('a', app.id), /disk full/)
  assert.deepEqual(service.snapshot(), before)
})

test('concurrent open and unregister cannot leave an archived service authorized', async () => {
  const { service, app, leases } = await fixture()
  await Promise.allSettled([
    service.unregisterTaskService('a', app.id),
    service.openLease({ taskId: 'a', serviceId: app.id, deviceId: leases[0]!.deviceId }),
  ])
  assert.equal(service.listTask('a').services.length, 0)
  assert.ok(service.listTask('a').leases.every(lease => lease.desiredState === 'closed'))
})
