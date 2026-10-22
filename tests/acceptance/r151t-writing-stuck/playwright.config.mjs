// r151t 回合结束后的信息事件不应让会话一直"在写" —— 验收。只由 run.sh 调起。
// 全是服务端接口用例(HTTP / SSE / WebSocket / 假命令行记录):不需要页面、vite、浏览器。
// 每条用例各起一次性实例(临时 HOME、自挑端口、用例自己 stop),串行跑,互不依赖。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: process.env.R151T_PW_JSON || '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/playwright',
});
