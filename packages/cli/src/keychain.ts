import { KEYCHAIN_SERVICE } from './config.js'
import { systemCommandRunner, type CommandRunner } from './command.js'

/** Apple OSS SecurityTool/macOS/security.c split_line escapes backslashes in quotes.
 * readline.c has MAX_LINE_LEN=4096. One newline + EOF preserves command exit status.
 * Pipe only: never use -v, a TTY, a shell, or append quit (which masks failure).
 */
export function securityInput(args: readonly string[]): string {
  const line = args.map(value => {
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Keychain input contains control characters')
    return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
  }).join(' ') + '\n'
  if (Buffer.byteLength(line, 'utf8') >= 4096) throw new Error('Keychain input exceeds safe line length')
  return line
}

export class MacKeychain {
  constructor(private readonly runner: CommandRunner = systemCommandRunner) {}

  async store(deviceId: string, token: string): Promise<void> {
    this.platformGuard()
    validate(deviceId, 'device id')
    validate(token, 'Device token')
    // No -U: never overwrite an existing credential.
    const stdin = securityInput(['add-generic-password', '-a', deviceId, '-s', KEYCHAIN_SERVICE, '-w', token])
    const result = await this.runner.run('/usr/bin/security', ['-i'], { stdin })
    if (result.code !== 0) throw new Error('macOS Keychain refused the Companion credential')
    try {
      if (await this.read(deviceId) !== token) throw new Error('verification mismatch')
    } catch {
      try { await this.remove(deviceId) }
      catch { throw new Error('Keychain verification failed; newly created credential cleanup also failed') }
      throw new Error('macOS Keychain credential verification failed; newly created credential removed')
    }
  }

  async read(deviceId: string): Promise<string> {
    this.platformGuard()
    validate(deviceId, 'device id')
    const result = await this.runner.run('/usr/bin/security', [
      'find-generic-password', '-a', deviceId, '-s', KEYCHAIN_SERVICE, '-w',
    ])
    const token = result.stdout.replace(/\r?\n$/, '')
    if (result.code !== 0 || !token) throw new Error('Companion Device credential is unavailable in macOS Keychain')
    validate(token, 'Device token')
    return token
  }

  async remove(deviceId: string): Promise<void> {
    this.platformGuard()
    validate(deviceId, 'device id')
    const result = await this.runner.run('/usr/bin/security', [
      'delete-generic-password', '-a', deviceId, '-s', KEYCHAIN_SERVICE,
    ])
    // errSecItemNotFound (-25300) is returned modulo 256.
    if (result.code !== 0 && result.code !== 44) throw new Error('macOS Keychain could not remove the Companion credential')
  }

  private platformGuard(): void {
    if (this.runner === systemCommandRunner && process.platform !== 'darwin') throw new Error('macOS Keychain requires macOS')
  }
}

function validate(value: string, name: string): void {
  if (!value || value.length > 1_024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('invalid ' + name)
}
