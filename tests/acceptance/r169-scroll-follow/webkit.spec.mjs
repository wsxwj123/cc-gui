// S03~S14：WebKit 内核（Mac 版应用）下。S03~S06 是"复现"用例（当前代码上应红），S07~S14 是"回归"用例（当前代码上应绿）。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import {
  boot, ensureRow, clickRow, openAndWait, waitMarker, markerInPane, openSplitAC, sleep, freshState, finishRounds, restoreViewport,
  setDuration, sendAndWaitRunning, ensureAtBottom, stopBtn, backBtn, metrics, metricsOrFail, median, wheelUp, wheelToBottom, wheelToTop,
  watchUntilStopGone, expectFollowing, loadOlder, messageRows,
} from './helpers/app.mjs';

test.describe.configure({ timeout: 240_000 });
test.beforeEach(() => { freshState(); });
test.afterEach(async ({ page }) => { await finishRounds(); await restoreViewport(page); });

/** 打开 A、发一条消息、等回复开始并停在底部。 */
async function startReplyInA(page, tag) {
  await boot(page);
  await ensureRow(page, 'A');
  await openAndWait(page, 'A');
  await sendAndWaitRunning(page, null, `${SESSIONS.A.beg} ${tag} 请开始一段长回复`);
  await ensureAtBottom(page, null);
}
const fmt = (n) => (typeof n === 'number' ? n.toFixed(0) : String(n));

test('S03 单窗格：回复中切到 B、B 加载完再等 2 秒切回 A，2 秒内回到最底部并一直跟随', async ({ page }) => {
  setDuration(45_000);
  await startReplyInA(page, 'S03');
  await clickRow(page, 'B');
  expect(await waitMarker(page, SESSIONS.B.end, 30_000), '前置：B 应加载出结束标记').not.toBeNull();
  await sleep(2_000);
  await clickRow(page, 'A');
  const early = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 2_000) { const m = await metrics(page, null); early.push(m && m.dist); await sleep(200); }
  const tail = early.filter((d) => typeof d === 'number').slice(-4);
  expect(tail.length, 'S03 切回 A 后应能读到离底距离').toBeGreaterThan(0);
  expect(median(tail), `S03 切回 A 后 2 秒内离底距离应 ≤4px；点击后每 200ms 实测：${early.map(fmt).join(',')}`).toBeLessThanOrEqual(4);
  await expect(stopBtn(page, null), '前置：切回 A 时回复应仍在进行（停止键可见）').toBeVisible({ timeout: 5_000 });
  const samples = await watchUntilStopGone(page, null);
  expectFollowing(samples, 'S03 切回 A 的 2 秒之后');
});

test('S04 单窗格：发消息后不碰滚动，停止键消失后 3 秒离底距离 ≤4px', async ({ page }) => {
  await startReplyInA(page, 'S04');
  const samples = await watchUntilStopGone(page, null);
  expect(samples[samples.length - 1].timedOut, 'S04 等停止键消失超时').toBeFalsy();
  await sleep(3_000);
  const m = await metricsOrFail(page, null);
  expect(m.dist, `S04 停止键消失后 3 秒离底距离应 ≤4px，实测 ${fmt(m.dist)}px（scrollTop ${fmt(m.top)}，scrollHeight ${fmt(m.sh)}）`).toBeLessThanOrEqual(4);
});

test('S05 单窗格：回复中往上翻 60–100px，回复把离底拉到 >200px 后 2 秒内出现「回到底部」按钮并一直可见，期间 scrollTop 不变', async ({ page }) => {
  await startReplyInA(page, 'S05');
  const up = await wheelUp(page, null, 60, { step: 20 });
  expect(up.moved, `前置：滚轮应往上翻 60–100px，实测 ${fmt(up.moved)}px`).toBeGreaterThanOrEqual(60);
  expect(up.moved, `前置：滚轮应往上翻 60–100px，实测 ${fmt(up.moved)}px`).toBeLessThanOrEqual(100);
  const samples = await watchUntilStopGone(page, null, { withButton: true });
  const run = samples.filter((s) => s.stop);
  const tExceed = (run.find((s) => s.dist > 200) || {}).t;
  const maxDist = Math.max(...run.map((s) => s.dist));
  const maxBtnCount = Math.max(...samples.map((s) => s.btnCount || 0));
  expect(tExceed, `S05 回复进行中离底距离应超过 200px（最大 ${fmt(maxDist)}px）`).toBeDefined();
  const firstBtn = run.find((s) => s.btn);
  expect(Boolean(firstBtn && firstBtn.t <= tExceed + 2_000),
    `S05 离底超过 200px（t=${tExceed}ms）后 2 秒内应出现名为「回到底部」的按钮；按钮是否找到：${maxBtnCount > 0 ? '找到但不可见' : '找到 0 个（无此无障碍名称）'}；首次可见 t=${firstBtn ? firstBtn.t : '从未'}；最大离底 ${fmt(maxDist)}px`).toBe(true);
  const lateMiss = run.filter((s) => s.t >= tExceed + 2_000 && !s.btn);
  expect(lateMiss.length, `S05 按钮应在停止键消失前一直可见；不可见的采样 ${lateMiss.length} 个（t=${lateMiss.slice(0, 5).map((s) => s.t).join(',')}ms）`).toBe(0);
  const tops = run.map((s) => s.top);
  const range = Math.max(...tops) - Math.min(...tops);
  expect(range, `S05 期间 scrollTop 变化应 ≤2px，实测 ${fmt(range)}px（${fmt(Math.min(...tops))}→${fmt(Math.max(...tops))}）`).toBeLessThanOrEqual(2);
});

test('S06 单窗格：回复中往上翻 ≥600px 出现「回到底部」按钮，点击后 1 秒内吸底并一直跟随', async ({ page }) => {
  await startReplyInA(page, 'S06');
  const up = await wheelUp(page, null, 600);
  expect(up.moved, `前置：应往上翻 ≥600px，实测 ${fmt(up.moved)}px`).toBeGreaterThanOrEqual(600);
  const btn = backBtn(page, null);
  let n = 0; let vis = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 3_000 && !vis) {
    n = Math.max(n, await btn.count());
    vis = n > 0 && (await btn.first().isVisible().catch(() => false));
    if (!vis) await sleep(200);
  }
  const m = await metricsOrFail(page, null);
  expect(vis, `S06 往上翻 ≥600px 后应看到名为「回到底部」的按钮；按钮是否找到：${n > 0 ? '找到但不可见' : '找到 0 个（无此无障碍名称）'}；当前离底 ${fmt(m.dist)}px`).toBe(true);
  await btn.first().click({ timeout: 5_000 });
  let hit = null; const lasts = [];
  const t1 = Date.now();
  while (Date.now() - t1 < 1_000) {
    const mm = await metrics(page, null);
    lasts.push(mm && mm.dist);
    if (mm && mm.dist <= 4 && hit === null) hit = Date.now() - t1;
    await sleep(100);
  }
  expect(hit, `S06 点按钮后 1 秒内离底距离应 ≤4px；每 100ms 实测：${lasts.map(fmt).join(',')}`).not.toBeNull();
  const samples = await watchUntilStopGone(page, null);
  expectFollowing(samples, 'S06 点「回到底部」之后');
});

test('S07 单窗格：回复中往上翻 ≥600px，之后 4 秒 scrollTop 变化 ≤2px（不被拉回底部）', async ({ page }) => {
  await startReplyInA(page, 'S07');
  const up = await wheelUp(page, null, 600);
  expect(up.moved, `前置：应往上翻 ≥600px，实测 ${fmt(up.moved)}px`).toBeGreaterThanOrEqual(600);
  const tops = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 4_000) { tops.push((await metricsOrFail(page, null)).top); await sleep(200); }
  const range = Math.max(...tops) - Math.min(...tops);
  expect(range, `S07 翻上去后 4 秒内 scrollTop 变化应 ≤2px，实测 ${fmt(range)}px（${fmt(Math.min(...tops))}→${fmt(Math.max(...tops))}）`).toBeLessThanOrEqual(2);
});

test('S08 单窗格：往上翻 ≥600px 后再用滚轮滚回最底部，之后到停止键消失一直跟随', async ({ page }) => {
  await startReplyInA(page, 'S08');
  const up = await wheelUp(page, null, 600);
  expect(up.moved, `前置：应往上翻 ≥600px，实测 ${fmt(up.moved)}px`).toBeGreaterThanOrEqual(600);
  await sleep(1_000);
  const m = await wheelToBottom(page, null, 15_000);
  expect(m.dist, `前置：滚轮应能滚回最底部，实测离底 ${fmt(m.dist)}px`).toBeLessThanOrEqual(4);
  const samples = await watchUntilStopGone(page, null);
  expectFollowing(samples, 'S08 滚回底部之后');
});

test('S09 单窗格：往上翻 ≥600px 后不再操作，停止键消失后 3 秒 scrollTop 与消失前一刻相差 ≤2px', async ({ page }) => {
  await startReplyInA(page, 'S09');
  const up = await wheelUp(page, null, 600);
  expect(up.moved, `前置：应往上翻 ≥600px，实测 ${fmt(up.moved)}px`).toBeGreaterThanOrEqual(600);
  const samples = await watchUntilStopGone(page, null, { interval: 100 });
  expect(samples[samples.length - 1].timedOut, 'S09 等停止键消失超时').toBeFalsy();
  const before = samples.filter((s) => s.stop).pop();
  expect(before, 'S09 应采到停止键消失前的样本').toBeDefined();
  await sleep(3_000);
  const after = await metricsOrFail(page, null);
  expect(Math.abs(after.top - before.top), `S09 停止键消失前一刻 scrollTop=${fmt(before.top)}，消失后 3 秒=${fmt(after.top)}，差应 ≤2px`).toBeLessThanOrEqual(2);
});

test('S10 单窗格：回复中在 A 翻上去 ≥600px，切到 B 加载完再切回 A，2 秒内回到原位置且之后 3 秒不动', async ({ page }) => {
  setDuration(60_000);
  await startReplyInA(page, 'S10');
  const up = await wheelUp(page, null, 600);
  expect(up.moved, `前置：应往上翻 ≥600px，实测 ${fmt(up.moved)}px`).toBeGreaterThanOrEqual(600);
  const saved = (await metricsOrFail(page, null)).top;
  await clickRow(page, 'B');
  expect(await waitMarker(page, SESSIONS.B.end, 30_000), '前置：B 应加载出结束标记').not.toBeNull();
  await clickRow(page, 'A');
  await sleep(2_000);
  const back = await metricsOrFail(page, null);
  expect(Math.abs(back.top - saved), `S10 切回 A 后 2 秒 scrollTop=${fmt(back.top)}，切走前记下的=${fmt(saved)}，差应 ≤2px`).toBeLessThanOrEqual(2);
  const tops = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 3_000) { tops.push((await metricsOrFail(page, null)).top); await sleep(200); }
  const range = Math.max(back.top, ...tops) - Math.min(back.top, ...tops);
  expect(range, `S10 之后 3 秒 scrollTop 变化应 ≤2px，实测 ${fmt(range)}px（${fmt(Math.min(...tops))}→${fmt(Math.max(...tops))}）`).toBeLessThanOrEqual(2);
});

test('S11 分屏两窗格都没回复：在一个窗格翻 ≥600px，另一个窗格 scrollTop 不变（左右各来一遍）', async ({ page }) => {
  await openSplitAC(page);
  const right0 = (await metricsOrFail(page, 1)).top;
  const upL = await wheelUp(page, 0, 600);
  expect(upL.moved, `前置：左窗格应往上翻 ≥600px，实测 ${fmt(upL.moved)}px`).toBeGreaterThanOrEqual(600);
  await sleep(500);
  const right1 = (await metricsOrFail(page, 1)).top;
  expect(Math.abs(right1 - right0), `S11 左窗格翻页后右窗格 scrollTop ${fmt(right0)} → ${fmt(right1)}，应不变（差 ≤1px）`).toBeLessThanOrEqual(1);
  const left1 = (await metricsOrFail(page, 0)).top;
  const upR = await wheelUp(page, 1, 600);
  expect(upR.moved, `前置：右窗格应往上翻 ≥600px，实测 ${fmt(upR.moved)}px`).toBeGreaterThanOrEqual(600);
  await sleep(500);
  const left2 = (await metricsOrFail(page, 0)).top;
  expect(Math.abs(left2 - left1), `S11 右窗格翻页后左窗格 scrollTop ${fmt(left1)} → ${fmt(left2)}，应不变（差 ≤1px）`).toBeLessThanOrEqual(1);
});

test('S12 单窗格：回复结束后往上翻 ≥600px，再发新消息，发送后 1 秒内回到最底部', async ({ page }) => {
  setDuration(4_000);
  await boot(page);
  await ensureRow(page, 'A');
  await openAndWait(page, 'A');
  await sendAndWaitRunning(page, null, `${SESSIONS.A.beg} S12 第一条`);
  await expect(stopBtn(page, null), '前置：第一条回复应在几秒内结束').toBeHidden({ timeout: 30_000 });
  await sleep(1_000);
  const up = await wheelUp(page, null, 600);
  expect(up.moved, `前置：应往上翻 ≥600px，实测 ${fmt(up.moved)}px`).toBeGreaterThanOrEqual(600);
  setDuration(15_000);
  await sendAndWaitRunning(page, null, `${SESSIONS.A.beg} S12 第二条`);
  const ds = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1_000) { const m = await metrics(page, null); ds.push(m && m.dist); await sleep(100); }
  const tail = ds.filter((d) => typeof d === 'number').slice(-3);
  expect(tail.length, 'S12 发送后应能读到离底距离').toBeGreaterThan(0);
  expect(median(tail), `S12 发送后 1 秒内离底距离应 ≤4px；发送后每 100ms 实测：${ds.map(fmt).join(',')}`).toBeLessThanOrEqual(4);
});

test('S13 打开 L，滚到最顶部点「加载更早」，加载完后点击前视口最上方那条消息仍在视口内', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'L');
  await openAndWait(page, 'L');
  await wheelToTop(page, null);
  await sleep(500);
  const entry = loadOlder(page).first();
  await expect(entry, '前置：滚到顶部后应有「加载更早」入口').toBeVisible({ timeout: 10_000 });
  const probe = (uuid) => page.evaluate((u) => {
    const list = document.querySelector('[data-cgui="message-list"]');
    const lr = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll('[data-turn-uuid]')];
    if (u) {
      const el = rows.find((r) => r.getAttribute('data-turn-uuid') === u);
      if (!el) return { found: false, listTop: lr.top, listBottom: lr.bottom };
      const r = el.getBoundingClientRect();
      return { found: true, top: r.top, bottom: r.bottom, listTop: lr.top, listBottom: lr.bottom };
    }
    const first = rows.find((r) => { const b = r.getBoundingClientRect(); return b.bottom > lr.top + 1 && b.top < lr.bottom; });
    return first ? { uuid: first.getAttribute('data-turn-uuid') } : { uuid: null };
  }, uuid);
  const { uuid } = await probe(null);
  expect(uuid, '前置：点击前视口里应有一条消息').toBeTruthy();
  const before = await messageRows(page).count();
  await entry.dispatchEvent('click');
  let after = before;
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000 && after <= before) { await sleep(250); after = await messageRows(page).count(); }
  expect(after, `前置：点「加载更早」后消息条数应变多：${before} -> ${after}`).toBeGreaterThan(before);
  await sleep(1_500);
  const r = await probe(uuid);
  expect(r.found, `S13 点击前视口最上方的消息（${uuid}）加载后应仍在页面上`).toBe(true);
  expect(r.bottom > r.listTop && r.top < r.listBottom,
    `S13 点击前视口最上方的消息加载后应仍在视口内：消息 top=${fmt(r.top)} bottom=${fmt(r.bottom)}，列表可视区 ${fmt(r.listTop)}~${fmt(r.listBottom)}`).toBe(true);
});

test('S14 打开从未打开过的 N，结束标记出现后 2 秒内离底距离 ≤4px', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'N');
  await clickRow(page, 'N');
  expect(await waitMarker(page, SESSIONS.N.end, 60_000), '前置：N 应加载出结束标记').not.toBeNull();
  const ds = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 2_000) { const m = await metrics(page, null); ds.push(m && m.dist); await sleep(200); }
  const tail = ds.filter((d) => typeof d === 'number').slice(-3);
  expect(tail.length, 'S14 应能读到离底距离').toBeGreaterThan(0);
  expect(median(tail), `S14 结束标记出现后 2 秒内离底距离应 ≤4px；每 200ms 实测：${ds.map(fmt).join(',')}`).toBeLessThanOrEqual(4);
});
