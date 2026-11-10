import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseCreate, unitName } from './spec.mjs'

/** Protect operation fences from both PID reuse and reboot. */
function incarnation(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
    throw error
  }
}

export function validateRecord(record, version = 2) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid persisted service')
  const spec = parseCreate(Object.fromEntries(['name', 'executable', 'args', 'workdir', 'port', 'protocol'].map(key => [key, record[key]])))
  unitName('validation', record.id)
  if (typeof record.ownership !== 'string' || !/^[a-f0-9]{64}$/.test(record.ownership)) throw new Error('Invalid persisted ownership')
  if (version === 1) {
    if (typeof record.taskId !== 'string' || !record.taskId) throw new Error('Invalid legacy Task identity')
  } else {
    if (Object.hasOwn(record, 'taskId')) throw new Error('Legacy taskId must not grant Workspace authority')
    if (record.workspaceId === null && record.workspacePath === null) {
      if (typeof record.legacyTaskId !== 'string' || !record.legacyTaskId) throw new Error('Unclaimed service requires legacy identity')
    } else if (!isAbsolute(record.workspacePath ?? '') || !(record.workspaceId === null || typeof record.workspaceId === 'string' && record.workspaceId)) throw new Error('Invalid Workspace ownership')
    if (record.legacyTaskId !== undefined && (typeof record.legacyTaskId !== 'string' || !record.legacyTaskId)) throw new Error('Invalid legacy identity')
    if (record.claimedAt !== undefined && (typeof record.claimedAt !== 'string' || !Number.isFinite(Date.parse(record.claimedAt)) || record.claimedBy !== 'owner-browser')) throw new Error('Invalid claim audit')
    if (record.readiness !== undefined && (!['starting', 'not_ready', 'ready'].includes(record.readiness.state) || typeof record.readiness.reason !== 'string' || record.readiness.reason.length > 512)) throw new Error('Invalid readiness summary')
  }
  if (!['stopped', 'running', 'removed'].includes(record.desired)) throw new Error('Invalid persisted desired state')
  if (!['none', 'pending', 'synced', 'retired', 'unavailable', 'error', 'detached'].includes(record.companion?.state)) throw new Error('Invalid Companion sync state')
  return { ...record, ...spec }
}

const schema = `
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE services (id TEXT PRIMARY KEY, port INTEGER UNIQUE NOT NULL, value TEXT NOT NULL);
  CREATE TABLE operation_lock (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, incarnation TEXT NOT NULL, token TEXT NOT NULL);
  PRAGMA user_version=2;
`

/** Transactional SQLite v2 records. v1 backup is validated before migration writes. */
export class ServiceStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.path = realpathSync(path)
    chmodSync(path, 0o600)
    try {
      this.db.exec('PRAGMA busy_timeout=5000;')
      const version = this.db.prepare('PRAGMA user_version').get().user_version
      if (![0, 1, 2].includes(version)) throw new Error('Unsupported service database version')
      if (version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error('Unversioned nonempty service database; refusing initialization')
        this.db.exec(schema)
        this.db.prepare('INSERT INTO metadata VALUES (?,?)').run('namespace', `dev-services-${randomUUID()}`)
      } else if (version === 1) this.migrateV1()
      this.db.exec('PRAGMA journal_mode=DELETE;')
      if (this.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Service database integrity validation failed')
      this.namespace = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('namespace')?.value
      if (typeof this.namespace !== 'string' || !this.namespace) throw new Error('Missing service namespace')
      this.list()
      this.owner = incarnation(process.pid)
      if (!this.owner) throw new Error('Cannot identify operation owner')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  migrateV1() {
    // VACUUM INTO captures a consistent SQLite snapshot, including any WAL data.
    // A live older Host is rejected; no process is signalled to obtain the fence.
    this.backupPath = `${this.path}.v1-backup-${randomUUID()}.sqlite`
    this.db.exec(`VACUUM INTO '${this.backupPath.replaceAll("'", "''")}'`)
    chmodSync(this.backupPath, 0o600)
    const backup = new DatabaseSync(this.backupPath, { readOnly: true })
    try {
      if (backup.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || backup.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Invalid migration backup')
      const before = backup.prepare('SELECT id, port, value FROM services ORDER BY id').all()
      const namespace = backup.prepare("SELECT value FROM metadata WHERE key='namespace'").get()?.value
      if (typeof namespace !== 'string' || !namespace) throw new Error('Invalid migration namespace')
      // Validate all v1 rows and indexed identities before changing any record.
      const records = before.map(row => {
        const record = validateRecord(JSON.parse(row.value), 1)
        if (record.id !== row.id || record.port !== row.port) throw new Error('Migration identity mismatch')
        const { taskId, lastError, readiness, ...rest } = record
        return validateRecord({ ...rest, legacyTaskId: taskId, workspaceId: null, workspacePath: null })
      })
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const currentLock = this.db.prepare('SELECT * FROM operation_lock WHERE id=1').get()
        if (currentLock && incarnation(currentLock.pid) === currentLock.incarnation) throw new Error('Cannot migrate while a service operation is active')
        if (this.db.prepare('PRAGMA user_version').get().user_version !== 1 || JSON.stringify(this.db.prepare('SELECT id, port, value FROM services ORDER BY id').all()) !== JSON.stringify(before) || this.db.prepare("SELECT value FROM metadata WHERE key='namespace'").get()?.value !== namespace) throw new Error('Service database changed after backup; retry migration')
        for (const record of records) this.db.prepare('UPDATE services SET value=? WHERE id=? AND port=?').run(JSON.stringify(record), record.id, record.port)
        this.db.exec('PRAGMA user_version=2; COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } catch (error) {
      throw new Error(`SQLite v1 migration failed; original retained, backup: ${this.backupPath}`, { cause: error })
    } finally { backup.close() }
  }

  list() { return this.db.prepare('SELECT value FROM services ORDER BY rowid').all().map(row => validateRecord(JSON.parse(row.value))) }
  get(id) {
    const row = this.db.prepare('SELECT value FROM services WHERE id=?').get(id)
    if (!row) throw new Error('Unknown service')
    return validateRecord(JSON.parse(row.value))
  }
  insert(record) {
    validateRecord(record)
    this.db.prepare('INSERT INTO services VALUES (?,?,?)').run(record.id, record.port, JSON.stringify(record))
  }
  save(record) {
    validateRecord(record)
    const result = this.db.prepare('UPDATE services SET value=? WHERE id=? AND port=?').run(JSON.stringify(record), record.id, record.port)
    if (result.changes !== 1) throw new Error('Service identity changed')
  }
  async locked(action) {
    const token = randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const lock = this.db.prepare('SELECT * FROM operation_lock WHERE id=1').get()
      if (lock && incarnation(lock.pid) === lock.incarnation) throw new Error('A service operation is already in progress; retry after it settles')
      this.db.prepare('INSERT OR REPLACE INTO operation_lock VALUES (1,?,?,?)').run(process.pid, this.owner, token)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    try { return await action() }
    finally { this.db.prepare('DELETE FROM operation_lock WHERE id=1 AND token=?').run(token) }
  }
  close() { this.db.close() }
}
