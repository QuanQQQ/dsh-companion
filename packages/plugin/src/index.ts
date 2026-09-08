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
import { createCompanionHttpRoute, type CompanionHttpRoute, type CompanionRequestAuthenticator } from './http-route.js'
import { CompanionService } from './service.js'
import { JsonCompanionStateStore } from './store.js'
import { createTaskWorkspaceResolver } from './task-resolver.js'
import { assertTrustedAuthority } from './trust.js'

export const name = 'dsh-companion'
export const inject = ['webServer', 'webRuntime', 'systemPrompt', 'tools', 'connection']

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
  webRuntime: { trustedHosts: readonly string[] }
  systemPrompt: {
    section(section: PromptSection): () => void
  }
  tools: { register(definition: ToolDefinition): () => void }
  effect(callback: () => void | (() => void), label?: string): unknown
}

export async function apply(ctx: HostContext): Promise<void> {
  const trustedHosts = [...ctx.webRuntime.trustedHosts]
  for (const authority of trustedHosts) assertTrustedAuthority(authority)

  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const stateStore = new JsonCompanionStateStore(join(dshHome, 'companion', 'state.json'))
  const service = await CompanionService.create(stateStore)
  const resolver = createTaskWorkspaceResolver(ctx.webServer.port)
  const hub = new CompanionDeviceHub(service, trustedHosts, undefined, async () => {
    const tasks = await resolver.list()
    await service.reconcileActiveTasks(new Set(tasks.filter(task => task.status !== 'archived').map(task => task.id)))
  })

  ctx.systemPrompt.section(COMPANION_GUIDANCE_SECTION)
  for (const tool of createCompanionTools(service, resolver)) ctx.tools.register(tool)

  ctx.effect(
    () => ctx.webServer.register(createCompanionHttpRoute(service, trustedHosts, undefined, resolver, undefined, ctx.connection)),
    'dsh-companion: Host JSON API',
  )
  ctx.effect(
    () => ctx.webServer.registerUpgrade(hub.route()),
    'dsh-companion: Device WebSocket',
  )

  const reconcile = async (): Promise<void> => {
    try {
      await service.expireLeases()
      const tasks = await resolver.list()
      const activeTaskIds = new Set(tasks.filter(task => task.status !== 'archived').map(task => task.id))
      await service.reconcileActiveTasks(activeTaskIds)
    } catch (error) {
      console.error('dsh-companion: periodic reconciliation failed', error)
    }
  }
  const timer = setInterval(() => void reconcile(), 30_000)
  void reconcile()
  ctx.effect(() => () => {
    clearInterval(timer)
    hub.dispose()
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
export * from './task-resolver.js'
export * from './trust.js'
