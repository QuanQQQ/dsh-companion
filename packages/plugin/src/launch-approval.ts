import type { IncomingMessage } from 'node:http'
import { ownerBrowserRejection, type CompanionRequestAuthenticator } from './owner-browser.js'
import type { DevServicesFacade } from './local-services.js'

type Operation = 'start' | 'restart' | 'launch'
interface PendingApproval {
  serviceId: string
  digest: string
  operation: 'start' | 'restart'
  request: IncomingMessage
  signal: AbortSignal
}

/** A proof is private to one authenticated, explicitly confirmed HTTP operation. */
export class OwnerLaunchApprovals {
  private readonly pending = new WeakMap<object, PendingApproval>()

  constructor(private readonly auth: CompanionRequestAuthenticator | undefined, private readonly devFor: () => DevServicesFacade | undefined) {}

  async approve(input: { serviceId: string; configurationDigest: string; operation: Operation; request: IncomingMessage; signal: AbortSignal }): Promise<{ authority: Record<string, unknown>; release(): void }> {
    input.signal.throwIfAborted()
    if (ownerBrowserRejection(this.auth, input.request) !== undefined) throw new Error('Owner-browser authentication required')
    const dev = this.devFor()
    if (!dev?.reviewLaunch) throw new Error('Service launch review is unavailable')
    const review = await dev.reviewLaunch(input.serviceId)
    if (!input.configurationDigest || review.configurationDigest !== input.configurationDigest) throw new Error('Service configuration changed; review and confirm the command again')
    input.signal.throwIfAborted()
    const proof = Object.freeze({})
    this.pending.set(proof, { serviceId: input.serviceId, digest: input.configurationDigest,
      operation: input.operation === 'launch' ? 'start' : input.operation,
      request: input.request, signal: input.signal })
    return { authority: { operatorLaunchProof: proof, signal: input.signal }, release: () => { this.pending.delete(proof) } }
  }

  approveLaunch(review: Readonly<{ serviceId: string; configurationDigest: string }>, authority: Record<string, unknown>): boolean {
    const proof = authority.operatorLaunchProof
    const approved = proof && typeof proof === 'object' ? this.pending.get(proof) : undefined
    return Boolean(approved && !approved.signal.aborted
      && approved.serviceId === review.serviceId && approved.digest === review.configurationDigest
      && approved.operation === authority.operation
      && ownerBrowserRejection(this.auth, approved.request) === undefined)
  }
}
