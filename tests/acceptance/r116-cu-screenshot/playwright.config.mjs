// r116 界面验收。只由 run.sh 调起(它负责起隔离实例 + dev server 并注入 R116_UI_BASE)。
// 真机是 macOS 的 WKWebView,浏览器用 webkit。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,   // 探路脚本放在 .artifacts 里,不算用例
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    baseURL: process.env.R116_UI_BASE || undefined,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
