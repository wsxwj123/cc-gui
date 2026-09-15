import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  // 默认 90s；两条慢用例（120s 静置 / 60 格拖拽）在自己的 test.setTimeout 里单独放宽。
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    baseURL: process.env.BASE_URL,
    // 真机是 macOS 的 WKWebView。本套件的性能判据（J8/I-122）按 PLAN §10 也要求 WebKit 上跑
    // —— Chromium 的绝对值不能搬到 WKWebView，所以这套默认就用 webkit。
    browserName: 'webkit',
    headless: true,
    viewport: { width: 1180, height: 900 },
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
});
