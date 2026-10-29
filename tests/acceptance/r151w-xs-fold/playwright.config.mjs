// r151w 跨会话 UI 折叠化验收。只由 run.sh 调起(它起隔离实例 + 假模型接口 + dev server,并注入 R151B_* 环境变量)。
// 所有用例共用一个隔离实例,串行跑;每个用例自己摆场景,不依赖顺序。新行为的断言给较短超时,未实现时尽快失败。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 5_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: process.env.R151W_JSON_OUTPUT || '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    baseURL: process.env.R151B_UI_BASE || undefined,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 8_000,
    navigationTimeout: 40_000,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
