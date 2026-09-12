import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { daemonLock } from './daemon-lock.js'
import { companionPaths, readConfig, atomicPrivateWrite } from './config.js'
import { MacKeychain } from './keychain.js'
import { RuntimeStore } from './runtime-state.js'
import { ForwardController } from './controller.js'
import { SshExecutor } from './ssh.js'
import { runControlChannel, connectionDetails, type ConnectionState } from './connection.js'

/** No SSH tunnel is retained after the authenticated control channel is lost. */
export async function runDaemon(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('The Companion daemon requires macOS')
  const paths = companionPaths()
  const config = await readConfig(paths.config)
  const unlock = await daemonLock(join(paths.root, 'daemon.lock'))
  const ssh = new SshExecutor(config.sshHost, paths.controlDirectory)
  try {
    const store = await RuntimeStore.open(paths.runtimeState, config.authorityEpoch)
    const statusFile = join(paths.root, 'daemon-status.json')
    await runControlChannel({ config, controller: new ForwardController(store, ssh),
      previous: await readConnectionState(statusFile, config.deviceId), observations: () => store.observations(),
      readToken: () => new MacKeychain().read(config.deviceId),
      writeStatus: value => atomicPrivateWrite(statusFile, JSON.stringify(value) + '\n'),
    })
  } finally {
    try { await ssh.stopAll() } finally { await unlock() }
  }
}

export async function readConnectionState(path: string, deviceId: string): Promise<ConnectionState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { reconnectAttempts?: unknown; pairingRequired?: unknown; automaticRetryBlocked?: unknown; state?: unknown; deviceId?: unknown }
    if (value.deviceId !== deviceId) throw new Error('Daemon observation belongs to a different Device; use unified launch to recover pairing')
    if (!Number.isSafeInteger(value.reconnectAttempts) || (value.reconnectAttempts as number) < 0) throw new Error('Invalid reconnect state')
    if (value.pairingRequired !== undefined && typeof value.pairingRequired !== 'boolean') throw new Error('Invalid pairing state')
    if (value.automaticRetryBlocked !== undefined && typeof value.automaticRetryBlocked !== 'boolean') throw new Error('Invalid retry policy state')
    // Legacy exhausted counters are diagnostics, not a permanent network-recovery lockout.
    // Older CLIs persisted every LOCAL_ERROR as terminal. A fresh daemon first revalidates
    // and closes owned SSH state in controller.initialize(), so that legacy block is safe to retry.
    const details = connectionDetails(value)
    return { ...details, attempts: value.reconnectAttempts as number, pairingRequired: value.pairingRequired === true || value.state === 'needs_pairing',
      automaticRetryBlocked: value.automaticRetryBlocked === true && details.lastDisconnectReason !== 'LOCAL_ERROR' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { attempts: 0, pairingRequired: false, automaticRetryBlocked: false }
    throw error
  }
}
