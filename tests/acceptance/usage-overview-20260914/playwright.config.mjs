// UI 层(浏览器)用例的 playwright 配置。只匹配 ui-*.spec.mjs —— usage-cold.spec.mjs 是
// 自己起实例、自己登记结果的普通 node 脚本,被 playwright 当用例跑会打乱它的实例生命周期。
//
// 实例由 spec 自己在 beforeAll 里起(runtime.mjs 的 startInstance,端口取 run-isolated.sh
// 挑好的 USAGE_PORT;resolvePort 里硬拒 6677/6689),跑完在 afterAll 里按 pid 杀。
// 所以这里不配 webServer/baseURL:baseURL 是运行时才知道的。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /(^|\/)ui-.*\.spec\.mjs$/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,          // 含实例启动 + 一次真重扫的等待
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
  use: { headless: true, screenshot: 'off', video: 'off', trace: 'off' },
});
