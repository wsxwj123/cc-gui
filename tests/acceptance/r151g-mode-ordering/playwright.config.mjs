// r151g 用户发消息与切档的先后顺序 + 复用占位 + 收尾 —— 验收。只由 run.sh 调起(它起隔离实例 + 假模型接口 + dev server,
// 并注入 R151B_* 环境变量;环境变量名沿用一期,以便直接复用一期 helpers/)。
// 界面用例(行为 8、9)用共享实例;其余用例各起一次性实例;串行跑,每个用例自己摆场景,不依赖顺序。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 360_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    baseURL: process.env.R151B_UI_BASE || undefined,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 40_000,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
