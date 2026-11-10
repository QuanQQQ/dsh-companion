import { cp, mkdir, readdir } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
await mkdir(new URL('lib/', root), { recursive: true })
for (const entry of await readdir(new URL('src/', root))) {
  if (entry.endsWith('.mjs') || entry.endsWith('.d.ts')) await cp(new URL(`src/${entry}`, root), new URL(`lib/${entry}`, root))
}
