import { readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, createConnection } from 'node:net'

/** Check a loopback port without retaining the socket; launch must still verify ownership. */
export async function assertPortFree(port) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve)
  })
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

/** Read listening socket identities in the Host network namespace. */
export function parseListeners(text, port) {
  return text.trim().split('\n').slice(1).flatMap(line => {
    const fields = line.trim().split(/\s+/)
    const [address, hexPort] = fields[1]?.split(':') ?? []
    return fields[3] === '0A' && Number.parseInt(hexPort, 16) === port ? [{ address, inode: fields[9] }] : []
  })
}

/** Locate the mounted systemd hierarchy for cgroup v1 or v2. */
export function cgroupDirectory(mountinfo, cgroup) {
  const unescape = value => value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
  const mounts = mountinfo.trim().split('\n').map(line => {
    const [left, right] = line.split(' - ')
    const before = left.split(' '), after = right?.split(' ') ?? []
    return { root: unescape(before[3] ?? ''), path: unescape(before[4] ?? ''), type: after[0], options: after[2] ?? '' }
  })
  const mount = mounts.find(item => item.type === 'cgroup' && item.options.split(',').includes('name=systemd')) ?? mounts.find(item => item.type === 'cgroup2')
  if (!mount || !(mount.root === '/' || cgroup === mount.root || cgroup.startsWith(`${mount.root}/`))) throw new Error('Systemd cgroup hierarchy is not mounted')
  return join(mount.path, mount.root === '/' ? cgroup : cgroup.slice(mount.root.length))
}

async function collectPids(directory) {
  const pids = (await readFile(join(directory, 'cgroup.procs'), 'utf8')).trim().split(/\s+/).filter(Boolean)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) pids.push(...await collectPids(join(directory, entry.name)))
  }
  return pids
}

/** Actively establish TCP, not merely a procfs LISTEN row. Never sends app data. */
export async function connectLoopback(port, timeoutMs = 500) {
  return await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = ok => { if (settled) return; settled = true; socket.destroy(); resolve(ok) }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Dependency hooks permit isolated Linux child tests without shared cgroup writes. */
export async function serviceHealth(record, runtime, options = {}) {
  const read = options.readFile ?? readFile
  const directory = options.readdir ?? readdir
  const link = options.readlink ?? readlink
  const probe = options.connect ?? connectLoopback
  if (!runtime.exists || runtime.state !== 'active') return { state: 'unavailable', reason: 'Process is not active' }
  if (!runtime.cgroup?.startsWith('/') || runtime.cgroup.split('/').includes('..') || !runtime.cgroup.endsWith(`/${runtime.unit}`)) return { state: 'unknown', reason: 'No verified service cgroup' }
  try {
    const [tcp, tcp6] = await Promise.all([read('/proc/net/tcp', 'utf8'), read('/proc/net/tcp6', 'utf8')])
    const listeners = [...parseListeners(tcp, record.port), ...parseListeners(tcp6, record.port)]
    if (!listeners.length) return { state: 'starting', reason: 'Expected listener is absent' }
    const unsupported = listeners.find(socket => !['0100007F', '00000000'].includes(socket.address))
    if (unsupported) return { state: 'unsafe', reason: 'Service port is not reachable through IPv4 loopback' }
    const owned = new Set()
    for (const pid of await (options.collectPids ?? collectPids)(cgroupDirectory(await read('/proc/self/mountinfo', 'utf8'), runtime.cgroup))) {
      try {
        for (const fd of await directory(`/proc/${pid}/fd`)) {
          try {
            const target = await link(`/proc/${pid}/fd/${fd}`)
            const match = /^socket:\[(\d+)\]$/.exec(target)
            if (match) owned.add(match[1])
          } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!listeners.every(socket => owned.has(socket.inode))) return { state: 'unsafe', reason: 'Port listener belongs to another process' }
    if (!await probe(record.port)) return { state: 'not_ready', reason: 'Owned listener did not accept an active loopback TCP connection' }
    // Repeat identity observation after connecting; fail closed on a replacement.
    const [after4, after6] = await Promise.all([read('/proc/net/tcp', 'utf8'), read('/proc/net/tcp6', 'utf8')])
    const after = [...parseListeners(after4, record.port), ...parseListeners(after6, record.port)]
    if (after.length !== listeners.length || !after.every(socket => listeners.some(before => before.inode === socket.inode && before.address === socket.address))) return { state: 'not_ready', reason: 'Listener changed during readiness verification' }
    return listeners.some(socket => socket.address === '00000000')
      ? { state: 'ready', reason: 'Owned wildcard listener observed; application-level health is not probed', warning: 'Service listens on 0.0.0.0 and may be reachable through non-loopback interfaces' }
      : { state: 'ready', reason: 'Owned loopback listener observed; application-level health is not probed' }
  } catch (error) {
    return { state: 'unknown', reason: 'Cannot verify listener ownership' }
  }
}
