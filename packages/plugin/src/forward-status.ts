import type { ForwardInstanceObservation, ForwardLease, PublicDevice } from './domain.js'
import { isForwardCloseConfirmed } from './closure.js'
export const MAX_OBSERVATION_AGE_MS = 30_000

export function freshTransportObservation(instance: ForwardInstanceObservation | undefined, now = Date.now()): boolean {
  if (!instance?.sampledAt || !Number.isSafeInteger(instance.probeAgeMs) || instance.probeAgeMs! < 0) return false
  const receivedAge = now - Date.parse(instance.observedAt)
  return Number.isFinite(receivedAge) && receivedAge >= 0 && receivedAge + instance.probeAgeMs! <= MAX_OBSERVATION_AGE_MS
}
export type ForwardPhase = 'setup_required' | 'device_selection_required' | 'device_offline' | 'waiting_for_mac' | 'forwarding_error' | 'probe_unsupported' | 'ready' | 'closed' | 'closing'
export function forwardStatus(lease: ForwardLease, device: PublicDevice | undefined, instance: ForwardInstanceObservation | undefined, now = Date.now()): {phase:ForwardPhase; closeConfirmed:boolean; applicationReadiness:'unknown'} {
  const same = instance?.deviceId === lease.deviceId && instance.leaseId === lease.id && instance.generation === lease.generation
  const fresh = same && freshTransportObservation(instance,now)
  const online = !!device?.online && !device.revokedAt
  const closeConfirmed = online && fresh && isForwardCloseConfirmed(lease,instance)
  if (lease.desiredState === 'closed') return {phase:closeConfirmed?'closed':'closing',closeConfirmed,applicationReadiness:'unknown'}
  if (!online) return {phase:'device_offline',closeConfirmed:false,applicationReadiness:'unknown'}
  if (Date.parse(lease.expiresAt)<=now) return {phase:'closing',closeConfirmed:false,applicationReadiness:'unknown'}
  if (same && fresh && (instance?.state==='needs_attention' || instance?.remoteProbe==='failed')) return {phase:'forwarding_error',closeConfirmed:false,applicationReadiness:'unknown'}
  if (same && instance?.state==='running' && (instance.remoteProbe==='disabled' || !instance.sampledAt || instance.probeAgeMs===undefined)) return {phase:'probe_unsupported',closeConfirmed:false,applicationReadiness:'unknown'}
  return {phase:fresh && instance?.state==='running' && instance.sshChild==='running' && instance.listener==='owned' && instance.remoteProbe==='healthy' ? 'ready':'waiting_for_mac',closeConfirmed:false,applicationReadiness:'unknown'}
}
