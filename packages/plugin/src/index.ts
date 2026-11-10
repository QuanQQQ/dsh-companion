import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  COMPANION_GUIDANCE_SECTION,
  createCompanionTools,
} from './agent-tools.js'
import { CompanionDeviceHub } from './device-hub.js'
import { CompanionEnrollmentService } from './enrollment.js'
import { createCompanionHttpRoute, type CompanionHttpRoute, type CompanionRequestAuthenticator } from './http-route.js'
import { CompanionService } from './service.js'
import { JsonCompanionStateStore } from './store.js'
import { isTrustedCompanionRequest } from './trust.js'
import { connectionTrustFence, ownerBrowserRejection } from './owner-browser.js'
import { managedServicesCapability } from './managed-services.js'
import { LocalServicesCoordinator, type DevServicesFacade } from './local-services.js'
import { createLocalServiceRoute } from './local-service-route.js'
import { OwnerLaunchApprovals } from './launch-approval.js'

export const name = 'dsh-companion'
export const inject = ['webServer', 'systemPrompt', 'tools', 'connection']

export interface HostContext {
  connection?: CompanionRequestAuthenticator
  webServer: {
    port: number
    register(route: CompanionHttpRoute): () => void
    registerUpgrade(route: {
      path: string
      handler(req: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>
    }): () => void
  }
  provide(name: string, service: unknown): unknown
  get?(name: string): unknown
  systemPrompt: {
    section(section: PromptSection): () => void
  }
  tools: { register(definition: ToolDefinition): () => void }
  effect(callback: () => void | (() => void), label?: string): unknown
}

export async function apply(ctx: HostContext): Promise<void> {
  const trustedHosts = connectionTrustFence(ctx.connection as CompanionRequestAuthenticator)

  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const stateStore = new JsonCompanionStateStore(join(dshHome, 'companion', 'state.json'))
  let service: CompanionService
  try {
    service = await CompanionService.create(stateStore)
  } catch (error) {
    console.error('dsh-companion: initialization failed; Companion is unavailable, Host remains running', error)
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix', path: '/api/companion',
      async handler(req, res) {
        const rejection = ownerBrowserRejection(ctx.connection, req)
        const status = rejection ?? 503
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: {
          code: status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : 'COMPANION_UNAVAILABLE',
          message: status === 503 ? 'Companion initialization failed. State was preserved; check Host logs.' : 'Access denied',
        } }))
      },
    }), 'dsh-companion: unavailable API')
    return
  }
  ctx.provide('companionManagedServices', managedServicesCapability(service))
  const devFor = () => ctx.get?.('devServices') as DevServicesFacade | undefined
  const approvals = new OwnerLaunchApprovals(ctx.connection, devFor)
  ctx.provide('devServicesOperatorApproval', approvals)
  const coordinator = new LocalServicesCoordinator(service, devFor)
  ctx.effect(() => ctx.webServer.register(createLocalServiceRoute(coordinator, devFor, ctx.connection, approvals)), 'dsh-companion: Local Services API')
  const enrollment = new CompanionEnrollmentService(service)
  const hub = new CompanionDeviceHub(service, trustedHosts, undefined, () => service.expireLeases().then(() => undefined))

  ctx.systemPrompt.section(COMPANION_GUIDANCE_SECTION)
  for (const tool of createCompanionTools(service, async (record, exec) => {
    const dev = devFor()
    if (!record.workspacePath || !dev?.authorizeServiceRoot) throw new Error('Managed service Workspace authority is unavailable')
    await dev.authorizeServiceRoot(exec, record.workspacePath)
  })) ctx.tools.register(tool)

  ctx.effect(
    () => ctx.webServer.register(createCompanionHttpRoute(service, trustedHosts, undefined, undefined, undefined, ctx.connection, enrollment)),
    'dsh-companion: Host JSON API',
  )
  ctx.effect(
    () => ctx.webServer.registerUpgrade(hub.route()),
    'dsh-companion: Device WebSocket',
  )

  const reconcile = async (): Promise<void> => {
    try {
      await service.expireLeases()
    } catch (error) {
      console.error('dsh-companion: periodic reconciliation failed', error)
    }
  }
  const timer = setInterval(() => void reconcile(), 30_000)
  void reconcile()
  ctx.effect(() => () => {
    clearInterval(timer)
    hub.dispose()
    enrollment.dispose()
  }, 'dsh-companion: reconciliation teardown')
}

export default { name, inject, apply }

export * from './agent-tools.js'
export * from './device-hub.js'
export * from './domain.js'
export * from './http-route.js'
export * from './protocol.js'
export * from './service.js'
export * from './store.js'
export * from './trust.js'
