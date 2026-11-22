import { defineConfig } from '@playwright/test';

// 第一段:有页面的用例(b/c/d)。只跑 WebKit(与桌面应用的 WKWebView 同引擎)。后端 A:自动清理被推迟到约 24.8 天后,用例期间不会自己动手。
export default defineConfig({
  testDir: '.',
  testMatch: /(^|\/)[bcd]-[^/]*\.spec\.mjs$/,
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
