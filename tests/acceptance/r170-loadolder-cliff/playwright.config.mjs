import { defineConfig } from '@playwright/test';

// 两个项目,各吃各的文件(不用 skip):
//   chromium = both.spec(行为 1、4;即行为 5)
//   webkit   = both.spec + webkit.spec(行为 1–4、6–8)
// 只由 run.sh 调起(它起隔离后端 + Vite 源码直出,并注入 BASE_URL)。串行跑。
const common = { testDir: '.', testIgnore: ['**/.artifacts/**', '**/node_modules/**'] };
export default defineConfig({
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    baseURL: process.env.BASE_URL,
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
    viewport: { width: 1440, height: 900 },
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', ...common, testMatch: /both\.spec\.mjs$/, use: { browserName: 'chromium' } },
    { name: 'webkit', ...common, testMatch: /(webkit|both)\.spec\.mjs$/, use: { browserName: 'webkit' } },
  ],
});
