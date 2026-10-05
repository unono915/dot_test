import { defineConfig } from 'vitest/config';

// Scale/performance measurements (not part of the regular unit run).
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    environment: 'node',
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
