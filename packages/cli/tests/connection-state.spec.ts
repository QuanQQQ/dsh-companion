import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConnectionState } from '../src/daemon.js'
import { parseLaunchArgs, main } from '../src/cli.js'

test('credential rejection remains needs-pairing after a later stopped status and daemon restart', async t => {
  const root = await mkdtemp(join(tmpdir(),'companion-state-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const path = join(root,'state.json')
  assert.deepEqual(await readConnectionState(path,'dev-a'),{attempts:0,pairingRequired:false,automaticRetryBlocked:false})
  await writeFile(path,JSON.stringify({deviceId:'dev-a',state:'stopped',reconnectAttempts:3,pairingRequired:true}))
  assert.deepEqual(await readConnectionState(path,'dev-a'),{attempts:3,pairingRequired:true,automaticRetryBlocked:false})
  await assert.rejects(readConnectionState(path,'dev-b'),/different Device/)
  await writeFile(path,JSON.stringify({deviceId:'dev-a',state:'needs_pairing',reconnectAttempts:3}))
  assert.equal((await readConnectionState(path,'dev-a')).pairingRequired,true)
})

test('unified command requires only a server origin, never pairing credentials in argv', async () => {
  assert.deepEqual(parseLaunchArgs(['--server','https://host.test']),{serverUrl:'https://host.test',allowInsecureHttp:false})
  assert.throws(()=>parseLaunchArgs(['--server','https://host.test','--pair-code-stdin']))
  assert.throws(()=>parseLaunchArgs(['--server','https://host.test','--token','secret']))
  let called=false
  const code = await main(['launch','--server','https://host.test'],{stdout:()=>{},stderr:()=>{},runLaunch:async(options,deps)=>{
    called=true; assert.equal(options.sshHost,undefined); assert.ok(deps.signal)
    return {action:'updated',config:{version:1,serverUrl:'https://host.test',sshHost:'devbox',installationId:'install',deviceId:'dev',authorityEpoch:'epoch',runtimePath:process.execPath,installedAt:new Date().toISOString(),allowInsecureHttp:false}}
  }})
  assert.equal(code,0); assert.equal(called,true)
})

test('legacy exhausted state resumes but safety blocks and sanitized diagnostics persist across restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'companion-retry-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'state.json')
  await writeFile(path, JSON.stringify({ deviceId: 'dev', state: 'needs_attention', reconnectAttempts: 6 }))
  assert.deepEqual(await readConnectionState(path, 'dev'), { attempts: 6, pairingRequired: false, automaticRetryBlocked: false })
  const persisted = { deviceId: 'dev', state: 'stopped', reconnectAttempts: 12, automaticRetryBlocked: true,
    lastDisconnectReason: 'TLS_ERROR', lastDisconnectAt: '2026-09-10T00:00:00.000Z', lastHttpStatus: 503, rawError: 'secret', token: 'secret' }
  await writeFile(path, JSON.stringify(persisted))
  assert.deepEqual(await readConnectionState(path, 'dev'), { attempts: 12, pairingRequired: false, automaticRetryBlocked: true,
    lastDisconnectReason: 'TLS_ERROR', lastDisconnectAt: persisted.lastDisconnectAt, lastHttpStatus: 503 })
  await writeFile(path, JSON.stringify({ ...persisted, automaticRetryBlocked: 'false' }))
  await assert.rejects(readConnectionState(path, 'dev'), /Invalid retry policy/)
})
