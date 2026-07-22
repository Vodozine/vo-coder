import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@vo-coder/providers': resolve(import.meta.dirname, '../providers/src/index.ts'),
    },
  },
});
