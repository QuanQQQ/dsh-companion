import type { IncomingHttpHeaders } from 'node:http'

export interface TrustFenceRequest {
  headers: IncomingHttpHeaders | Headers
}

export function assertTrustedAuthority(entry: string): void {
  const parsed = parseAuthority(entry)
  if (parsed && canonicalAuthority(entry, parsed) === entry.toLowerCase()) return
  throw new Error(`dsh-companion: trusted host ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

/** Mirrors the DSH Host, Fetch-Metadata, and Origin checks for browser-facing routes. */
export function isTrustedCompanionRequest(request: TrustFenceRequest, trustedHosts: readonly string[]): boolean {
  const hostHeader = header(request.headers, 'host')
  if (!hostHeader) return false
  const host = parseAuthority(hostHeader)
  if (!host) return false
  if (!isLoopbackHostname(host.hostname) && !isTrustedAuthority(host, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      && parsed.pathname === '/' && !parsed.search && !parsed.hash && parsed.host === host.host
  } catch { return false }
}

function header(headers: IncomingHttpHeaders | Headers, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string): URL | undefined {
  if (!authority || /[\s/@?#\\]/.test(authority)) return undefined
  try {
    const parsed = new URL(`http://${authority}`)
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined
    return parsed
  } catch { return undefined }
}

function canonicalAuthority(entry: string, parsed: URL): string {
  const port = parsed.port || new URL(`https://${entry}`).port
  return port ? `${parsed.hostname}:${port}` : parsed.hostname
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isTrustedAuthority(host: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some(entry => {
    const parsed = parseAuthority(entry)
    if (!parsed) return false
    return canonicalAuthority(entry, parsed) === parsed.hostname
      ? parsed.hostname === host.hostname
      : parsed.host === host.host
  })
}
