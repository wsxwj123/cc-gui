import { defineConfig } from '@playwright/test';

// 两个项目，各吃各的文件（不用 skip）：
//   chromium = both.spec（S01、S02）
//   webkit   = both.spec + webkit.spec（S03~S14）
// 想只跑一个项目：run-isolated.sh --project=webkit
const common = { testDir: '.', testIgnore: ['**/.artifacts/**', '**/node_modules/**'] };
export default defineConfig({
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    baseURL: process.env.BASE_URL,
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 60_000,
    viewport: { width: 1500, height: 1000 },
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [
    { name: 'chromium', ...common, testMatch: /both\.spec\.mjs$/, use: { browserName: 'chromium' } },
    { name: 'webkit', ...common, testMatch: /(webkit|both)\.spec\.mjs$/, use: { browserName: 'webkit' } },
  ],
});
