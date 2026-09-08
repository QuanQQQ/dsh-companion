# Restrict forwarding to loopback with identical ports

DSH Companion accepts only mappings from a macOS Device's `127.0.0.1:PORT` to the devbox's `127.0.0.1:PORT`, with the same `PORT` on both ends. Arbitrary hosts, SSH flags, proxy commands, silent port remapping, and edits to Bifrost or operating-system proxy configuration are outside the product boundary. This deliberately trades general tunnel flexibility for a narrow authority surface that an AI tool can request safely and that a user can understand as “make this Task service available on my Mac at the same localhost URL.”
