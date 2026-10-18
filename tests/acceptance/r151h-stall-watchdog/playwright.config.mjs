// r151h 静默看门狗与后台任务 —— 验收。只由 run.sh 调起(它建隔离 HOME + 假模型接口;
// 四条用例各起一次性实例,环境变量名沿用一期,以便直接复用一期 helpers/)。
// 串行跑,每个用例自己摆场景,不依赖顺序。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 40_000,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
