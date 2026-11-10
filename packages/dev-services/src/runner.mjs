import { spawn } from 'node:child_process'

// The transient unit receives only a base64url payload, so systemd performs no
// environment or specifier expansion on application arguments.
const spec = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'))
let stoppingSignal
const child = spawn(spec.executable, spec.args, {
  cwd: spec.workdir,
  env: spec.env,
  stdio: 'inherit',
  shell: false,
})
child.once('error', error => {
  console.error(`Cannot launch development service: ${error.message}`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal && signal !== stoppingSignal) console.error(`Development service exited from ${signal}`)
  process.exitCode = signal && signal === stoppingSignal ? 0 : code ?? 1
})
// systemd KillMode=control-group signals both the runner and all descendants.
// Remain alive until the direct child exits and distinguish an owned unit stop
// from an application that terminates itself with the same signal.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stoppingSignal = signal })
