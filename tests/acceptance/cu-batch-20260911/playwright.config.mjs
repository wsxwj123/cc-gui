import { defineConfig } from '@playwright/test';

// No browser is used: the suite drives the ccgui-computer-use MCP over stdio and the
// /api/computer-use/* HTTP surface. Playwright is only the runner/discovery/exit-code layer.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  globalTeardown: './global-teardown.mjs',
  use: {
    baseURL: process.env.BASE_URL,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
});
