import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

// Dev-time DX: alias workspace packages to their TS source so the app
// hot-reloads across packages without a watch-build chain.
const aliases = {
  '@vo-coder/providers': resolve(import.meta.dirname, '../../packages/providers/src/index.ts'),
  '@vo-coder/core': resolve(import.meta.dirname, '../../packages/core/src/index.ts'),
};

export default defineConfig({
  main: {
    // Everything bundles into out/main (all deps are pure JS) so the packaged
    // app needs no node_modules. Data files (seed, templates) ship as
    // extraResources with runtime fallbacks in their loaders.
    resolve: { alias: aliases },
    build: { sourcemap: true },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        ...aliases,
        // Renderer-safe scaffold subset (pure questionnaire/render, no node:fs).
        '@vo-coder/scaffold/core': resolve(
          import.meta.dirname,
          '../../packages/scaffold/src/core.ts',
        ),
        // Renderer-safe DSP (VAD + WAV encoding, no node imports).
        '@vo-coder/voice/dsp': resolve(import.meta.dirname, '../../packages/voice/src/dsp.ts'),
        '@vo-coder/project-config': resolve(
          import.meta.dirname,
          '../../packages/project-config/src/index.ts',
        ),
      },
    },
  },
});
