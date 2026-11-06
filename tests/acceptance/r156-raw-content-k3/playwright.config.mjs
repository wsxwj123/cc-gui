import { defineConfig } from '@playwright/test';

// r156-raw-content-k3 验收:读文件接口 raw=1 的内容隔离头、无 Origin 的自报跨站请求拒绝(K3)、WS 握手内部异常、开发服务器只监听本机。
// 每个用例自己起隔离的后端实例(假家目录在本套件 .artifacts 下),不碰真实 ~/.claude-gui。
// 浏览器用例在用例内自己 launch chromium / webkit,所以这里不设 browserName。
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
