// r151e 偏好文件读失败加固验收。只由 run.sh 调起(它建数据根与 claude 垫片、起本地假模型接口,并注入 R151B_* 环境变量;
// 环境变量名沿用一期,以便直接复用一期 helpers/)。本套件没有界面用例:每条用例自起一次性实例(要改偏好文件权限或重启服务),
// 串行跑,每个用例自己摆场景,不依赖顺序。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.mjs$/,
  testIgnore: /\.artifacts/,
  fullyParallel: false,
  workers: 1,
  timeout: 360_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.artifacts/last-run.json' }]],
  outputDir: '.artifacts/playwright',
});
