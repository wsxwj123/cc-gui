// SF-3xx：渐进挂载（W-C）—— 默认只挂最近 K 行、向上补齐、几何全真、既有滚动机制不变。
//
// 夹具 B = 320 轮（640 行左右）的长会话；"挂载了几行"用 `[data-turn-uuid]` 数。
// 全量分母：打开窗内检索时按契约是**全量挂载**（INTERFACE §H.6），用它当分母，
// 免得把"这个夹具一共几行"写死成常数。
import { test, expect } from '@playwright/test';
import { MARKER_B, MARKER_A, A } from './helpers/fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, allRows, mountedRowCount, scrollBox, scrollMetrics,
  scrollToBottom, scrollTo, userScroll, topVisibleRow, scrubber, clickScrubberTick, openSearch, closeSearch,
  searchHits,
} from './helpers/runtime.mjs';

const LONG_TIMEOUT = 120_000;

test.beforeEach(async ({ page }) => { await primeOverlays(page); });

async function openLongSession(page) {
  await openApp(page);
  await openSessionByMarker(page, MARKER_B);
  await expect.poll(async () => await mountedRowCount(page), { timeout: 60_000 }).toBeGreaterThan(3);
  await page.waitForTimeout(600);
}

/** 打开检索 → 数一次"全量"，关掉 → 回到裁剪态。分母来自产品自己的契约行为。 */
async function fullRowCount(page) {
  await openSearch(page);
  const full = await expect.poll(async () => await mountedRowCount(page), { timeout: 60_000 }).toBeGreaterThan(3)
    .then(async () => await mountedRowCount(page));
  await closeSearch(page);
  await page.waitForTimeout(500);
  return full;
}

test('SF-301 默认只挂最近 K 行：不是把整个长会话都挂上', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT);
  await openLongSession(page);
  const windowed = await mountedRowCount(page);
  const full = await fullRowCount(page);
  console.log(`[SF-301] 已挂载 ${windowed} 行 / 全量 ${full} 行`);
  expect(full, '夹具 B 的行数应当足够多（否则这条没意义）').toBeGreaterThan(200);
  expect(windowed, '默认应当只挂最近 K 行（K 默认 30，留一点余量）').toBeLessThanOrEqual(45);
  expect(windowed, '裁剪必须真的生效：已挂行数要显著少于全量').toBeLessThan(full);
});

test('SF-302 向上滚到顶会补齐更早的行，顶部标记只是一行提示', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT);
  await openLongSession(page);
  const before = await mountedRowCount(page);
  await userScroll(page, -3000, { steps: 20 });
  const after = await expect.poll(async () => await mountedRowCount(page), { timeout: 30_000 })
    .toBeGreaterThan(before).then(async () => await mountedRowCount(page));
  console.log(`[SF-302] 补齐：${before} → ${after} 行`);
  expect(after, '滚到顶必须补齐更多行').toBeGreaterThan(before);

  const box = await scrollBox(page);
  const ph = box.locator('[data-turn-placeholder]');
  if (await ph.count()) {
    const info = await ph.first().evaluate((el) => ({ h: Math.round(el.getBoundingClientRect().height), text: (el.textContent || '').trim(), hasUuid: el.hasAttribute('data-turn-uuid') }));
    console.log('[SF-302] 顶部标记 =', JSON.stringify(info));
    expect(info.hasUuid, '顶部标记不得冒充一轮（不带 data-turn-uuid）').toBe(false);
    expect(info.h, '顶部标记是"更早的 N 轮还没加载"这种一行提示，不是几百 px 的假高度占位').toBeLessThan(80);
  }
});

test('SF-303 补齐时视口不跳：补进来的高度必须同帧写回 scrollTop', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT);
  await openLongSession(page);
  // 判据取自契约本身（§5.1.5）：补齐把内容加在视口上方 → 同一个 layout 提交里
  // scrollTop += (新 scrollHeight − 旧 scrollHeight)。没补偿的实现会停在 scrollTop≈0，
  // 用户眼前的内容被整批新内容顶走。
  const m0 = await scrollMetrics(page);
  await scrollTo(page, 0);
  await expect.poll(async () => await mountedRowCount(page), {
    timeout: 30_000, message: '滚到顶之后没有补齐（行数没增加）',
  }).toBeGreaterThan(m0.mountedRows);
  const m1 = await scrollMetrics(page);
  const delta = m1.scrollHeight - m0.scrollHeight;
  console.log(`[SF-303] 补齐新增内容高 ${delta}px，scrollTop 0 → ${m1.scrollTop}`);
  expect(delta, '补齐必须真的让文档变高').toBeGreaterThan(0);
  expect(m1.scrollTop, '补齐后 scrollTop 必须被推高约等于新内容的高度（否则视口被顶走）')
    .toBeGreaterThanOrEqual(delta - 2);

  // 视口里仍然应当有已挂载的行（没被甩到空白处）
  const top = await topVisibleRow(page);
  expect(top, '补齐之后视口里还得有内容').not.toBeNull();
});

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

test('SF-305 回合导航跳远：不得静默无反应，且代价落表', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT);
  await openLongSession(page);
  const bar = scrubber(page);
  await expect(bar, '右侧回合导航条（role=slider）应当存在').toHaveCount(1);
  const valueBefore = await bar.getAttribute('aria-valuenow');

  await scrollToBottom(page);
  const t0 = Date.now();
  await clickScrubberTick(page, 1, 320); // 最上面一档 = 最早那一轮
  const jumpMountMs = Date.now() - t0;
  console.log(`[SF-305] 跳转前 ${valueBefore} → 触发跳转用了 ${jumpMountMs}ms`);
  test.info().annotations.push({ type: 'jumpMountMs', description: `${jumpMountMs}ms（夹具 B，320 轮）` });

  await expect.poll(async () => await bar.getAttribute('aria-valuenow'), {
    timeout: 30_000, message: '点最上面一档之后 navigation 没跳到第 1 回合',
  }).toBe('1');
  // 目标轮必须真的进了视口（只改 aria 数字不算）。滚动可能是平滑动画，用轮询等它落位。
  const probe = async () => await page.locator('[data-cgui="message-list"]').first().evaluate((el) => {
    const boxTop = el.getBoundingClientRect().top;
    const boxBottom = el.getBoundingClientRect().bottom;
    const row = [...el.querySelectorAll('[data-turn-uuid]')].find((r) => (r.textContent || '').includes('第 1 轮：把这一段改一下'));
    if (!row) return { mounted: false, inView: false };
    const r = row.getBoundingClientRect();
    return { mounted: true, inView: r.bottom > boxTop + 1 && r.top < boxBottom - 1 };
  });
  await expect.poll(async () => (await probe()).inView, {
    timeout: 20_000, message: '目标轮没有进入视口（跳转静默无反应）',
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

test('SF-307 搜索打开时全量挂载，关闭后恢复裁剪且不丢位置', async ({ page }) => {
  test.setTimeout(LONG_TIMEOUT);
  await openLongSession(page);
  const windowed = await mountedRowCount(page);

  await openSearch(page);
  const full = await expect.poll(async () => await mountedRowCount(page), { timeout: 60_000 })
    .toBeGreaterThan(windowed).then(async () => await mountedRowCount(page));
  const hits = await searchHits(page);
  console.log(`[SF-307] 回收索：${windowed} → 全量 ${full} 行，命中 ${JSON.stringify(hits)}`);
  const topBefore = await topVisibleRow(page);

  await closeSearch(page);
  await page.waitForTimeout(600);
  const back = await mountedRowCount(page);
  expect(back, '关掉检索要恢复裁剪').toBeLessThan(full);
  const topAfter = await topVisibleRow(page);
  expect(topAfter, '关掉检索后视口里还得有内容').not.toBeNull();
  expect(topAfter.uuid, '关掉检索不该把视野甩到别处（误差 ≤1 行）').toBe(topBefore.uuid);
});

test('SF-308 性能：拖 60 格视口宽度，每格墙钟 ≤150ms、常驻节点 ≤10000（WebKit）', async ({ page }) => {
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
  test.info().annotations.push({ type: 'perf', description: `每格 ${perStep}ms、节点 ${stats.domNodes}（夹具 B，WebKit）` });

  expect(perStep, '每格墙钟必须 ≤150ms（PLAN §10 J8）').toBeLessThanOrEqual(150);
  expect(stats.frameMedian, '帧中位不得比现状（35ms）更差').toBeLessThanOrEqual(35);
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
