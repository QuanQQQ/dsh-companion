import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'

/** rc.5 API Peers can be owners too; only the shared browser Peer has browser authority. */
export type CompanionRequestAuthenticator = Pick<HostConnectionHandle, 'admit' | 'browserPeer'>
export type BrowserRejection = 401 | 403 | 503 | undefined

export function ownerBrowserRejection(authentication: CompanionRequestAuthenticator | undefined, request: ConnectionTrustRequest): BrowserRejection {
  if (typeof authentication?.admit !== 'function' || !authentication.browserPeer) return 503
  try {
    const admission = authentication.admit(request)
    if ('rejection' in admission) return admission.rejection === 401 || admission.rejection === 403 ? admission.rejection : 503
    const peer = admission.peer
    if (!peer || !peer.signal || !peer.principal) return 503
    if (peer.signal.aborted || authentication.browserPeer.signal.aborted) return 401
    return peer.id === authentication.browserPeer.id && peer.principal.kind === 'owner' ? undefined : 403
  } catch { return 503 }
}

/** admit applies the carrier's bind-IP, TLS, Host/Origin and Fetch-Metadata fence first.
 * Anonymous trusted requests return 401 and still use their independent Device/poll capability.
 */
export function connectionTrustFence(authentication: CompanionRequestAuthenticator): (request: ConnectionTrustRequest) => boolean {
  return request => {
    if (typeof authentication?.admit !== 'function' || !authentication.browserPeer?.signal || authentication.browserPeer.signal.aborted) throw new Error('Connection trust API unavailable')
    const admission = authentication.admit(request)
    if ('peer' in admission) { if (!admission.peer?.id || !admission.peer.signal || !admission.peer.principal) throw new Error('Connection admission invalid'); return true }
    if (admission.rejection !== 401 && admission.rejection !== 403) throw new Error('Connection trust result invalid')
    return admission.rejection === 401
  }
}
