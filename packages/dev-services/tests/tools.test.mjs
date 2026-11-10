import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceStore } from '../src/store.mjs'
import { createTools } from '../src/tools.mjs'
import { createFacade } from '../src/facade.mjs'

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dev-services-tools-'))
  const store = new ServiceStore(join(root, 'state.sqlite'))
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const active = new Set(), calls = []
  const state = { mode: 'read-only', root, cwd: root }
  const exec = { agent: { session: { id: 'a', header: { cwd: root } } }, signal: new AbortController().signal }
  const facade = createFacade({
    store, policyFor: async () => ({ mode: state.mode, workspaceRoot: state.root }), directoryFor: () => state.cwd,
    backend: {
      inspect: async r => ({ exists: active.has(r.id), state: active.has(r.id) ? 'active' : 'stopped' }),
      start: async r => { calls.push('start'); active.add(r.id) }, stop: async r => { calls.push('stop'); active.delete(r.id) },
      logs: async () => 'bounded logs',
    },
    options: { health: async (_r, runtime) => ({ state: runtime.state === 'active' ? 'ready' : 'unavailable' }), portFree: async () => {} },
    ...overrides,
  })
  const input = { name: 'App', executable: process.execPath, args: ['SECRET_ARG'], workdir: root, port: 5173, protocol: 'http' }
  return { root, store, active, calls, state, exec, facade, input }
}

test('rc.5 tools support unregistered original project; policy is freshly checked', async t => {
  const f = await fixture(t)
  const tools = createTools({ facade: f.facade })
  const call = (op, args, context = f.exec) => tools.find(tool => tool.name === `dev_service_${op}`).execute(args, context)
  const created = JSON.parse(await call('create', f.input))
  assert.equal(created.workspaceId, null)
  assert.equal(created.workspacePath, f.root)
  for (const denied of ['read-only', 'workspace-write', undefined]) {
    f.state.mode = denied
    await assert.rejects(call('start', { service_id: created.id }), /refusing to bypass/)
  }
  assert.equal(f.calls.length, 0)
  f.state.mode = 'danger-full-access'
  assert.equal(JSON.parse(await call('start', { service_id: created.id })).health.state, 'ready')
  f.state.mode = 'read-only'
  await assert.rejects(call('restart', { service_id: created.id }), /refusing to bypass/)
  assert.equal(f.active.size, 1)
  await assert.rejects(call('start', { service_id: created.id, sandbox_permissions: 'danger-full-access' }), /Unknown field/)
  await assert.rejects(f.facade.agent('claim', { service_id: created.id, workspace_path: f.root }, f.exec), /Agent cannot claim|Unknown field/)
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'))
  await assert.rejects(call('stop', { service_id: created.id }, { ...f.exec, signal: cancelled.signal }), /cancelled/)
  await call('stop', { service_id: created.id })
  assert.equal(f.active.size, 0)
  assert.equal(tools.length, 9)
  assert.ok(tools.every(tool => tool.presentCall().card === 'generic' && tool.output.schema.type === 'string'))
  assert.ok(!JSON.stringify(await f.facade.list()).includes('SECRET_ARG'))
})

test('cd, symlink and policy-root changes cannot enlarge immutable project authority', async t => {
  const f = await fixture(t)
  const child = join(f.root, 'child'); const sibling = `${f.root}-other`
  await mkdir(child); await mkdir(sibling)
  t.after(() => rm(sibling, { recursive: true, force: true }))
  await symlink(sibling, join(f.root, 'escape'))
  const created = await f.facade.agent('create', f.input, f.exec)
  f.state.cwd = child
  assert.equal((await f.facade.scope(f.exec)).workspacePath, f.root)
  await assert.rejects(f.facade.agent('create', { ...f.input, workdir: join(f.root, 'escape'), port: 5174 }, f.exec), /inside/)
  f.state.cwd = sibling
  await assert.rejects(f.facade.agent('status', { service_id: created.id }, f.exec), /inside/)
  f.state.cwd = f.root; f.state.root = sibling
  await assert.rejects(f.facade.agent('status', { service_id: created.id }, f.exec), /immutable original/)
  assert.equal(f.calls.length, 0)
})

test('registry exact root match labels; parent matching never grants or labels authority', async t => {
  const f = await fixture(t)
  const child = join(f.root, 'child'); await mkdir(child)
  const registry = { resolveByPath: async () => ({ id: 'parent', path: f.root }) }
  const facade = createFacade({ store: f.store, backend: {}, policyFor: () => ({ mode: 'read-only', workspaceRoot: child }), directoryFor: () => child, registryFor: () => registry })
  const exec = { ...f.exec, agent: { session: { header: { cwd: child } } } }
  assert.equal((await facade.scope(exec)).workspaceId, null)
  registry.resolveByPath = async () => ({ id: 'exact', path: child })
  assert.equal((await facade.scope(exec)).workspaceId, 'exact')
  await assert.rejects(facade.authorizeServiceRoot(exec, f.root), /another project/)
})

test('owner launch requires separate record-bound approval; no bool bypass', async t => {
  const f = await fixture(t)
  const created = await f.facade.agent('create', f.input, f.exec)
  const authority = { explicitCrossWorkspace: true, allowUnrestrictedExecution: true }
  await assert.rejects(f.facade.ownerBrowser('start', { service_id: created.id }, authority), /separate explicit operator/)
  await assert.rejects(f.facade.ownerBrowser('stop', { service_id: created.id }, {}), /explicit cross/)
  assert.equal(f.calls.length, 0)
  const reviews = []
  const allowed = await fixture(t, { approveLaunch: async review => { reviews.push(review); return true } })
  const service = await allowed.facade.agent('create', allowed.input, allowed.exec)
  await allowed.facade.ownerBrowser('start', { service_id: service.id }, { explicitCrossWorkspace: true })
  assert.equal(reviews[0].serviceId, service.id)
  assert.equal(reviews[0].workspacePath, allowed.root)
  assert.match(reviews[0].configurationDigest, /^[a-f0-9]{64}$/)
  assert.equal(reviews[0].executable, undefined)
  assert.equal(allowed.active.size, 1)
})
