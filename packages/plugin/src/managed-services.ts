import type { RegisteredService } from './domain.js'
import type { CompanionService } from './service.js'

export interface ManagedServiceInput {
  owner: { provider: string; namespace: string; id: string }
  name: string
  port: number
  protocol: 'http' | 'https' | 'tcp'
  evidence?: string | undefined
  workspaceId?: string | undefined
  workspacePath?: string | undefined
}
export interface CompanionManagedServices {
  readonly version: 1
  ensure(input: ManagedServiceInput): Promise<RegisteredService>
  retire(input: ManagedServiceInput): Promise<RegisteredService>
}

/** Declaration-only capability shares the Host's single serialized service and state store. */
export function managedServicesCapability(service: CompanionService): CompanionManagedServices {
  return Object.freeze({ version: 1 as const,
    ensure: (input: ManagedServiceInput) => service.ensureManagedService(input),
    retire: (input: ManagedServiceInput) => service.retireManagedService(input),
  })
}
