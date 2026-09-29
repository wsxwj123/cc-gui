// r131 验收。两类用例:
//   api 项目(r131-a / r131-b / r131-d-api):不起浏览器,每条用例自己起/停隔离实例,直调 /api/usage。
//   ui  项目(r131-c / r131-d-ui):webkit 1440×900(真机是 WKWebView),页面来自 run.sh 起的 dev server,/api、/ws 代理到隔离实例。
// 只由 run.sh 调起(它注入 TZ / 数据根 / R131_UI_BASE / R131_API_BASE)。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  projects: [
    ...(process.env.R131_PROBE ? [{ name: 'probe', testMatch: /r131-probe\.spec\.mjs$/, use: { browserName: 'webkit', headless: true, timezoneId: 'Asia/Shanghai', baseURL: process.env.R131_UI_BASE || undefined, viewport: { width: 1440, height: 900 } } }] : []),
    { name: 'api', testMatch: /r131-(a|b|d-api)-.*\.spec\.mjs$/ },
    {
      name: 'ui',
      testMatch: /r131-(c|c9)-.*\.spec\.mjs$/,
      use: {
        browserName: 'webkit', headless: true, timezoneId: 'Asia/Shanghai', locale: 'zh-CN',
        baseURL: process.env.R131_UI_BASE || undefined,
        viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure', video: 'off', trace: 'off',
      },
    },
  ],
});
