import { defineConfig } from '@playwright/test';

// Drives the real Electron app; requires `npm run build` first (see `npm run test:e2e`).
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
});
