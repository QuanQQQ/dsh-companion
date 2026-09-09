import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'
import { type ChildProcess } from 'node:child_process'
import { SshExecutor, type SshCommandResult, type SshExecutorOptions, type SshRunner, type SshSpawn } from '../src/ssh.js'

// These are Linux-portable contract tests, not evidence of macOS/OpenSSH integration.
const ok = (stdout = '', stderr = ''): SshCommandResult => ({code:0,stdout,stderr})
const denied = (): SshCommandResult => ({code:1,stdout:'',stderr:''})
// Command runner contract tests exercise this bounded seam independently of master startup.
const command = (executor: SshExecutor) => (executor as unknown as {command(file:string,args:string[],timeout:number):Promise<SshCommandResult>}).command('/usr/bin/ssh',['-F','/dev/null','-S','/tmp/test-only','-O','check','work-box'],100)

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  exited = false
  exitOn: string | undefined = 'SIGTERM'
  closeDelayMs = 0
  constructor(readonly pid: number) { super() }
  kill(signal: string) {
    this.signals.push(signal)
    if (signal === this.exitOn || (signal === 'SIGKILL' && this.exitOn !== undefined)) {
      queueMicrotask(() => this.finish(0))
    }
    return true
  }
  finish(code = 255) {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code, null)
    const close = () => { this.stdout.end(); this.stderr.end(); this.emit('close', code, null) }
    if (this.closeDelayMs) setTimeout(close, this.closeDelayMs)
    else close()
  }
  asChild() { return this as unknown as ChildProcess }
}
interface Call { file: string; args: readonly string[]; shell: boolean }
async function fixture(t: TestContext, options: SshExecutorOptions = {}) {
  const root = await mkdtemp('/tmp/dsh-s-')
  const calls: Call[] = [], spawns: Call[] = []
  const children: FakeChild[] = []
  const sockets = new Map<string, { child: FakeChild; server: Server; port: number }>()
  const state = {
    masterOffset: 0,
    listener: undefined as ((pid: number, port: number) => SshCommandResult) | undefined,
    closeMaster: true,
    makeSocket: true,
    configureChild: (_child: FakeChild) => {},
  }
  const spawn: SshSpawn = (file, args, settings) => {
    assert.equal(settings.detached,true)
    spawns.push({ file, args, shell: settings.shell })
    const child = new FakeChild(41000 + children.length)
    children.push(child)
    state.configureChild(child)
    const path = args[args.indexOf('-S') + 1]!
    const port = 0
    if (state.makeSocket) {
      const server = createServer()
      sockets.set(path, { child, server, port })
      server.on('error', () => child.finish())
      server.listen(path)
      child.once('close', () => { if (server.listening) server.close() })
    }
    return child.asChild()
  }
  const runner: SshRunner = { async run(file, args, settings) {
    calls.push({ file, args, shell: settings.shell })
    if (args.includes('-O')) {
      const value = sockets.get(args[args.indexOf('-S') + 1]!)
      if (!value || value.child.exited) return denied()
      if (args.includes('forward')) {
        value.port = Number(args[args.indexOf('-L') + 1]!.split(':')[1])
        return ok()
      }
      if (args.includes('exit')) {
        if (state.closeMaster) value.child.finish(0)
        return ok()
      }
      return ok('', 'Master running (pid=' + (value.child.pid + state.masterOffset) + ')\n')
    }
    if (file.endsWith('/lsof')) {
      const pid = Number(args[args.indexOf('-p') + 1])
      const value = [...sockets.values()].find(value => value.child.pid === pid)
      if (!value || value.child.exited) return denied()
      if (!value.port) return {code:1,stdout:'',stderr:''}
      return state.listener?.(pid, value.port) ?? ok('p' + pid + '\nn127.0.0.1:' + value.port + '\n')
    }
    if (file === '/bin/ps') {
      const child = children.find(child => String(child.pid) === args[1])
      return child?.exited ? denied() : ok(args[1] + '\n')
    }
    throw new Error('Unexpected command: ' + file)
  } }
  const settings = { runner, spawn, signalGroup: (child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL') => { child.kill(signal) }, startupTimeoutMs: 150, commandTimeoutMs: 80, terminateTimeoutMs: 20, pollIntervalMs: 2, ...options }
  const executor = new SshExecutor('work-box', root, settings)
  t.after(async () => {
    for (const child of children) child.finish(0)
    await executor.stopAll().catch(() => undefined)
    for (const { server } of sockets.values()) if (server.listening) await new Promise<void>(done => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
  })
  return { root, calls, spawns, children, sockets, state, runner, spawn, settings, executor }
}

test('failed mux forward never reports running and closes its authenticated master', async t => {
  const f=await fixture(t)
  const run=f.runner.run.bind(f.runner)
  let forwards=0
  f.runner.run=async(file,args,options)=>{
    if(args.includes('forward')) {forwards++;return denied()}
    return run(file,args,options)
  }
  await assert.rejects(f.executor.start('lease',3080),/SSH_FORWARD_FAILED/)
  assert.equal(forwards,1)
  assert.equal(f.children[0]!.exited,true)
  assert.equal(await f.executor.isOwned('lease'),false)
  assert.deepEqual(await readdir(f.root),[])
})

test('cancellation after master verification never adds a forward', async t => {
  const f=await fixture(t)
  const run=f.runner.run.bind(f.runner)
  let entered!:()=>void,release!:()=>void,first=true
  const verifying=new Promise<void>(r=>{entered=r}),gate=new Promise<void>(r=>{release=r})
  f.runner.run=async(file,args,options)=>{
    const result=await run(file,args,options)
    if(first && args.includes('check')) {first=false;entered();await gate}
    return result
  }
  const outcome=assert.rejects(f.executor.start('lease',3080),/SSH_START_CANCELLED/)
  await verifying
  const stopped=f.executor.stop('lease')
  release()
  await Promise.all([stopped,outcome])
  assert.equal(f.calls.filter(c=>c.args.includes('forward')).length,0)
  assert.equal(f.children[0]!.exited,true)
})

test('native alias connection and hermetic same-port forwarding have separate argv', async t => {
  const f = await fixture(t)
  const started = await f.executor.start('lease-1',3080)
  assert.equal(started.pid,41000)
  assert.equal(await f.executor.isOwned('lease-1'),true)
  const call=f.spawns[0]!
  assert.equal(call.file,'/usr/bin/ssh')
  assert.equal(call.shell,false)
  assert.equal(call.args.at(-1),'work-box')
  for(const flag of ['-G','-F','-L']) assert.ok(!call.args.includes(flag))
  for(const flag of ['ClearAllForwardings=yes','StrictHostKeyChecking=yes','ControlPersist=no','BatchMode=yes','PermitLocalCommand=no','RemoteCommand=none','GatewayPorts=no']) assert.ok(call.args.includes(flag),flag)
  for(const flag of ['ProxyCommand=none','ProxyJump=none','GSSAPIDelegateCredentials=no']) assert.ok(!call.args.includes(flag),flag)
  const forwarding=f.calls.filter(c=>c.args.includes('forward'))
  assert.equal(forwarding.length,1)
  assert.ok(forwarding[0]!.args.includes('/dev/null'))
  assert.ok(forwarding[0]!.args.includes('127.0.0.1:3080:127.0.0.1:3080'))
  assert.ok(!forwarding[0]!.args.includes('ClearAllForwardings=yes'))
  await assert.rejects(readFile(join(dirname(started.controlPath),'config')),{code:'ENOENT'})
  assert.equal((await lstat(dirname(started.controlPath))).mode & 0o777,0o700)
  assert.equal((await lstat(join(dirname(started.controlPath),'owner.json'))).mode & 0o777,0o600)
})

test('input cannot inject options, shell text, alternate bind addresses, or traversal paths', async t => {
  const f = await fixture(t)
  for (const alias of ['-Fbad', 'name -oProxyCommand=evil', 'a;touch /tmp/x', 'a\nb', 'a@b', 'ssh://a', 'a%h']) {
    assert.throws(() => new SshExecutor(alias, f.root), /SSH_INVALID_ALIAS/)
  }
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, '3080;bad' as unknown as number]) {
    await assert.rejects(f.executor.start('lease', port), /SSH_INVALID_PORT/)
  }
  await assert.rejects(f.executor.start('x\nHost *', 80), /SSH_INVALID_LEASE/)
  assert.equal(f.calls.length, 0)
  const started = await f.executor.start('../../outside', 3080)
  assert.equal(dirname(dirname(started.controlPath)), await realpath(f.root))
  assert.doesNotMatch(started.controlPath, /outside|\.\./)
})

test('rejects a non-private root and symlink root before running commands', async t => {
  const f = await fixture(t)
  await chmod(f.root, 0o755)
  await assert.rejects(f.executor.start('lease', 3080), /SSH_OWNERSHIP_UNVERIFIED/)
  await chmod(f.root, 0o700)
  const link = join(f.root, 'link')
  await symlink(f.root, link)
  await assert.rejects(new SshExecutor('work-box', link, f.settings).start('lease', 3080), /SSH_OWNERSHIP_UNVERIFIED/)
  assert.equal(f.calls.length, 0)
})

test('a missing control socket never becomes owned even with a reachable foreign TCP server', async t => {
  const f = await fixture(t, { startupTimeoutMs: 40 })
  const server = createServer(socket => socket.end())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>(done => server.close(() => done())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const client = createConnection(address.port, '127.0.0.1')
  await once(client, 'connect')
  client.destroy()
  f.state.makeSocket = false
  await assert.rejects(f.executor.start('lease', address.port), /SSH_START_TIMEOUT/)
  assert.equal(await f.executor.isOwned('lease'), false)
  assert.equal(server.listening, true)
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM'])
})

test('ownership requires matching master PID and exactly one matching lsof loopback listener', async t => {
  const f = await fixture(t)
  await f.executor.start('lease', 3080)
  f.state.masterOffset = 1
  assert.equal(await f.executor.isOwned('lease'), false)
  f.state.masterOffset = 0
  for (const output of [
    'p99999\nn127.0.0.1:3080\n', 'p41000\nn*:3080\n', 'p41000\nn[::1]:3080\n',
    'p41000\nn127.0.0.1:9999\n', 'p41000\nn127.0.0.1:3080\nn127.0.0.1:9999\n',
    'p41000\nn127.0.0.1:3080\np99999\nn127.0.0.1:3080\n', '',
  ]) {
    f.state.listener = () => ok(output)
    assert.equal(await f.executor.isOwned('lease'), false, output)
  }
  f.state.listener = () => denied()
  assert.equal(await f.executor.isOwned('lease'), false)
  f.state.listener = undefined
  assert.equal(await f.executor.isOwned('lease'), true)
  await f.executor.stop('unknown-lease')
  assert.deepEqual(f.children[0]!.signals, [])
})

test('startup ownership mismatch times out and kills only its created child', async t => {
  const f = await fixture(t, { startupTimeoutMs: 40 })
  f.state.masterOffset = 100
  await assert.rejects(f.executor.start('lease', 3080), /SSH_START_TIMEOUT/)
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM'])
  assert.deepEqual(await readdir(f.root), [])
})

test('concurrent duplicate starts and instance capacity are rejected before extra spawn', async t => {
  const f = await fixture(t, { maxInstances: 1 })
  const opening = f.executor.start('lease', 3080)
  await assert.rejects(f.executor.start('lease', 3080), /SSH_LEASE_EXISTS/)
  await assert.rejects(f.executor.start('another', 3081), /SSH_CAPACITY/)
  await opening
  await f.executor.stop('lease')
  await f.executor.start('another', 3081)
  assert.equal(f.spawns.length, 2)
})

test('stop cancels an in-flight start and stopAll blocks racing starts', async t => {
  const f = await fixture(t)
  const opening = f.executor.start('lease', 3080)
  const rejected = assert.rejects(opening, /SSH_START_CANCELLED/)
  const stopping = f.executor.stopAll()
  await assert.rejects(f.executor.start('race', 3081), /SSH_STOPPING/)
  await stopping
  await rejected
  assert.equal(f.spawns.length, 0)
  await f.executor.start('after', 3080)
})

test('TERM escalates to KILL and stop waits for close without reporting onExit', async t => {
  const f = await fixture(t, { terminateTimeoutMs: 25 })
  f.state.configureChild = child => { child.exitOn = 'SIGKILL'; child.closeDelayMs = 10 }
  const exits: string[] = []
  f.executor.onExit = lease => exits.push(lease)
  await f.executor.start('lease', 3080)
  const before = Date.now()
  await Promise.all([f.executor.stop('lease'), f.executor.stop('lease')])
  assert.ok(Date.now() - before >= 30)
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(exits, [])
  assert.deepEqual(await readdir(f.root), [])
})

test('unconfirmed termination is an error, retains metadata, and allows safe retry', async t => {
  const f = await fixture(t, { terminateTimeoutMs: 10 })
  f.state.configureChild = child => { child.exitOn = undefined }
  const started = await f.executor.start('lease', 3080)
  await assert.rejects(f.executor.stop('lease'), /SSH_STOP_TIMEOUT/)
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM', 'SIGKILL'])
  assert.ok(await lstat(join(dirname(started.controlPath), 'owner.json')))
  f.children[0]!.finish(0)
  await f.executor.stop('lease')
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM', 'SIGKILL'])
})

test('stopAll attempts every child even if one child refuses termination', async t => {
  const f = await fixture(t, { terminateTimeoutMs: 10 })
  await f.executor.start('one', 3080)
  await f.executor.start('two', 3081)
  f.children[0]!.exitOn = undefined
  await assert.rejects(f.executor.stopAll(), /SSH_STOP_FAILED/)
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(f.children[1]!.signals, ['SIGTERM'])
})

test('drains large stderr with bounded retention and reports a sanitized exit code once', async t => {
  const f = await fixture(t, { stderrLimitBytes: 128 })
  const exits: [string, string][] = []
  f.executor.onExit = (lease, code) => { exits.push([lease, code]); throw new Error('callback cannot break cleanup') }
  await f.executor.start('lease', 3080)
  const child = f.children[0]!
  child.stderr.write('Host key verification failed\n' + 'secret'.repeat(100_000))
  child.stderr.write('Permission denied (publickey). private user secret\n')
  child.stdout.write('x'.repeat(100_000))
  // Deliberate white-box assertion: retention bound is part of the security contract.
  const tracked = (f.executor as unknown as { instances: Map<string, { stderr: Buffer }> }).instances.get('lease')!
  assert.ok(tracked.stderr.length <= 128)
  child.finish(255)
  assert.deepEqual(exits, [['lease', 'SSH_AUTH_FAILED']])
  assert.equal(await f.executor.isOwned('lease'), false)
  await f.executor.stop('lease')
  assert.deepEqual(child.signals, [])
})

test('early SSH failure rejects start instead of reporting a successful lease', async t => {
  const f = await fixture(t)
  f.state.configureChild = child => queueMicrotask(() => {
    child.stderr.write('Host key verification failed.\n')
    child.finish(255)
  })
  await assert.rejects(f.executor.start('lease', 3080), /SSH_HOST_KEY_FAILED/)
  assert.deepEqual(f.children[0]!.signals, [])
})

test('mux timeout aborts its command and stops the forwarding-free master', async t => {
  let aborted = false
  const f = await fixture(t, { commandTimeoutMs: 10, runner: { run(_file, _args, options) {
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }))
  } } })
  await assert.rejects(f.executor.start('lease', 3080), /SSH_START_TIMEOUT/)
  assert.equal(aborted, true)
  assert.equal(f.spawns.length, 1)
  assert.equal(f.children[0]!.exited, true)
  assert.ok(!f.spawns[0]!.args.includes('-L'))
  assert.deepEqual(await readdir(f.root), [])
})

test('oversized mux response is rejected and its master is stopped', async t => {
  const f=await fixture(t)
  const run=f.runner.run.bind(f.runner)
  f.runner.run=async(file,args,options)=>args.includes('forward')?ok('x'.repeat(300000)):run(file,args,options)
  await assert.rejects(f.executor.start('lease',3080),/SSH_COMMAND_OUTPUT_LIMIT/)
  assert.equal(f.children[0]!.exited,true)
})

test('restart recovery verifies metadata, socket, PID, listener; only control exit is used', async t => {
  const f = await fixture(t)
  const started = await f.executor.start('lease', 3080)
  const restarted = new SshExecutor('work-box', f.root, f.settings)
  await restarted.recover({ leaseId: 'lease', controlPath: started.controlPath, processId: started.pid })
  assert.deepEqual(f.children[0]!.signals, [])
  assert.equal(f.spawns.length, 1)
  assert.equal(f.calls.filter(call => call.args.includes('exit')).length, 1)
  assert.ok(f.calls.some(call => call.file === '/bin/ps'))
  assert.equal(await restarted.isOwned('lease'), false)
  assert.deepEqual(await readdir(f.root), [])
})

test('recovery rejects unrelated paths, lease IDs, PID mismatch and changed socket ownership evidence', async t => {
  const f = await fixture(t)
  const started = await f.executor.start('lease', 3080)
  const restarted = new SshExecutor('work-box', f.root, f.settings)
  for (const input of [
    { leaseId: 'lease', controlPath: '/tmp/foreign' },
    { leaseId: 'other', controlPath: started.controlPath },
    { leaseId: 'lease', controlPath: started.controlPath, processId: 99999 },
  ]) await assert.rejects(restarted.recover(input), /SSH_OWNERSHIP_UNVERIFIED/)
  f.state.masterOffset = 1
  await assert.rejects(restarted.recover({ leaseId: 'lease', controlPath: started.controlPath }), /SSH_OWNERSHIP_UNVERIFIED/)
  f.state.masterOffset = 0
  f.state.listener = () => ok('p99999\nn127.0.0.1:3080\n')
  await assert.rejects(restarted.recover({ leaseId: 'lease', controlPath: started.controlPath }), /SSH_OWNERSHIP_UNVERIFIED/)
  assert.deepEqual(f.children[0]!.signals, [])
  assert.equal(f.calls.filter(call => call.args.includes('exit')).length, 0)
})

test('recovery rejects tampered metadata and does not signal any saved PID', async t => {
  const f = await fixture(t)
  const started = await f.executor.start('lease', 3080)
  const metadata = join(dirname(started.controlPath), 'owner.json')
  await writeFile(metadata, JSON.stringify({ leaseId: 'lease', sshHost: 'other-alias', pid: started.pid, port: 3080, controlPath: started.controlPath }))
  await assert.rejects(new SshExecutor('work-box', f.root, f.settings).recover({ leaseId: 'lease', controlPath: started.controlPath }), /SSH_OWNERSHIP_UNVERIFIED/)
  assert.deepEqual(f.children[0]!.signals, [])
  assert.equal(f.calls.filter(call => call.args.includes('exit')).length, 0)
})

test('recovery waits for exit, times out safely, and never falls back to numeric PID kill', async t => {
  const f = await fixture(t, { terminateTimeoutMs: 10 })
  const started = await f.executor.start('lease', 3080)
  f.state.closeMaster = false
  await assert.rejects(new SshExecutor('work-box', f.root, f.settings).recover({ leaseId: 'lease', controlPath: started.controlPath }), /SSH_STOP_TIMEOUT/)
  assert.deepEqual(f.children[0]!.signals, [])
  assert.ok(await lstat(join(dirname(started.controlPath), 'owner.json')))
})

test('default command runner drains output, bounds it, and awaits TERM/KILL using injected spawn', async t => {
  const root = await mkdtemp('/tmp/dsh-s-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const children: FakeChild[] = []
  const spawn: SshSpawn = (file, args, options) => {
    assert.equal(file, '/usr/bin/ssh')
    assert.equal(options.shell, false)
    assert.ok(args.includes('-O'))
    const child = new FakeChild(42000)
    child.exitOn = 'SIGKILL'
    children.push(child)
    queueMicrotask(() => child.stdout.write('x'.repeat(300_000)))
    return child.asChild()
  }
  const executor = new SshExecutor('work-box', root, { spawn, terminateTimeoutMs: 10, commandTimeoutMs: 100 })
  await assert.rejects(command(executor), /SSH_COMMAND_OUTPUT_LIMIT/)
  assert.deepEqual(children[0]!.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(children[0]!.exited, true)
})

test('a replaced control socket or permissive lease directory invalidates ownership', async t => {
  const f = await fixture(t)
  const started = await f.executor.start('lease', 3080)
  const directory = dirname(started.controlPath)
  await chmod(directory, 0o755)
  assert.equal(await f.executor.isOwned('lease'), false)
  await chmod(directory, 0o700)
  const socket = f.sockets.get(started.controlPath)!
  await new Promise<void>(done => socket.server.close(() => done()))
  await writeFile(started.controlPath, 'not a socket', { mode: 0o600 })
  assert.equal(await f.executor.isOwned('lease'), false)
  const restarted = new SshExecutor('work-box', f.root, f.settings)
  await assert.rejects(restarted.recover({ leaseId: 'lease', controlPath: started.controlPath }), /SSH_OWNERSHIP_UNVERIFIED/)
  assert.deepEqual(f.children[0]!.signals, [])
  assert.equal(f.calls.filter(call => call.args.includes('exit')).length, 0)
})

test('stop during spawned-but-unverified startup awaits child cleanup', async t => {
  const f = await fixture(t)
  let spawned!: () => void
  const notification = new Promise<void>(done => { spawned = done })
  f.state.makeSocket = false
  f.state.configureChild = () => { spawned() }
  const opening = f.executor.start('lease', 3080)
  const rejected = assert.rejects(opening)
  await notification
  await f.executor.stop('lease')
  await rejected
  assert.equal(f.children[0]!.exited, true)
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM'])
  assert.deepEqual(await readdir(f.root), [])
})

test('missing lsof fails closed, and stop still only signals the local child handle', async t => {
  const f = await fixture(t)
  const runner: SshRunner = { run(file, args, options) {
    if (file.endsWith('/lsof')) throw new Error('ENOENT')
    return f.runner.run(file, args, options)
  } }
  const executor = new SshExecutor('work-box', f.root, { ...f.settings, runner, startupTimeoutMs: 40 })
  await assert.rejects(executor.start('lease', 3080), /SSH_START_TIMEOUT/)
  assert.deepEqual(f.children[0]!.signals, ['SIGTERM'])
})

test('synchronous spawn failure leaves no private config or lease directory', async t => {
  const f = await fixture(t, { spawn() { throw new Error('spawn failed') } })
  await assert.rejects(f.executor.start('lease', 3080), /spawn failed/)
  assert.deepEqual(await readdir(f.root), [])
})

test('production command timeout awaits kill/reap, and never signals after exit while pipes close', async t => {
  const root = await mkdtemp('/tmp/dsh-s-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const child = new FakeChild(42000)
  child.exitOn = 'SIGKILL'
  const executor = new SshExecutor('work-box', root, {
    spawn: () => child.asChild(), commandTimeoutMs: 10, terminateTimeoutMs: 10,
  })
  await assert.rejects(command(executor), /SSH_COMMAND_TIMEOUT/)
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(child.exited, true)

  const lateClose = new FakeChild(42001)
  lateClose.closeDelayMs = 25
  const second = new SshExecutor('work-box', root, {
    spawn: () => { queueMicrotask(() => lateClose.finish(1)); return lateClose.asChild() },
    commandTimeoutMs: 10, terminateTimeoutMs: 20,
  })
  await assert.rejects(command(second), /SSH_COMMAND_TIMEOUT/)
  assert.deepEqual(lateClose.signals, [])
})

test('recoverAll permits an absent root on first launch without creating it or issuing commands', async t => {
  const f = await fixture(t)
  const missing = join(f.root, 'absent')
  await new SshExecutor('work-box', missing, f.settings).recoverAll()
  await assert.rejects(lstat(missing), { code: 'ENOENT' })
  assert.equal(f.calls.length, 0)
  assert.equal(f.spawns.length, 0)
})

test('recoverAll finds owner records without any controller runtime controlPath', async t => {
  const f = await fixture(t)
  await f.executor.start('unrecorded-a', 3080)
  await f.executor.start('unrecorded-b', 3081)
  // A restarted controller has no saved start() results; only the private root survives.
  const restarted = new SshExecutor('work-box', f.root, f.settings)
  await restarted.recoverAll()
  assert.equal(f.calls.filter(call => call.args.includes('exit')).length, 2)
  assert.deepEqual(f.children.map(child => child.signals), [[], []])
  assert.equal(f.spawns.length, 2)
  assert.deepEqual(await readdir(f.root), [])
  assert.equal(await restarted.isOwned('unrecorded-a'), false)
  await restarted.recoverAll()
})

test('recoverAll closes a spawned SSH whose start has not returned for runtime persistence', async t => {
  const f = await fixture(t)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(done => { release = done })
  const checking = new Promise<void>(done => { entered = done })
  const interrupted = new SshExecutor('work-box', f.root, { ...f.settings, runner: { async run(file, args, options) {
    if (args.includes('check')) { entered(); await gate }
    return f.runner.run(file, args, options)
  } } })
  t.after(() => interrupted.stopAll())
  const start = interrupted.start('not-yet-persisted', 3080)
  const rejected = assert.rejects(start)
  await checking
  await new SshExecutor('work-box', f.root, f.settings).recoverAll()
  release()
  await rejected
  assert.deepEqual(f.children[0]!.signals, [])
  assert.equal(f.calls.filter(call => call.args.includes('exit')).length, 1)
  assert.deepEqual(await readdir(f.root), [])
})

test('recoverAll rejects missing or malformed owner records and retains their evidence', async t => {
  const f = await fixture(t)
  const started = await f.executor.start('lease', 3080)
  const metadata = join(dirname(started.controlPath), 'owner.json')
  const original = await readFile(metadata, 'utf8')
  const restarted = new SshExecutor('work-box', f.root, f.settings)
  await rm(metadata)
  await assert.rejects(restarted.recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  for (const content of ['{bad-json', 'null', '{}', 'x'.repeat(9000)]) {
    await writeFile(metadata, content, { mode: 0o600 })
    await assert.rejects(restarted.recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  }
  await writeFile(metadata, original, { mode: 0o600 })
  await chmod(metadata, 0o644)
  await assert.rejects(restarted.recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  assert.equal(f.calls.filter(call => call.args.includes('exit')).length, 0)
  assert.deepEqual(f.children[0]!.signals, [])
  assert.equal(await f.executor.isOwned('lease'), true)
})

test('recoverAll rejects changed aliases, sockets, or lease-bound directory names', async t => {
  const f = await fixture(t)
  const started = await f.executor.start('lease', 3080)
  await assert.rejects(new SshExecutor('different-alias', f.root, f.settings).recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  const metadata = join(dirname(started.controlPath), 'owner.json')
  const owner = JSON.parse(await readFile(metadata, 'utf8'))
  await writeFile(metadata, JSON.stringify({ ...owner, leaseId: 'other-lease' }))
  await assert.rejects(new SshExecutor('work-box', f.root, f.settings).recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  await writeFile(metadata, JSON.stringify(owner))
  const socket = f.sockets.get(started.controlPath)!
  await new Promise<void>(done => socket.server.close(() => done()))
  await assert.rejects(new SshExecutor('work-box', f.root, f.settings).recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  assert.equal(f.calls.filter(call => call.args.includes('exit')).length, 0)
  assert.deepEqual(f.children[0]!.signals, [])
})

test('recoverAll never follows root/lease symlinks and rejects non-private roots', async t => {
  const f = await fixture(t)
  const started = await f.executor.start('lease', 3080)
  const restarted = new SshExecutor('work-box', f.root, f.settings)
  await chmod(f.root, 0o755)
  await assert.rejects(restarted.recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  await chmod(f.root, 0o700)
  const rootLink = join(f.root, 'root-link')
  await symlink(f.root, rootLink)
  await assert.rejects(new SshExecutor('work-box', rootLink, f.settings).recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  await rm(rootLink)
  const leaseLink = join(f.root, 'l-0000000000000000-AbCd12')
  await symlink(dirname(started.controlPath), leaseLink)
  await assert.rejects(restarted.recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  assert.ok((await lstat(leaseLink)).isSymbolicLink())
  assert.deepEqual(f.children[0]!.signals, [])
})

test('recoverAll reports corruption but still stops every independently verified peer', async t => {
  const f = await fixture(t)
  const bad = await f.executor.start('bad', 3080)
  const good = await f.executor.start('good', 3081)
  await writeFile(join(dirname(bad.controlPath), 'owner.json'), '{}')
  await assert.rejects(new SshExecutor('work-box', f.root, f.settings).recoverAll(), /SSH_OWNERSHIP_UNVERIFIED/)
  assert.equal(f.children[0]!.exited, false)
  assert.equal(f.children[1]!.exited, true)
  assert.ok(await lstat(dirname(bad.controlPath)))
  await assert.rejects(lstat(dirname(good.controlPath)), { code: 'ENOENT' })
  assert.deepEqual(f.children.map(child => child.signals), [[], []])
})

test('recoverAll is single-flight, blocks new starts, and refuses a live executor', async t => {
  const f = await fixture(t)
  await f.executor.start('lease', 3080)
  await assert.rejects(f.executor.recoverAll(), /SSH_LEASE_EXISTS/)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(done => { release = done })
  const checking = new Promise<void>(done => { entered = done })
  const restarted = new SshExecutor('work-box', f.root, { ...f.settings, runner: { async run(file, args, options) {
    if (args.includes('check')) { entered(); await gate }
    return f.runner.run(file, args, options)
  } } })
  const recovery = restarted.recoverAll()
  assert.equal(restarted.recoverAll(), recovery)
  await checking
  await assert.rejects(restarted.start('racing-start', 3081), /SSH_RECOVERING/)
  release()
  await recovery
  assert.equal(f.calls.filter(call => call.args.includes('exit')).length, 1)
})
