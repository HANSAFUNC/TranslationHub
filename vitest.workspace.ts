import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'node',
      include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
      testTimeout: 20000,
    },
  },
  {
    test: {
      name: 'integration',
      environment: 'node',
      setupFiles: ['./vitest.setup.integration.ts'],
      include: ['**/*.integration.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      testTimeout: 120000,
      hookTimeout: 120000,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
