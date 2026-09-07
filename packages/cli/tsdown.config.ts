export default {
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outDir: 'lib',
  clean: false,
  dts: false,
  deps: { neverBundle: [] },
  outputOptions: { entryFileNames: 'cli.mjs', banner: '#!/usr/bin/env node' },
}
