import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));

// 只有一个项目:webkit(与桌面应用的 WKWebView 同引擎),跑全部 Q 用例。
// json 结果固定写到 .artifacts/results.json(run-isolated.sh 读它打印计数;命令行加 --reporter=… 时也照写)。
process.env.PLAYWRIGHT_JSON_OUTPUT_NAME = path.join(suiteDir, '.artifacts', 'results.json');

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: ['**/.artifacts/**', '**/node_modules/**'],
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['json']],
  outputDir: '.artifacts/playwright',
  use: {
    baseURL: process.env.BASE_URL,
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 60_000,
    viewport: { width: 1280, height: 900 },
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
