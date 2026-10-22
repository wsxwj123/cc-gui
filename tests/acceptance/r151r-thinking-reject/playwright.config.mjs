// r151r 验收:只由 run.sh 调起(它起共享实例 + dev server 并注入 R151B_* 环境)。串行,每个用例自己摆场景。
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: process.env.R151R_PW_JSON || '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/playwright',
  use: { browserName: 'webkit', headless: true, baseURL: process.env.R151B_UI_BASE || undefined, viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000, navigationTimeout: 60_000, screenshot: 'only-on-failure', video: 'off', trace: 'off' },
});
