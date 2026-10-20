// r151l 历史消息分页与按需加载 —— 验收。只由 run.sh 调起(它起共享隔离实例 + dev server,
// 并注入 R151L_UI_BASE / R151L_API_BASE;A 组用例自己起一次性实例,不依赖共享实例)。
// 串行跑,每个用例自己摆场景,不依赖顺序。JSON reporter 的落点由 R151L_PW_JSON 覆盖
// (交付要求 .devflow/pw-r151l-step1.json)。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.R151L_PW_JSON || '.artifacts/last-run.json' }],
  ],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    baseURL: process.env.R151L_UI_BASE || undefined,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 40_000,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
