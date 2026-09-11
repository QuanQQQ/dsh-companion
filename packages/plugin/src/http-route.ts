import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { renderBootstrapScript } from './bootstrap.js'
import { CompanionEnrollmentService, EnrollmentError } from './enrollment.js'
import { CompanionError } from './domain.js'
import type { CompanionService } from './service.js'
import { isTrustedCompanionRequest } from './trust.js'

export const COMPANION_API_PREFIX = '/api/companion'
export const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024

/** Structural subset of the public HostConnectionHandle authentication API. */
export interface CompanionRequestAuthenticator {
  requestRejection(request: { headers: Record<string, string | string[] | undefined> }): 401 | 403 | undefined
}

export interface CompanionHttpRoute {
  kind: 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>
}

export function createCompanionHttpRoute(
  service: CompanionService,
  trustedHosts: readonly string[],
  maxBodyBytes = DEFAULT_MAX_JSON_BODY_BYTES,
  _legacyTaskResolver?: unknown,
  cliBundleUrl = new URL('./companion-cli.mjs', import.meta.url),
  authentication?: CompanionRequestAuthenticator,
  enrollment = new CompanionEnrollmentService(service),
): CompanionHttpRoute {
  return {
    kind: 'prefix',
    path: COMPANION_API_PREFIX,
    async handler(req, res) {
      try {
        if (!isTrustedCompanionRequest(req, trustedHosts)) {
          sendError(res, 403, 'FORBIDDEN', 'request authority is not trusted')
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const relative = url.pathname.slice(COMPANION_API_PREFIX.length)
        // Only code, authority identity, and capability-authenticated device enrollment are public.
        // Browser management, including approving enrollment, still requires Host Connection auth.
        const publicRequest = (req.method === 'GET' && ['/bootstrap.sh', '/bootstrap/cli.mjs', '/identity'].includes(relative)) ||
          (req.method === 'POST' && ['/pair', '/enrollments/start', '/enrollments/poll', '/device/verify'].includes(relative))
        if (!publicRequest) {
          if (typeof authentication?.requestRejection !== 'function') {
            sendError(res, 503, 'AUTH_UNAVAILABLE', 'Host Connection authentication API is unavailable')
            return
          }
          const rejection = authentication.requestRejection(req)
          if (rejection !== undefined) {
            if (rejection === 401) sendError(res, 401, 'UNAUTHORIZED', 'Host browser authentication is required')
            else if (rejection === 403) sendError(res, 403, 'FORBIDDEN', 'Host Connection rejected this request')
            else sendError(res, 503, 'AUTH_UNAVAILABLE', 'Host Connection authentication result is invalid')
            return
          }
        }

        if (req.method === 'GET' && relative === '/identity') {
          sendJson(res, 200, { ok: true, authorityEpoch: service.authorityEpoch })
          return
        }
        if (req.method === 'GET' && ['/downloads/cli.mjs', '/bootstrap/cli.mjs', '/bootstrap.sh'].includes(relative)) {
          let bundle: Buffer
          try { bundle = await readFile(cliBundleUrl) }
          catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
              sendError(res, 503, 'CLI_NOT_PACKAGED', 'Companion CLI bundle is not packaged on this Host')
              return
            }
            throw error
          }
          if (relative === '/bootstrap.sh') {
            const script = renderBootstrapScript(createHash('sha256').update(bundle).digest('hex'))
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
            res.end(script)
            return
          }
          res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-disposition': 'attachment; filename="dsh-companion.mjs"',
            'content-length': bundle.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(bundle)
          return
        }
        if (req.method === 'GET' && relative === '/enrollments') {
          sendJson(res, 200, { ok: true, requests: enrollment.list() })
          return
        }
        if (req.method === 'POST' && relative === '/device/verify') {
          const authorization = req.headers.authorization
          if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization)) {
            sendError(res, 401, 'UNAUTHORIZED', 'Device credential required')
            return
          }
          const device = service.authenticateDevice(authorization.slice(7))
          sendJson(res, 200, { ok: true, deviceId: device.id, authorityEpoch: service.authorityEpoch })
          return
        }
        if (req.method === 'GET' && relative === '/devices') {
          sendJson(res, 200, { ok: true, devices: service.listDevices() })
          return
        }
        if (req.method === 'GET' && relative === '/snapshot') {
          sendJson(res, 200, { ok: true, snapshot: service.list() })
          return
        }
        const taskMatch = /^\/tasks\/([^/]+)$/.exec(relative)
        if (req.method === 'GET' && taskMatch) {
          // Compatibility endpoint for cached clients; the requested Task no longer scopes data.
          sendJson(res, 200, { ok: true, snapshot: { ...service.list(), taskId: decodeRouteId(taskMatch[1]) } })
          return
        }
        if (req.method !== 'POST') {
          sendError(res, 404, 'NOT_FOUND', 'endpoint not found')
          return
        }
        const body = await readJsonObject(req, maxBodyBytes)

        if (relative === '/enrollments/start') {
          const request = enrollment.start({
            installationId: requiredString(body.installationId, 'installationId'), name: requiredString(body.name, 'name'),
            osVersion: requiredString(body.osVersion, 'osVersion'), architecture: requiredString(body.architecture, 'architecture'),
            companionVersion: requiredString(body.companionVersion, 'companionVersion'),
          })
          sendJson(res, 201, { ok: true, request })
          return
        }
        if (relative === '/enrollments/poll') {
          sendJson(res, 200, { ok: true, ...enrollment.poll({requestId:requiredString(body.requestId, 'requestId'), pollToken:requiredString(body.pollToken, 'pollToken')}) })
          return
        }
        const enrollmentAction = /^\/enrollments\/([^/]+)\/(approve|deny)$/.exec(relative)
        if (enrollmentAction) {
          const id = decodeRouteId(enrollmentAction[1])
          const request = enrollmentAction[2] === 'approve' ? await enrollment.approve(id) : await enrollment.deny(id)
          sendJson(res, 200, { ok: true, request })
          return
        }
        if (relative === '/pairings') {
          const ticket = await service.createPairingTicket(optionalInteger(body.ttlMs, 'ttlMs'))
          sendJson(res, 201, { ok: true, ticket })
          return
        }
        if (relative === '/pair') {
          const paired = await service.pairDevice({
            code: requiredString(body.code, 'code'),
            installationId: requiredString(body.installationId, 'installationId'),
            name: requiredString(body.name, 'name'),
            osVersion: requiredString(body.osVersion, 'osVersion'),
            architecture: requiredString(body.architecture, 'architecture'),
            companionVersion: requiredString(body.companionVersion, 'companionVersion'),
            capabilities: requireCapabilities(body.capabilities),
          })
          sendJson(res, 201, { ok: true, ...paired })
          return
        }

        const revokeMatch = /^\/devices\/([^/]+)\/revoke$/.exec(relative)
        if (revokeMatch) {
          sendJson(res, 200, { ok: true, device: await service.revokeDevice(decodeRouteId(revokeMatch[1])) })
          return
        }
        const legacyServiceMatch = /^\/tasks\/([^/]+)\/services$/.exec(relative)
        if (relative === '/services' || legacyServiceMatch) {
          if (legacyServiceMatch) decodeRouteId(legacyServiceMatch[1])
          const registered = await service.registerService({
            name: requiredString(body.name, 'name'),
            port: requiredInteger(body.port, 'port'),
            protocol: requireProtocol(body.protocol),
            source: 'manual',
            evidence: optionalString(body.evidence, 'evidence'),
          })
          sendJson(res, 201, { ok: true, service: registered })
          return
        }
        const unregisterMatch = /^\/services\/([^/]+)\/unregister$/.exec(relative)
        const legacyUnregisterMatch = /^\/tasks\/([^/]+)\/services\/([^/]+)\/unregister$/.exec(relative)
        if (unregisterMatch || legacyUnregisterMatch) {
          if (legacyUnregisterMatch) decodeRouteId(legacyUnregisterMatch[1])
          const removed = await service.unregisterService(decodeRouteId(unregisterMatch?.[1] ?? legacyUnregisterMatch?.[2]))
          sendJson(res, 200, { ok: true, service: removed,
            leases: service.list().leases.filter(lease => lease.serviceId === removed.id) })
          return
        }
        const openMatch = /^\/services\/([^/]+)\/leases$/.exec(relative)
        const legacyOpenMatch = /^\/tasks\/([^/]+)\/services\/([^/]+)\/leases$/.exec(relative)
        if (openMatch || legacyOpenMatch) {
          if (legacyOpenMatch) decodeRouteId(legacyOpenMatch[1])
          const lease = await service.openLease({
            serviceId: decodeRouteId(openMatch?.[1] ?? legacyOpenMatch?.[2]),
            deviceId: requiredString(body.deviceId, 'deviceId'),
            ttlMs: optionalInteger(body.ttlMs, 'ttlMs'),
          })
          sendJson(res, 201, { ok: true, lease })
          return
        }
        const leaseActionMatch = /^\/leases\/([^/]+)\/(close|restart|recheck)$/.exec(relative)
        if (leaseActionMatch) {
          const leaseId = decodeRouteId(leaseActionMatch[1])
          const action = leaseActionMatch[2]
          const lease = action === 'close'
            ? await service.closeLease(leaseId)
            : action === 'restart'
              ? await service.restartLease(leaseId)
              : await service.recheckLease(leaseId)
          sendJson(res, 200, { ok: true, lease })
          return
        }
        sendError(res, 404, 'NOT_FOUND', 'endpoint not found')
      } catch (error) {
        if (error instanceof BodyError) sendError(res, error.status, error.code, error.message)
        else if (error instanceof CompanionError || error instanceof EnrollmentError) sendError(res, error.status, error.code, error.message)
        else {
          console.error('dsh-companion: HTTP request failed', error)
          sendError(res, 500, 'INTERNAL_ERROR', 'Companion request failed')
        }
      }
    },
  }
}

async function readJsonObject(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') throw new BodyError(415, 'UNSUPPORTED_MEDIA_TYPE', 'content type must be application/json')
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new BodyError(400, 'INVALID_BODY', 'invalid content-length')
    if (parsed > maxBodyBytes) { req.resume(); throw new BodyError(413, 'BODY_TOO_LARGE', 'JSON body is too large') }
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += buffer.byteLength
    if (received > maxBodyBytes) { req.resume(); throw new BodyError(413, 'BODY_TOO_LARGE', 'JSON body is too large') }
    chunks.push(buffer)
  }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new BodyError(400, 'INVALID_JSON', 'body is not valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BodyError(400, 'INVALID_BODY', 'JSON body must be an object')
  return parsed as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

function decodeRouteId(value: string | undefined): string {
  if (!value) throw new BodyError(400, 'VALIDATION_ERROR', 'route id is missing')
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { throw new BodyError(400, 'VALIDATION_ERROR', 'route id has invalid encoding') }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(decoded)) throw new BodyError(400, 'VALIDATION_ERROR', 'route id is invalid')
  return decoded
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new BodyError(400, 'VALIDATION_ERROR', `${field} is required`)
  return value
}
function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field)
}
function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new BodyError(400, 'VALIDATION_ERROR', `${field} must be an integer`)
  return value as number
}
function optionalInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, field)
}
function requireProtocol(value: unknown): 'http' | 'https' | 'tcp' {
  if (value !== 'http' && value !== 'https' && value !== 'tcp') throw new BodyError(400, 'VALIDATION_ERROR', 'protocol is invalid')
  return value
}
function requireCapabilities(value: unknown): { protocolVersion: 1; localForward: true; tcpProbe: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BodyError(400, 'VALIDATION_ERROR', 'capabilities are invalid')
  const record = value as Record<string, unknown>
  if (record.protocolVersion !== 1 || record.localForward !== true || typeof record.tcpProbe !== 'boolean') {
    throw new BodyError(400, 'VALIDATION_ERROR', 'capabilities are invalid')
  }
  return { protocolVersion: 1, localForward: true, tcpProbe: record.tcpProbe }
}

class BodyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
