import { test } from 'node:test'
import assert from 'node:assert/strict'
import { companionAdapter } from '../src/companion.mjs'

const record = { id: 'svc_12345678-1234-1234-1234-123456789abc', workspaceId: 'workspace-a', workspacePath: '/project', name: 'App', port: 5173, protocol: 'http' }

test('adapter sends stable declaration ownership and exposes no Lease method', async () => {
  const calls = []
  const adapter = companionAdapter({ version: 1, ensure: async input => { calls.push(['ensure', input]); return { id: 'decl' } }, retire: async input => { calls.push(['retire', input]); return { id: 'decl', archivedAt: 'now' } } })
  assert.equal(adapter.openLease, undefined)
  assert.deepEqual(await adapter.ensure('namespace', record), { state: 'synced', id: 'decl' })
  assert.deepEqual(await adapter.retire('namespace', record), { state: 'retired', id: 'decl' })
  assert.deepEqual(calls[0][1].owner, { provider: 'dsh-dev-services', namespace: 'namespace', id: record.id })
  assert.equal(calls[0][1].deviceId, undefined)
})

test('archived ensure becomes detached and unsupported capability fails loud', async () => {
  assert.equal((await companionAdapter({ version: 1, ensure: async () => ({ id: 'decl', archivedAt: 'now' }) }).ensure('n', record)).state, 'detached')
  await assert.rejects(companionAdapter({ version: 2 }).ensure('n', record), /Unsupported/)
})
