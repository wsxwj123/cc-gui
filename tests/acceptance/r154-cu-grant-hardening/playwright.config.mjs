import { defineConfig } from '@playwright/test';

// r154-cu-grant-hardening 验收:HTTP/WS/MCP 面不需要浏览器;面板(U1-U3)用 webkit(与真机 WKWebView 同引擎)。
// 所有被测进程都跑在本套件 .artifacts 下的假家目录里,不碰真实 ~/.claude-gui 与 ~/.claude.json。
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
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: { browserName: 'webkit', headless: true, screenshot: 'off', video: 'off', trace: 'off' },
});
