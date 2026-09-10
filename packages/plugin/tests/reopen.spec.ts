import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Children, isValidElement, type ReactNode, type ReactElement } from 'react'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'
import { ServiceActions, currentLease } from '../src/client/task-services.js'

async function fixture() {
  let now = Date.parse('2026-09-10T00:00:00Z')
  const clock = { now: () => now }
  const store = new MemoryCompanionStateStore()
  const service = await CompanionService.create(store, { clock })
  const ticket = await service.createPairingTicket()
  const { device } = await service.pairDevice({ code: ticket.code, installationId: 'reopen-test', name: 'Test', osVersion: 'test', architecture: 'test', companionVersion: 'test', capabilities: { protocolVersion: 1, localForward: true, tcpProbe: false } })
  const app = await service.registerTaskService({ taskId: 'a', name: 'App', port: 5173, protocol: 'http', source: 'manual' })
  const input = { taskId: 'a', serviceId: app.id, deviceId: device.id }
  const old = await service.openLease({ ...input, ttlMs: 60_000 })
  return { service, store, clock, app, input, old, advance(ms: number) { now += ms } }
}

test('reopen atomically fences an expired Lease even before the expiry sweep and waits for its close ACK', async () => {
  const f = await fixture()
  f.advance(60_000)
  const next = await f.service.openLease(f.input)
  assert.notEqual(next.id, f.old.id)
  assert.equal(Date.parse(next.expiresAt) - Date.parse(next.createdAt), 604_800_000)
  assert.equal(f.service.snapshot().leases[0]!.closeReason, 'expired')
  assert.equal(f.service.snapshot().leases[0]!.expiresAt, f.old.expiresAt)
  const pending = f.service.pendingOperations(f.input.deviceId)
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.kind, 'close')
  const freshOp = f.service.snapshot().operations.find(op => op.leaseId === next.id && op.kind === 'open')!
  assert.equal(await f.service.claimOperation(f.input.deviceId, freshOp.id), undefined)
  const reloaded = await CompanionService.create(f.store, { clock: f.clock })
  assert.equal(reloaded.pendingOperations(f.input.deviceId).some(op => op.kind === 'open'), false)
  await reloaded.acknowledgeOperation(f.input.deviceId, pending[0]!.id, { ok: true })
  assert.equal(reloaded.pendingOperations(f.input.deviceId)[0]!.leaseId, next.id)
})

test('failed prior closure stays fenced and recheck on the new Lease retries that closure', async () => {
  const f = await fixture()
  await f.service.closeLease(f.old.id)
  const next = await f.service.openLease(f.input)
  const close = f.service.pendingOperations(f.input.deviceId)[0]!
  await f.service.acknowledgeOperation(f.input.deviceId, close.id, { ok: false, errorCode: 'SSH_STOP_TIMEOUT' })
  assert.equal(f.service.pendingOperations(f.input.deviceId).length, 0)
  await f.service.recheckLease(next.id)
  const retry = f.service.pendingOperations(f.input.deviceId)[0]!
  assert.equal(retry.leaseId, f.old.id)
  assert.notEqual(retry.id, close.id)
  assert.equal(retry.generation, close.generation)
  await f.service.acknowledgeOperation(f.input.deviceId, retry.id, { ok: true })
  assert.ok(f.service.pendingOperations(f.input.deviceId).some(op => op.leaseId === next.id && op.kind === 'open'))
})

test('same-millisecond reopen is idempotent and both Host and UI select the new Lease', async () => {
  const f = await fixture()
  await f.service.closeLease(f.old.id)
  const next = await f.service.openLease(f.input)
  const again = await f.service.openLease(f.input)
  assert.equal(next.createdAt, f.old.createdAt)
  assert.equal(again.id, next.id)
  assert.equal(f.service.snapshot().leases.filter(l => l.desiredState === 'open').length, 1)
  assert.equal(currentLease(f.service.listTask('a'), f.app.id, f.input.deviceId)?.id, next.id)
})

test('reopening rejects revoked Devices and retired services, without altering the old expiry', async () => {
  for (const action of ['revoke', 'unregister']) {
    const f = await fixture()
    if (action === 'revoke') await f.service.revokeDevice(f.input.deviceId)
    else await f.service.unregisterTaskService('a', f.app.id)
    await assert.rejects(f.service.openLease(f.input))
    assert.equal(f.service.snapshot().leases.length, 1)
    assert.equal(f.service.snapshot().leases[0]!.expiresAt, f.old.expiresAt)
  }
})

type Button = ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => void }>
function buttons(node: ReactNode): Button[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return []
    return child.type === 'button' ? [child as Button] : buttons(child.props.children)
  })
}

test('a closed unconfirmed offline Lease exposes an enabled reopen button which requests a new TTL', async t => {
  const f = await fixture()
  await f.service.closeLease(f.old.id)
  const snapshot = f.service.listTask('a')
  let request: unknown
  let pending = Promise.resolve()
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    request = JSON.parse(String(init?.body))
    return Response.json({ ok: true })
  })
  const props = { service: f.app, task: { id: 'a', title: 'Task', objective: '', status: 'active', workspacePath: '/a' }, device: { ...snapshot.devices[0]!, online: false }, lease: snapshot.leases[0]!, busy: false, ttlMinutes: 10080, act(action: () => Promise<void>) { pending = action(); return pending } }
  const rendered = buttons(ServiceActions(props))
  const reopen = rendered.find(b => b.props.children === '重新开启转发')!
  assert.ok(reopen)
  assert.equal(reopen.props.disabled, false)
  assert.ok(rendered.some(b => b.props.children === '重新检查关闭'))
  reopen.props.onClick!()
  await pending
  assert.deepEqual(request, { deviceId: f.input.deviceId, ttlMs: 604_800_000 })
  assert.equal(buttons(ServiceActions({ ...props, busy: true }))[0]!.props.disabled, true)
  assert.equal(buttons(ServiceActions({ ...props, task: { ...props.task, status: 'archived' } }))[0]!.props.disabled, true)
})
