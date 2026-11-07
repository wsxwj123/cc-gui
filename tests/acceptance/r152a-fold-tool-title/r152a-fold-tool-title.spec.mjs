// r152a-fold-tool-title（r159 起只剩两条）：原本测「总栏」(折叠条)的标题 / 悬停提示 / 开合 / 直播标记；总栏已按用户要求去掉，
// B1–B7、B9、B10 随之退役；B8 只保留底部状态行 / 历史回合无点阵与用时的部分，B11 只保留"不抛错、不白屏、<script> 不被执行"。
// 判据只看页面上用户能看到的东西：[data-live-line] / [data-live-elapsed] / [data-strip-dots] / [data-strip-elapsed] / [data-strip-root] / [data-turn-uuid]。
// 命名：Bn 对应行为清单第 n 条；B11 对应错误契约。
import { test, expect } from '@playwright/test';
import { SESSIONS, ERROR_ROWS, HIST_ROWS } from './helpers/fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, newSessionInFixtureProject, turnRows, stripRootOf,
  parseElapsed, collectPageErrors, sendMessage, sendInOpenSession,
  waitRoundIdle, writeScenario, releaseRound, touchCtl, resetCtl,
} from './helpers/runtime.mjs';

test.beforeEach(async ({ page }) => {
  resetCtl();
  await primeOverlays(page);
});

// 用例失败时直播回合会停在半路（假命令行在等放行文件）：把所有放行文件都放了，让它自己收尾，别拖累下一条。
test.afterEach(async () => {
  for (const name of ['done-b', 'done-c', 'go-c', 'go-d', 'go-finish']) touchCtl(name);
  releaseRound();
});

/** 全页范围内：点阵动画 / 用时（r154 R3 起恒为 0）、底部状态行各有几个（历史回合应一个都没有）。（r159：原来的 [data-strip-live] 直播标记随总栏去掉，不再数。） */
const liveMarks = async (scope) => ({
  dots: await scope.locator('[data-strip-dots]').count(),
  elapsed: await scope.locator('[data-strip-elapsed]').count(),
  line: await scope.locator('[data-live-line]').count(),
});

// r154 R3 换锚：点阵动画与用时从折叠条头行挪到了页面底部的状态行 [data-live-line]（[data-live-elapsed]）；
// r159：折叠条（总栏）本身已去掉，头行 / 直播标记 / 标题相关的判据一并退役；本条只守护——状态行只属于正在生成的这一轮、用时每秒走、
// 结束后消失、历史回合没有。
test('B8 直播回合：状态行的用时每秒增加；结束后状态行消失；同页历史回合从头到尾没有点阵 / 用时 / 状态行（r159 起没有总栏）', async ({ page }) => {
  const LIVE = 'R152A-B8 直播正文。';
  writeScenario({
    events: [
      { kind: 'thinking', text: 'B8 先想一想。' },
      { kind: 'tool', name: 'Bash', input: { command: 'ls', description: 'B8 直播工具标题' }, result: 'ok' },
      { kind: 'text', text: LIVE },
    ],
    holdBeforeResult: true, // 假命令行停在 result 之前：回合保持“正在生成”
  });
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.h.marker);
  await expect(turnRows(page)).toHaveCount(HIST_ROWS.length, { timeout: 20_000 });
  expect(await liveMarks(page.locator('body')), '发消息之前：历史回合没有任何直播标记，也没有底部状态行').toEqual({ dots: 0, elapsed: 0, line: 0 });

  await sendInOpenSession(page, 'B8 跑一轮');
  const root = stripRootOf(page, LIVE);
  await expect(root, '正在生成的回合应画出过程条').toHaveCount(1, { timeout: 40_000 });
  const lineElapsed = page.locator('[data-live-line] [data-live-elapsed]');
  await expect(page.locator('[data-live-line]'), '整页恰有 1 个底部状态行').toHaveCount(1);
  const readLineElapsed = async () => ((await lineElapsed.first().textContent()) || '').trim();
  const t0 = await readLineElapsed();
  expect(t0, '状态行用时文字形如 12s 或 2m 22s').toMatch(/^(\d+m )?\d+s$/);
  const s0 = parseElapsed(t0);
  await expect.poll(async () => parseElapsed(await readLineElapsed()), { timeout: 10_000, message: `状态行用时应每秒增加（起点 ${t0}）` })
    .toBeGreaterThan(s0);
  expect(await liveMarks(page.locator('body')), '整页没有点阵与用时；底部状态行恰 1 个')
    .toEqual({ dots: 0, elapsed: 0, line: 1 });
  for (const h of HIST_ROWS) {
    const histRow = turnRows(page).filter({ hasText: h.anchor }).first();
    expect(await liveMarks(histRow), `生成中：历史回合 ${h.key} 不得有 4 点动画 / 用时 / 直播标记 / 状态行`).toEqual({ dots: 0, elapsed: 0, line: 0 });
  }

  releaseRound();
  await waitRoundIdle(page);
  await expect.poll(async () => await liveMarks(page.locator('body')), { timeout: 15_000, message: '回合结束后：底部状态行消失（页面上也没有点阵与用时）' })
    .toEqual({ dots: 0, elapsed: 0, line: 0 });
});

test('B11 错误契约：工具入参异常（不是对象 / 字段类型不对 / 奇怪字符）→ 不抛错、不白屏、description 里的 <script> 不被执行（r159：原「标题退回工具原名」属于总栏，已退役）', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.e.marker);
  await expect(turnRows(page), '7 个异常入参的回合都应画出来（没白屏）').toHaveCount(ERROR_ROWS.length, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__r152a_xss), 'description 里的 <script> 只能当文字，不能被执行').toBeUndefined();
  expect(errors, '页面不得有未捕获异常').toEqual([]);
});
