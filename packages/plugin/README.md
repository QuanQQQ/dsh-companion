# dsh-companion

One Host/Web plugin for Task-scoped localhost forwarding to paired macOS Devices. Better Sidebar integration uses its public registerTab API; no sidebar source patch is required.

UI: Better Sidebar → New tab → Task Services; global Settings → Companion Devices. Service declarations do not grant forwarding. Select a Device and TTL explicitly to create a Lease. Restart preserves expiry and waits for close acknowledgment before a new generation opens.

Requires the Task Workspace public HTTP API and DSH Connection requestRejection authentication contract (validated in isolated DSH 0.1.2-rc.1). Management and CLI download routes require browser authentication. Pairing codes and Device Bearer tokens authenticate Companion traffic independently. Missing authentication capability fails closed.

The matching bundled CLI is included at lib/companion-cli.mjs and downloaded from /api/companion/downloads/cli.mjs after login. CLI requires external Node.js 22+ and macOS; it is not a signed native application. Complete Mac acceptance before production rollout.

Stable DSH changes must use the PDM stable-update queue and idle gate, never direct profile mutation or Host restart.
