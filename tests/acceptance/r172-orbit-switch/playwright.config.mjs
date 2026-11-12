import { defineConfig } from '@playwright/test';

// 两个项目:webkit 跑全部 11 条行为(与桌面应用的 WKWebView 同引擎);chromium 只加跑行为 1、2、3(Windows 的 WebView2 是 Chromium)。
// 只跑一个内核:  --project=webkit  或  --project=chromium
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: ['**/.artifacts/**', '**/node_modules/**'],
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
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
  projects: [
    { name: 'webkit', use: { browserName: 'webkit' } },
    { name: 'chromium', use: { browserName: 'chromium' }, grep: /行为[123]\s/ },
  ],
});
