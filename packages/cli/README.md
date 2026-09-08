# dsh-companion-cli

macOS CLI for the paired DSH Companion Host/Web plugin. Requires external Node.js 22+; this package contains one bundled JavaScript executable, not a notarized native runtime.

```sh
node lib/cli.mjs setup --server https://DSH_HOST --ssh-host YOUR_LOCAL_ALIAS
```

Enter the one-use pairing code from DSH Settings → Companion Devices when prompted. Never pass a pairing secret as an argument. setup copies the fixed bundle into the user Library, stores the Device credential in macOS Keychain via stdin, and registers the user LaunchAgent. It refuses existing/partial installations instead of overwriting them.

Commands: setup/install, daemon, status, restart, uninstall. restart preserves the retry budget. uninstall is local only: revoke the Device in DSH separately. SSH only binds identical ports on literal 127.0.0.1; unknown Host Keys, authentication failure and port conflicts require attention. ProxyJump/ProxyCommand are unsupported. No proxy settings or user SSH configuration are modified.

HTTPS is required except for loopback or explicit --allow-insecure-http test-network consent. Node path must remain installed and executable. Real macOS Keychain, Apple SSH, launchd, crash and sleep/wake acceptance is required before production use; Linux unit and fake-SSH tests are not proof of those behaviors.
