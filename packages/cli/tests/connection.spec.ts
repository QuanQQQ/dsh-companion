import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { EventEmitter } from 'node:events'
import { setImmediate as turn } from 'node:timers/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { runControlChannel, reconnectDelay, connectionDetails, type ConnectionClock, type ConnectionOptions } from '../src/connection.js'

async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); await turn() }
class Clock implements ConnectionClock {
  time = Date.parse('2026-09-10T00:00:00Z')
  sequence = 0
  tasks = new Map<number, { at: number; action: () => void; interval: number }>()
  now = () => this.time
  after = (action: () => void, ms: number) => this.add(action, ms, 0)
  every = (action: () => void, ms: number) => this.add(action, ms, ms)
  add(action: () => void, ms: number, interval: number) {
    const id = ++this.sequence; this.tasks.set(id, { at: this.time + ms, action, interval })
    return () => { this.tasks.delete(id) }
  }
  async advance(ms: number) {
    const end = this.time + ms
    for (;;) {
      const next = [...this.tasks].filter(([,t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at || a[0]-b[0])[0]
      if (!next) break
      const [id, task] = next
      this.time = Math.max(this.time, task.at)
      if (task.interval) task.at = this.time + task.interval
      else this.tasks.delete(id)
      task.action(); await flush()
    }
    this.time = end; await flush()
  }
  async sleep(ms: number) { this.time += ms; await this.advance(0) }
}
class Socket extends EventEmitter {
  readyState = 1
  sent: string[] = []
  send(data: string) { this.sent.push(data) }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', 1006) }
  hello(now: number, authorityEpoch = 'epoch') { this.frame({ v: 1, type: 'host.hello', authorityEpoch, sessionEpoch: 'session', heartbeatMs: 15000, serverTime: new Date(now).toISOString() }) }
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
}
async function fixture(t: TestContext, overrides: Partial<ConnectionOptions> = {}) {
  const clock = new Clock(), signals = new EventEmitter(), sockets: Socket[] = [], states: Record<string, unknown>[] = []
  let disconnected = 0, expirations = 0
  const controller: ConnectionOptions['controller'] = { initialize: async () => {}, connect: () => {}, disconnect: async () => { disconnected++ }, execute: async () => ({ ok: true }), expireNow: async () => { expirations++ }, tick: async () => {} }
  const opts: ConnectionOptions = {
    config: { deviceId: 'device', authorityEpoch: 'epoch', serverUrl: 'http://127.0.0.1:1' },
    previous: { attempts: 0, pairingRequired: false, automaticRetryBlocked: false }, controller, observations: () => [],
    readToken: async () => 'dummy-secret-never-log', clock, signals, random: () => 1,
    writeStatus: async value => { states.push(value) },
    socketFactory: (_url, options) => { assert.equal(options.followRedirects, false); const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket }, ...overrides,
  }
  // Permit a test override to observe persisted status without disabling fixture diagnostics.
  if (overrides.writeStatus) opts.writeStatus = async value => { states.push(value); await overrides.writeStatus!(value) }
  const done = runControlChannel(opts); void done.catch(() => {})
  t.after(async () => { signals.emit('SIGTERM'); await done.catch(() => {}); assert.equal(clock.tasks.size, 0) })
  await flush()
  return { clock, signals, sockets, states, controller, done, disconnected: () => disconnected, expirations: () => expirations,
    latest: () => states.at(-1)!, async retry() { const next = Date.parse(String(states.at(-1)!.nextReconnectAt)); assert.ok(Number.isFinite(next)); await clock.advance(Math.max(0, next-clock.now())) } }
}

test('network failures retry beyond five attempts, with bounded backoff and no duplicate sockets', async t => {
  const f = await fixture(t, { previous: { attempts: 6, pairingRequired: false, automaticRetryBlocked: false } })
  assert.equal(f.sockets.length, 1)
  for (let i = 0; i < 12; i++) {
    f.sockets.at(-1)!.emit('error', new Error('dummy-secret-never-log'))
    await flush()
    assert.equal(f.latest().state, 'reconnecting')
    assert.equal(f.latest().reconnectAttempts, i + 7)
    const delay = Date.parse(String(f.latest().nextReconnectAt))-f.clock.now()
    assert.ok(delay > 0 && delay <= 30000)
    await f.retry()
    assert.equal(f.sockets.length, i + 2)
  }
  f.sockets.at(-1)!.hello(f.clock.now()); await flush()
  assert.equal(f.latest().state, 'connected')
  assert.ok(!JSON.stringify(f.states).includes('dummy-secret-never-log'))
  assert.equal(f.latest().lastDisconnectReason, 'NETWORK_ERROR')
  assert.equal(f.disconnected(), 12)
})

test('heartbeat timeout after simulated overnight sleep recovers and still runs Lease expiry', async t => {
  const f = await fixture(t)
  f.sockets[0]!.hello(f.clock.now()); await flush()
  await f.clock.sleep(8 * 3600000)
  assert.equal(f.latest().lastDisconnectReason, 'HEARTBEAT_TIMEOUT')
  assert.equal(f.latest().state, 'reconnecting')
  assert.ok(f.expirations() > 0)
  await f.retry()
  f.sockets.at(-1)!.hello(f.clock.now()); await flush()
  assert.equal(f.latest().state, 'connected')
  assert.equal(f.sockets.length, 2)
})

test('an overdue disconnected retry runs once on wake without waiting for another backoff', async t => {
  const f = await fixture(t)
  f.sockets[0]!.emit('error', new Error('network')); await flush()
  await f.clock.sleep(8 * 3600000)
  assert.equal(f.sockets.length, 2)
  f.sockets[1]!.hello(f.clock.now()); await flush()
  await f.clock.advance(2000)
  assert.equal(f.sockets.length, 2)
})

test('only a full minute of healthy heartbeats resets network backoff', async t => {
  const f = await fixture(t, { previous: { attempts: 12, pairingRequired: false, automaticRetryBlocked: false } })
  const s = f.sockets[0]!
  s.hello(f.clock.now()); await flush()
  for (let i=0;i<4;i++) {
    await f.clock.advance(15000)
    s.frame({ v: 1, type: 'ping', authorityEpoch: 'epoch', sessionEpoch: 'session', nonce: 'ping-'+i }); await flush()
  }
  assert.equal(f.latest().reconnectAttempts, 0)
  assert.equal(s.sent.map(s=>JSON.parse(s)).filter(s=>s.type==='pong').length, 4)
})

test('HTTP rejection, revocation, wrong authority, TLS and protocol failures remain terminal', async t => {
  for (const kind of ['401','403','302','4003','4001','1008','authority','tls','protocol']) {
    await t.test(kind, async t => {
      const f = await fixture(t), s = f.sockets[0]!
      if (['401','403','302'].includes(kind)) s.emit('unexpected-response', {}, { statusCode: Number(kind), resume() {} })
      else if (['4003','4001','1008'].includes(kind)) s.emit('close', Number(kind))
      else if (kind === 'authority') s.hello(f.clock.now(), 'different-host')
      else if (kind === 'tls') s.emit('error', Object.assign(new Error('secret certificate detail'), {code:'CERT_HAS_EXPIRED'}))
      else s.frame({ not: 'a protocol frame' })
      await flush(); await f.clock.advance(120000)
      assert.equal(f.sockets.length, 1)
      assert.equal(f.latest().automaticRetryBlocked, true)
      assert.equal(f.latest().nextReconnectAt, undefined)
      assert.ok(!JSON.stringify(f.states).includes('secret certificate detail'))
    })
  }
})

test('server overload retries but stale events cannot poison a replacement connection', async t => {
  const f = await fixture(t), old = f.sockets[0]!
  old.emit('unexpected-response', {}, { statusCode: 503, resume() {} }); await flush()
  assert.equal(f.latest().lastHttpStatus, 503)
  await f.retry(); f.sockets[1]!.hello(f.clock.now()); await flush()
  old.emit('unexpected-response', {}, { statusCode: 401, resume() {} }); old.emit('close', 4003)
  await flush()
  assert.equal(f.latest().pairingRequired, false)
  assert.equal(f.latest().state, 'connected')
})

test('cleanup completion gates retry, and cleanup failure never permits reconnect', async t => {
  let resolve!: () => void
  const gate = new Promise<void>(r=>{resolve=r})
  const controller: ConnectionOptions['controller'] = { initialize: async()=>{}, connect:()=>{}, disconnect:()=>gate, execute:async()=>({ok:true}), expireNow:async()=>{}, tick:async()=>{} }
  const f = await fixture(t,{controller})
  f.sockets[0]!.emit('error',new Error('network')); await flush(); await f.clock.advance(60000)
  assert.equal(f.sockets.length,1)
  resolve(); await flush(); await f.retry(); assert.equal(f.sockets.length,2)
  controller.disconnect = async()=>{throw new Error('unsafe cleanup')}
  f.sockets[1]!.emit('error',new Error('network'));await flush();await f.clock.advance(60000)
  assert.equal(f.latest().state,'cleanup_failed');assert.equal(f.latest().automaticRetryBlocked,true);assert.equal(f.sockets.length,2)
})

test('credential/storage failures, persisted safety blocks and shutdown cannot resurrect a connection', async t => {
  await t.test('credential',async t=>{ const f=await fixture(t,{readToken:async()=>{throw new Error('secret')}});assert.equal(f.sockets.length,0);assert.equal(f.latest().lastDisconnectReason,'CREDENTIAL_UNAVAILABLE');await f.clock.advance(60000);assert.equal(f.sockets.length,0) })
  await t.test('status',async t=>{ const f=await fixture(t,{writeStatus:async()=>{throw new Error('disk full')}});await f.clock.advance(60000);assert.equal(f.sockets.length,0) })
  await t.test('block',async t=>{ const f=await fixture(t,{previous:{attempts:3,pairingRequired:false,automaticRetryBlocked:true}});await f.clock.advance(60000);assert.equal(f.sockets.length,0);f.signals.emit('SIGHUP');await flush();assert.equal(f.sockets.length,1) })
  await t.test('stop',async t=>{ const f=await fixture(t);f.sockets[0]!.emit('error',new Error('offline'));await flush();f.signals.emit('SIGTERM');await f.done;await f.clock.advance(60000);assert.equal(f.sockets.length,1);assert.equal(f.signals.listenerCount('SIGHUP'),0) })
})

test('backoff and diagnostics are bounded and do not serialize arbitrary error content',()=>{
  for(const n of [1,2,5,6,100,Number.MAX_SAFE_INTEGER])for(const jitter of [0,0.5,1])assert.ok(reconnectDelay(n,jitter)<=30000)
  assert.deepEqual(connectionDetails({lastDisconnectReason:'secret',lastCloseCode:99999,lastHttpStatus:'secret',lastDisconnectAt:'secret',token:'secret'}),{})
})

test('real WebSocket handshake recovers after seven HTTP 503 responses and shuts down cleanly',async t=>{
  const server=createServer(), wss=new WebSocketServer({noServer:true})
  let upgrades=0
  server.on('upgrade',(req,socket,head)=>{
    assert.equal(req.headers.authorization,'Bearer dummy-secret-never-log')
    if(++upgrades<=7){socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return}
    wss.handleUpgrade(req,socket,head,ws=>{ws.send(JSON.stringify({v:1,type:'host.hello',authorityEpoch:'epoch',sessionEpoch:'session',heartbeatMs:15000,serverTime:new Date().toISOString()}))})
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const f=await fixture(t,{config:{deviceId:'device',authorityEpoch:'epoch',serverUrl:'http://127.0.0.1:'+(server.address() as {port:number}).port},socketFactory:(url,opts)=>new WebSocket(url,opts)})
  t.after(async()=>{for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))})
  const until=async(predicate:()=>boolean)=>{for(let i=0;i<2000;i++){if(predicate())return;await turn()}throw new Error('network event timeout')}
  for(let i=0;i<7;i++){await until(()=>f.latest().state==='reconnecting');await f.retry()}
  await until(()=>f.latest().state==='connected');assert.equal(upgrades,8)
  f.signals.emit('SIGTERM');await f.done
})
