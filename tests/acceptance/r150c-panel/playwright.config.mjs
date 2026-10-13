// r150c 工具面板验收(返工 M1 / S6 / S7 / S8)。只由 run.sh 调起(它负责起隔离实例 + dev server 并注入 R150C_UI_BASE)。
// 真机是 macOS 的 WKWebView,浏览器用 webkit。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    baseURL: process.env.R150C_UI_BASE || undefined,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
