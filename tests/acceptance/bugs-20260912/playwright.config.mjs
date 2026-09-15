import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    baseURL: process.env.BASE_URL,
    // 真机是 macOS 的 WKWebView。T1 的截断缺陷与 T4 的排版代价都跟排版引擎相关，
    // 用 webkit 跑才作数（诊断代理也是这么量的：<pre> 强制回流 11.9~17.9s）。
    browserName: 'webkit',
    headless: true,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
});
