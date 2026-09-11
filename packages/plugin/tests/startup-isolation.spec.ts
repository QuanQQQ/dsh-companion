import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { apply, type HostContext } from '../src/index.js'
import type { CompanionHttpRoute } from '../src/http-route.js'

test('invalid state isolates Companion without resetting data or stopping Host HTTP', async t => {
  const root=await mkdtemp(join(tmpdir(),'companion-startup-'))
  const previous=process.env.DSH_HOME
  process.env.DSH_HOME=root
  t.after(async()=>{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;await rm(root,{recursive:true,force:true})})
  await mkdir(join(root,'companion'))
  const file=join(root,'companion/state.json')
  let route: CompanionHttpRoute | undefined
  const server=createServer((req,res)=>{if(req.url==='/'){res.end('Host alive');return}void route!.handler(req,res)})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  const authority=`127.0.0.1:${address.port}`
  const ctx: HostContext={
    connection:{requestRejection:req=>req.headers.authorization==='Bearer test'?undefined:401},
    webServer:{port:address.port,register:value=>{route=value;return()=>{}},registerUpgrade:()=>assert.fail('No device socket on invalid state')},
    webRuntime:{trustedHosts:[authority]},systemPrompt:{section:()=>assert.fail('No operational guidance')},
    tools:{register:()=>assert.fail('No operational tools')},effect:callback=>callback(),
  }
  for(const raw of ['{broken','{"version":999}','{"version":2}']){
    await writeFile(file,raw)
    await assert.doesNotReject(apply(ctx))
    assert.equal(await readFile(file,'utf8'),raw)
    assert.equal(await(await fetch(`http://${authority}/`)).text(),'Host alive')
    assert.equal((await fetch(`http://${authority}/api/companion/devices`)).status,401)
    const response=await fetch(`http://${authority}/api/companion/devices`,{headers:{authorization:'Bearer test'}})
    assert.equal(response.status,503)
    assert.equal((await response.json() as {error:{code:string}}).error.code,'COMPANION_UNAVAILABLE')
  }
})
