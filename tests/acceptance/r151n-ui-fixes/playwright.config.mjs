// r151n 分屏图标化 / 粘贴乱码还原 —— 验收。只由 run.sh 调起(它起隔离实例 + dev server,
// 并注入 R151N_UI_BASE / R151N_API_BASE / R151N_SEED_FILE)。串行跑,每个用例自己摆场景。
// JSON reporter 的落点由 R151N_PW_JSON 覆盖(交付要求 .devflow/pw-r151n.json)。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.R151N_PW_JSON || '.artifacts/last-run.json' }],
  ],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    baseURL: process.env.R151N_UI_BASE || undefined,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 40_000,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
