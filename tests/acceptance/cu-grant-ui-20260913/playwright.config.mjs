import { defineConfig } from '@playwright/test';

// 两端面共用一套 runner:
//   · HTTP / MCP 用例:只打隔离实例(端口由 run-isolated.sh 挑,硬拒 6677/6689);
//   · UI 用例:浏览器加载 **dev server**(源码直出,不产 client/dist —— 本批禁用统一构建),
//     页面里的 /api、/ws 由 dev server 代理到同一个隔离实例。
//   真机是 macOS 的 WKWebView,所以浏览器用 webkit。
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  // 备份/还原授权真源(写授权的用例会把真实 grants.json 改成测试状态)。
  // run-isolated.sh 自己也会做一遍(见 helpers/grants-cli.mjs)—— 两条路都留着,
  // 因为只押在钩子上会漏(第一版就漏了,把操作者的授权状态留在测试状态里)。
  globalSetup: './global-setup.mjs',
  globalTeardown: './global-teardown.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'webkit',
    headless: true,
    baseURL: process.env.CGUI_TEST_UI_BASE || undefined,
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },
});
