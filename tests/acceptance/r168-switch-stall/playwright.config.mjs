import { defineConfig } from '@playwright/test';

// 三个项目，各吃各的文件（不用 skip）：api = 只发 HTTP；chromium = chromium.spec + both.spec；webkit = webkit.spec + both.spec。
// 想只跑一个项目：run-isolated.sh --project=chromium
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
    viewport: { width: 1280, height: 900 },
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
  projects: [
    { name: 'api', ...common, testMatch: /api\.spec\.mjs$/, use: { browserName: 'chromium' } },
    { name: 'chromium', ...common, testMatch: /(chromium|both)\.spec\.mjs$/, use: { browserName: 'chromium' } },
    { name: 'webkit', ...common, testMatch: /(webkit|both)\.spec\.mjs$/, use: { browserName: 'webkit' } },
  ],
});
