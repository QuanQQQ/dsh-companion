import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonCompanionStateStore, MemoryCompanionStateStore } from '../src/store.js'
import { CompanionService } from '../src/service.js'

test('same empty Host Home retains its authority before the first pairing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-persistence-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  const file = join(root, 'companion', 'state.json')
  const first = await new JsonCompanionStateStore(file).load()
  const again = await new JsonCompanionStateStore(file).load()
  assert.equal(again.authorityEpoch, first.authorityEpoch)
})

test('v1 Task-scoped state migrates durably to one global declaration per port', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-persistence-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  const file = join(root, 'companion', 'state.json')
  await mkdir(join(root, 'companion'))
  const memory = new MemoryCompanionStateStore()
  const service = await CompanionService.create(memory)
  const ticket = await service.createPairingTicket()
  const paired = await service.pairDevice({code:ticket.code, installationId:'migration-installation',name:'Migration Mac',osVersion:'15',architecture:'arm64',companionVersion:'0.1.9',capabilities:{protocolVersion:1,localForward:true,tcpProbe:true}})
  const registered = await service.registerService({name:'Old Task A',port:5173,protocol:'http',source:'manual'})
  await service.openLease({serviceId:registered.id,deviceId:paired.device.id})
  const current = service.snapshot()
  const later = new Date(Date.parse(registered.updatedAt) + 1_000).toISOString()
  const legacy = {
    ...current,
    version: 1,
    services: [
      { ...registered, taskId: 'task-a' },
      { ...registered, id: 'svc-task-b', taskId: 'task-b', name: 'Latest global name', protocol: 'https', updatedAt: later },
    ],
    leases: current.leases.map(lease => ({ ...lease, taskId: 'task-a' })),
  }
  await writeFile(file, JSON.stringify(legacy))

  const migrated = await new JsonCompanionStateStore(file).load()
  assert.equal(migrated.version, 2)
  assert.equal(migrated.services.length, 1)
  assert.equal(migrated.services[0]?.id, 'svc-task-b')
  assert.equal(migrated.services[0]?.name, 'Latest global name')
  assert.equal(migrated.leases[0]?.serviceId, 'svc-task-b')
  assert.equal('taskId' in migrated.services[0]!, false)
  assert.equal('taskId' in migrated.leases[0]!, false)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2)
})

test('same Home restart preserves Device and token; different Home never adopts them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-persistence-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  const file = join(root, 'a', 'state.json')
  const service = await CompanionService.create(new JsonCompanionStateStore(file))
  const ticket = await service.createPairingTicket()
  const pair = await service.pairDevice({code:ticket.code, installationId:'test-installation',name:'Test Mac',osVersion:'15',architecture:'arm64',companionVersion:'0.1.4',capabilities:{protocolVersion:1,localForward:true,tcpProbe:true}})
  const restarted = await CompanionService.create(new JsonCompanionStateStore(file))
  assert.equal(restarted.snapshot().authorityEpoch,pair.authorityEpoch)
  assert.equal(restarted.authenticateDevice(pair.token).id,pair.device.id)
  const isolated = await CompanionService.create(new JsonCompanionStateStore(join(root,'b','state.json')))
  assert.notEqual(isolated.snapshot().authorityEpoch,pair.authorityEpoch)
  assert.throws(()=>isolated.authenticateDevice(pair.token))
  assert.ok(!(await readFile(file,'utf8')).includes(pair.token))
})
