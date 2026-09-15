// 直播子代理金额验收配置。
// 跑法(仓库根):
//   npx playwright test -c tests/acceptance/live-subcost-20260913/playwright.config.mjs
//
// 红线:端口只用 harness.mjs 里写死的 6795/6796;HOME 指到 /tmp 临时目录;
// 绝不碰 6677/6689(用户实例)。串行(workers=1):端口只有两个,且两条用例本就该各自独占一份实例。
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: './.artifacts',
  testMatch: /.*\.spec\.mjs$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,           // 验收不重试:抖动本身就是要报的问题
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: undefined, // 由 harness 按端口注入
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
