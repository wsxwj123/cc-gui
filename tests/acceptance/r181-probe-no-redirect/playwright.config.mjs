// r181 验收。只由 run.sh 调起(它负责起共享隔离实例 [+ dev server] 并注入 R181_* 环境变量)。
// WebKit 与 Chromium 各跑一遍页面用例(Windows 的 WebView2 与 Chromium 同源);接口用例只在 WebKit 项目里跑一遍(与浏览器无关)。
import { defineConfig } from '@playwright/test';

const common = { headless: true, baseURL: process.env.R181_UI_BASE || undefined, viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure', video: 'off', trace: 'off' };

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  projects: [
    { name: 'webkit', use: { ...common, browserName: 'webkit' } },
    { name: 'chromium', testMatch: /r181-b-page\.spec\.mjs$/, use: { ...common, browserName: 'chromium' } },
  ],
});
