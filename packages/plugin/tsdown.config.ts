export default [
  {
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    outDir: 'lib',
    clean: false,
    dts: false,
    deps: { neverBundle: [/@deepseek-ai\//, 'cordis'] },
    outputOptions: { entryFileNames: 'host.mjs' },
  },
  {
    name: 'dsh-companion/client',
    entry: { client: 'src/client/index.tsx' },
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    clean: false,
    dts: false,
    deps: { neverBundle: [/@deepseek-ai\/dsh-client-/, 'react', 'react/jsx-runtime'] },
    outputOptions: {
      entryFileNames: 'index.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-companion", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
      footer: 'return exports; } });',
    },
  },
]
