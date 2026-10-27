import { build } from 'esbuild'

await build({
  entryPoints: { index: 'src/index.ts', 'typert.host': 'src/remote.ts' },
  outdir: 'lib', platform: 'node', target: 'node22', format: 'esm', bundle: true,
  packages: 'external', sourcemap: true,
})
await build({
  entryPoints: ['src/client.tsx'], outfile: 'lib/client.js',
  platform: 'browser', target: 'es2022', format: 'cjs', bundle: true,
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-plugin-knowra", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
  sourcemap: true,
})
