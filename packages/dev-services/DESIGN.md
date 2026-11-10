# Development service design

## Independent responsibility

This package owns service specification, project scope, durable SQLite state and owned Linux lifecycle. Companion manages declarations and forwarding permissions; plugin/UI composition and CLI transport remain outside this package. No permanent ctx.jobs job, process-manager daemon, shell-string interpolation or detached Host-owned fallback is introduced.

## Project identity and permission

A canonical project root owns a definition. Workspace registration is an optional exact-root label; taskId is neither identity nor permission. Original session cwd and sandbox policy.workspaceRoot canonicalize to the same immutable directory. A separate effective cwd is contained but never changes authorization. Workdir is resolved at create and again before start/restart; its canonical identity cannot change. A registered parent path is never accepted as the project's registry label.

Agent launch always resolves current policy and requires danger-full-access. Host-owner entrypoints are explicitly separate, require an external authentication guard, and have no automatic execution privilege. Owner launch is denied without a strict external record-bound operator approval. The approval review exposes ID, canonical root and configuration digest, not argv/env. A human review must be bound to the actual fixed definition by that external guard; a standalone caller-controlled boolean is insufficient.

## Signed transient supervision

Per-service systemd user transient units are named by hash(namespace, random service ID), described with a random persisted ownership token. All systemctl mutations first inspect and match the description. KillMode=control-group permits explicit stop to clean the owned tree; restart-on-failure with bounded burst and interval handles crashes. Application executable/args are encoded into one runner payload and run without shell, with controlled env inheritance. No arbitrary PID/port/unit input is exposed. Unknown identity produces an error, never a kill.

The Host owns operation handles, not service lifetime. Timeout, cancellation, Host disposal, missing readiness or uncertain start persists running intent plus starting/not_ready. It never supplies new stopped intent or invokes backend stop as cleanup. A Host shutdown aborts waiting, settles bounded in-flight operations and closes SQLite. Status/get observes without restarting. A stopped definition remains stopped until explicit start.

## Ready evidence

An active unit alone is not ready. Readiness requires a structurally verified unit cgroup, all expected port listener inodes owned by processes in that cgroup, an active TCP connect to 127.0.0.1, and unchanged listener identity after the connect. An owned wildcard listener is allowed with an exposure warning; non-loopback-only or foreign inodes are unsafe. No readiness failure authorizes signaling a foreign PID. Application-level health and Device reachability are independent.

## Durable schema

SQLite v2 stores fixed definition, workspacePath, optional workspaceId, independent unit ownership, desired state, bounded readiness summary, declaration synchronization and port tombstones. Cross-Host operation fences include Linux boot ID and PID start incarnation, protecting against PID reuse. Reads validate durable records before launch or unit use.

v1 migration first snapshots a consistent SQLite backup, validates backup integrity/namespace/indexed identities/records, rejects any live operation, and checks no source change after backup under BEGIN IMMEDIATE. The transaction replaces taskId with legacyTaskId and sets both workspace fields null. Invalid data leaves v1 untouched with an explicit backup error; unsupported versions never downgrade. Legacy records cannot be accessed by Agent even if old task name or workdir happens to match. Owner-only explicit claim validates containment, retains legacyTaskId and records claimedAt/claimedBy. Claim does not launch or silently infer a project.

## Declaration and outputs

The facade and model tools never return command, argv or environment. Snapshot errors are allowlisted summaries; logs are explicit and bounded to 500 lines/64 KiB total. Systemd transport is bounded to 15 seconds and 256 KiB. Long-lived service logs are journal-owned, not continuously injected into model context.

Only the optional single Host companionManagedServices declaration capability is used, with ensure/retire and stable source identity. Sync does not choose Device, authorize Lease, extend TTL or resurrect manually retired declarations. Remove persists removed intent before stop/retirement; unknown retirement remains incomplete. Retired ports are never reassigned, including an offline Device's uncertain close. This cannot prevent external programs from binding stopped ports.

## Tests and task boundary

Ordinary tests use temporary SQLite files and temporary self-owned Linux ChildProcess objects; no shared systemd changes. Transport mocks test exact signed-unit targeting, bounded restart flags and sanitized environment. Opt-in isolated user-unit tests retain actual Host-unit isolation and tree-cleanup scenarios for a separately approved environment. This task runs no PDM, replacement server or Stable restart, and makes no commit.
