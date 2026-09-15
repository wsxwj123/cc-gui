import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // 实例身份预检（指错实例时一句话报错，别等一堆用例报成产品红）：见 global-setup.mjs
  globalSetup: './global-setup.mjs',
  testMatch: /.*\.spec\.mjs$/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    baseURL: process.env.BASE_URL,
    headless: true,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
});
