import { createHash } from 'node:crypto'
import { DevServiceManager } from './manager.mjs'
import { createScopeResolver, canonicalRoot, exactWorkspace } from './scope.mjs'
import { resolveWorkdir } from './spec.mjs'

export const operations = ['create', 'list', 'status', 'start', 'stop', 'restart', 'logs', 'remove', 'synchronize', 'claim']
const createKeys = ['name', 'executable', 'args', 'workdir', 'port', 'protocol']
function validateArgs(operation, args) {
  if (!operations.includes(operation)) throw new Error('Unknown development service operation')
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected operation arguments')
  const keys = operation === 'create' ? createKeys : operation === 'list' ? [] : ['service_id', ...(operation === 'logs' ? ['lines'] : operation === 'claim' ? ['workspace_id', 'workspace_path'] : [])]
  for (const key of Object.keys(args)) if (!keys.includes(key)) throw new Error(`Unknown field: ${key}`)
  if (!['create', 'list'].includes(operation) && (typeof args.service_id !== 'string' || !args.service_id)) throw new Error('Missing service_id')
}

/** Digest permits an external operator gate to bind review to fixed launch config. */
export function launchReview(record) {
  return {
    serviceId: record.id, workspacePath: record.workspacePath, workspaceId: record.workspaceId,
    configurationDigest: createHash('sha256').update(JSON.stringify([record.id, record.workspacePath, record.workdir, record.executable, record.args, record.port, record.protocol])).digest('hex'),
  }
}

/**
 * Structural in-process capability. Host routes MUST authenticate owner-browser
 * and enforce their external operator gate. This is not a model-facing owner API.
 */
export function createFacade({ store, backend, policyFor, directoryFor, registryFor, options = {}, track = fn => fn(), approveLaunch }) {
  const scopeFor = createScopeResolver({ policyFor, directoryFor, registryFor })
  const makeManager = (signal, authorizeLaunch, validateWorkdir) => new DevServiceManager(store, backend, {
    ...options, signal, authorizeLaunch, validateWorkdir,
    companion: options.companionFor ? options.companionFor() : options.companion,
  })
  const dispatch = async (manager, operation, args, scope) => operation === 'create' ? await manager.create(scope, args)
    : operation === 'list' ? await manager.list(scope)
    : operation === 'logs' ? await manager.logs(scope, args.service_id, args.lines)
    : await manager[operation](scope, args.service_id)
  const publicScope = value => ({ workspaceId: value.workspaceId, workspacePath: value.workspacePath, cwd: value.cwd })
  const facade = {
    version: 1,
    get: id => track(() => makeManager().get(id)),
    list: () => track(() => makeManager().list()),
    // In-process owner review only; never included in Agent output or service snapshots.
    reviewLaunch: id => track(() => {
      const record = store.get(id)
      if (record.desired === 'removed') throw new Error('Service is retired')
      return { ...launchReview(record), name: record.name, executable: record.executable,
        args: [...record.args], workdir: record.workdir, port: record.port, protocol: record.protocol }
    }),
    scope: exec => track(async () => publicScope(await scopeFor(exec))),
    authorizeServiceRoot: (exec, root) => track(async () => {
      const scope = await scopeFor(exec)
      if (await canonicalRoot(root) !== scope.workspacePath) throw new Error('Service belongs to another project Workspace')
      return publicScope(scope)
    }),
    agent: (operation, args, exec) => track(async () => {
      validateArgs(operation, args)
      if (operation === 'claim') throw new Error('Agent cannot claim legacy services')
      const scope = await scopeFor(exec)
      const validate = async (_scope, path) => {
        const fresh = await scopeFor(exec)
        if (fresh.workspacePath !== scope.workspacePath) throw new Error('Immutable project scope changed')
        const target = await resolveWorkdir(fresh.policyRoot, path)
        await resolveWorkdir(fresh.workspacePath, target)
        return target
      }
      const authorize = async () => {
        const fresh = await scopeFor(exec)
        if (fresh.policy?.mode !== 'danger-full-access') throw new Error('Independent services require danger-full-access; refusing to bypass the current sandbox')
      }
      return await dispatch(makeManager(exec.signal, authorize, validate), operation, args, scope)
    }),
    ownerBrowser: (operation, args, authority = {}) => track(async () => {
      validateArgs(operation, args)
      if (authority.explicitCrossWorkspace !== true) throw new Error('Owner-browser calls require explicit cross-Workspace intent and external Host authentication')
      let root = authority.workspacePath
      let id = authority.workspaceId
      if (operation === 'claim') {
        if (Number(args.workspace_id !== undefined) + Number(args.workspace_path !== undefined) !== 1) throw new Error('Claim requires exactly one explicit workspace_id or workspace_path')
        id = args.workspace_id
        root = args.workspace_path
      }
      const registry = registryFor?.()
      if (id !== undefined && id !== null) {
        const registered = await registry?.get(id)
        if (!registered) throw new Error('Unknown Workspace registry identity')
        const registeredRoot = await canonicalRoot(registered.path)
        if (root && await canonicalRoot(root) !== registeredRoot) throw new Error('Workspace id and path mismatch')
        root = registeredRoot
      }
      if (!root && args.service_id) {
        const record = store.get(args.service_id)
        root = record.workspacePath
        id = record.workspaceId
      }
      let scope = { kind: 'owner-browser' }
      if (root) {
        root = await canonicalRoot(root)
        const registered = await exactWorkspace(registry, root)
        scope = { kind: 'owner-browser', workspacePath: root, id: registered?.id ?? null }
      }
      const authorize = async () => {
        if (typeof approveLaunch !== 'function') throw new Error('Owner launch requires a separate explicit operator approval; no Agent sandbox bypass is available')
        const record = store.get(args.service_id)
        const review = launchReview(record)
        if (await approveLaunch(Object.freeze(review), { ...authority, operation }) !== true) throw new Error('Owner launch was not explicitly approved for this service configuration')
      }
      return await dispatch(makeManager(authority.signal, authorize), operation, args, scope)
    }),
    invoke(operation, args, authority) {
      if (authority?.kind === 'agent') return facade.agent(operation, args, authority.exec)
      if (authority?.kind === 'owner-browser') return facade.ownerBrowser(operation, args, authority)
      return Promise.reject(new Error('Explicit Agent or owner-browser authority required'))
    },
  }
  return Object.freeze(facade)
}
