import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS, MIN_LEASE_TTL_MS } from './domain.js'
import { isForwardCloseConfirmed } from './closure.js'
import type { CompanionService } from './service.js'

export const COMPANION_GUIDANCE_SECTION: PromptSection = {
  name: 'dsh-companion:guidance',
  order: 119,
  text: 'Companion service declarations are Host-global even though the compatibility tool names retain the task_ prefix. Registration records an expected devbox loopback service; it never authorizes forwarding. Forwarding requires task_forward_open and an explicitly selected paired Device. Mappings are always Device 127.0.0.1:PORT to devbox 127.0.0.1:PORT with the same port. Use task_forward_close to stop one Lease while retaining its service, or task_service_unregister to retire a service and close all its Device Leases. Neither stops the devbox application. Transient control-channel and SSH failures recover automatically while a Lease remains valid; authentication, Host Key, port conflict, policy, revocation, and expiry require attention. A closed desired state is not proof the listener stopped; task_forward_list reports close_confirmed from a matching-generation observation. The tools do not accept hosts, SSH flags, keys, ProxyCommand, or target aliases.',
}

/** Tool names remain stable for compatibility; all operations target one Host-global registry. */
export function createCompanionTools(service: CompanionService): ToolDefinition[] {
  return [
    defineTool({
      name: 'task_service_register',
      description: 'Register or refresh a Host-global loopback service declaration. The legacy task_ prefix does not scope it to the calling Task. This grants no forwarding permission.',
      parameters: {
        name: { type: 'string', required: true, description: 'Short human-facing service name.' },
        port: { type: 'integer', required: true, description: 'Devbox loopback port, 1-65535.' },
        protocol: { type: 'string', enum: ['http', 'https', 'tcp'], default: 'http', description: 'Application protocol for display and optional probing.' },
        evidence: { type: 'string', description: 'Short evidence that this service was observed, such as a localhost URL from command output.' },
      },
      output: serviceOutput(),
      async execute(args) {
        return presentService(await service.registerService({
          name: args.name,
          port: args.port,
          protocol: args.protocol ?? 'http',
          source: 'agent',
          evidence: args.evidence,
        }))
      },
    }),
    defineTool({
      name: 'task_service_unregister',
      description: 'Unregister one Host-global service and revoke all its Device Forward Leases. Retains close tombstones and diagnostics; does not stop the devbox application.',
      parameters: {
        service_id: { type: 'string', required: true, description: 'Service id from task_forward_list or task_service_register.' },
      },
      output: {
        ...serviceOutput(),
        schema: { ...serviceOutput().schema, properties: {
          ...serviceOutput().schema.properties,
          archived_at: { type: 'string', required: true },
          leases: { type: 'array', required: true, items: leaseOutput().schema },
        } },
      },
      async execute(args) {
        const removed = await service.unregisterService(args.service_id)
        return { ...presentService(removed), archived_at: removed.archivedAt!,
          leases: service.list().leases.filter(lease => lease.serviceId === removed.id).map(presentLease) }
      },
    }),
    defineTool({
      name: 'task_forward_close',
      description: 'Revoke one Forward Lease while retaining its Host-global service declaration. Idempotent; does not stop the devbox application.',
      parameters: {
        lease_id: { type: 'string', required: true, description: 'Forward Lease id from task_forward_list.' },
      },
      output: leaseOutput(),
      async execute(args) { return presentLease(await service.closeLease(args.lease_id)) },
    }),
    defineTool({
      name: 'task_forward_open',
      description: 'Open a TTL-bound same-port loopback Forward Lease for one Host-global service and one explicitly selected paired Device.',
      parameters: {
        service_id: { type: 'string', required: true, description: 'Service id from task_forward_list or task_service_register.' },
        device_id: { type: 'string', required: true, description: 'Explicit paired Device id from task_forward_list. No implicit failover occurs.' },
        ttl_minutes: { type: 'integer', default: DEFAULT_LEASE_TTL_MS / 60_000, description: `Authorization lifetime from ${MIN_LEASE_TTL_MS / 60_000} to ${MAX_LEASE_TTL_MS / 60_000} minutes; defaults to ${DEFAULT_LEASE_TTL_MS / 60_000} (7 days). Existing Leases are not extended.` },
      },
      output: leaseOutput(),
      async execute(args) {
        return presentLease(await service.openLease({
          serviceId: args.service_id,
          deviceId: args.device_id,
          ttlMs: args.ttl_minutes === undefined ? undefined : args.ttl_minutes * 60_000,
        }))
      },
    }),
    defineTool({
      name: 'task_forward_list',
      description: 'List the Host-global service registry, paired Devices, Forward Leases, and accepted Instance observations.',
      parameters: {},
      output: snapshotOutput(),
      async execute() { return presentSnapshot(service) },
    }),
    defineTool({
      name: 'task_forward_restart',
      description: 'Restart one open Forward Lease. This interrupts the listener, preserves Lease id and expiry, and advances fencing generations.',
      parameters: {
        lease_id: { type: 'string', required: true, description: 'Forward Lease id returned by task_forward_list.' },
      },
      output: leaseOutput(),
      async execute(args) { return presentLease(await service.restartLease(args.lease_id)) },
    }),
  ]
}

function presentService(service: ReturnType<CompanionService['list']>['services'][number]) {
  return { id: service.id, name: service.name, port: service.port, protocol: service.protocol, source: service.source }
}

function presentLease(lease: ReturnType<CompanionService['snapshot']>['leases'][number]) {
  return {
    id: lease.id, service_id: lease.serviceId, device_id: lease.deviceId,
    port: lease.localPort, desired_state: lease.desiredState, generation: lease.generation, expires_at: lease.expiresAt,
  }
}

function presentSnapshot(service: CompanionService) {
  const snapshot = service.list()
  return {
    services: snapshot.services.map(presentService),
    devices: snapshot.devices.map(item => ({ id: item.id, name: item.name, online: item.online, revoked: item.revokedAt !== undefined })),
    leases: snapshot.leases.map(lease => {
      const instance = snapshot.instances.find(item => item.leaseId === lease.id && item.generation === lease.generation)
      return {
        ...presentLease(lease),
        instance_state: instance?.generation === lease.generation ? instance.state : 'unconfirmed',
        close_confirmed: isForwardCloseConfirmed(lease, instance),
        ...(instance?.errorCode ? { error_code: instance.errorCode } : {}),
      }
    }),
  }
}

function serviceOutput() {
  return {
    schema: {
      type: 'object' as const, additionalProperties: false, properties: {
        id: { type: 'string' as const, required: true },
        name: { type: 'string' as const, required: true }, port: { type: 'integer' as const, required: true },
        protocol: { type: 'string' as const, required: true }, source: { type: 'string' as const, required: true },
      },
    },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  } as const
}

function leaseOutput() {
  return {
    schema: {
      type: 'object' as const, additionalProperties: false, properties: {
        id: { type: 'string' as const, required: true },
        service_id: { type: 'string' as const, required: true }, device_id: { type: 'string' as const, required: true },
        port: { type: 'integer' as const, required: true }, desired_state: { type: 'string' as const, required: true },
        generation: { type: 'integer' as const, required: true }, expires_at: { type: 'string' as const, required: true },
      },
    },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  } as const
}

function snapshotOutput() {
  return {
    schema: {
      type: 'object' as const, additionalProperties: false, properties: {
        services: { type: 'array' as const, required: true, items: serviceOutput().schema },
        devices: { type: 'array' as const, required: true, items: {
          type: 'object' as const, additionalProperties: false, properties: {
            id: { type: 'string' as const, required: true }, name: { type: 'string' as const, required: true },
            online: { type: 'boolean' as const, required: true }, revoked: { type: 'boolean' as const, required: true },
          },
        } },
        leases: { type: 'array' as const, required: true, items: {
          type: 'object' as const, additionalProperties: false, properties: {
            ...leaseOutput().schema.properties,
            close_confirmed: { type: 'boolean' as const, required: true },
            instance_state: { type: 'string' as const, required: true }, error_code: { type: 'string' as const },
          },
        } },
      },
    },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  } as const
}
