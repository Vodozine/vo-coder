// Single-file bundle for shipping inside the desktop app as an extraResource.
// The packaged harness spawns it via Electron-as-Node; no node_modules needed.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist-bundle/index.js',
  banner: {
    js: "import { createRequire as __vo_cr } from 'node:module'; const require = __vo_cr(import.meta.url);",
  },
  logLevel: 'warning',
});
console.log('infra-mcp bundled → dist-bundle/index.js');
