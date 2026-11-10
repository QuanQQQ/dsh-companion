import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'

/** Reject paths outside the resolved Task workspace, including symlink escapes. */
export async function resolveWorkdir(workspacePath, workdir) {
  if (!isAbsolute(workspacePath) || !isAbsolute(workdir)) throw new Error('Workspace and workdir must be absolute')
  const [root, target] = await Promise.all([realpath(workspacePath), realpath(workdir)])
  if (!(await stat(root)).isDirectory() || !(await stat(target)).isDirectory()) throw new Error('Workspace and workdir must be directories')
  const rel = relative(root, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Workdir must be inside the Task workspace')
  return target
}

/** Construct a fixed namespace-scoped unit name; never accept a caller-supplied unit. */
export function unitName(namespace, serviceId) {
  if (typeof namespace !== 'string' || !namespace) throw new Error('Missing instance namespace')
  if (typeof serviceId !== 'string' || !/^svc_[0-9a-f-]{36}$/.test(serviceId)) throw new Error('Invalid service id')
  const digest = createHash('sha256').update(JSON.stringify([namespace, serviceId])).digest('hex')
  return `dsh-dev-services-${digest}.service`
}

/** Parse the external create payload without granting Task or execution authority. */
export function parseCreate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected create object')
  const allowed = new Set(['name', 'executable', 'args', 'workdir', 'port', 'protocol'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown field: ${key}`)
  for (const key of ['name', 'executable', 'workdir']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].includes('\0')) throw new Error(`Invalid ${key}`)
  }
  if (input.name.length > 160) throw new Error('Name exceeds 160 characters')
  if (!isAbsolute(input.executable) || !isAbsolute(input.workdir)) throw new Error('Executable and workdir must be absolute')
  if (!Array.isArray(input.args) || input.args.length > 128 || input.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid args')
  if (Buffer.byteLength(JSON.stringify(input)) > 32768) throw new Error('Create payload exceeds 32 KiB')
  if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error('Port must be between 1024 and 65535')
  if (!['http', 'https', 'tcp'].includes(input.protocol)) throw new Error('Invalid protocol')
  return { name: input.name.trim(), executable: input.executable, args: [...input.args], workdir: input.workdir, port: input.port, protocol: input.protocol }
}

/** Authorize against registered Workspace identity, never legacy Task metadata. */
export function authorizeWorkspace(workspace, record, operation) {
  if (!workspace || !isAbsolute(workspace.workspacePath ?? '')) throw new Error('A canonical project Workspace root is required')
  if (record && (!record.workspacePath || record.workspacePath !== workspace.workspacePath)) throw new Error('Service is unclaimed or belongs to another Workspace')
  if ((workspace.status === 'archived' || workspace.archivedAt) && ['create', 'start', 'restart', 'synchronize'].includes(operation)) throw new Error('Archived Workspace cannot launch or publish services')
}

/** Never persist arbitrary exception messages: they may contain argv, env or tokens. */
export function publicError(error, fallback = 'Service operation failed; inspect owned service state') {
  if (error?.code === 'PORT_IN_USE' || error?.code === 'EADDRINUSE') return 'Expected port is already in use; no process was signalled'
  return fallback
}
