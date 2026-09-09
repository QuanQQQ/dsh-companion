import type { ForwardLease, ForwardInstanceObservation } from './domain.js'

export function isForwardCloseConfirmed(
  lease: Pick<ForwardLease, 'desiredState' | 'generation'>,
  instance?: Pick<ForwardInstanceObservation, 'generation' | 'state' | 'sshChild' | 'listener'>,
): boolean {
  return lease.desiredState === 'closed' && instance?.generation === lease.generation
    && instance.state === 'closed' && instance.sshChild === 'exited' && instance.listener === 'missing'
}
