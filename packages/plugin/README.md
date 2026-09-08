# dsh-companion

One Host/Web plugin for Task-scoped localhost forwarding to paired macOS Devices. Better Sidebar integration uses its public registerTab API; no sidebar source patch is required.

UI: Better Sidebar → New tab → Task Services; global Settings → Companion Devices. Service declarations do not grant forwarding. Select a Device and TTL explicitly to create a Lease. Restart preserves expiry and waits for close acknowledgment before a new generation opens.

Requires the Task Workspace public HTTP API and DSH Connection requestRejection authentication contract (validated in isolated DSH 0.1.2-rc.1). Management, enrollment list/approve/deny and the legacy download route require browser authentication. Public bootstrap code and authority identity contain no credentials; public enrollment requests cannot grant trust until a logged-in human approves. Polling is protected by a random one-time delivery capability. Device verification and WSS require Device Bearer credentials. Missing management authentication capability fails closed.

The matching CLI is bundled at lib/companion-cli.mjs. Settings generates one curl-to-bash command using /api/companion/bootstrap.sh; the script verifies the SHA-256 of /api/companion/bootstrap/cli.mjs before invoking unified launch. No manual CLI download is required. Pairing persists under DSH_HOME/companion/state.json; different test Homes remain separate authorities. CLI requires external Node.js 22+ and macOS; it is not a signed native application. Complete Mac acceptance before production rollout.

Stable DSH changes must use the PDM stable-update queue and idle gate, never direct profile mutation or Host restart.
