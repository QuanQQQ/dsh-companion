import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { CompanionService } from '../src/service.js'
import { MemoryCompanionStateStore } from '../src/store.js'
import { createCompanionHttpRoute } from '../src/http-route.js'

test('public launch code cannot approve devices or expose private device lists', async t => {
  const service = await CompanionService.create(new MemoryCompanionStateStore())
  const root = await mkdtemp(join(tmpdir(), 'companion-bootstrap-api-'))
  const bundle = 'export const VERSION = "0.1.4";\n'
  const path = join(root,'cli.mjs'); await writeFile(path,bundle)
  const route = createCompanionHttpRoute(service, [], undefined, undefined, pathToFileURL(path), {
    requestRejection: req => req.headers.cookie === 'admin=yes' ? undefined : 401,
  })
  const server = createServer((req,res)=>void route.handler(req,res)); server.listen(0,'127.0.0.1'); await once(server,'listening')
  t.after(async()=>{server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(root,{recursive:true,force:true})})
  const base = 'http://127.0.0.1:'+(server.address() as {port:number}).port+'/api/companion'
  const post = (path:string,body:unknown,admin=false,token?:string)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(admin?{cookie:'admin=yes'}:{}),...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)})
  assert.equal((await fetch(base+'/devices')).status,401)
  assert.equal((await fetch(base+'/downloads/cli.mjs')).status,401)
  assert.equal((await fetch(base+'/enrollments')).status,401)
  assert.equal(await (await fetch(base+'/bootstrap/cli.mjs')).text(),bundle)
  assert.ok((await (await fetch(base+'/bootstrap.sh')).text()).includes(createHash('sha256').update(bundle).digest('hex')))
  const identity = await (await fetch(base+'/identity')).json() as {authorityEpoch:string}
  assert.equal(identity.authorityEpoch,service.authorityEpoch)
  const start = await post('/enrollments/start',{installationId:'fresh-install',name:'Mac',osVersion:'15',architecture:'arm64',companionVersion:'0.1.4'})
  assert.equal(start.status,201)
  const {request} = await start.json() as {request:{requestId:string;pollToken:string;userCode:string}}
  const pathAction = '/enrollments/'+request.requestId+'/approve'
  assert.equal((await post(pathAction,{})).status,401)
  assert.equal(service.listDevices().length,0)
  const list = await (await fetch(base+'/enrollments',{headers:{cookie:'admin=yes'}})).text()
  assert.ok(!list.includes(request.pollToken))
  const approved = await post(pathAction,{},true)
  assert.equal(approved.status,200)
  const approvalText = await approved.text(); assert.ok(!approvalText.includes('dsht_'))
  const result = await (await post('/enrollments/poll',request)).json() as {status:string;pairing:{token:string;device:{id:string};authorityEpoch:string}}
  assert.equal(result.status,'ready')
  assert.equal(service.authenticateDevice(result.pairing.token).id,result.pairing.device.id)
  const verified = await post('/device/verify',{},false,result.pairing.token)
  assert.equal(verified.status,200)
  assert.equal((await verified.json() as {authorityEpoch:string}).authorityEpoch,identity.authorityEpoch)
  assert.equal((await post('/device/verify',{})).status,401)
  await service.revokeDevice(result.pairing.device.id)
  assert.equal((await post('/device/verify',{},false,result.pairing.token)).status,403)
  assert.equal(service.snapshot().leases.length,0)
})
