import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export const CONFIG_VERSION = 1 as const
export const KEYCHAIN_SERVICE = 'dev.deepseek.dsh-companion'
export const LAUNCH_AGENT_LABEL = 'dev.deepseek.dsh-companion'

export interface CompanionPaths {
  root: string
  bundle: string
  config: string
  runtimeState: string
  logDirectory: string
  stdoutLog: string
  stderrLog: string
  launchAgent: string
  controlDirectory: string
}

export interface CompanionConfig {
  version: typeof CONFIG_VERSION
  serverUrl: string
  sshHost: string
  deviceId: string
  installationId: string
  authorityEpoch: string
  runtimePath: string
  installedAt: string
  allowInsecureHttp?: boolean
}

export function companionPaths(home = homedir(), uid = typeof process.getuid === 'function' ? process.getuid() : 0): CompanionPaths {
  const root = join(home, 'Library', 'Application Support', 'DSH Companion')
  const logDirectory = join(home, 'Library', 'Logs', 'DSH Companion')
  return {
    root,
    bundle: join(root, 'dsh-companion.mjs'),
    config: join(root, 'config.json'),
    runtimeState: join(root, 'runtime-state.json'),
    logDirectory,
    stdoutLog: join(logDirectory, 'daemon.log'),
    stderrLog: join(logDirectory, 'daemon.error.log'),
    launchAgent: join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`),
    controlDirectory: join('/tmp', `dsh-companion-${uid}`),
  }
}

export async function readConfig(path: string): Promise<CompanionConfig> {
  return parseConfig(JSON.parse(await readFile(path, 'utf8')))
}

export function parseConfig(value: unknown): CompanionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Companion config is invalid')
  const record = value as Record<string, unknown>
  if (record.version !== CONFIG_VERSION) throw new Error('Companion config version is unsupported')
  return {
    version: CONFIG_VERSION,
    serverUrl: normalizeServerUrl(required(record.serverUrl, 'serverUrl'), record.allowInsecureHttp === true),
    sshHost: validateSshHost(required(record.sshHost, 'sshHost')),
    deviceId: required(record.deviceId, 'deviceId'),
    installationId: required(record.installationId, 'installationId'),
    authorityEpoch: required(record.authorityEpoch, 'authorityEpoch'),
    runtimePath: absoluteRuntimePath(required(record.runtimePath, 'runtimePath')),
    installedAt: required(record.installedAt, 'installedAt'),
    allowInsecureHttp: record.allowInsecureHttp === true,
  }
}

export async function writeConfig(path: string, config: CompanionConfig): Promise<void> {
  await atomicPrivateWrite(path, `${JSON.stringify(parseConfig(config), null, 2)}\n`)
}

export async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(content, 'utf8'); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temporary, { force: true }) }
}

export function createInstallationId(): string { return `install_${randomUUID()}` }

export function normalizeServerUrl(value: string, allowInsecureHttp = false): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('server must be an absolute URL') }
  if (url.username || url.password || url.search || url.hash) throw new Error('server URL cannot contain credentials, query, or fragment')
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('server URL must be an origin without a path')
  const loopback = url.hostname === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowInsecureHttp))) {
    throw new Error('server must use HTTPS; HTTP is allowed only for loopback or with --allow-insecure-http')
  }
  return url.origin
}

export function validateSshHost(value: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(value)) {
    throw new Error('ssh-host must be one human SSH alias: letters, digits, dot, underscore or hyphen; start with a letter or digit')
  }
  return value
}

export function absoluteRuntimePath(value: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Node runtime must be an absolute path')
  return value
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 1_024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Companion config ${name} is invalid`)
  return value
}
