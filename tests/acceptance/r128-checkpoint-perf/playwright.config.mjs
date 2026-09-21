// r128 验收(接口层,不起浏览器、不起 dev server)。只由 run.sh 调起(它负责数据根与收尾)。
// 用 @playwright/test 只当测试跑器(项目既有依赖):用例全是直调隔离实例的接口 + 读隔离 HOME 的文件。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: '.artifacts/playwright',
});
