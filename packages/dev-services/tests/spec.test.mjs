import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeWorkspace, parseCreate, resolveWorkdir, unitName } from '../src/spec.mjs'

const input = () => ({ name: 'App', executable: '/usr/bin/node', args: ['app.mjs'], workdir: '/workspace', port: 5173, protocol: 'http' })

test('create retains literal argv without accepting shell, unit, env, or Task overrides', () => {
  const value = input()
  value.args = ['$(touch /tmp/no)', '; rm -rf /', 'two words']
  assert.deepEqual(parseCreate(value), value)
  for (const key of ['unit', 'taskId', 'env', 'shell', 'ignoreIdle']) assert.throws(() => parseCreate({ ...input(), [key]: true }), /Unknown field/)
  const parsed = parseCreate(value)
  parsed.args.push('new')
  assert.equal(value.args.length, 3)
})

test('create rejects malformed external fields', () => {
  for (const change of [{ executable: 'node' }, { args: 'hello' }, { args: ['\0'] }, { port: 80 }, { port: 65536 }, { port: 5.5 }, { protocol: 'ssh' }, { workdir: 'relative' }, { name: ' ' }, { args: ['a'.repeat(33000)] }]) {
    assert.throws(() => parseCreate({ ...input(), ...change }))
  }
})

test('unit identity is deterministic and isolated across service and DSH namespaces', () => {
  const id = 'svc_12345678-1234-1234-1234-123456789abc'
  assert.equal(unitName('home-a', id), unitName('home-a', id))
  assert.notEqual(unitName('home-a', id), unitName('home-b', id))
  assert.match(unitName('home-a', id), /^dsh-dev-services-[a-f0-9]{64}\.service$/)
  assert.throws(() => unitName('a', 'dsh-web.service'))
})

test('authorization is canonical project scoped and legacy metadata grants nothing', () => {
  assert.throws(() => authorizeWorkspace(undefined, undefined, 'create'))
  assert.throws(() => authorizeWorkspace({ workspacePath: '/a' }, { workspacePath: '/b' }, 'stop'))
  assert.throws(() => authorizeWorkspace({ workspacePath: '/a' }, { workspacePath: null, legacyTaskId: 'a' }, 'start'))
  for (const op of ['create', 'start', 'restart']) assert.throws(() => authorizeWorkspace({ workspacePath: '/a', status: 'archived' }, undefined, op))
  for (const op of ['stop', 'remove', 'status', 'logs']) authorizeWorkspace({ workspacePath: '/a', status: 'archived' }, { workspacePath: '/a' }, op)
})

test('resolved workdir rejects symlink and sibling escapes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dev-services-spec-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const task = join(root, 'task')
  const sibling = join(root, 'task-other')
  await mkdir(task)
  await mkdir(sibling)
  await symlink(sibling, join(task, 'escape'))
  assert.equal(await resolveWorkdir(task, task), task)
  await assert.rejects(resolveWorkdir(task, sibling), /inside/)
  await assert.rejects(resolveWorkdir(task, join(task, 'escape')), /inside/)
})
