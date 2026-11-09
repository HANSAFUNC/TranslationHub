import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@localehub/contracts': resolve(__dirname, '../contracts/src/index.ts'),
      '@localehub/format-adapters': resolve(__dirname, '../format-adapters/src/index.ts'),
    },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
