import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

export type Operation = 'create' | 'list' | 'status' | 'start' | 'stop' | 'restart' | 'logs' | 'remove' | 'synchronize' | 'claim'
export interface Scope { workspaceId: string | null; workspacePath: string; cwd: string }
export interface LaunchReview { serviceId: string; workspaceId: string | null; workspacePath: string; configurationDigest: string }
export interface OwnerLaunchReview extends LaunchReview { name: string; executable: string; args: string[]; workdir: string; port: number; protocol: 'http' | 'https' | 'tcp' }
export interface OwnerBrowserAuthority {
  /** External Host authentication and explicit cross-project intent are required. */
  explicitCrossWorkspace: true
  workspaceId?: string
  workspacePath?: string
  signal?: AbortSignal
  /** Opaque external approval binding; never a model-supplied bypass boolean. */
  [key: string]: unknown
}
export interface SafeView {
  id: string
  workspaceId: string | null
  workspacePath: string | null
  legacyTaskId?: string
  claimedAt?: string
  claimedBy?: 'owner-browser'
  name: string
  port: number
  protocol: 'http' | 'https' | 'tcp'
  desired: 'stopped' | 'running' | 'removed'
  runtime: { exists?: boolean; unit?: string; state: string; subState?: string; pid?: number; cgroup?: string; result?: string; restarts?: number }
  health: { state: string; reason: string; warning?: string }
  readiness?: { state: 'starting' | 'not_ready' | 'ready'; reason: string }
  companion: { state: string; id?: string; attempted?: boolean; error?: string }
  lastError?: string
  removalComplete: boolean
}
export interface DevServicesFacade {
  readonly version: 1
  get(serviceId: string): Promise<SafeView>
  list(): Promise<SafeView[]>
  /** In-process owner review; contains execution configuration and must not be exposed by Agent tools. */
  reviewLaunch(serviceId: string): Promise<OwnerLaunchReview>
  scope(exec: ToolRunContext): Promise<Scope>
  authorizeServiceRoot(exec: ToolRunContext, root: string): Promise<Scope>
  agent(operation: Exclude<Operation, 'claim'>, args: Record<string, unknown>, exec: ToolRunContext): Promise<SafeView | SafeView[] | string>
  /** External authenticated owner wrapper only. Claim args require explicit workspace_id OR workspace_path. */
  ownerBrowser(operation: Operation, args: Record<string, unknown>, authority: OwnerBrowserAuthority): Promise<SafeView | SafeView[] | string>
  invoke(operation: Operation, args: Record<string, unknown>, authority: { kind: 'agent'; exec: ToolRunContext } | ({ kind: 'owner-browser' } & OwnerBrowserAuthority)): Promise<SafeView | SafeView[] | string>
}
export interface OperatorApproval {
  /** Strict true approves this exact immutable configuration; false/undefined denies. */
  approveLaunch(review: Readonly<LaunchReview>, authority: OwnerBrowserAuthority): boolean | Promise<boolean>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    devServices: DevServicesFacade
    devServicesOperatorApproval: OperatorApproval
  }
}
export const name: 'dev-services'
export const provide: 'devServices'
export const inject: string[]
export const Config: unknown
export function apply(ctx: Context, config: Record<string, number>): void
export function createFacade(options: Record<string, unknown>): DevServicesFacade
export function createTools(options: { facade: DevServicesFacade }): ToolDefinition[]
export function createScopeResolver(options: Record<string, unknown>): (exec: ToolRunContext) => Promise<Scope>
export function companionAdapter(capability: { version: 1; ensure(input: unknown): Promise<unknown>; retire(input: unknown): Promise<unknown> }): unknown
export class ServiceStore { constructor(path: string); readonly namespace: string; readonly path: string; readonly backupPath?: string; list(): Record<string, unknown>[]; get(id: string): Record<string, unknown>; close(): void }
export class SystemdBackend { constructor(namespace: string, options?: Record<string, unknown>) }
export class DevServiceManager { constructor(store: ServiceStore, backend: unknown, options?: Record<string, unknown>) }
