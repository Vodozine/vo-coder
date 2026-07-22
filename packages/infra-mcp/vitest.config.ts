import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@vo-coder/project-config': resolve(import.meta.dirname, '../project-config/src/index.ts'),
    },
  },
});
