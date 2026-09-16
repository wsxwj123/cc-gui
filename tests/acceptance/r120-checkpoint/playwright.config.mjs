// r120 界面验收。真机是 macOS 的 WKWebView;本机没装 playwright 的 webkit 浏览器二进制,
// 而"装浏览器"属于新增依赖,不在本任务范围,因此走系统自带的 Chrome(channel: 'chrome')。
// 只用来判"界面上有没有这个入口/这句话",不量渲染时序,浏览器差异不影响结论。
// 想换回 webkit:`npx playwright install webkit` 后把 browserName 改回 'webkit'、去掉 channel。
export const BROWSER_CHANNEL = 'chrome';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: {
    browserName: 'chromium',
    channel: BROWSER_CHANNEL,
    headless: true,
    baseURL: process.env.R120_UI_BASE || undefined,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'off',
  },
});
