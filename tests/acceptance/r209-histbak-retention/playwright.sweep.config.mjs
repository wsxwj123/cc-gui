import { defineConfig } from '@playwright/test';

// 第二段:自动清理时间线(a-sweep)。只用文件与日志观测,不开浏览器。后端 B 由 run.sh 在这一段开始前一刻才启动
// (首轮延迟 10 秒、定时间隔 1 秒),所以这一段不能带耗时的 globalSetup。
export default defineConfig({
  testDir: '.',
  testMatch: /(^|\/)a-sweep\.spec\.mjs$/,
  testIgnore: ['**/.artifacts/**', '**/node_modules/**'],
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright-sweep',
});
