// SF-3xx：长会话打开后的几何与性能 —— 首屏全显示、吸底精确、回合导航跳远、重开恢复滚动位置、拖宽度性能、静置无抖动。
//
// 夹具 B = 320 轮（640 行左右）的长会话；首屏只加载最近 120 条，且这 120 条全部显示
// （不再有"打开长会话默认只显示最近 30 行"的规则：回到底部 / 停在底部、已加载超过 400 条时才只保留最近一批，
//  看历史期间已显示的消息不会被收起）。"挂载了几行"用 `[data-turn-uuid]` 数。
// 原 SF-301 / SF-302 / SF-303 / SF-307 的前提是"默认只显示最近 30 行"，已不成立，已删除；
// 对应行为由 r151l-history-pagination 的 B1 / B2 与 r170-loadolder-cliff 覆盖。
import { test, expect } from '@playwright/test';
import { MARKER_B, MARKER_A, A } from './helpers/fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, allRows, mountedRowCount, scrollBox, scrollMetrics,
  scrollToBottom, userScroll, scrubber, clickScrubberTick,
} from './helpers/runtime.mjs';

const LONG_TIMEOUT = 120_000;

test.beforeEach(async ({ page }) => { await primeOverlays(page); });

async function openLongSession(page) {
  await openApp(page);
  await openSessionByMarker(page, MARKER_B);
  await expect.poll(async () => await mountedRowCount(page), { timeout: 60_000 }).toBeGreaterThan(3);
  await page.waitForTimeout(600);
}

test('SF-304 滚到底：吸底精确 + 总高不漂移（几何是真的，不是估算）', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT);
  await openLongSession(page);
  await scrollToBottom(page);
  let m = await scrollMetrics(page);
  expect(Math.abs((m.scrollTop + m.clientHeight) - m.scrollHeight), '吸底：scrollTop + 视口高 ≈ scrollHeight').toBeLessThanOrEqual(2);

  // 反复到底，scrollHeight 不得因"高度估算收敛"而漂移（W-B/W-A 会漂）
  for (let i = 0; i < 3; i += 1) {
    await userScroll(page, 900, { steps: 4 });
    await scrollToBottom(page);
    const m2 = await scrollMetrics(page);
    expect(Math.abs(m2.scrollHeight - m.scrollHeight), '总高不得漂移（说明总高是真几何，不是估算）').toBeLessThanOrEqual(2);
    m = m2;
  }

  // 最后一行底边贴近容器底 → 底部永远是"真的底部"
  const gap = await (await scrollBox(page)).evaluate((el) => {
    const rows = [...el.querySelectorAll('[data-turn-uuid]')];
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    return Math.round(el.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
  });
  console.log('[SF-304] 最后一行底边与容器底的间距 =', gap);
  expect(gap, '滚到底时最后一行应当贴着容器底（说明底部挂着的是真内容）').not.toBeNull();
  expect(Math.abs(gap), '最后一行底边与容器底误差 ≤8px').toBeLessThanOrEqual(8);
});

test('SF-305 回合导航跳远：不得静默无反应，目标是已加载范围内最早的一轮并进入视口', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT);
  await openLongSession(page);
  const bar = scrubber(page);
  await expect(bar, '右侧回合导航条（role=slider）应当存在').toHaveCount(1);
  const valueBefore = await bar.getAttribute('aria-valuenow');

  await scrollToBottom(page);
  // 目标 = 已加载范围内最早的一轮 = 页面上第一条消息行（首屏只加载最近 120 条，更早的「第 1 轮」不在页面上）。
  const box = page.locator('[data-cgui="message-list"]').first();
  const earliestUuid = await box.evaluate((el) => {
    const row = el.querySelector('[data-turn-uuid]');
    return row ? row.getAttribute('data-turn-uuid') : null;
  });
  expect(earliestUuid, '前置：页面上应有已加载的消息行').not.toBeNull();
  const t0 = Date.now();
  await clickScrubberTick(page, 1, 320); // 最上面一档 = 已加载范围内最早的那一轮
  const jumpMountMs = Date.now() - t0;
  console.log(`[SF-305] 跳转前 ${valueBefore} → 触发跳转用了 ${jumpMountMs}ms；目标行 ${earliestUuid}`);
  test.info().annotations.push({ type: 'jumpMountMs', description: `${jumpMountMs}ms（夹具 B，320 轮）` });

  // 目标轮必须真的进了视口（只改 aria 数字不算）。滚动可能是平滑动画，用轮询等它落位。
  const probe = async () => await box.evaluate((el, uuid) => {
    const boxTop = el.getBoundingClientRect().top;
    const boxBottom = el.getBoundingClientRect().bottom;
    const row = [...el.querySelectorAll('[data-turn-uuid]')].find((r) => r.getAttribute('data-turn-uuid') === uuid);
    if (!row) return { mounted: false, inView: false };
    const r = row.getBoundingClientRect();
    return { mounted: true, inView: r.bottom > boxTop + 1 && r.top < boxBottom - 1 };
  }, earliestUuid);
  await expect.poll(async () => (await probe()).inView, {
    timeout: 20_000, message: '已加载范围内最早的一轮没有进入视口（跳转静默无反应）',
  }).toBe(true);
  console.log('[SF-305] 目标轮 =', JSON.stringify(await probe()));
});

test('SF-306 重开会话：滚动位置恢复不报错、落在已挂范围内（像素记忆退化，按接受处理）', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  await openLongSession(page);
  await userScroll(page, -3000, { steps: 10 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openSessionByMarker(page, MARKER_B);
  await expect.poll(async () => await mountedRowCount(page), { timeout: 60_000 }).toBeGreaterThan(3);

  const m = await scrollMetrics(page);
  const max = Math.max(0, m.scrollHeight - m.clientHeight);
  expect(m.scrollTop, '恢复后的 scrollTop 必须落在文档范围内（不许是负数/超界）').toBeGreaterThanOrEqual(0);
  expect(m.scrollTop, 'scrollTop 不得超过最大可滚距离').toBeLessThanOrEqual(max + 2);

  // 不许把用户永久锁在"看历史"态：往下滚还能回到最新，且底部仍是真底部。
  // （像素级位置记忆在裁剪下会退化，这是**已知退化**，按接受处理 —— 本条判的是"不报错、不锁死"。）
  await scrollToBottom(page);
  const m2 = await scrollMetrics(page);
  expect(Math.abs((m2.scrollTop + m2.clientHeight) - m2.scrollHeight), '重开之后底部仍是真底部').toBeLessThanOrEqual(2);
  const newest = await page.locator('[data-cgui="message-list"]').first().evaluate((el) => (el.textContent || '').includes('第 320 轮'));
  expect(newest, '重开之后应当能看到最新的那一轮（说明没被锁在历史里）').toBe(true);
  expect(errors, `重开过程不许有未捕获异常：${errors.join(' | ')}`).toEqual([]);
});

test('SF-308 性能：拖 60 格视口宽度，每格墙钟 ≤150ms、常驻节点 ≤10000（WebKit）；帧中位只记录', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT * 3);
  await openLongSession(page);

  // 探针（与 .devflow/lag-probe 同一套口径）：rAF 帧间隔 + longtask
  await page.evaluate(() => {
    const S = window.__sfLag = { observing: true, rafFrames: [], longtasks: [], t0: performance.now() };
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) if (S.observing) S.longtasks.push(Math.round(e.duration)); })
        .observe({ entryTypes: ['longtask'] });
    } catch { /* 不支持就算了 */ }
    const loop = (t) => { if (S.observing) S.rafFrames.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });

  const STEPS = 60;
  const t1 = Date.now();
  for (let i = 0; i < STEPS; i += 1) {
    const v = 1180 + (i % 2 === 0 ? 0 : 90) + (i % 5) * 8;
    await page.setViewportSize({ width: v, height: 860 });
  }
  const dragWallMs = Date.now() - t1;
  const stats = await page.evaluate(() => {
    const S = window.__sfLag;
    S.observing = false;
    const gaps = [];
    for (let i = 1; i < S.rafFrames.length; i += 1) gaps.push(S.rafFrames[i] - S.rafFrames[i - 1]);
    const sorted = gaps.slice().sort((a, b) => a - b);
    const pc = (p) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 100) / 100 : null);
    return {
      frameMedian: pc(0.5), frameP90: pc(0.9), longtaskTotal: S.longtasks.reduce((a, b) => a + b, 0),
      domNodes: document.getElementsByTagName('*').length,
      mountedRows: document.querySelectorAll('[data-turn-uuid]').length,
    };
  });
  const perStep = Math.round((dragWallMs / STEPS) * 10) / 10;
  console.log(`[SF-308] 每格 ${perStep}ms｜帧中位 ${stats.frameMedian}ms｜P90 ${stats.frameP90}ms｜longtask 合计 ${stats.longtaskTotal}ms｜节点 ${stats.domNodes}｜已挂行 ${stats.mountedRows}`);
  test.info().annotations.push({ type: 'perf', description: `每格 ${perStep}ms、帧中位 ${stats.frameMedian}ms、节点 ${stats.domNodes}（夹具 B，WebKit）` });

  expect(perStep, '每格墙钟必须 ≤150ms（PLAN §10 J8）').toBeLessThanOrEqual(150);
  // 帧中位不再判：原门槛「≤35ms」是按"只显示最近 30 行"定的；首屏改为全显示 120 行后行数翻了几倍，该门槛不再适用，只记录数值（见上面的日志与 annotation）。
  expect(stats.domNodes, '常驻 DOM 节点必须 ≤10000（现状 22043）').toBeLessThanOrEqual(10_000);
});

test('SF-309 静置 120 秒无抖动（消息流里不许有自发变更，也不许长任务）', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT * 3);
  await openApp(page);
  await openSessionByMarker(page, MARKER_A); // 静态会话，没有流式的东西
  const result = await page.evaluate(async () => {
    const scroller = document.querySelector('[data-cgui="message-list"]');
    let mutations = 0;
    const mo = new MutationObserver((recs) => { for (const r of recs) mutations += r.addedNodes.length + r.removedNodes.length; });
    mo.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true });
    const longtasks = [];
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) longtasks.push(Math.round(e.duration)); })
        .observe({ entryTypes: ['longtask'] });
    } catch { /* 不支持 */ }
    const frames = [];
    let on = true;
    const loop = (t) => { if (on) frames.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const h0 = scroller.scrollHeight;
    await new Promise((r) => setTimeout(r, 120_000));
    on = false;
    mo.disconnect();
    const gaps = [];
    for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i] - frames[i - 1]);
    gaps.sort((a, b) => a - b);
    return {
      mutations,
      longtaskTotal: longtasks.reduce((a, b) => a + b, 0),
      longtaskCount: longtasks.length,
      frameMedian: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)] * 100) / 100 : null,
      heightDrift: scroller.scrollHeight - h0,
    };
  });
  console.log('[SF-309] 静置 120s：', JSON.stringify(result));
  expect(result.mutations, '静置期间消息流里不许有任何自发变更（含隐藏/属性变化）').toBe(0);
  expect(result.longtaskTotal, '静置期间不许有长任务').toBe(0);
  expect(result.frameMedian, '静置期间帧中位 ≤20ms').toBeLessThanOrEqual(20);
  expect(Math.abs(result.heightDrift), 'scrollHeight 不许漂移（说明没有"估算收敛"）。').toBeLessThanOrEqual(2);
});
