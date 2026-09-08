import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonLock } from '../src/daemon-lock.js'

it('concurrent stale-lock recovery grants only one daemon ownership', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'daemon.lock')
  await mkdir(path)
  await writeFile(join(path, 'pid'), '99999')
  const attempts = await Promise.allSettled([daemonLock(path, pid => pid === process.pid), daemonLock(path, pid => pid === process.pid)])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  for (const result of attempts) if (result.status === 'fulfilled') await result.value()
})
it('owner cannot release a lock replaced by another identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'daemon.lock')
  const release = await daemonLock(path)
  await writeFile(join(path, 'nonce'), 'other-owner')
  await assert.rejects(release(), /ownership changed/)
})
