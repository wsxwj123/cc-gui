// r195-trim-keep-titles 验收:只用 request 上下文打接口,不开页面、不需要浏览器。由 run-isolated.sh 调起。
// json 结果文件名由运行脚本通过 PLAYWRIGHT_JSON_OUTPUT_NAME 指定(调用方想改也可以自己设)。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: ['**/.artifacts/**', '**/node_modules/**'],
  globalSetup: './global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['json']],
  outputDir: '.artifacts/playwright',
  projects: [{ name: 'api' }],
});
