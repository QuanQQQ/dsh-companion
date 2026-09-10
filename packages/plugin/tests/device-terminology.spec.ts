import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('generic interface and guidance use Device rather than a hardware brand', async () => {
  for (const path of ['../src/client/device-settings.tsx', '../src/client/task-services.tsx', '../src/agent-tools.ts', '../../cli/src/setup.ts']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\bMac\b/, path)
  }
  const settings = await readFile(new URL('../src/client/device-settings.tsx', import.meta.url), 'utf8')
  assert.ok(settings.includes('允许此 Device'))
  assert.ok(settings.includes('待授权的 Device'))
  assert.ok(settings.includes('当前 CLI 支持 macOS'))
  const services = await readFile(new URL('../src/client/task-services.tsx', import.meta.url), 'utf8')
  assert.ok(services.includes('Device 127.0.0.1:'))
})
