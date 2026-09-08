import { createInterface } from 'node:readline/promises'
import { realpath } from 'node:fs/promises'
import { companionPaths, normalizeServerUrl, readConfig, validateSshHost } from './config.js'
import { Writable } from 'node:stream'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setup, status, uninstall, type LifecycleDependencies } from './setup.js'
import { restartLaunchAgent } from './launchd.js'
import { systemCommandRunner } from './command.js'
import type { LaunchDependencies, LaunchOptions, LaunchResult } from './launch.js'

import { VERSION } from './version.js'
export { VERSION } from './version.js'
export const HELP = 'Usage: dsh-companion <launch|setup|install|update|daemon|status|restart|uninstall>\n' +
  '  launch --server https://HOST [--ssh-host SSH_ALIAS]: unified start, replacement and browser approval.\n' +
  '  setup (install is an alias) --server https://HOST --ssh-host SSH_ALIAS [--name NAME]\n' +
  '    [--node /absolute/path/to/node] [--allow-insecure-http] [--pair-code-stdin]\n' +
  '  First setup reads a hidden pairing code; repeat setup with matching settings updates without re-pairing.\n' +
  '  Requires macOS and an externally installed Node.js 22+; no native runtime is bundled.\n' +
  '  update uses this downloaded bundle, preserving pairing/configuration and rolling back a failed replacement.\n' +
  '  Update briefly interrupts Companion forwards; missing or unverifiable installations fail safely.\n' +
  '  status reports local installation/launchctl state, not Host connectivity.\n'

export interface CliDependencies extends LaunchDependencies {
  readPairCode?: (stdinOnly: boolean) => Promise<string>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  runDaemon?: () => Promise<void>
  runLaunch?: (options: LaunchOptions, deps: LaunchDependencies) => Promise<LaunchResult>
  runUpdate?: (deps: LifecycleDependencies) => Promise<{ version: string; changed: boolean; note?: string }>
}

export async function main(argv = process.argv.slice(2), deps: CliDependencies = {}): Promise<number> {
  const out = deps.stdout ?? (text => { process.stdout.write(text) })
  const err = deps.stderr ?? (text => { process.stderr.write(text) })
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help' || argv[1] === '--help') { out(HELP); return 0 }
  if (argv.length === 1 && argv[0] === '--version') { out('dsh-companion ' + VERSION + '\n'); return 0 }
  const performUpdate = async () => {
    out('Checking local update; pairing is preserved and Companion forwards may pause briefly.\n')
    const result = await (deps.runUpdate ?? (async d => (await import('./update.js')).update(d)))(deps)
    out((result.changed ? 'Updated Companion to ' : 'Companion already matches ') + result.version + '; pairing and configuration preserved.\n')
    if (result.note) out(result.note + '\n')
  }
  try {
    const command = argv[0]
    if (command === 'launch') {
      const options = parseLaunchArgs(argv.slice(1))
      const abort = new AbortController()
      const signal = deps.signal ? AbortSignal.any([abort.signal, deps.signal]) : abort.signal
      const cancel = () => abort.abort()
      process.on('SIGINT', cancel)
      process.on('SIGTERM', cancel)
      process.on('SIGHUP', cancel)
      const question = async (text: string) => {
        if (!process.stdin.isTTY) throw new Error('Unified launch needs an interactive terminal for first authorization')
        const rl = createInterface({input:process.stdin,output:process.stdout})
        try { return await rl.question(text, {signal}) } finally { rl.close() }
      }
      try {
        const launched = await (deps.runLaunch ?? (async (o,d) => (await import('./launch.js')).launch(o,d)))(options, {
          ...deps, signal,
          promptSshHost: deps.promptSshHost ?? (async current => (await question('本机 SSH alias' + (current ? ' ['+current+']' : '') + ': ')).trim() || current || ''),
          confirmRepair: deps.confirmRepair ?? (async info => /^(y|yes)$/i.test((await question('本地配对与此 Host 不匹配 ('+info.reason+')。从 '+info.oldServer+' 切换/重新授权到 '+info.newServer+'？旧 Lease 不会迁移 [y/N]: ')).trim())),
          showApproval: deps.showApproval ?? (async info => {
            out('请在 '+info.serverUrl+' 的 Settings → Companion Devices 核对验证码 '+info.userCode+' 并点击允许。无需复制配对密钥。\n')
            try { await (deps.runner ?? systemCommandRunner).run('/usr/bin/open',[info.serverUrl]) } catch { /* URL remains visible for manual navigation. */ }
          }),
        })
        out('Companion 已启动：'+launched.config.serverUrl+'；设备 '+launched.config.deviceId+'。等待页面连接状态，旧 Lease 不会自动迁移。\n')
      } finally { process.off('SIGINT',cancel); process.off('SIGTERM',cancel); process.off('SIGHUP',cancel) }
    } else if (command === 'setup' || command === 'install') {
      const options = parseSetupArgs(argv.slice(1))
      let existing
      try { existing = await readConfig((deps.paths ?? companionPaths()).config) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (existing) {
        if (normalizeServerUrl(options.serverUrl, options.allowInsecureHttp) !== existing.serverUrl ||
            validateSshHost(options.sshHost) !== existing.sshHost ||
            (options.runtimePath !== undefined && await realpath(options.runtimePath) !== existing.runtimePath)) {
          throw new Error('Existing pairing settings differ; update preserves the existing Host, SSH alias and Node runtime. Use update without setup options.')
        }
        out('Existing installation detected; updating in place without a new pairing code.\n')
        await performUpdate()
        return 0
      }
      const code = await (deps.readPairCode ?? readPairCode)(options.stdinOnly)
      const config = await setup({ ...options, pairCode: code }, deps)
      out('Installed Device ' + config.deviceId + ' with external Node.js runtime ' + config.runtimePath + '\n')
    } else {
      if (argv.length !== 1) throw new Error('Unexpected arguments; use --help (secrets are not accepted in argv)')
      switch (command) {
        case 'daemon': {
          if (deps.runDaemon) await deps.runDaemon()
          else { const { runDaemon } = await import('./daemon.js'); await runDaemon() }
          break
        }
        case 'update': {
          await performUpdate()
          break
        }
        case 'status': out(JSON.stringify(await status(deps), null, 2) + '\n'); break
        case 'restart':
          await restartLaunchAgent(deps.runner, deps.uid)
          out('LaunchAgent restart requested; reconnect budget is preserved. Inspect status and logs for readiness.\n')
          break
        case 'uninstall':
          await uninstall(deps)
          out('Local installation and Keychain credential removed. Logs retained. Revoke this Device in DSH separately.\n')
          break
        default: throw new Error('Unknown command; use --help')
      }
    }
    return 0
  } catch (error) {
    err((error instanceof Error ? error.message : 'Companion command failed') + '\n')
    return 1
  }
}

export function parseLaunchArgs(args: string[]): LaunchOptions {
  if (args.includes('--pair-code-stdin')) throw new Error('Unified launch uses browser approval, not pairing codes')
  const hasAlias = args.includes('--ssh-host')
  const parsed = parseSetupArgs(hasAlias ? args : [...args,'--ssh-host','prompt-locally'])
  return {serverUrl:parsed.serverUrl, allowInsecureHttp:parsed.allowInsecureHttp,
    ...(hasAlias ? {sshHost:parsed.sshHost} : {}),
    ...(parsed.name !== undefined ? {name:parsed.name} : {}),
    ...(parsed.runtimePath !== undefined ? {runtimePath:parsed.runtimePath} : {})}
}

export function parseSetupArgs(args: string[]) {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!
    if (['--allow-insecure-http', '--pair-code-stdin'].includes(key)) {
      if (flags.has(key)) throw new Error('Duplicate setup option')
      flags.add(key)
    } else if (['--server', '--ssh-host', '--name', '--node'].includes(key)) {
      const value = args[++i]
      if (!value || value.startsWith('--') || values.has(key)) throw new Error('Missing value or duplicate setup option')
      values.set(key, value)
    } else throw new Error('Unsupported setup option; pair codes and tokens must not be passed in argv')
  }
  const serverUrl = values.get('--server')
  const sshHost = values.get('--ssh-host')
  if (!serverUrl || !sshHost) throw new Error('setup requires --server and --ssh-host')
  return { serverUrl, sshHost, ...(values.has('--name') ? { name: values.get('--name')! } : {}),
    ...(values.has('--node') ? { runtimePath: values.get('--node')! } : {}),
    allowInsecureHttp: flags.has('--allow-insecure-http'), stdinOnly: flags.has('--pair-code-stdin') }
}

async function readPairCode(stdinOnly: boolean): Promise<string> {
  if (process.stdin.isTTY) {
    if (stdinOnly) throw new Error('--pair-code-stdin requires piped stdin')
    process.stderr.write('Pair code (hidden): ')
    const muted = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true })
    try { return await rl.question('') }
    finally { rl.close(); process.stderr.write('\n') }
  }
  let value = ''
  for await (const chunk of process.stdin) {
    value += chunk.toString('utf8')
    if (Buffer.byteLength(value) > 1_024) throw new Error('Pair code stdin exceeds maximum length')
  }
  const code = value.replace(/\r?\n$/, '')
  if (!code || /[\x00-\x1f\x7f]/.test(code)) throw new Error('stdin must contain exactly one pair code line')
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
