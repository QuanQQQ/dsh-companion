import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { browserAuth } from './auth-fixture.js'
import { connectionTrustFence, ownerBrowserRejection } from '../src/owner-browser.js'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'
import { createCompanionHttpRoute } from '../src/http-route.js'

test('rc.5 owner API Peers are not the browser authority, regardless of participation',()=>{
 const auth=browserAuth(),req={headers:{host:'127.0.0.1'}}
 assert.equal(ownerBrowserRejection(auth,req),undefined)
 for(const interactions of ['none','answer']){
  const other={...auth.browserPeer,id:('api-'+interactions) as typeof auth.browserPeer.id}
  assert.equal(ownerBrowserRejection({...auth,admit:()=>({peer:other})},req),403)
 }
 assert.equal(ownerBrowserRejection(undefined,req),503)
 assert.equal(ownerBrowserRejection({...auth,admit:()=>{throw Error('unavailable')}},req),503)
 const controller=new AbortController();controller.abort()
 assert.equal(ownerBrowserRejection({...auth,browserPeer:{...auth.browserPeer,signal:controller.signal}},req),401)
})
test('public rc.5 trust uses admission status only while browser authority is live',()=>{
 const auth=browserAuth()
 assert.equal(connectionTrustFence({...auth,admit:()=>({rejection:401})})({headers:{}}),true)
 assert.equal(connectionTrustFence({...auth,admit:()=>({rejection:403})})({headers:{}}),false)
 const dead=new AbortController();dead.abort()
 assert.throws(()=>connectionTrustFence({...auth,browserPeer:{...auth.browserPeer,signal:dead.signal}})({headers:{}}),/unavailable/)
})
test('owner browser revoked while a POST body streams cannot mutate or deliver tickets',async()=>{
 const service=await CompanionService.create(new MemoryCompanionStateStore())
 const controller=new AbortController(),auth=browserAuth()
 const peer={...auth.browserPeer,signal:controller.signal}
 const route=createCompanionHttpRoute(service,[],undefined,undefined,undefined,{browserPeer:peer,admit:()=>({peer})})
 const req=new PassThrough() as any;req.method='POST';req.url='/api/companion/pairings';req.headers={host:'127.0.0.1','content-type':'application/json'}
 let status=0,body='';const res={writableEnded:false,writeHead(value:number){status=value},end(value:string){body=value;this.writableEnded=true}} as any
 const running=route.handler(req,res)
 req.write('{');controller.abort();req.end('}')
 await running
 assert.equal(status,401);assert.equal(service.snapshot().pairings.length,0);assert.ok(!body.includes('dshp_'))
})
