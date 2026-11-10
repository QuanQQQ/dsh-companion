# DSH Dev Services

Independent project Workspace-scoped Linux development services. This package supplies Host tools and the structural `ctx.get('devServices')` facade; it does not edit Companion, the CLI, root configuration, or PDM.

## Safety and scope

- Requires Node >=22.13, Linux procfs, a usable **systemd user manager**, and Host tools/systemPrompt/sandboxPolicy/workingDirectory. No detached-shell fallback.
- Agent authority is the canonical immutable original `session.header.cwd`, equal to canonical `policy.workspaceRoot`. Effective `workingDirectory.get(session)` may change only within that root. `workspaceRegistry.resolveByPath` is optional and labels only an **exact canonical path** match; parent registrations never extend authority. Ordinary unregistered projects work.
- Fixed service workdir must stay realpath-contained in the original project root and policy root. A moved symlink or root identity is rejected. Launch/restart require freshly resolved `danger-full-access`; restart checks permissions and directory before stopping.
- Units are derived from the persistent instance namespace and random service ID, with an independent ownership token checked against the exact unit description. No caller PID/unit/port killer exists. An unknown owner is never stopped.
- Applications receive only HOME, PATH, LANG, PORT and HOST=127.0.0.1. Environment scrubbing is not a filesystem sandbox; authorized launch has user-level filesystem access.

## Operations and readiness

Nine rc.5 model tools expose create, list, status, start, stop, restart, logs, remove and synchronize. They accept absolute executable and literal args, fixed port 1024–65535, and http/https/tcp. Create does not launch. There is no model claim or owner-browser tool.

Readiness requires both owned TCP socket inode(s) in the verified unit cgroup **and an active IPv4 loopback connection**. A wildcard 0.0.0.0 listener carries an exposure warning. Ready does not mean business HTTP health or Device reachability.

The readiness budget defaults to 30 seconds (configurable to 10 minutes). Timeout, cancellation, unsafe listener, unknown launch result or Host unload **never stop a self-owned process**. Running intent and starting/not_ready are persisted for later status. Only an explicit stop/restart/remove operates the verified owned unit. Host reload does not auto-start or auto-stop units. Transient units may be lost on machine reboot; recovery requires explicit start. Systemd failure restarts have a bounded burst/interval budget.

Safe get/list/status snapshots omit command/argv/env and redact exception transport text. Logs are explicit, at most 500 lines and **64 KiB total including truncation notice**; application logs can still contain secrets. Retired definitions remain port tombstones and cannot be reused by this manager. External programs may still bind a stopped port.

## Facade contract (version 1)

```ts
get(serviceId): Promise<SafeView>
list(): Promise<SafeView[]>
scope(exec): Promise<{ workspaceId: string | null, workspacePath: string, cwd: string }>
authorizeServiceRoot(exec, root): Promise<Scope> // exact canonical original root
agent(operation, args, exec): Promise<SafeView | SafeView[] | string>
ownerBrowser(operation, args, authority): Promise<SafeView | SafeView[] | string>
invoke(operation, args, { kind: 'agent', exec } | { kind: 'owner-browser', ...authority })
```

`ownerBrowser` is an in-process Host capability, **not authentication**. The external Host route must authenticate its human owner, reject Agent impersonation, and pass `explicitCrossWorkspace: true`. Create uses authority `workspacePath` or `workspaceId`; service actions default to their persisted root. Claim requires exactly one explicit `workspace_path` or `workspace_id` in args plus `service_id`. Registered IDs resolve through registry.get; paths may be ordinary unregistered project roots. Claim retains legacyTaskId, claimedAt and claimedBy=owner-browser. Reassignment is not allowed.

Owner start/restart default **fail closed**. They call the optional external `ctx.get('devServicesOperatorApproval').approveLaunch(review, authority)` seam. Review is `{serviceId, workspaceId, workspacePath, configurationDigest}` bound to the immutable launch configuration. Only strict true approves; no model argument or boolean sandbox bypass is accepted. The companion integration supplies authenticated owner-only configuration review and a private proof bound to that request, operation and fresh configuration digest. Standalone deployments must establish equivalent record-bound operator approval or a bound-session policy adapter; this package does not grant one itself.

## Persistence and migration

SQLite v2 is under DSH_HOME/dev-services/services.sqlite (0600). Migration from v1 creates a consistent SQLite backup via VACUUM INTO, validates backup integrity, namespace, every old row and indexed identity, rechecks no live operation or source change, then commits transactionally. Invalid/unsupported schema errors retain the original and report backup location. The old taskId becomes **legacyTaskId only**, with workspaceId and workspacePath null; Task metadata grants no authority. IDs, ownership tokens, desired state and port tombstones are preserved. Only explicit owner claim can assign a root.

## Companion declaration adapter

The optional single Host `ctx.get('companionManagedServices')` v1 capability receives stable `{provider:'dsh-dev-services',namespace,id}` source ownership, workspacePath and optional workspaceId, name, port, protocol and evidence. Only ensure/retire are exposed: no Device selection, Lease, TTL or forwarding preferences. Companion owns forwarding preferences and authorization. Stop preserves declarations and forwarding; remove retires/revokes through the declaration provider, and removalComplete stays false if retirement is unknown. Manually retired declarations never resurrect.

## Verification

`npm test` runs ordinary isolated tests, including temporary self-owned Linux child lifetime, active TCP/inode ownership, v1 migration and Agent/owner scope. `npm run build` copies source modules to package artifacts. Optional `npm run test:systemd` mutates only temporary isolated user units and is **not run in this task**. No PDM, server, shared systemd configuration or Stable restart is used.
