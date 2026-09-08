/** Public code only. The complete function must parse before its final invocation executes. */
export function renderBootstrapScript(cliSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(cliSha256)) throw new Error('A lowercase SHA-256 digest is required')
  // Restore escaped shell parameter expansions after String.raw preserves template escapes.
  return String.raw`#!/bin/bash
dsh_companion_bootstrap() (
  set -eu
  fail() { printf '%s\n' "$1" >&2; exit 1; }
  [ "$#" -ge 1 ] && [ "$#" -le 2 ] || fail 'Usage: bootstrap SERVER_ORIGIN [--allow-insecure-http]'
  server="$1"
  shift
  allow=''
  if [ "$#" -eq 1 ]; then
    [ "$1" = '--allow-insecure-http' ] || fail 'Unknown bootstrap option'
    allow='--allow-insecure-http'
  fi
  [ "$(/usr/bin/uname -s)" = Darwin ] || fail 'DSH Companion requires macOS'
  node_bin="$(command -v node 2>/dev/null)" || fail 'Install Node.js 22+ first; bootstrap does not install runtimes'
  case "$node_bin" in /*) ;; *) fail 'Node.js must resolve to an absolute executable path' ;; esac
  [ -x "$node_bin" ] || fail 'Node.js executable is unavailable'
  server="$("$node_bin" -e '
    const fail = () => { console.error("Canonical HTTPS server origin and Node.js 22+ required (HTTP needs explicit consent or loopback)"); process.exit(1) };
    if (Number(process.versions.node.split(".")[0]) < 22) fail();
    const raw = process.argv[1], insecure = process.argv[2] === "--allow-insecure-http";
    try {
      const url = new URL(raw);
      if (/[\x00-\x20\x7f]/.test(raw) || raw !== url.origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail();
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && (insecure || loopback))) fail();
      process.stdout.write(url.origin);
    } catch { fail() }
  ' -- "$server" "$allow")" || exit 1
  umask 077
  temporary="$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/dsh-companion.XXXXXXXX")" || fail 'Cannot create a private temporary directory'
  trap '/bin/rm -rf -- "$temporary"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  artifact="$temporary/companion.mjs"
  status="$(/usr/bin/curl --disable --fail --silent --show-error --connect-timeout 10 --max-time 120 --max-filesize 8388608 --max-redirs 0 --proto '=http,https' --output "$artifact" --write-out '%{http_code}' "$server/api/companion/bootstrap/cli.mjs")" || fail 'Companion download failed; nothing was installed'
  [ "$status" = 200 ] || fail 'Companion download must return HTTP 200; redirects are not followed'
  "$node_bin" -e 'const n = require("node:fs").statSync(process.argv[1]).size; if (n < 1 || n > 8388608) process.exit(1)' -- "$artifact" || fail 'Companion download has an invalid size'
  digest="$(/usr/bin/shasum -a 256 "$artifact")" || fail 'Cannot verify Companion download'
  digest="\${digest%% *}"
  [ "$digest" = '${cliSha256}' ] || fail 'Companion digest mismatch; nothing was executed'
  if [ -n "$allow" ]; then
    "$node_bin" "$artifact" launch --server "$server" --allow-insecure-http < /dev/tty
  else
    "$node_bin" "$artifact" launch --server "$server" < /dev/tty
  fi
)
dsh_companion_bootstrap "$@"
`.replaceAll('\\${', '${')
}
