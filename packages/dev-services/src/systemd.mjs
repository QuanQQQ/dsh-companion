import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { unitName } from './spec.mjs'

const exec = promisify(execFile)
const fields = ['LoadState', 'Description', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup', 'Result', 'NRestarts']

/** Both line count and total UTF-8 bytes include the truncation notice. */
export function boundedLogs(text, lines = 80) {
  if (!Number.isInteger(lines) || lines < 1 || lines > 500) throw new Error('Log lines must be between 1 and 500')
  const rows = text.replace(/\n$/, '').split('\n')
  let output = rows.slice(-lines).join('\n')
  let truncated = rows.length > lines || Buffer.byteLength(output) > 65536
  if (truncated) {
    const notice = '[earlier output truncated]\n'
    output = lines === 1 ? output.split('\n').at(-1) : output.split('\n').slice(-(lines - 1)).join('\n')
    const budget = 65536 - (lines === 1 ? 0 : Buffer.byteLength(notice))
    const bytes = Buffer.from(output)
    if (bytes.length > budget) output = bytes.subarray(-budget).toString('utf8')
    // Replacement characters at a split UTF-8 boundary can expand bytes.
    while (Buffer.byteLength(output) > budget) output = output.slice(1)
    return lines === 1 ? output : notice + output
  }
  return output
}

/** Bounded process transport. Non-zero results stay observable for missing units. */
export async function command(file, args) {
  try {
    const result = await exec(file, args, { timeout: 15000, maxBuffer: 256 * 1024, encoding: 'utf8', env: { ...process.env, SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' } })
    return { ...result, code: 0 }
  } catch (error) {
    if (Number.isInteger(error.code) && !error.killed) return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }
    throw new Error('Service manager operation failed or result unknown', { cause: error })
  }
}

/** Linux user-service backend; all mutations derive names from verified records. */
export class SystemdBackend {
  constructor(namespace, options = {}) {
    this.namespace = namespace
    this.run = options.run ?? command
    this.node = options.node ?? process.execPath
    this.runner = options.runner ?? fileURLToPath(new URL('./runner.mjs', import.meta.url))
    this.policy = { restartDelaySeconds: 2, restartBurst: 3, restartIntervalSeconds: 60, stopTimeoutSeconds: 5, ...options.policy }
    for (const [key, value] of Object.entries(this.policy)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 3600) throw new Error(`Invalid systemd policy ${key}`)
    }
  }

  identity(record) {
    if (typeof record.ownership !== 'string' || !/^[a-f0-9]{64}$/.test(record.ownership)) throw new Error('Invalid service ownership')
    return { unit: unitName(this.namespace, record.id), description: `dsh-dev-services:${record.ownership}` }
  }

  async checked(file, args) {
    const result = await this.run(file, args)
    if (result.code !== 0) throw new Error(`Owned service manager operation failed (${result.code})`)
    return result.stdout
  }

  async inspect(record) {
    const identity = this.identity(record)
    const result = await this.run('systemctl', ['--user', '--no-pager', 'show', identity.unit, ...fields.map(key => `--property=${key}`)])
    const values = Object.fromEntries(result.stdout.split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    if (values.LoadState === 'not-found' && [0, 1, 4].includes(result.code)) return { exists: false, unit: identity.unit, state: 'stopped' }
    if (result.code !== 0 || !values.LoadState) throw new Error('Cannot observe service manager')
    if (values.Description !== identity.description) throw new Error('Unit ownership mismatch; refusing access')
    return {
      exists: true, unit: identity.unit, state: values.ActiveState, subState: values.SubState,
      pid: Number(values.MainPID), cgroup: values.ControlGroup, result: values.Result, restarts: Number(values.NRestarts),
    }
  }

  async start(record) {
    const before = await this.inspect(record)
    if (before.exists && ['active', 'activating'].includes(before.state)) return before
    if (before.exists) {
      // Reset only a unit whose exact persisted ownership was checked above.
      if (before.state === 'failed') await this.checked('systemctl', ['--user', 'reset-failed', before.unit])
      else await this.checked('systemctl', ['--user', 'stop', before.unit])
    }
    const identity = this.identity(record)
    // These are fixed launcher paths, not application argv. systemd expands
    // percent and dollar sequences; refuse unusual installation paths here.
    for (const path of [this.node, this.runner]) if (!path.startsWith('/') || /[%$\0\n\r]/.test(path)) throw new Error('Unsupported launcher path')
    const payload = Buffer.from(JSON.stringify({
      executable: record.executable, args: record.args, workdir: record.workdir,
      env: { HOME: homedir(), PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PORT: String(record.port), HOST: '127.0.0.1' },
    })).toString('base64url')
    const p = this.policy
    await this.checked('systemd-run', [
      '--user', '--no-ask-password', '--quiet', `--unit=${identity.unit}`, `--description=${identity.description}`,
      '--service-type=exec', '--property=KillMode=control-group', '--property=SuccessExitStatus=SIGTERM', '--property=Restart=on-failure',
      `--property=RestartSec=${p.restartDelaySeconds}`, `--property=StartLimitBurst=${p.restartBurst}`,
      `--property=StartLimitIntervalSec=${p.restartIntervalSeconds}`, `--property=TimeoutStopSec=${p.stopTimeoutSeconds}`,
      '--property=StandardOutput=journal', '--property=StandardError=journal', '--property=UMask=0077',
      '--', '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', this.node, this.runner, payload,
    ])
    return await this.inspect(record)
  }

  async stop(record) {
    const before = await this.inspect(record)
    if (!before.exists) return before
    await this.checked('systemctl', ['--user', 'stop', before.unit])
    let after = await this.inspect(record)
    if (after.exists && after.state === 'failed') {
      await this.checked('systemctl', ['--user', 'reset-failed', before.unit])
      after = await this.inspect(record)
    }
    if (after.exists && after.state !== 'inactive') throw new Error('Service has not stopped')
    return after
  }

  async logs(record, lines = 80) {
    if (!Number.isInteger(lines) || lines < 1 || lines > 500) throw new Error('Log lines must be between 1 and 500')
    // A persisted record supplies identity even after systemd unloads its unit.
    await this.inspect(record)
    const { unit } = this.identity(record)
    const text = await this.checked('journalctl', ['--user', '--no-pager', '--output=cat', `--user-unit=${unit}`, `--lines=${lines}`])
    return boundedLogs(text, lines)
  }
}
