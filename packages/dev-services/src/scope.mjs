import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { resolveWorkdir } from './spec.mjs'

export async function canonicalRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Absolute project Workspace root required')
  const root = await realpath(path)
  if (!(await stat(root)).isDirectory()) throw new Error('Project Workspace root must be a directory')
  return root
}

/** Registry metadata is a label, never a broader parent permission boundary. */
export async function exactWorkspace(registry, root) {
  const item = await registry?.resolveByPath(root)
  if (!item) return undefined
  if (typeof item.id !== 'string' || typeof item.path !== 'string') throw new Error('Invalid Workspace registry response')
  if (await canonicalRoot(item.path) !== root) return undefined
  return item
}

/** Immutable original cwd AND sandbox root own authority; cd grants nothing. */
export function createScopeResolver({ policyFor, directoryFor, registryFor = () => undefined }) {
  const identities = new WeakMap()
  return async exec => {
    exec?.signal?.throwIfAborted()
    const session = exec?.agent?.session
    if (!session || typeof session !== 'object') throw new Error('A calling Agent session is required')
    const original = session.header?.cwd
    const policy = await policyFor(exec)
    if (!policy?.workspaceRoot) throw new Error('Immutable sandbox Workspace root required')
    const [root, headerRoot] = await Promise.all([canonicalRoot(policy.workspaceRoot), canonicalRoot(original)])
    if (root !== headerRoot) throw new Error('Sandbox root must equal immutable original project cwd')
    const identity = identities.get(session)
    if (identity && (identity.root !== root || identity.original !== original)) throw new Error('Immutable Agent project root changed')
    identities.set(session, { root, original })
    const effective = directoryFor ? await directoryFor(session) : original
    const cwd = await resolveWorkdir(root, effective)
    const registry = registryFor()
    const registered = await exactWorkspace(registry, root)
    exec?.signal?.throwIfAborted()
    return {
      kind: 'agent', id: registered?.id ?? null, workspaceId: registered?.id ?? null,
      workspacePath: root, policyRoot: root, cwd,
      ...(registry?.archivedSessionIds?.includes(session.id) ? { status: 'archived' } : {}),
      policy,
    }
  }
}
