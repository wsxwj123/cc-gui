import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  reporter: 'list',
  timeout: 45_000,
  use: {
    headless: true,
    trace: 'retain-on-failure',
  },
});
