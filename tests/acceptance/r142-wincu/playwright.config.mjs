import { defineConfig } from '@playwright/test';

// r142-wincu:平台分派的验收层。
//   · HTTP 用例与 UI 用例共用一套 runner;
//   · UI 用例跑在 dev server(源码直出,不产 client/dist —— 有别的代理在并行动前端,统一构建会打架),
//     /api、/ws 由 dev server 代理到本套件的隔离实例;
//   · 真机是 macOS 的 WKWebView / Windows 的 WebView2,浏览器一律用 webkit(与既有套件同口径)。
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
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
