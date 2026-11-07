import { defineConfig } from '@playwright/test';

// 浏览器：默认只跑 webkit（与桌面应用的 WKWebView 同引擎）；想加 chromium 对照：R154_BROWSERS=webkit,chromium。
const names = (process.env.R154_BROWSERS || 'webkit').split(',').map((s) => s.trim()).filter(Boolean);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: ['**/.artifacts/**', '**/node_modules/**'],
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  // 单条用例默认 120s；需要更久的用例在自己的 test.setTimeout 里放宽。
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
  projects: names.map((n) => ({ name: n, use: { browserName: n } })),
});
