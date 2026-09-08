import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { CompanionPaths } from './config.js'
import { LAUNCH_AGENT_LABEL, absoluteRuntimePath } from './config.js'
import { systemCommandRunner, type CommandRunner } from './command.js'

export async function installBundle(source: string, destination: string): Promise<void> {
  if (!isAbsolute(source) || !isAbsolute(destination) || !source.endsWith('.mjs')) throw new Error('Install requires an absolute bundled .mjs path')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  // COPYFILE_EXCL is intentional: setup may not replace an older installation.
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  try { await chmod(destination, 0o700) }
  catch (error) { await rm(destination, { force: true }); throw error }
}

export function renderLaunchAgent(paths: CompanionPaths, runtimePath: string): string {
  absoluteRuntimePath(runtimePath)
  for (const path of [paths.bundle, paths.root, paths.stdoutLog, paths.stderrLog]) {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('LaunchAgent paths must be absolute and contain no controls')
  }
  const args = [runtimePath, paths.bundle, 'daemon']
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>\n' +
    '<key>Label</key><string>' + LAUNCH_AGENT_LABEL + '</string>\n' +
    '<key>ProgramArguments</key><array>' + args.map(value => '<string>' + xml(value) + '</string>').join('') + '</array>\n' +
    '<key>WorkingDirectory</key><string>' + xml(paths.root) + '</string>\n' +
    '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n' +
    '<key>ThrottleInterval</key><integer>15</integer>\n' +
    '<key>ProcessType</key><string>Background</string>\n' +
    '<key>StandardOutPath</key><string>' + xml(paths.stdoutLog) + '</string>\n' +
    '<key>StandardErrorPath</key><string>' + xml(paths.stderrLog) + '</string>\n' +
    '</dict></plist>\n'
}

export async function installLaunchAgent(paths: CompanionPaths, runtimePath: string, runner: CommandRunner = systemCommandRunner, uid = currentUid()): Promise<void> {
  platformGuard(runner)
  const plist = renderLaunchAgent(paths, runtimePath)
  await mkdir(dirname(paths.launchAgent), { recursive: true, mode: 0o700 })
  await mkdir(paths.logDirectory, { recursive: true, mode: 0o700 })
  await writeFile(paths.launchAgent, plist, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const domain = 'gui/' + uid
  const enable = await runner.run('/bin/launchctl', ['enable', domain + '/' + LAUNCH_AGENT_LABEL])
  if (enable.code !== 0) throw new Error('launchctl could not enable DSH Companion')
  const bootstrap = await runner.run('/bin/launchctl', ['bootstrap', domain, paths.launchAgent])
  if (bootstrap.code !== 0) throw new Error('launchctl bootstrap failed')
  // RunAtLoad starts it; no kickstart -k race against the newly started daemon.
}

export class LaunchAgentStopError extends Error {
  constructor(readonly code: 'STOP_REQUEST_FAILED' | 'STOP_REGISTRATION_UNKNOWN' | 'STOP_REGISTRATION_TIMEOUT') { super(code + ': cannot confirm owned LaunchAgent shutdown; installation retained') }
}

export async function waitForLaunchAgentStop(runner: CommandRunner, uid: number, timeoutMs = 10_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid bounded LaunchAgent stop timeout')
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const state = await launchAgentStatus(runner, uid)
    if (state === 'not_loaded') return
    if (state === 'unknown') throw new LaunchAgentStopError('STOP_REGISTRATION_UNKNOWN')
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new LaunchAgentStopError('STOP_REGISTRATION_TIMEOUT')
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remaining)))
  }
}

export async function stopLaunchAgent(paths: CompanionPaths, runner: CommandRunner = systemCommandRunner, uid = currentUid()): Promise<void> {
  platformGuard(runner)
  const result = await runner.run('/bin/launchctl', ['bootout', 'gui/' + uid + '/' + LAUNCH_AGENT_LABEL])
  // ESRCH means no registered service; other failures must retain recovery files.
  if (result.code !== 0 && result.code !== 3) throw new Error('launchctl could not stop DSH Companion; installation retained')
}

export async function restartLaunchAgent(runner: CommandRunner = systemCommandRunner, uid = currentUid()): Promise<void> {
  platformGuard(runner)
  const result = await runner.run('/bin/launchctl', ['kickstart', '-k', 'gui/' + uid + '/' + LAUNCH_AGENT_LABEL])
  if (result.code !== 0) throw new Error('launchctl restart failed')
}

export async function launchAgentStatus(runner: CommandRunner = systemCommandRunner, uid = currentUid()): Promise<'loaded' | 'not_loaded' | 'unknown'> {
  platformGuard(runner)
  const result = await runner.run('/bin/launchctl', ['print', 'gui/' + uid + '/' + LAUNCH_AGENT_LABEL])
  if (result.code === 0) return 'loaded'
  if (result.code === 3) return 'not_loaded'
  // launchctl print uses its own 113 status for a missing service on macOS.
  // Require the exact requested label and GUI domain; 113 alone is not absence
  // evidence and must never be generalized to bootout or other subcommands.
  const diagnostic = result.stderr.replaceAll('\r\n', '\n').trim()
  const missingService = 'Could not find service "' + LAUNCH_AGENT_LABEL + '" in domain for user gui: ' + uid
  if (result.code === 113 && (diagnostic === missingService || diagnostic === 'Bad request.\n' + missingService)) return 'not_loaded'
  return 'unknown'
}

export function currentUid(): number { return typeof process.getuid === 'function' ? process.getuid() : 0 }
function platformGuard(runner: CommandRunner): void {
  if (runner === systemCommandRunner && process.platform !== 'darwin') throw new Error('LaunchAgent lifecycle requires macOS')
}
function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}
