import { defineConfig } from '@playwright/test';

// 只跑 WebKit(与桌面应用的 WKWebView 同引擎)。
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: ['**/.artifacts/**', '**/node_modules/**'],
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    baseURL: process.env.BASE_URL,
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 60_000,
    viewport: { width: 1280, height: 900 },
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
});
