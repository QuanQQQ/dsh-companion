import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceStore } from '../src/store.mjs'
import { createFacade } from '../src/facade.mjs'

async function v1(t, change = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dev-services-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'services.sqlite')
  const record = {
    id: `svc_${randomUUID()}`, taskId: 'legacy-task', name: 'Old app', executable: process.execPath, args: ['SECRET_ARG'], workdir: root,
    port: 5173, protocol: 'http', ownership: 'a'.repeat(64), desired: 'running', companion: { state: 'synced', id: 'decl' }, createdAt: '2026-01-01', ...change,
  }
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE services (id TEXT PRIMARY KEY,port INTEGER UNIQUE NOT NULL,value TEXT NOT NULL); CREATE TABLE operation_lock (id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,incarnation TEXT NOT NULL,token TEXT NOT NULL); PRAGMA user_version=1;')
  db.prepare('INSERT INTO metadata VALUES (?,?)').run('namespace', 'preserved-namespace')
  db.prepare('INSERT INTO services VALUES (?,?,?)').run(record.id, record.port, JSON.stringify(record))
  db.close()
  return { root, path, record }
}

test('v1 migration backups and validates, retaining signed unit identity and legacy metadata only', async t => {
  const f = await v1(t)
  const store = new ServiceStore(f.path); t.after(() => store.close())
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2)
  assert.equal(store.namespace, 'preserved-namespace')
  const migrated = store.get(f.record.id)
  assert.equal(migrated.workspaceId, null)
  assert.equal(migrated.workspacePath, null)
  assert.equal(migrated.legacyTaskId, 'legacy-task')
  assert.equal(migrated.taskId, undefined)
  assert.equal(migrated.ownership, f.record.ownership)
  assert.equal(migrated.desired, 'running')
  assert.equal((await stat(store.backupPath)).mode & 0o777, 0o600)
  const backup = new DatabaseSync(store.backupPath, { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1)
    assert.equal(JSON.parse(backup.prepare('SELECT value FROM services').get().value).taskId, 'legacy-task')
  } finally { backup.close() }
})

test('invalid v1 data fails with backup and original unchanged', async t => {
  const f = await v1(t, { executable: 'invalid-relative-command' })
  assert.throws(() => new ServiceStore(f.path), /migration failed; original retained, backup:/)
  const db = new DatabaseSync(f.path, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
    assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM services').get().value), f.record)
  } finally { db.close() }
})

test('live v1 operation blocks migration with backup, no process signalled', async t => {
  const f = await v1(t)
  const db = new DatabaseSync(f.path)
  const proc = await import('node:fs/promises')
  const value = await proc.readFile(`/proc/${process.pid}/stat`, 'utf8')
  const owner = `${(await proc.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()}:${value.slice(value.lastIndexOf(')') + 2).split(' ')[19]}`
  db.prepare('INSERT INTO operation_lock VALUES (1,?,?,?)').run(process.pid, owner, 'active-token')
  db.close()
  assert.throws(() => new ServiceStore(f.path), /migration failed; original retained, backup:/)
  const unchanged = new DatabaseSync(f.path, { readOnly: true })
  try { assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 1) } finally { unchanged.close() }
})

test('unsupported schema is rejected without automatic downgrade', async t => {
  const f = await v1(t)
  const db = new DatabaseSync(f.path); db.exec('PRAGMA user_version=99'); db.close()
  assert.throws(() => new ServiceStore(f.path), /Unsupported/)
})

test('legacy record remains unclaimed until explicit owner claim; Task name grants no access', async t => {
  const f = await v1(t)
  const store = new ServiceStore(f.path); t.after(() => store.close())
  const calls = []
  const facade = createFacade({
    store, backend: { inspect: async () => ({ exists: false, state: 'stopped' }), stop: async () => calls.push('stop') },
    policyFor: () => ({ mode: 'danger-full-access', workspaceRoot: f.root }), directoryFor: () => f.root,
  })
  const exec = { agent: { session: { header: { cwd: f.root } } }, signal: new AbortController().signal }
  assert.equal((await facade.agent('list', {}, exec)).length, 0)
  for (const op of ['status', 'start', 'stop', 'restart', 'logs', 'remove', 'synchronize']) await assert.rejects(facade.agent(op, { service_id: f.record.id }, exec), /unclaimed|another Workspace/)
  await assert.rejects(facade.agent('claim', { service_id: f.record.id, workspace_path: f.root }, exec), /Agent cannot claim/)
  assert.deepEqual(calls, [])
  assert.equal((await facade.list())[0].legacyTaskId, 'legacy-task')
  const claimed = await facade.ownerBrowser('claim', { service_id: f.record.id, workspace_path: f.root }, { explicitCrossWorkspace: true })
  assert.equal(claimed.workspacePath, f.root)
  assert.equal(claimed.workspaceId, null)
  assert.equal(claimed.legacyTaskId, 'legacy-task')
  assert.ok(store.get(f.record.id).claimedAt)
  assert.equal((await facade.agent('list', {}, exec)).length, 1)
  await assert.rejects(facade.ownerBrowser('claim', { service_id: f.record.id, workspace_path: f.root }, { explicitCrossWorkspace: true }), /already claimed/)
})
