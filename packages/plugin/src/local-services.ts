import { setTimeout as delay } from 'node:timers/promises'
import { assertTtl, DEFAULT_LEASE_TTL_MS, type CompanionSnapshot, type ForwardLease, type RegisteredService } from './domain.js'
import { forwardStatus, type ForwardPhase } from './forward-status.js'
import type { CompanionService } from './service.js'

export interface DevServiceView {
  id:string; name:string; port:number; protocol:'http'|'https'|'tcp'; desired:string
  workspaceId?:string; workspacePath?:string; legacyTaskId?:string
  health:{state:string;reason?:string;warning?:string}; runtime:{state:string;exists?:boolean}
  companion:{state:string;id?:string}; removalComplete:boolean; lastError?:string
}
export interface DevServicesFacade {
  version:1
  get(serviceId:string):Promise<DevServiceView>
  list():Promise<DevServiceView[]>
  reviewLaunch?(serviceId:string):Promise<OwnerLaunchReview>
  authorizeServiceRoot?(exec:unknown, root:string):Promise<unknown>
  agent(operation:string,args:Record<string,unknown>,exec:unknown):Promise<unknown>
  ownerBrowser(operation:string,args:Record<string,unknown>,authority:Record<string,unknown>):Promise<unknown>
}
export interface OwnerLaunchReview {
  serviceId:string; workspaceId:string|null; workspacePath:string|null; configurationDigest:string
  name:string; executable:string; args:string[]; workdir:string; port:number; protocol:'http'|'https'|'tcp'
}
export interface LaunchInput {service_id:string;device_id?:string;ttl_minutes?:number;authorize_forward?:boolean;wait_ms?:number}
export interface LaunchResult {phase:ForwardPhase|'starting'|'linux_error'|'companion_unavailable'|'authorization_required'; linux:DevServiceView;lease?:ForwardLease;applicationReadiness:'unknown'; message?:string}

/** Composition is deliberately outside the SQLite operation lock; Device waits cannot block Linux control. */
export class LocalServicesCoordinator {
  constructor(readonly companion:CompanionService, readonly devFor:()=>DevServicesFacade|undefined, private now=Date.now) {}
  async snapshot():Promise<{linux:DevServiceView[];companion:CompanionSnapshot}> {
    const dev=this.devFor()
    return {linux:dev?await dev.list():[],companion:this.companion.list()}
  }
  async launch(input:LaunchInput, launchLinux:()=>Promise<unknown>, signal?:AbortSignal):Promise<LaunchResult> {
    const dev=this.devFor();if(!dev)throw Error('Linux development service capability unavailable')
    if(!Number.isSafeInteger(input.wait_ms??10000)||(input.wait_ms??10000)<0||(input.wait_ms??10000)>30000)throw Error('wait_ms must be 0–30000')
    signal?.throwIfAborted()
    await launchLinux()
    signal?.throwIfAborted()
    const linux=await dev.get(input.service_id)
    signal?.throwIfAborted()
    const result=(phase:LaunchResult['phase'],message?:string,lease?:ForwardLease):LaunchResult=>({phase,linux,applicationReadiness:'unknown',...(message?{message}:{}),...(lease?{lease}:{})})
    if(linux.health.state!=='ready')return result(['failed','unsafe'].includes(linux.health.state)||linux.runtime.state==='failed'?'linux_error':'starting')
    if(linux.companion.state!=='synced'||!linux.companion.id)return result('companion_unavailable')
    const state=this.companion.list(),service=state.services.find(s=>s.id===linux.companion.id)
    if(!service)return result('companion_unavailable')
    const devices=state.devices.filter(d=>!d.revokedAt)
    if(!devices.length)return result('setup_required')
    const deviceId=input.device_id??service.preferredDeviceId
    if(!deviceId)return result('device_selection_required')
    const device=devices.find(d=>d.id===deviceId)
    if(!device)return result('device_selection_required','Saved Device is revoked or unavailable; explicitly choose another')
    const ttlMs=input.ttl_minutes===undefined?service.preferredTtlMs??DEFAULT_LEASE_TTL_MS:input.ttl_minutes*60000
    assertTtl(ttlMs)
    let lease=state.leases.filter(l=>l.serviceId===service.id&&l.deviceId===device.id).at(-1)
    const existing=lease?.desiredState==='open'&&Date.parse(lease.expiresAt)>this.now()
    // A saved selection is not standing permission to reopen a manually closed Lease.
    if(!existing && input.authorize_forward!==true)return result('authorization_required','Explicit TTL-bound authorization is required to open or reopen forwarding')
    if(!existing && (!input.device_id && !service.preferredDeviceId))return result('device_selection_required')
    signal?.throwIfAborted()
    if(!existing)lease=await this.companion.openLease({serviceId:service.id,deviceId:device.id,ttlMs})
    signal?.throwIfAborted()
    if(input.authorize_forward===true&&input.device_id)await this.companion.saveForwardPreference(service.id,device.id,ttlMs)
    const deadline=this.now()+(input.wait_ms??10000)
    while(true){
      signal?.throwIfAborted()
      const snapshot=this.companion.list(),current=snapshot.leases.find(l=>l.id===lease!.id)!
      const instance=snapshot.instances.find(i=>i.leaseId===current.id)
      const status=forwardStatus(current,snapshot.devices.find(d=>d.id===current.deviceId),instance,this.now())
      if(status.phase!=='waiting_for_mac'||this.now()>=deadline)return result(status.phase,undefined,current)
      await delay(Math.min(100,Math.max(1,deadline-this.now())),undefined,{signal})
    }
  }
}
