import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** A reclaim mutex serializes stale-PID recovery; malformed locks fail closed. */
export async function daemonLock(path: string, alive = processAlive): Promise<() => Promise<void>> {
  const nonce = randomUUID()
  const reclaim = path + '.reclaim'
  await mkdir(reclaim, { mode: 0o700 }).catch(() => { throw new Error('Daemon lock acquisition in progress or interrupted; inspect reclaim lock') })
  try {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pid = Number(await readFile(join(path, 'pid'), 'utf8'))
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Incomplete daemon lock; inspect it manually')
      if (alive(pid)) throw new Error('Companion daemon is already running')
      await rm(path, { recursive: true })
      await mkdir(path, { mode: 0o700 })
    }
    await writeFile(join(path, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' })
    await writeFile(join(path, 'nonce'), nonce, { mode: 0o600, flag: 'wx' })
  } finally { await rm(reclaim, { recursive: true }) }
  return async () => {
    if (await readFile(join(path, 'nonce'), 'utf8') !== nonce) throw new Error('Daemon lock ownership changed')
    await rm(path, { recursive: true })
  }
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
