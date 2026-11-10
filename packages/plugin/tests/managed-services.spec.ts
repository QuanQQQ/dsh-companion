import assert from 'node:assert/strict'
import test from 'node:test'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore, normalizeState } from '../src/store.js'
import { managedServicesCapability } from '../src/managed-services.js'
const input = {owner:{provider:'dsh-dev-services',namespace:'isolated',id:'svc_owned'},name:'App',port:45173,protocol:'http' as const,workspaceId:'ws-a',workspacePath:'/tmp/ws-a'}

test('single Host declaration capability is idempotent, fixed ownership and has no Lease or pairing authority', async()=>{
 const service=await CompanionService.create(new MemoryCompanionStateStore())
 const capability=managedServicesCapability(service)
 assert.deepEqual(Object.keys(capability).sort(),['ensure','retire','version'])
 const first=await capability.ensure(input)
 assert.equal((await capability.ensure({...input,name:'New label'})).id,first.id)
 await assert.rejects(capability.ensure({...input,port:45174}),/cannot change/)
 await assert.rejects(capability.ensure({...input,workspaceId:'ws-b'}),/cannot change/)
 await assert.rejects(service.registerService({name:'manual',port:input.port,protocol:'http',source:'manual'}),/managed service/)
 assert.equal(service.snapshot().leases.length,0);assert.equal(service.snapshot().devices.length,0)
 const retired=await capability.retire(input)
 assert.ok(retired.archivedAt)
 assert.equal((await capability.ensure(input)).archivedAt,retired.archivedAt)
 await assert.rejects(capability.ensure({...input,owner:{...input.owner,id:'other'}}),/reserved/)
 await assert.rejects(service.registerService({name:'manual',port:input.port,protocol:'http',source:'manual'}),/tombstone/)
})
test('retire before ensure creates a durable owner tombstone and never revives',async()=>{
 const store=new MemoryCompanionStateStore(),service=await CompanionService.create(store)
 const tombstone=await service.retireManagedService(input)
 const reloaded=await CompanionService.create(store)
 assert.equal((await reloaded.ensureManagedService(input)).id,tombstone.id)
 assert.equal(reloaded.list().services.length,0)
 const corrupt=reloaded.snapshot();corrupt.services.push({...corrupt.services[0]!,id:'different'})
 assert.throws(()=>normalizeState(corrupt),/invalid/)
})
test('manual declaration conflict is explicit and provider cannot approve a Device',async()=>{
 const service=await CompanionService.create(new MemoryCompanionStateStore())
 await service.registerService({name:'manual',port:input.port,protocol:'http',source:'manual'})
 await assert.rejects(service.ensureManagedService(input),/reserved/)
 await assert.rejects(service.ensureManagedService({...input,owner:{...input.owner,provider:'other'}}),/Unsupported/)
 assert.equal(service.snapshot().pairings.length,0)
})
