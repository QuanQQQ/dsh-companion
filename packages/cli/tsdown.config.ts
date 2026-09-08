export default {
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'lib',
  clean: false,
  dts: false,
  deps: { alwaysBundle: ['ws'], neverBundle: [] },
  outputOptions: { inlineDynamicImports: true, entryFileNames: 'cli.mjs', banner: '#!/usr/bin/env node' },
}
