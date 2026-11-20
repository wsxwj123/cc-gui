// r205-rollback-trim-reason 黑盒验收:回滚时会话记录裁剪失败,黄字提示带上原因;后端对失败的历史操作往标准错误输出写一行 [history-op]。
// 只依据接口文件的行为清单 1–4;只通过页面(悬停用户消息 →「回滚 / 重新编辑」→「仅回退消息」、黄字提示)、会话记录文件、后端 stdout / stderr 文件观测。
// 后端关了目录监听,用例改会话记录文件后页面不会自动刷新。会话夹具见 helpers/fixtures.mjs(全部在后端启动前写好)。
import { test, expect } from '@playwright/test';
import { CASES, deleteUserLineContaining, readTranscript } from './helpers/fixtures.mjs';
import {
  openCaseSession, rollbackOnly, waitTrimFailedNotice, bodyText, markServerOutput, stderrSince, historyOpLinesSince, TRIM_FAILED,
} from './helpers/runtime.mjs';

const REASON_NOT_FOUND = '原因：会话记录里找不到这条消息。';
const REASON_SPLIT_TOOL = '原因：从这条消息处裁开会拆散一次工具调用和它的结果，为了不损坏会话没有裁。可以回滚到更早的一条消息。';

/** 在后端 stderr(自 mark 起)里找以 `[history-op] trim sid=<前 8 位>` 开头的行;等不到返回 null。 */
async function waitTrimLine(page, mark, sid8, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const hit = stderrSince(mark).split('\n').find((l) => l.startsWith(`[history-op] trim sid=${sid8}`));
    if (hit) return hit;
    if (Date.now() >= end) return null;
    await page.waitForTimeout(200);
  }
}

test('R1 页面加载后会话记录里这条用户消息被删掉:点回退 → 黄字写「原因：会话记录里找不到这条消息。」,会话记录文件不变', async ({ page }) => {
  const c = CASES.c1;
  await openCaseSession(page, c);
  expect(deleteUserLineContaining(c, c.targetText), 'R1 夹具:应从会话记录文件里删掉 1 行用户消息').toBe(1);
  const before = readTranscript(c);
  await rollbackOnly(page, c.targetText);
  const text = await waitTrimFailedNotice(page);
  expect(text, `R1:黄字应含「${REASON_NOT_FOUND}」`).toContain(REASON_NOT_FOUND);
  expect(readTranscript(c), 'R1:会话记录文件内容应与点回退之前完全相同').toBe(before);
});

test('R2 用户消息夹在 tool_use 与它的 tool_result 之间:点回退 → 黄字写「原因：从这条消息处裁开会拆散一次工具调用和它的结果…」,会话记录文件不变', async ({ page }) => {
  const c = CASES.c2;
  await openCaseSession(page, c);
  const before = readTranscript(c);
  await rollbackOnly(page, c.targetText);
  const text = await waitTrimFailedNotice(page);
  expect(text, `R2:黄字应含「${REASON_SPLIT_TOOL}」`).toContain(REASON_SPLIT_TOOL);
  expect(readTranscript(c), 'R2:会话记录文件内容应与点回退之前完全相同').toBe(before);
});

test('R3a 第 1 条的失败(找不到消息)之后:后端 stderr 有一行 [history-op] trim sid=<前 8 位> stage=… code=… status=…,且不含消息原文', async ({ page }) => {
  const c = CASES.c3a;
  const sid8 = c.sid.slice(0, 8);
  await openCaseSession(page, c);
  deleteUserLineContaining(c, c.targetText);
  const mark = markServerOutput();
  await rollbackOnly(page, c.targetText);
  await waitTrimFailedNotice(page);
  const line = await waitTrimLine(page, mark, sid8);
  expect(line, `R3a:后端 stderr 里应有以「[history-op] trim sid=${sid8}」开头的行`).not.toBeNull();
  expect(line, 'R3a:这一行应整行符合 [history-op] trim sid=<8位> stage=<preview|submit> code=<代码> status=<状态码>').toMatch(
    new RegExp(`^\\[history-op\\] trim sid=${sid8} stage=(preview|submit) code=\\S+ status=\\d{3}$`),
  );
  expect(line, 'R3a:这一行不应含那条消息的原文').not.toContain(c.targetText);
  expect(line, 'R3a:这一行不应含会话标记').not.toContain(c.marker);
});

test('R3b 第 2 条的失败(拆散工具调用)之后:后端 stderr 有一行 [history-op] trim sid=<前 8 位> stage=… code=… status=…,且不含消息原文', async ({ page }) => {
  const c = CASES.c3b;
  const sid8 = c.sid.slice(0, 8);
  await openCaseSession(page, c);
  const mark = markServerOutput();
  await rollbackOnly(page, c.targetText);
  await waitTrimFailedNotice(page);
  const line = await waitTrimLine(page, mark, sid8);
  expect(line, `R3b:后端 stderr 里应有以「[history-op] trim sid=${sid8}」开头的行`).not.toBeNull();
  expect(line, 'R3b:这一行应整行符合 [history-op] trim sid=<8位> stage=<preview|submit> code=<代码> status=<状态码>').toMatch(
    new RegExp(`^\\[history-op\\] trim sid=${sid8} stage=(preview|submit) code=\\S+ status=\\d{3}$`),
  );
  expect(line, 'R3b:这一行不应含那条消息的原文').not.toContain(c.targetText);
  expect(line, 'R3b:这一行不应含会话标记').not.toContain(c.marker);
});

test('R4 【反向】回合没在跑、正常回退一条消息:回退成功,页面不出现「会话记录裁剪失败」,后端输出里没有 [history-op] 行', async ({ page }) => {
  const c = CASES.c4;
  await openCaseSession(page, c);
  const mark = markServerOutput();
  await rollbackOnly(page, c.targetText);
  await expect.poll(() => readTranscript(c).includes(c.targetText), { message: 'R4:回退成功后会话记录文件里不应再有被回退的那条用户消息', timeout: 30_000 }).toBe(false);
  await page.waitForTimeout(2_500);
  expect(await bodyText(page), `R4:回退成功,页面不应出现「${TRIM_FAILED}」`).not.toContain(TRIM_FAILED);
  expect(historyOpLinesSince(mark), 'R4:回退成功,后端输出里不应有 [history-op] 行').toEqual([]);
});
