import { defineConfig } from '@playwright/test';

// r155-origin-port-gate 验收:后端对浏览器 Origin 的"站点(主机名+端口)"校验。
// 每个用例自己起隔离的后端实例(假家目录在本套件 .artifacts 下),不碰真实 ~/.claude-gui。
// 浏览器用例(O17-O21)在用例内自己 launch chromium / webkit,所以这里不设 browserName。
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: '**/.artifacts/**',
  globalSetup: './global-setup.mjs',
  globalTeardown: './global-teardown.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.artifacts/results.json' }]],
  outputDir: '.artifacts/playwright',
  use: { headless: true, screenshot: 'off', video: 'off', trace: 'off' },
});
