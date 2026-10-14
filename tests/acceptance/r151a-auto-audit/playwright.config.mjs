// r151a 第三方 provider 下的 auto 审计验收。只由 run.sh 调起(它负责起隔离实例 + 假模型接口 + dev server,
// 并注入 R151A_* 环境变量)。真机是 macOS 的 WKWebView,浏览器用 webkit。
// 所有用例共用一个隔离实例(同一个临时 HOME),所以串行跑;每个用例自己摆场景、自己收尾,不依赖顺序。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    baseURL: process.env.R151A_UI_BASE || undefined,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
