import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { VERSION } from '../src/version.js'

const source = fileURLToPath(new URL('../src/cli.ts',import.meta.url))
test('CLI entry runs from a symlinked directory, like macOS /var to /private/var', async t => {
  const root = await mkdtemp(join(tmpdir(),'companion-entry-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  // Match the shipped .mjs format when preserving the TS entry's symlink path.
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module'}))
  await symlink(dirname(source),join(root,'alias'),'dir')
  for(const [script,flags] of [[source,[]],[join(root,'alias','cli.ts'),[]],[join(root,'alias','cli.ts'),['--preserve-symlinks-main']]] as [string,string[]][]) {
    const result=spawnSync(process.execPath,[...flags,'--import','tsx',script,'--version'],{encoding:'utf8',timeout:10000})
    assert.equal(result.status,0,result.stderr)
    assert.equal(result.stdout.trim(),'dsh-companion '+VERSION,'CLI must not exit successfully without invoking main')
  }
})

test('importing CLI does not execute it or fail on a non-file argv entry', () => {
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e','await import('+JSON.stringify(pathToFileURL(source).href)+'); console.log("imported")','nonexistent-cli-argument'],{encoding:'utf8',timeout:10000})
  assert.equal(result.status,0,result.stderr)
  assert.equal(result.stdout.trim(),'imported')
})
