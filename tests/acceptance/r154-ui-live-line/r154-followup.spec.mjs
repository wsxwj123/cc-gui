// r154-followup：占位阶段（回合已发出、模型还没产出任何内容，底部状态行 connecting）点停止 → 「停止中」。
// 判据全部来自 .devflow/r154-followup-接口.md 的「行为清单」P1–P3，只看页面上用户能看到的东西
// （[data-live-line]、data-live-phase、[data-live-text] / [data-live-verb] / [data-live-object]、role、停止键）；不读源码、不读 React state。
// 造「连接中」照 L3：场景第一个事件就是 wait g1，闸门不开模型就一个字都不出。
// 「停止中」只持续一两百毫秒，用页内 MutationObserver 记录（照 L5 的写法；这里额外记下每次变动时 [data-live-line] 的个数，给 P3 用）。
import { test, expect } from '@playwright/test';
import {
  stopBtn, openAllGates, startRound, endRound, liveSnap, expectOneLine, expectPhase, phaseTrail,
} from './helpers/live.mjs';

test.afterEach(async () => {
  try { openAllGates(); } catch { /* 忽略 */ }
});

// 占位阶段：闸门 g1 不开，假命令行一直不出任何事件。
const PLACEHOLDER_SCENARIO = { events: [
  { kind: 'wait', file: 'g1' },
  { kind: 'thinking', text: 'R154-FU 思考内容。' },
  { kind: 'text', text: 'R154-FU-MARK 正文' },
] };

/** 页内观察器：每次 DOM 变动记 { count, phase, role, verb, text, object, hasObject }；装上时先记一条。 */
async function installCountObserver(page) {
  await page.evaluate(() => {
    if (window.__fuObs) window.__fuObs.disconnect();
    window.__fuLog = [];
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const record = () => {
      const all = document.querySelectorAll('[data-live-line]');
      const el = all[0];
      if (!el) { window.__fuLog.push({ count: 0 }); return; }
      const text = el.querySelector('[data-live-text]');
      const verb = text ? text.querySelector('[data-live-verb]') : null;
      const obj = el.querySelector('[data-live-object]');
      window.__fuLog.push({
        count: all.length,
        phase: el.getAttribute('data-live-phase'),
        role: el.getAttribute('role'),
        text: text ? norm(text.textContent) : null,
        verb: verb ? norm(verb.textContent) : null,
        object: obj ? norm(obj.textContent) : null,
        hasObject: !!obj,
      });
    };
    const obs = new MutationObserver(record);
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__fuObs = obs;
    record();
  });
}
const readLog = async (page) => await page.evaluate(() => (Array.isArray(window.__fuLog) ? window.__fuLog.slice() : []));
const lineRows = (log) => log.filter((r) => r.count > 0);

test('P2 占位阶段不点停止：data-live-phase=connecting、「连接中」、role 不是 status', async ({ page }) => {
  await startRound(page, { key: 'l3', scenario: PLACEHOLDER_SCENARIO, text: 'R154-FU P2 请开始' });
  await installCountObserver(page);
  await expectOneLine(page);
  await expectPhase(page, 'connecting');
  await page.waitForTimeout(1500); // 稳住一会儿：占位阶段持续期间都应是同一个样子
  const s = await liveSnap(page);
  expect.soft(s.phase, '占位阶段（未点停止）：data-live-phase 应为 connecting').toBe('connecting');
  expect.soft(s.verb, '占位阶段（未点停止）：[data-live-verb] 应为「连接中」').toBe('连接中');
  expect.soft(s.text, '占位阶段（未点停止）：状态词应恰为「连接中」').toBe('连接中');
  expect.soft(s.role, '占位阶段（未点停止）：根节点 role 不应是 status').not.toBe('status');
  const rows = lineRows(await readLog(page));
  expect(rows.length, '前置自证：观察器应记到占位阶段的状态行').toBeGreaterThan(0);
  const bad = rows.filter((r) => r.phase !== 'connecting' || r.verb !== '连接中' || r.role === 'status');
  expect(bad, `占位阶段（未点停止）每一刻都应是 connecting /「连接中」/ role 非 status（轨迹：${phaseTrail(rows)}）`).toEqual([]);
  await endRound(page);
});

test('P1+P3 占位阶段点停止：观察到 stopping /「停止中」/ role=status、回合结束后 0 个，全程至多 1 个状态行', async ({ page }) => {
  // 点停止要等"发消息的请求已返回"：前端在那个请求返回后才记下进程号，点得比它早就不会进「停止中」（只会直接中止），用例会偶发红。
  // 监听必须在发消息之前挂上（startRound 里会点发送）。
  const chatPosted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/chat', { timeout: 40_000 });
  await startRound(page, { key: 'l3', scenario: PLACEHOLDER_SCENARIO, text: 'R154-FU P1 请开始' });
  await installCountObserver(page);
  await expectOneLine(page);
  await expectPhase(page, 'connecting');
  await chatPosted;
  await page.waitForTimeout(300); // 留给前端处理完返回的 JSON、记下进程号
  const pre = await liveSnap(page);
  expect(pre.verb, '前置自证：点停止之前占位行应显示「连接中」').toBe('连接中');

  await stopBtn(page).click();
  // 闸门不开：点停止后模型不可能再产出内容，此期间观察到的一切都只能来自占位阶段。
  await page.waitForTimeout(1500);
  const afterStop = lineRows(await readLog(page));

  await endRound(page);
  await expect.poll(async () => (await liveSnap(page)).count, { timeout: 15_000, message: 'P1：回合结束后 [data-live-line] 应为 0 个' }).toBe(0);
  const full = await readLog(page);

  const stopping = afterStop.filter((r) => r.phase === 'stopping');
  console.log(`[R154-FU 观察器] 点停止后 1.5 秒内的阶段轨迹：${phaseTrail(afterStop)}；全程：${phaseTrail(lineRows(full))}`);
  expect(stopping.length, `P1：占位阶段点停止后，底部状态行的 data-live-phase 应变为 stopping（页内观察器记到的阶段轨迹：${phaseTrail(afterStop)}）`).toBeGreaterThan(0);
  expect(stopping.filter((r) => r.verb !== '停止中').map((r) => r.verb), 'P1：stopping 时 [data-live-verb] 应为「停止中」').toEqual([]);
  expect(stopping.filter((r) => r.object).map((r) => r.object), 'P1：stopping 时不应有 [data-live-object] 文字').toEqual([]);
  expect(stopping.filter((r) => r.role !== 'status').map((r) => r.role), 'P1：stopping 时根节点应带 role="status"').toEqual([]);

  const maxCount = Math.max(0, ...full.map((r) => r.count));
  expect(maxCount, `P3：占位阶段点停止的全过程里，[data-live-line] 任一时刻不得超过 1 个（观察器记到的最大个数 ${maxCount}）`).toBeLessThanOrEqual(1);
});
