import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonCompanionStateStore } from '../src/store.js'
import { CompanionService } from '../src/service.js'

test('same empty Host Home retains its authority before the first pairing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-persistence-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  const file = join(root, 'companion', 'state.json')
  const first = await new JsonCompanionStateStore(file).load()
  const again = await new JsonCompanionStateStore(file).load()
  assert.equal(again.authorityEpoch, first.authorityEpoch)
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
