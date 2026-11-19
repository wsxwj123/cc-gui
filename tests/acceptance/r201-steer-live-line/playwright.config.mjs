import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));

// r201l 复现探针:只跑 webkit(与桌面应用的 WKWebView 同引擎)。
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: ['**/.artifacts/**', '**/node_modules/**'],
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 200_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: path.join(suiteDir, '.artifacts', 'results.json') }]],
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
