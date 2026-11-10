import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyState } from '../src/domain.js'
import { JsonCompanionStateStore, normalizeState } from '../src/store.js'

test('optional Device sample age round trips without altering Host receipt or refreshing a cached probe', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-probe-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = emptyState()
  const observedAt = '2026-11-04T00:02:00.000Z'
  const createdAt = '2026-11-04T00:00:00.000Z'
  state.devices.push({ id: 'device', installationIdHash: 'a'.repeat(64), tokenHash: 'b'.repeat(64), name: 'Fixture',
    platform: 'macos', osVersion: 'fixture', architecture: 'fixture', companionVersion: 'fixture',
    capabilities: { protocolVersion: 1, localForward: true, tcpProbe: true }, createdAt, updatedAt: createdAt })
  state.services.push({ id: 'service', name: 'Fixture', port: 5173, protocol: 'tcp', source: 'manual', createdAt, updatedAt: createdAt })
  state.leases.push({ id: 'lease', serviceId: 'service', deviceId: 'device', localHost: '127.0.0.1', remoteHost: '127.0.0.1',
    localPort: 5173, remotePort: 5173, desiredState: 'open', generation: 1, createdAt, updatedAt: createdAt, expiresAt: observedAt })
  state.instances.push({ leaseId: 'lease', deviceId: 'device', generation: 1, state: 'running',
    sshChild: 'running', listener: 'owned', remoteProbe: 'healthy', observedAt,
    sampledAt: '2026-11-04T00:00:00.000Z', probeAgeMs: 120_000 })
  const store = new JsonCompanionStateStore(join(root, 'state.json'))
  await store.save(state)
  const again = await store.load()
  assert.deepEqual(again.instances, state.instances)
  assert.equal(again.instances[0]?.observedAt, observedAt)
  assert.equal(again.instances[0]?.probeAgeMs, 120_000)
  for (const extra of [{ sampledAt: 'not-time' }, { probeAgeMs: -1 }, { probeAgeMs: 0.5 }, { probeAgeMs: '0' }]) {
    const invalid = structuredClone(state)
    Object.assign(invalid.instances[0]!, extra)
    assert.throws(() => normalizeState(invalid), /invalid/)
  }
  const legacy = structuredClone(state)
  delete legacy.instances[0]!.sampledAt
  delete legacy.instances[0]!.probeAgeMs
  assert.deepEqual(normalizeState(legacy), legacy, 'v1 legacy observations remain valid without a sample')
})
