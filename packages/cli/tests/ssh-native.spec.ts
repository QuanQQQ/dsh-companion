import assert from 'node:assert/strict'
import test from 'node:test'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createServer,createConnection} from 'node:net'
import {once} from 'node:events'
import {SshExecutor} from '../src/ssh.js'
const exec=promisify(execFile)
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function port() {const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p}

for (const transport of ['ProxyCommand','ProxyJump']) test('native OpenSSH honors '+transport+' and isolates configured forwards', {timeout:20000,skip:process.platform!=='linux'}, async t=>{
  const root=await mkdtemp('/tmp/dsh-native-')
  t.after(()=>rm(root,{recursive:true,force:true}))
  const sshPort=await port(),forwardPort=await port(),extraPort=await port(),dynamicPort=await port(),remotePort=await port()
  const username=(await exec('/usr/bin/id',['-un'])).stdout.trim()
  for(const name of ['host','client']) await exec('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',join(root,name)])
  const hostPub=(await readFile(join(root,'host.pub'),'utf8')).trim().split(' ').slice(0,2).join(' ')
  await writeFile(join(root,'known_hosts'),'[127.0.0.1]:'+sshPort+' '+hostPub+'\n')
  await writeFile(join(root,'sshd.conf'),[
    'ListenAddress 127.0.0.1','Port '+sshPort,'HostKey '+join(root,'host'),'PidFile '+join(root,'sshd.pid'),
    'AuthorizedKeysFile '+join(root,'client.pub'),'StrictModes no','PasswordAuthentication no','KbdInteractiveAuthentication no',
    'UsePAM no','AllowUsers '+username,'AllowTcpForwarding yes','LogLevel ERROR',
  ].join('\n')+'\n')
  const server=spawn('/usr/sbin/sshd',['-D','-e','-f',join(root,'sshd.conf')],{stdio:['ignore','ignore','pipe']})
  let serverError='';server.stderr.on('data',b=>{serverError+=b})
  t.after(async()=>{if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await once(server,'close')}})
  let ready=false
  for(let i=0;i<100;i++){
    if(server.exitCode!==null||server.signalCode!==null) throw new Error('Isolated sshd failed: '+serverError)
    ready=await new Promise<boolean>(r=>{const s=createConnection({host:'127.0.0.1',port:sshPort});s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>r(false))})
    if(ready)break
    await pause(20)
  }
  assert.equal(ready,true,serverError)
  const marker=join(root,'proxy-started'),childPid=join(root,'proxy-child'),localMarker=join(root,'local-command')
  await writeFile(join(root,'proxy.cjs'),[
    'const fs=require("node:fs"),net=require("node:net"),{spawn}=require("node:child_process");',
    'fs.writeFileSync(process.argv[4],String(process.pid));',
    'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(process.argv[5],String(child.pid));',
    'const socket=net.createConnection({host:process.argv[2],port:Number(process.argv[3])});process.stdin.pipe(socket);socket.pipe(process.stdout);',
    'socket.on("error",()=>process.exit(1));socket.on("close",()=>process.exit(0));',
  ].join('\n'))
  const config=join(root,'user-config')
  const configText=[
    'Host native-test','HostName 127.0.0.1','User '+username,'Port '+sshPort,
    'IdentityFile '+join(root,'client'),'IdentitiesOnly yes','UserKnownHostsFile '+join(root,'known_hosts'),
    'ControlMaster no','ControlPath '+join(root,'foreign-control'),'ControlPersist 60',
    'LocalForward 127.0.0.1:'+extraPort+' 127.0.0.1:1','DynamicForward 127.0.0.1:'+dynamicPort,
    'RemoteForward '+remotePort+' 127.0.0.1:1','PermitLocalCommand yes','LocalCommand touch '+localMarker,'RemoteCommand false',
    transport==='ProxyCommand' ? 'ProxyCommand '+process.execPath+' '+join(root,'proxy.cjs')+' %h %p '+marker+' '+childPid : 'ProxyJump jump-test',
    'Host jump-test','HostName 127.0.0.1','User '+username,'Port '+sshPort,
    'IdentityFile '+join(root,'client'),'IdentitiesOnly yes','UserKnownHostsFile '+join(root,'known_hosts'),
    'StrictHostKeyChecking yes','ControlMaster no','ControlPersist no','BatchMode yes',
  ].join('\n')+'\n'
  await writeFile(config,configText)
  const calls:{file:string,args:readonly string[]}[]=[]
  const executor=new SshExecutor('native-test',join(root,'control'),{
    startupTimeoutMs:10000,terminateTimeoutMs:1000,
    spawn:(file,args,options)=>{calls.push({file,args});return spawn(file,file==='/usr/bin/ssh'?['-F',config,...args]:[...args],options)},
  })
  t.after(()=>executor.stopAll())
  // This local fixture proves real listener creation/ownership, not same-host recursive payload forwarding.
  const opened=await executor.start('native-lease',forwardPort)
  assert.equal(await executor.isOwned('native-lease'),true)
  if(transport==='ProxyCommand') assert.ok(await readFile(marker,'utf8'))
  assert.ok(!calls.some(c=>c.args.includes('-G')))
  assert.equal(await readFile(config,'utf8'),configText)
  await assert.rejects(readFile(localMarker),{code:'ENOENT'})
  for(const port of [extraPort,dynamicPort,remotePort]) {
    const listening=await new Promise<boolean>(r=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();r(true)});socket.once('error',()=>r(false))})
    assert.equal(listening,false,'user-configured forward must not be started by this master')
  }
  const listeners=(await exec('/usr/bin/lsof',['-nP','-a','-p',String(opened.pid),'-iTCP','-sTCP:LISTEN','-Fpn'])).stdout
  assert.deepEqual(listeners.trim().split('\n').filter(l=>l.startsWith('n')),['n127.0.0.1:'+forwardPort])
  const descendants=transport==='ProxyCommand' ? [Number(await readFile(marker,'utf8')),Number(await readFile(childPid,'utf8'))] : (await exec('/bin/ps',['--ppid',String(opened.pid),'-o','pid='])).stdout.trim().split(/\s+/).map(Number)
  assert.ok(descendants.length>0 && descendants.every(pid=>pid>1))
  await executor.stop('native-lease')
  for(const pid of descendants) {
    let running=true
    for(let i=0;i<50;i++) {
      try {running=!(await exec('/bin/ps',['-p',String(pid),'-o','stat='])).stdout.trim().startsWith('Z')}
      catch {running=false}
      if(!running)break
      await pause(20)
    }
    assert.equal(running,false,'owned proxy descendant must be stopped')
  }
  const occupied=createServer()
  occupied.listen(forwardPort,'127.0.0.1');await once(occupied,'listening')
  t.after(()=>new Promise<void>(r=>occupied.close(()=>r())))
  await assert.rejects(executor.start('conflicting-lease',forwardPort),{code:'SSH_PORT_IN_USE'})
  assert.equal(await executor.isOwned('conflicting-lease'),false)
})
