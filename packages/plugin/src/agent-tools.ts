import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CompanionError } from './domain.js'
import { isForwardCloseConfirmed } from './closure.js'
import type { CompanionService } from './service.js'
import type { TaskWorkspaceResolver, TaskWorkspaceTaskRef } from './task-resolver.js'

export const COMPANION_GUIDANCE_SECTION: PromptSection = {
  name: 'dsh-companion:guidance',
  order: 119,
  text: 'Task Service registration only records a service expected on the current Task devbox loopback port; it never authorizes forwarding. Forwarding requires task_forward_open and a paired Device id. Companion mappings are always Mac 127.0.0.1:PORT to devbox 127.0.0.1:PORT with the same port. Never claim that a Preferred Device grants authority or that recovery migrates a Lease. Use task_forward_close to stop a single Lease while retaining its service, or task_service_unregister to retire a service and close all its Device Leases. Neither stops the devbox application. A closed desired state is not proof of listener shutdown; task_forward_list reports close_confirmed from a matching-generation observation. The tools do not accept hosts, SSH flags, keys, ProxyCommand, or target aliases.',
}

export function createCompanionTools(
  service: CompanionService,
  resolver: TaskWorkspaceResolver,
): ToolDefinition[] {
  return [
    defineTool({
      name: 'task_service_register',
      description: 'Register or refresh a loopback service declaration for the current Task. This does not open forwarding or grant any Device permission.',
      parameters: {
        name: { type: 'string', required: true, description: 'Short human-facing service name.' },
        port: { type: 'integer', required: true, description: 'Devbox loopback port, 1-65535.' },
        protocol: { type: 'string', enum: ['http', 'https', 'tcp'], default: 'http', description: 'Application protocol for display and optional probing.' },
        evidence: { type: 'string', description: 'Short evidence that this service was observed, such as a localhost URL from command output.' },
      },
      output: serviceOutput(),
      async execute(args, exec) {
        const task = await currentTask(resolver, exec)
        const registered = await service.registerTaskService({
          taskId: task.id,
          name: args.name,
          port: args.port,
          protocol: args.protocol ?? 'http',
          source: 'agent',
          evidence: args.evidence,
        })
        return presentService(registered)
      },
    }),
    defineTool({
      name: 'task_service_unregister',
      description: 'Unregister a service in the current Task and revoke ALL of its Device Forward Leases. Retains close tombstones and diagnostics; does not stop the devbox application. Idempotent. Closed desired state is not proof that an offline Device has stopped its listener; use task_forward_list to inspect observations.',
      parameters: {
        service_id: { type: 'string', required: true, description: 'Task Service id from task_forward_list or task_service_register. All associated Device Leases will be closed.' },
      },
      output: {
        ...serviceOutput(),
        schema: { ...serviceOutput().schema, properties: {
          ...serviceOutput().schema.properties,
          archived_at: { type: 'string', required: true },
          leases: { type: 'array', required: true, items: leaseOutput().schema },
        } },
      },
      async execute(args, exec) {
        const task = await currentTask(resolver, exec, true)
        const removed = await service.unregisterTaskService(task.id, args.service_id)
        return { ...presentService(removed), archived_at: removed.archivedAt!,
          leases: service.listTask(task.id).leases.filter(lease => lease.serviceId === removed.id).map(presentLease) }
      },
    }),
    defineTool({
      name: 'task_forward_close',
      description: 'Revoke one Forward Lease in the current Task, retaining its service declaration. Idempotent; does not stop the devbox application. Close delivery may be pending while the Device is offline; inspect task_forward_list before claiming the listener stopped.',
      parameters: {
        lease_id: { type: 'string', required: true, description: 'Forward Lease id from task_forward_list. Only this Lease is closed.' },
      },
      output: leaseOutput(),
      async execute(args, exec) {
        const task = await currentTask(resolver, exec, true)
        return presentLease(await service.closeLease(args.lease_id, 'user', task.id))
      },
    }),
    defineTool({
      name: 'task_forward_open',
      description: 'Open a TTL-bound same-port loopback Forward Lease for one registered service and one explicitly selected paired Device in the current Task.',
      parameters: {
        service_id: { type: 'string', required: true, description: 'Task Service id from task_forward_list or task_service_register.' },
        device_id: { type: 'string', required: true, description: 'Explicit paired Device id from task_forward_list. No implicit failover occurs.' },
        ttl_minutes: { type: 'integer', default: 120, description: 'Authorization lifetime from 1 to 480 minutes; defaults to 120.' },
      },
      output: leaseOutput(),
      async execute(args, exec) {
        const task = await currentTask(resolver, exec)
        const lease = await service.openLease({
          taskId: task.id,
          serviceId: args.service_id,
          deviceId: args.device_id,
          ttlMs: (args.ttl_minutes ?? 120) * 60_000,
        })
        return presentLease(lease)
      },
    }),
    defineTool({
      name: 'task_forward_list',
      description: 'List Task Services, paired Devices, Forward Leases, and accepted Instance observations for the current Task.',
      parameters: {},
      output: snapshotOutput(),
      async execute(_args, exec) {
        const task = await currentTask(resolver, exec, true)
        return presentSnapshot(service, task.id)
      },
    }),
    defineTool({
      name: 'task_forward_restart',
      description: 'Restart one open Forward Lease in the current Task. This interrupts the listener, preserves Lease id and expiry, and advances fencing generations.',
      parameters: {
        lease_id: { type: 'string', required: true, description: 'Forward Lease id returned by task_forward_list.' },
      },
      output: leaseOutput(),
      async execute(args, exec) {
        const task = await currentTask(resolver, exec)
        const owned = service.listTask(task.id).leases.some(lease => lease.id === args.lease_id)
        if (!owned) throw new CompanionError('NOT_FOUND', 'Forward Lease does not belong to the current Task', 404)
        return presentLease(await service.restartLease(args.lease_id))
      },
    }),
  ]
}

async function currentTask(
  resolver: TaskWorkspaceResolver,
  exec: { agent?: { session?: { header?: { cwd?: string } } } },
  allowArchived = false,
): Promise<TaskWorkspaceTaskRef> {
  const cwd = exec.agent?.session?.header?.cwd
  if (!cwd) throw new CompanionError('VALIDATION_ERROR', 'this operation requires a calling Agent with a working directory')
  const task = await resolver.resolveFromCwd(cwd)
  if (!task) throw new CompanionError('VALIDATION_ERROR', 'this operation requires an Agent inside a Task Workspace')
  if (!allowArchived && task.status === 'archived') throw new CompanionError('VALIDATION_ERROR', 'archived Tasks cannot register or forward services')
  return task
}

function presentService(service: ReturnType<CompanionService['listTask']>['services'][number]) {
  return { id: service.id, task_id: service.taskId, name: service.name, port: service.port, protocol: service.protocol, source: service.source }
}

function presentLease(lease: ReturnType<CompanionService['snapshot']>['leases'][number]) {
  return {
    id: lease.id, task_id: lease.taskId, service_id: lease.serviceId, device_id: lease.deviceId,
    port: lease.localPort, desired_state: lease.desiredState, generation: lease.generation, expires_at: lease.expiresAt,
  }
}

function presentSnapshot(service: CompanionService, taskId: string) {
  const snapshot = service.listTask(taskId)
  return {
    task_id: taskId,
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
        id: { type: 'string' as const, required: true }, task_id: { type: 'string' as const, required: true },
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
        id: { type: 'string' as const, required: true }, task_id: { type: 'string' as const, required: true },
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
        task_id: { type: 'string' as const, required: true },
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
