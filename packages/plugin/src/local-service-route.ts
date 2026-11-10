import type { IncomingMessage } from 'node:http'
import { ownerBrowserRejection, type CompanionRequestAuthenticator } from './owner-browser.js'
import type { CompanionHttpRoute } from './http-route.js'
import type { DevServicesFacade, LaunchInput, LocalServicesCoordinator } from './local-services.js'

export interface LocalServiceExecutionGate {
  approve(input: { serviceId: string; configurationDigest: string; operation: 'start' | 'restart' | 'launch'; request: IncomingMessage; signal: AbortSignal }): Promise<{ authority: Record<string, unknown>; release(): void }>
}
const actions = new Set(['create', 'claim', 'status', 'stop', 'restart', 'start', 'logs', 'remove', 'synchronize'])

export function createLocalServiceRoute(coordinator: LocalServicesCoordinator, devFor: () => DevServicesFacade | undefined, auth: CompanionRequestAuthenticator | undefined, executionGate?: LocalServiceExecutionGate): CompanionHttpRoute {
  return { kind: 'prefix', path: '/api/local-services', async handler(req, res) {
    const reply = (status: number, payload: unknown) => {
      if (res.writableEnded) return
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify(payload))
    }
    const denied = () => {
      const status = ownerBrowserRejection(auth, req)
      if (status === undefined) return false
      reply(status, { ok: false, error: { code: status === 503 ? 'AUTH_UNAVAILABLE' : 'FORBIDDEN', message: 'An authorized owner-browser session is required' } })
      return true
    }
    if (denied()) return
    const controller = new AbortController()
    const abort = () => controller.abort()
    const closed = () => { if (!res.writableEnded) abort() }
    req.once('aborted', abort)
    res.once?.('close', closed)
    let approval: Awaited<ReturnType<LocalServiceExecutionGate['approve']>> | undefined
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (req.method === 'GET' && url.pathname === '/api/local-services/snapshot') {
        reply(200, { ok: true, snapshot: await coordinator.snapshot() })
        return
      }
      const dev = devFor()
      if (!dev) throw new Error('Development services are not configured on this Host')
      if (req.method === 'GET' && url.pathname === '/api/local-services/review') {
        const id = url.searchParams.get('service_id')
        if (!id || !dev.reviewLaunch) throw new Error('A service launch review is required')
        const review = await dev.reviewLaunch(id)
        if (denied()) return
        reply(200, { ok: true, review })
        return
      }
      if (req.method !== 'POST') { reply(404, { ok: false, error: { message: 'Not found' } }); return }
      const body = await readBody(req)
      if (denied()) return
      const operation = url.pathname.slice('/api/local-services/'.length)
      let authority: Record<string, unknown> = { explicitCrossWorkspace: true, signal: controller.signal }
      if (operation === 'start' || operation === 'restart' || operation === 'launch') {
        if (!executionGate) {
          reply(503, { ok: false, error: { code: 'EXECUTION_APPROVAL_REQUIRED', message: 'Owner execution approval is unavailable' } })
          return
        }
        approval = await executionGate.approve({ serviceId: String(body.service_id ?? ''), configurationDigest: String(body.configuration_digest ?? ''), operation, request: req, signal: controller.signal })
        authority = { ...authority, ...approval.authority }
        if (denied()) return
        delete body.configuration_digest
      }
      if (operation === 'create') {
        if (typeof body.workspace_path !== 'string' || !body.workspace_path) throw new Error('Select an explicit project directory')
        authority.workspacePath = body.workspace_path
        delete body.workspace_path
      }
      if (operation === 'launch') {
        const allowed = new Set(['service_id', 'device_id', 'ttl_minutes', 'authorize_forward', 'wait_ms'])
        if (Object.keys(body).some(key => !allowed.has(key))) throw new Error('Unknown launch field')
        const input = body as unknown as LaunchInput
        reply(200, { ok: true, result: await coordinator.launch(input, () => dev.ownerBrowser('start', { service_id: input.service_id }, authority), controller.signal) })
      } else if (actions.has(operation)) {
        reply(200, { ok: true, result: await dev.ownerBrowser(operation, body, authority) })
      } else reply(404, { ok: false, error: { message: 'Not found' } })
    } catch (error) {
      reply(400, { ok: false, error: { code: 'LOCAL_SERVICE_ERROR', message: error instanceof Error ? error.message : 'Local service operation failed' } })
    } finally {
      approval?.release()
      req.off('aborted', abort)
      res.off?.('close', closed)
    }
  } }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('JSON body required')
  let bytes = 0
  const parts: Buffer[] = []
  for await (const part of req) {
    const buffer = Buffer.from(part)
    bytes += buffer.length
    if (bytes > 65536) throw new Error('JSON body exceeds 64 KiB')
    parts.push(buffer)
  }
  const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON object required')
  return body as Record<string, unknown>
}
