import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test, { type TestContext } from 'node:test'
import { renderBootstrapScript } from '../src/bootstrap.js'

const exec = promisify(execFile)
const hash = 'a'.repeat(64)

async function fixture(t: TestContext, source = 'console.log("unused")') {
  const root = await mkdtemp(join(tmpdir(), 'companion-bootstrap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const payload = join(root, 'payload.mjs')
  await writeFile(payload, source)
  const uname = join(root, 'uname')
  await writeFile(uname, '#!/bin/sh\nprintf "%s\\n" Darwin\n', { mode: 0o700 })
  const curl = join(root, 'curl')
  await writeFile(curl, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CURL_ARGS"\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = --output ]; then shift; output="$1"; fi\nshift\ndone\n/bin/cp "$PAYLOAD" "$output"\nprintf "%s" "$HTTP_STATUS"\n', { mode: 0o700 })
  const digest = createHash('sha256').update(source).digest('hex')
  const scriptPath = join(root, 'bootstrap.sh')
  // The fixture replaces only OS command paths and terminal input. Native bash,
  // Node URL validation, real shasum and real filesystem cleanup still execute.
  const prepare = async (hash = digest, truncate = false) => {
    let script = renderBootstrapScript(hash)
      .replaceAll('/usr/bin/uname', JSON.stringify(uname))
      .replaceAll('/usr/bin/curl', JSON.stringify(curl))
      .replaceAll('< /dev/tty', '< /dev/null')
    if (truncate) script = script.slice(0, script.indexOf('  artifact='))
    await writeFile(scriptPath, script)
  }
  await prepare()
  const run = (args: string[], http = '200') => exec('/bin/bash', [scriptPath, ...args], {
    env: { ...process.env, TMPDIR: root, PAYLOAD: payload, CURL_ARGS: join(root, 'curl-args'), HTTP_STATUS: http, OUTPUT: join(root, 'launched') }, timeout: 10_000,
  })
  return { root, prepare, run }
}

test('complete bootstrap executes only the verified artifact with canonical arguments and cleans its temp', async t => {
  const f = await fixture(t, 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.OUTPUT, JSON.stringify(process.argv.slice(2)));')
  await f.run(['https://example.test:4433'])
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'launched'), 'utf8')), ['launch', '--server', 'https://example.test:4433'])
  const args = (await readFile(join(f.root, 'curl-args'), 'utf8')).split('\n')
  assert.equal(args[0], '--disable')
  assert.ok(!args.includes('--location'))
  assert.ok(args.includes('--max-filesize'))
  assert.ok(args.includes('https://example.test:4433/api/companion/bootstrap/cli.mjs'))
  assert.ok(!(await readdir(f.root)).some(name => name.startsWith('dsh-companion.')))
})

test('bootstrap rejects redirects or digest mismatches without executing and cleans owned temp', async t => {
  for (const mode of ['redirect', 'digest']) {
    const f = await fixture(t, 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.OUTPUT, "ran");')
    if (mode === 'digest') await f.prepare('0'.repeat(64))
    await assert.rejects(f.run(['https://example.test'], mode === 'redirect' ? '302' : '200'), error => String(error).includes(mode === 'redirect' ? 'HTTP 200' : 'digest mismatch'))
    assert.ok((await readdir(f.root)).includes('curl-args'))
    assert.ok(!(await readdir(f.root)).includes('launched'))
    assert.ok(!(await readdir(f.root)).some(name => name.startsWith('dsh-companion.')))
  }
})

test('bootstrap rejects noncanonical or credential-bearing URLs before download', async t => {
  const f = await fixture(t)
  for (const origin of ['http://example.test', 'https://a:b@example.test', 'https://example.test/', 'https://example.test/path', 'https://example.test?x=1', 'https://example.test#fragment', 'https://EXAMPLE.test', 'https://example.test\n', 'file:///tmp/file']) {
    await assert.rejects(f.run([origin]))
    assert.ok(!(await readdir(f.root)).includes('curl-args'))
  }
})

test('explicit HTTP and literal loopback are allowed, and consent is passed to launch', async t => {
  const f = await fixture(t, 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.OUTPUT, JSON.stringify(process.argv.slice(2)));')
  await f.run(['http://example.test', '--allow-insecure-http'])
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'launched'), 'utf8')), ['launch', '--server', 'http://example.test', '--allow-insecure-http'])
  await f.run(['http://127.0.0.1:3083'])
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'launched'), 'utf8')), ['launch', '--server', 'http://127.0.0.1:3083'])
})

test('a truncated bootstrap function executes no command or download', async t => {
  const f = await fixture(t)
  await f.prepare(undefined, true)
  await assert.rejects(f.run(['https://example.test']))
  assert.ok(!(await readdir(f.root)).includes('curl-args'))
  assert.ok(!(await readdir(f.root)).some(name => name.startsWith('dsh-companion.')))
})


test('the verified CLI exit failure is propagated and its owned temporary directory is removed', async t => {
  const f = await fixture(t, 'process.exit(7)')
  await assert.rejects(f.run(['https://example.test']), error => !!error && typeof error === 'object' && 'code' in error && error.code === 7)
  assert.ok(!(await readdir(f.root)).some(name => name.startsWith('dsh-companion.')))
})

test('the unmodified bootstrap refuses this Linux test environment without downloading', async t => {
  if (process.platform !== 'linux') { t.skip('Native negative platform check is Linux-specific'); return }
  await assert.rejects(exec('/bin/bash', ['-c', renderBootstrapScript(hash), 'bootstrap', 'https://example.test']), /requires macOS/)
})

test('bootstrap accepts only a literal SHA256 and is valid bash syntax', async () => {
  for (const input of ['', 'a'.repeat(63), 'A'.repeat(64), hash + '\n', '$(touch /tmp/untrusted)']) {
    assert.throws(() => renderBootstrapScript(input), /SHA-256/)
  }
  const script = renderBootstrapScript(hash)
  await exec('/bin/bash', ['-n', '-c', script])
  assert.ok(script.includes(hash))
  assert.ok(script.includes('/api/companion/bootstrap/cli.mjs'))
  assert.ok(script.includes('/dev/tty'))
  assert.ok(!script.includes('sudo'))
})
