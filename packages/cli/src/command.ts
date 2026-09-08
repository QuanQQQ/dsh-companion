import { spawn } from 'node:child_process'

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface CommandOptions { stdin?: string; timeoutMs?: number }
export interface CommandRunner { run(file: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult> }

export const systemCommandRunner: CommandRunner = {
  run(file, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout = boundedAppend(stdout, chunk) })
      child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, chunk) })
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30_000)
      child.once('error', () => { clearTimeout(timer); reject(new Error('Command could not start')) })
      child.stdin.on('error', () => { /* EPIPE is reported by the process exit status. */ })
      child.stdin.end(options.stdin)
      child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }) })
    })
  },
}

function boundedAppend(previous: string, chunk: string, limit = 64 * 1024): string {
  const next = previous + chunk
  return next.length > limit ? next.slice(-limit) : next
}
