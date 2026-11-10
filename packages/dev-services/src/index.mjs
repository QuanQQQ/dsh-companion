import { join } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { ServiceStore } from './store.mjs'
import { SystemdBackend } from './systemd.mjs'
import { createTools } from './tools.mjs'
import { createFacade } from './facade.mjs'
import { companionAdapter } from './companion.mjs'

export { ServiceStore, SystemdBackend, createFacade, createTools, companionAdapter }
export { DevServiceManager } from './manager.mjs'
export { createScopeResolver } from './scope.mjs'
export const name = 'dev-services'
export const inject = ['tools', 'systemPrompt', 'sandboxPolicy', 'workingDirectory']
export const provide = 'devServices'
export const Config = z.object({
  startupMs: z.number().step(1).min(1).max(600000).default(30000),
  pollMs: z.number().step(1).min(1).max(600000).default(100),
  restartDelaySeconds: z.number().step(1).min(1).max(3600).default(2),
  restartBurst: z.number().step(1).min(1).max(3600).default(3),
  restartIntervalSeconds: z.number().step(1).min(1).max(3600).default(60),
  stopTimeoutSeconds: z.number().step(1).min(1).max(3600).default(5),
})

/** Host disposal closes operation handles, not independent business service units. */
export function apply(ctx, config) {
  const store = new ServiceStore(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dev-services', 'services.sqlite'))
  const backend = new SystemdBackend(store.namespace, { policy: Object.fromEntries(['restartDelaySeconds', 'restartBurst', 'restartIntervalSeconds', 'stopTimeoutSeconds'].filter(key => config[key] !== undefined).map(key => [key, config[key]])) })
  const lifecycle = new AbortController()
  const pending = new Set()
  let disposed = false
  const track = action => {
    if (disposed) return Promise.reject(new Error('Development service facade is unloading'))
    const operation = Promise.resolve().then(action)
    pending.add(operation)
    void operation.then(() => pending.delete(operation), () => pending.delete(operation))
    return operation
  }
  ctx.effect(() => async () => {
    disposed = true
    lifecycle.abort(new Error('Development service tools unloaded'))
    await Promise.allSettled([...pending])
    store.close()
  }, 'dev-services: close database after in-flight operations')
  const facade = createFacade({
    store, backend, track,
    policyFor: exec => ctx.get('sandboxPolicy')?.resolve({ session: exec.agent.session }),
    directoryFor: session => ctx.get('workingDirectory')?.get(session) ?? session.header.cwd,
    registryFor: () => ctx.get('workspaceRegistry'),
    approveLaunch: (review, authority) => ctx.get('devServicesOperatorApproval')?.approveLaunch(review, authority) ?? false,
    options: { startupMs: config.startupMs, pollMs: config.pollMs, companionFor: () => {
      const capability = ctx.get('companionManagedServices')
      return capability ? companionAdapter(capability) : undefined
    } },
  })
  // Structural ctx service; no direct plugin or CLI dependency or UI endpoints.
  const fused = Object.freeze({ ...facade,
    agent: (operation, args, exec) => facade.agent(operation, args, { ...exec, signal: AbortSignal.any([exec.signal, lifecycle.signal]) }),
    ownerBrowser: (operation, args, authority = {}) => facade.ownerBrowser(operation, args, { ...authority, signal: authority.signal ? AbortSignal.any([authority.signal, lifecycle.signal]) : lifecycle.signal }),
    invoke(operation, args, authority) {
      if (authority?.kind === 'agent') return this.agent(operation, args, authority.exec)
      if (authority?.kind === 'owner-browser') return this.ownerBrowser(operation, args, authority)
      return Promise.reject(new Error('Explicit Agent or owner-browser authority required'))
    },
  })
  ctx.provide('devServices', fused)
  for (const tool of createTools({ facade: fused })) ctx.tools.register(tool)
  ctx.systemPrompt.section({
    name: 'dev-services:guidance', order: 120,
    text: 'Use dev_service_create/start for persistent project business services, not endless bash Jobs. The immutable original project cwd and sandbox workspaceRoot remain the authority boundary even after cd; optional registered Workspace labels match exact canonical paths only. Launch requires danger-full-access. Services are independently owned systemd user transient units and survive Host unload. Readiness timeout or cancellation persists starting/not_ready and NEVER stops a service. Ready requires owned socket inode plus active IPv4 loopback TCP connection; wildcard binding has an exposure warning, not Device reachability. Stop/remove are explicit. Logs are bounded. Companion declarations do not grant Device forwarding. Legacy Task records remain unclaimed until an authenticated owner explicitly claims their canonical root. Retired ports remain reserved. No Agent owner-browser bypass exists.',
  })
}
