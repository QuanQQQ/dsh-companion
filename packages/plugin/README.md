# dsh-companion

Host/Web plugin for Host-global localhost forwarding to paired macOS Devices. Better Sidebar integration uses its public `registerTab` API; no sidebar source patch is required.

UI: Better Sidebar → New tab → Local Services; global Settings → Companion Devices. One active Service declaration exists per Host port and is visible from every Session. Registration does not grant forwarding. Select a Device and TTL explicitly to create a Lease. Task or Session lifecycle changes do not close a Lease. Restart preserves expiry and waits for close acknowledgment before a new generation opens.

Requires the DSH Connection `requestRejection` authentication contract (validated in isolated DSH 0.1.2-rc.1), but does not require Task Workspace. Management, enrollment list/approve/deny and the legacy download route require browser authentication. Public bootstrap code and authority identity contain no credentials; public enrollment requests cannot grant trust until a logged-in human approves. Polling is protected by a random one-time delivery capability. Device verification and WSS require Device Bearer credentials. Missing management authentication capability fails closed.

State schema v2 removes Task ownership from Services and Leases. Loading v1 state collapses active Task declarations by port, remaps existing Leases, and durably writes v2. Global HTTP routes live under `/api/companion/snapshot` and `/api/companion/services`; old `/tasks/:taskId/...` routes remain cached-client compatibility aliases and do not scope data. AI tool names retain their `task_` prefix for compatibility only.

The Host continuously retransmits unacknowledged idempotent operations while their Lease remains valid. A new Device Connection Session reporting `starting` or `recovering` receives a fresh fenced Open command because Device session-local enablement is empty after disconnect. Permanent authentication, Host Key, port, policy, revocation and expiry failures remain manual.

The matching CLI is bundled at `lib/companion-cli.mjs`. Settings generates one curl-to-bash command using `/api/companion/bootstrap.sh`; the script verifies the SHA-256 of `/api/companion/bootstrap/cli.mjs` before invoking unified launch. No manual CLI download is required. Pairing persists under `DSH_HOME/companion/state.json`; different test Homes remain separate authorities. CLI requires external Node.js 22+ and macOS; it is not a signed native application. Complete Mac acceptance before production rollout.

Stable DSH changes must use the PDM stable-update queue and idle gate, never direct profile mutation or Host restart.
