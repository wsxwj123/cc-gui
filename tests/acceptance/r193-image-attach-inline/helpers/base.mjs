// 三个用例文件共用的 test 对象与用例准备。
//   - page 夹具:监听页面未捕获错误(pageerror),出现即失败。
//   - 自动夹具 abortAtEnd:每个用例收场时让假命令行把遗留的长回合尽快正常收尾(最多等 10 秒),免得占着后端拖慢下一个用例。
import { test as base, expect } from '@playwright/test';
import { seedPair, resetStatus, readStatus, requestAbort } from './fixtures.mjs';
import { uniqueTag } from './runtime.mjs';

let currentCtx = null;

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await use(page);
    expect(errors, '页面出现未捕获错误(pageerror)').toEqual([]);
  },
  abortAtEnd: [async ({}, use) => { // eslint-disable-line no-empty-pattern
    await use();
    if (!currentCtx) return;
    const name = currentCtx.workspaceName;
    requestAbort(name);
    for (let i = 0; i < 100; i += 1) {
      const st = readStatus(name);
      if (!st || st.openedAt == null || st.ended) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    currentCtx = null;
  }, { auto: true }],
});
export { expect };

/** 每个用例开头调一次:现建一对全新的会话甲 / 乙(各自独立的工作区)。 */
export function prepare() {
  const ctx = seedPair(uniqueTag('t'));
  currentCtx = ctx;
  resetStatus(ctx.workspaceName);
  return ctx;
}
