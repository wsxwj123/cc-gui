// r64-genui 浏览器验收测试配置。
// 跑法(项目根目录):
//   npx playwright test -c tests/acceptance/r64-genui/browser/playwright.config.js
//   npx playwright test -c tests/acceptance/r64-genui/browser/playwright.config.js b04
//
// 红线:
//  - 测试端口只用 6703-6710(每个 worker 挑一个空的),**绝不碰 6677 生产实例(只许 GET)**。
//  - 每个 worker 自己起后端、自己关干净,HOME 指向 /tmp 临时目录,不碰 ~/.claude 与 ~/.claude-gui。
//  - 因此 workers 上限 8;默认 6,可用 R64_WORKERS=n 覆盖。
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: './.artifacts',   // 失败时的截图/trace 落在本目录下,不脏化仓库根目录
  testMatch: /b\d+-.*\.spec\.js$/,
  // 6 个并发。可用测试端口放宽到 6703-6710 共 8 个,比 worker 多两个,
  // 留给"用例失败后换 worker"的churn,不会再出现端口互相占满。
  // 每个 worker 各起一份后端 + 各用一个临时 HOME,互不干扰。
  workers: Number(process.env.R64_WORKERS || 6),
  // 文件内的用例也分散到各 worker。不开的话 b02 那个 63 条的文件会独占一个 worker
  // 变成关键路径(约 20 分钟),并发就白开了。
  // 前提是用例彼此独立——本套每条自己开页面、自己建会话,worker 之间各有后端和临时 HOME。
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,                 // 验收测试不重试:抖动本身就是要报的问题
  reporter: [['list']],
  timeout: 75_000,          // 首启浮层 + 起后端 + 等锚;45s 会把清浮层的时间算成用例失败
  expect: { timeout: 8_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: undefined,       // 由 app fixture 按 worker 端口注入
    // 单个动作最多等 10s。不设的话点一个不存在的元素会一直等到整条用例超时,
    // 报出来是"Test timeout"而看不出缺的是哪个元素——那会让"等实现的红"和"夹具坏了的红"混在一起。
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    // 桌面尺寸跑除"窄屏"以外的全部
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } }, grepInvert: /窄屏/ },
    // 窄屏那一组只在 390px 视口跑一遍
    { name: 'narrow', use: { viewport: { width: 390, height: 780 } }, grep: /窄屏/ },
  ],
});
