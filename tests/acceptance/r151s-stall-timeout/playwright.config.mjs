// r151s 静默超时可设置 —— 验收。只由 run.sh 调起(它建隔离 HOME,并起一个共享的隔离实例 + vite dev server 给界面用例用;
// 接口 / 看门狗用例各自起一次性实例)。串行跑,每个用例自己摆场景,不依赖顺序。
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
  reporter: [['list'], ['json', { outputFile: process.env.R151S_PW_JSON || '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    baseURL: process.env.R151S_UI_BASE || undefined,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    // 首次访问 dev server 要冷编译整棵模块图(含 500KB 的 App.jsx),机器忙时可能超过 40s,给足冷启动余量
    navigationTimeout: 60_000,
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
