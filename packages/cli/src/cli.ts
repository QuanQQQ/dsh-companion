import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setup, status, uninstall, type LifecycleDependencies } from './setup.js'
import { restartLaunchAgent } from './launchd.js'

export const VERSION = '0.1.0'
export const HELP = 'Usage: dsh-companion <setup|install|daemon|status|restart|uninstall>\n' +
  '  setup (install is an alias) --server https://HOST --ssh-host SSH_ALIAS [--name NAME]\n' +
  '    [--node /absolute/path/to/node] [--allow-insecure-http] [--pair-code-stdin]\n' +
  '  Pair code is read from stdin, or a hidden TTY prompt; never pass it in argv.\n' +
  '  Requires macOS and an externally installed Node.js 22+; no native runtime is bundled.\n' +
  '  Existing/partial installations are not overwritten. Uninstall locally, then revoke Device in DSH.\n' +
  '  status reports local installation/launchctl state, not Host connectivity.\n'

export interface CliDependencies extends LifecycleDependencies {
  readPairCode?: (stdinOnly: boolean) => Promise<string>
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  runDaemon?: () => Promise<void>
}

export async function main(argv = process.argv.slice(2), deps: CliDependencies = {}): Promise<number> {
  const out = deps.stdout ?? (text => { process.stdout.write(text) })
  const err = deps.stderr ?? (text => { process.stderr.write(text) })
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help' || argv[1] === '--help') { out(HELP); return 0 }
  if (argv.length === 1 && argv[0] === '--version') { out('dsh-companion ' + VERSION + '\n'); return 0 }
  try {
    const command = argv[0]
    if (command === 'setup' || command === 'install') {
      const options = parseSetupArgs(argv.slice(1))
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
