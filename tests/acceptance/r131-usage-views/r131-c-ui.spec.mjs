// r131 · C 组(界面):首页用量块的「总览 | 模型」分页 + 「全部 | 30 天 | 7 天」范围切换 + 模型分页的堆叠柱状图与图例。
// 页面来自 run.sh 起的 dev server(/api、/ws 代理到隔离实例);数据一律用 helpers/ui.mjs 的 payload 打桩(确定性),
// 只有 C8 用真夹具端到端。文案与 testid 依据 .devflow/INTERFACE-r131.md。
import { test, expect } from '@playwright/test';
import {
  gotoHome, stubUsage, payload, dayEntry, sum4, fmtTokens, fmtInt, CARD_KEYS, TAB_TEXT, RANGE_TEXT,
  homeInput, usage, cards, card, cardValue, heatmap, tip, pickTab, pickRange, dayAgo, today, setPaneCount,
} from './helpers/ui.mjs';

const OPUS = 'claude-opus-4-1-20250805';
const SONNET = 'claude-sonnet-4-6';
const DEEP = 'deepseek-v3.2';

// 打桩夹具:四种天,两个模型(每个模型的四项 token 手算好,图例/占比的期望值都由这里推)
const TOK = {
  opus: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 40 },
  sonnet: { input: 500, output: 100, cacheRead: 60, cacheWrite: 0 },
  deep: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0 },
};
const row = (model, { input, output, cacheRead, cacheWrite, calls }) => ({ model, input, output, cacheRead, cacheWrite, calls, byPeriod: {} });
/** byDayModel:{ day: { model: 四项 + calls } }。 */
const dmOf = (day, models) => {
  const out = {};
  for (const [model, u] of Object.entries(models)) out[model] = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, calls: u.calls ?? 1 };
  return { [day]: out };
};
/** 一个"全部范围"的典型载荷:近 4 天有数据,今天两个模型。 */
function typical() {
  const days = [today(), dayAgo(1), dayAgo(3), dayAgo(10)];
  const oldDay = dayAgo(60);   // 只在"全部"范围里,用来区分 all 与 30d
  const t = (u, n = 1) => ({ input: u.input * n, output: u.output * n, cacheRead: u.cacheRead * n, cacheWrite: u.cacheWrite * n, calls: n });
  const byDay = [
    dayEntry(days[0], sum4(t(TOK.opus)) + sum4(t(TOK.sonnet)), { messages: 4, sessions: 1 }),
    dayEntry(days[1], sum4(t(TOK.opus, 2)), { messages: 2, sessions: 1 }),
    dayEntry(days[2], sum4(t(TOK.sonnet, 3)), { messages: 3, sessions: 1 }),
    dayEntry(days[3], sum4(t(TOK.deep, 5)), { messages: 5, sessions: 1 }),
    dayEntry(oldDay, sum4(t(TOK.deep, 5)), { messages: 5, sessions: 1 }),
  ];
  const byDayModel = {
    ...dmOf(days[0], { [OPUS]: t(TOK.opus), [SONNET]: t(TOK.sonnet) }),
    ...dmOf(days[1], { [OPUS]: t(TOK.opus, 2) }),
    ...dmOf(days[2], { [SONNET]: t(TOK.sonnet, 3) }),
    ...dmOf(days[3], { [DEEP]: t(TOK.deep, 5) }),
    ...dmOf(oldDay, { [DEEP]: t(TOK.deep, 5) }),
  };
  const byModel = [
    row(OPUS, { input: TOK.opus.input * 3, output: TOK.opus.output * 3, cacheRead: TOK.opus.cacheRead * 3, cacheWrite: TOK.opus.cacheWrite * 3, calls: 3 }),
    row(SONNET, { input: TOK.sonnet.input * 4, output: TOK.sonnet.output * 4, cacheRead: TOK.sonnet.cacheRead * 4, cacheWrite: 0, calls: 4 }),
    row(DEEP, { input: TOK.deep.input * 10, output: TOK.deep.output * 10, cacheRead: 0, cacheWrite: 0, calls: 10 }),
  ];
  // 7d / 30d:今天+昨天+3 天前在 7d 内,10 天前只在 30d 内。键必须是**真模型 id**(与 byModel 同源)
  const r7 = {
    [OPUS]: t(TOK.opus, 3),
    [SONNET]: t(TOK.sonnet, 4),
  };
  const r30 = { ...r7, [DEEP]: t(TOK.deep, 5) };
  const rangeOf = (bucket, daysIn, extra) => ({
    sessions: daysIn, messages: daysIn * 2,
    input: Object.values(bucket).reduce((s, u) => s + u.input, 0),
    output: Object.values(bucket).reduce((s, u) => s + u.output, 0),
    cacheRead: Object.values(bucket).reduce((s, u) => s + u.cacheRead, 0),
    cacheWrite: Object.values(bucket).reduce((s, u) => s + u.cacheWrite, 0),
    calls: Object.values(bucket).reduce((s, u) => s + u.calls, 0),
    activeDays: daysIn, firstDay: dayAgo(daysIn === 3 ? 3 : 10), lastActiveDay: today(),
    currentStreak: 2, longestStreak: 2, hourCounts: Array(24).fill(0), peakHour: 9, favoriteModel: OPUS,
    byModel: Object.entries(bucket).map(([m, u]) => row(m, u)),
    ...extra,
  });
  const ranges = { '7d': rangeOf(r7, 3), '30d': rangeOf(r30, 4) };
  // 全部口径 = 五天:3 会话(打桩值),19 条消息(4+2+3+5+5),5 个活跃天
  const totalAll = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const r of byDay) { totalAll.input += r.input; totalAll.output += r.output; totalAll.cacheRead += r.cacheRead; totalAll.cacheWrite += r.cacheWrite; }
  return payload({ total: { ...totalAll, sessionCount: 3 }, byDay, byModel, byDayModel, ranges, overview: { messages: 19, activeDays: 5, firstDay: oldDay, lastActiveDay: today(), currentStreak: 2, longestStreak: 2, hourCounts: [...Array(9).fill(0), 5, ...Array(14).fill(0)], peakHour: 9, favoriteModel: OPUS } });
}
const sum4of = (u) => sum4(u);
const legendRows = (page) => page.getByTestId('home-usage-legend-row');
const chartBars = (page) => page.getByTestId('home-usage-chart-bar');
const chart = (page) => page.getByTestId('home-usage-chart');
const rangeActive = (page) => page.locator('[data-testid^="home-usage-range-"][aria-pressed="true"]');
const tabActive = (page) => page.locator('[data-testid^="home-usage-tab-"][aria-selected="true"]');
const chartSvg = (page) => chart(page).locator('svg').first();

// ───────────── C1 顶部一行:分页 + 范围 ─────────────

test('C1a 用量块顶部一行:左「总览 | 模型」、右「全部 | 30 天 | 7 天」;默认选中「总览」+「全部」', async ({ page }) => {
  await stubUsage(page, typical());
  await gotoHome(page);
  await expect(cards(page), '默认分页应是总览(八卡可见)').toBeVisible();
  await expect(page.getByTestId('home-usage-tab-overview')).toHaveText(TAB_TEXT.overview);
  await expect(page.getByTestId('home-usage-tab-models')).toHaveText(TAB_TEXT.models);
  await expect(page.getByTestId('home-usage-range-all')).toHaveText(RANGE_TEXT.all);
  await expect(page.getByTestId('home-usage-range-30d')).toHaveText(RANGE_TEXT['30d']);
  await expect(page.getByTestId('home-usage-range-7d')).toHaveText(RANGE_TEXT['7d']);
  await expect(tabActive(page)).toHaveAttribute('data-testid', 'home-usage-tab-overview');
  await expect(rangeActive(page)).toHaveAttribute('data-testid', 'home-usage-range-all');
  // 左右分布:分页整体在范围整体左侧
  const tabs = await page.getByTestId('home-usage-tab-overview').boundingBox();
  const ranges = await page.getByTestId('home-usage-range-7d').boundingBox();
  expect(tabs.x + tabs.width).toBeLessThanOrEqual(ranges.x + 1);
  // 都在用量块内(不跑出 home-usage)
  const u = await usage(page).boundingBox();
  expect(tabs.y).toBeGreaterThanOrEqual(u.y - 1);
  expect(ranges.y + ranges.height).toBeLessThanOrEqual(u.y + u.height + 1);
});

test('C1b 分页与范围选中态记在 localStorage(cgui- 前缀键),刷新后保留', async ({ page }) => {
  await stubUsage(page, typical());
  await gotoHome(page);
  await pickTab(page, 'models');
  await pickRange(page, '7d');
  await expect(chart(page)).toBeVisible();
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('cgui-')));
  expect(keys.some((k) => /usage/i.test(k)), `应有用量视图偏好键(cgui- 前缀);实际:${keys.join(',')}`).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(chart(page), '刷新后仍在模型分页').toBeVisible({ timeout: 20_000 });
  await expect(rangeActive(page), '刷新后仍是 7 天').toHaveAttribute('data-testid', 'home-usage-range-7d');
  await expect(page.getByTestId('home-usage-tab-models')).toHaveAttribute('aria-selected', 'true');
});

// ───────────── C2 分页切换 ─────────────

test('C2a 切到「模型」:八卡与热力图不显示,堆叠柱状图 + 图例显示;切回「总览」恢复,样式不变', async ({ page }) => {
  await stubUsage(page, typical());
  await gotoHome(page);
  await expect(cards(page)).toBeVisible();
  await expect(heatmap(page)).toBeVisible();
  await pickTab(page, 'models');
  await expect(chart(page)).toBeVisible();
  await expect(legendRows(page).first()).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
  await expect(heatmap(page)).toHaveCount(0);
  await expect(tip(page), '模型分页不该留着热力图浮层').toHaveCount(0);
  await pickTab(page, 'overview');
  await expect(cards(page), '切回总览后八卡回来').toBeVisible();
  await expect(heatmap(page)).toBeVisible();
  await expect(chart(page)).toHaveCount(0);
  await expect(card(page, 'sessions')).toHaveAttribute('data-value', '3');
});

// ───────────── C3 范围切换:只改数字,图不裁 ─────────────

test('C3a 范围切换只重算数字:八卡随范围变(7 天 ≤ 30 天 ≤ 全部),卡片结构不变', async ({ page }) => {
  await stubUsage(page, typical());
  await gotoHome(page);
  const bodyTotalTokens = (() => { const b = typical(); return b.byDay.reduce((s, r) => s + sum4(r), 0); })();
  const snapshot = async () => Object.fromEntries(await Promise.all(CARD_KEYS.map(async (k) => [k, await cardValue(page, k)])));
  const all = await snapshot();
  await pickRange(page, '30d');
  const d30 = await snapshot();
  await pickRange(page, '7d');
  const d7 = await snapshot();
  expect(Number(d7.messages.dataValue), `7 天消息数应小于全部(${d7.messages.dataValue} vs ${all.messages.dataValue})`).toBeLessThan(Number(all.messages.dataValue));
  expect(Number(d30.messages.dataValue)).toBeLessThanOrEqual(Number(all.messages.dataValue));
  expect(Number(d7.tokens.dataValue), '7 天总 token 是全部口径的子集').toBeLessThan(Number(all.tokens.dataValue));
  expect(Number(all.tokens.dataValue), '全部口径总 token = byDay 五天四项合计').toBe(bodyTotalTokens);
  expect(d7.tokens.text, '总 token 仍走四档缩写').toBe(fmtTokens(Number(d7.tokens.dataValue)));
  expect(Number(d7['active-days'].dataValue), '7d:今天/昨天/3 天前').toBe(3);
  expect(Number(d30['active-days'].dataValue), '30d:再加 10 天前').toBe(4);
  expect(Number(all['active-days'].dataValue), '全部:再加 60 天前').toBe(5);
  expect(d7.sessions.dataValue, '会话数按范围重算').not.toBe('');
  for (const k of CARD_KEYS) expect(d7[k].whole.length, `卡片 ${k} 仍在`).toBeGreaterThan(0);
  await pickRange(page, 'all');
  const again = await snapshot();
  expect(again.messages.dataValue, '切回全部后数字复原').toBe(all.messages.dataValue);
});

test('C3b 范围切换不裁图:热力图(周数、格子数、data-weeks)与堆叠柱状图的柱子分布在三个范围内逐字不变', async ({ page }) => {
  await stubUsage(page, typical());
  await gotoHome(page);
  const heatSig = () => heatmap(page).evaluate((root) => ({ weeks: root.getAttribute('data-weeks'), cells: root.querySelectorAll('[data-testid="home-usage-cell"]').length, days: [...root.querySelectorAll('[data-testid="home-usage-cell"]')].map((e) => e.getAttribute('data-day')).join(',') }));
  const before = await heatSig();
  for (const r of ['30d', '7d', 'all']) await pickRange(page, r);
  expect(await heatSig(), '热力图不随范围裁').toEqual(before);
  // 模型分页的柱子也不裁
  await pickTab(page, 'models');
  const barSig = () => chart(page).evaluate((root) => [...root.querySelectorAll('[data-testid="home-usage-chart-bar"]')].map((b) => `${b.getAttribute('data-day')}:${b.getAttribute('data-total')}`).join('|'));
  const barsAll = await barSig();
  await pickRange(page, '7d');
  expect(await barSig(), '堆叠柱状图不随范围裁').toBe(barsAll);
  await pickRange(page, '30d');
  expect(await barSig()).toBe(barsAll);
  expect(await chartBars(page).count(), '仍有那几天的柱子').toBeGreaterThanOrEqual(4);
});

// ───────────── C4 模型分页:图例 ─────────────

test('C4a 图例每行 = 色块 + 模型短名 + in/out + 占比 + 费用;按占比降序;data-share 与 data-model 可核', async ({ page }) => {
  await stubUsage(page, typical());
  await gotoHome(page);
  await pickTab(page, 'models');
  const n = await legendRows(page).count();
  expect(n, '全部范围下三个模型各一行').toBe(3);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const r = legendRows(page).nth(i);
    rows.push({
      model: await r.getAttribute('data-model'),
      share: Number(await r.getAttribute('data-share')),
      block: await r.getAttribute('data-block'),
      text: (await r.innerText()).replace(/\s+/g, ' ').trim(),
    });
  }
  // 手算(全部口径):opus 1540×3=4620、sonnet 660×4=2640、deep 250×10=2500
  const totals = { [OPUS]: 4620, [SONNET]: 2640, [DEEP]: 2500 };
  const grand = 4620 + 2640 + 2500;
  expect(rows.map((r) => r.model), '按占比降序').toEqual([OPUS, SONNET, DEEP]);
  expect(rows[0].share).toBeCloseTo((4620 / grand) * 100, 1);
  expect(rows[1].share).toBeCloseTo((2640 / grand) * 100, 1);
  expect(rows[2].share).toBeCloseTo((2500 / grand) * 100, 1);
  // 短名:8 位日期后缀去掉
  expect(rows[0].text).toContain('claude-opus-4-1');
  expect(rows[0].text, 'in/out 只列输入与输出两项').toContain(`${fmtTokens(3000)} in · ${fmtTokens(600)} out`);
  expect(rows[0].text).toMatch(/\d+(\.\d+)?%/);
  expect(rows[0].text, '占比行含金额或占位(费用列)').toMatch(/[¥$]|—|订阅内/);
  expect(rows[0].block, '每行有色块').toBeTruthy();
  expect(new Set(rows.map((r) => r.block)).size, '三个色块深浅不同').toBe(3);
  expect(totals[OPUS]).toBeGreaterThan(totals[SONNET]);
});

test('C4b 范围切换重算图例数字与占比(只改数字,行集合与顺序可不变)', async ({ page }) => {
  await stubUsage(page, typical());
  await gotoHome(page);
  await pickTab(page, 'models');
  const read = async () => {
    const out = {};
    for (let i = 0; i < await legendRows(page).count(); i += 1) {
      const r = legendRows(page).nth(i);
      out[await r.getAttribute('data-model')] = { share: Number(await r.getAttribute('data-share')), text: (await r.innerText()).replace(/\s+/g, ' ') };
    }
    return out;
  };
  const all = await read();
  await pickRange(page, '7d');
  const d7 = await read();
  expect(d7[DEEP], '10 天前的 deepseek 只在 30d 内 → 7d 不出现').toBeUndefined();
  expect(d7[OPUS].share, '7d 里只有两个模型:占比按 7d 内部重算').toBeCloseTo((4620 / (4620 + 2640)) * 100, 1);
  expect(all[OPUS].share).toBeCloseTo((4620 / (4620 + 2640 + 2500)) * 100, 1);
  expect(d7[OPUS].text).toContain(`${fmtTokens(3000)} in · ${fmtTokens(600)} out`);
  await pickRange(page, '30d');
  const d30 = await read();
  expect(d30[DEEP], '30d 里 deepseek 回来(10 天前那 5 笔)').toBeTruthy();
  // 30d 内 deep 只有 10 天前那 5 笔(60 天前那 5 笔在窗外),所以 30d 的占比也按窗口内部重算 ——
  // 与"全部"口径**不该**相等(相等反而说明范围没生效)
  expect(d30[DEEP].share).toBeCloseTo((1250 / (4620 + 2640 + 1250)) * 100, 1);
  expect(d30[OPUS].share).toBeCloseTo((4620 / (4620 + 2640 + 1250)) * 100, 1);
  expect(Math.abs(d30[OPUS].share - all[OPUS].share), '30d 与全部口径不同(窗口外还有 60 天前那 5 笔)').toBeGreaterThan(1);
});

test('C4c 图例默认 6 行,「显示其余 N 个」展开后全部可见,再点收起', async ({ page }) => {
  const models = Array.from({ length: 11 }, (_, i) => `model-${String(i).padStart(2, '0')}-20250101`);
  const byModel = models.map((m, i) => row(m, { input: (11 - i) * 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 }));
  const byDayModel = { [today()]: Object.fromEntries(models.map((m, i) => [m, { input: (11 - i) * 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 }])) };
  await stubUsage(page, payload({
    total: { sessionCount: 1 },
    byDay: [dayEntry(today(), byModel.reduce((s, m) => s + m.input, 0))],
    byModel, byDayModel,
    ranges: { '7d': { sessions: 1, messages: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, activeDays: 1, firstDay: today(), lastActiveDay: today(), currentStreak: 1, longestStreak: 1, hourCounts: Array(24).fill(0), peakHour: null, favoriteModel: models[0], byModel }, '30d': { sessions: 1, messages: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, activeDays: 1, firstDay: today(), lastActiveDay: today(), currentStreak: 1, longestStreak: 1, hourCounts: Array(24).fill(0), peakHour: null, favoriteModel: models[0], byModel } },
  }));
  await gotoHome(page);
  await pickTab(page, 'models');
  await expect(legendRows(page), '默认只显示 6 行').toHaveCount(6);
  const more = page.getByTestId('home-usage-legend-more');
  await expect(more).toHaveText('显示其余 5 个');
  await more.click();
  await expect(legendRows(page), '展开后 11 行全在').toHaveCount(11);
  await expect(page.getByTestId('home-usage-legend-more')).toHaveText('收起');
  await page.getByTestId('home-usage-legend-more').click();
  await expect(legendRows(page)).toHaveCount(6);
});

test('C4d 模型短名:去掉 8 位日期后缀、超长名字截断(truncate)且 title 是完整显示名', async ({ page }) => {
  // 后缀必须是**8 位**数字 —— shortModelName 只剥 -\d{8}$(与 ModelBadge.jsx 同一正则)
  const long = 'very-long-model-name-that-should-be-truncated-in-the-legend-20250101';
  const short = 'very-long-model-name-that-should-be-truncated-in-the-legend';
  await stubUsage(page, payload({
    total: { sessionCount: 1 },
    byDay: [dayEntry(today(), 1000)],
    byModel: [row(long, { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 })],
    byDayModel: { [today()]: { [long]: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 } } },
  }));
  await gotoHome(page);
  await pickTab(page, 'models');
  const r = legendRows(page).first();
  const name = r.locator('[data-testid="home-usage-legend-name"]');
  await expect(name).toHaveAttribute('title', long);
  await expect(name).toHaveText(short);
  expect(await name.evaluate((el) => el.classList.contains('truncate')), '名字必须 truncate').toBe(true);
});

// ───────────── C5 模型分页:堆叠柱状图 ─────────────

test('C5a 每天一根柱,柱子 data-day / data-total 与后端 byDayModel 对齐;按模型分段堆叠,总高一致', async ({ page }) => {
  const body = typical();
  await stubUsage(page, body);
  await gotoHome(page);
  await pickTab(page, 'models');
  await expect(chartBars(page)).toHaveCount(body.byDay.length);
  const days = body.byDay.map((r) => r.day).reverse();   // 图从左到右 = 早 → 晚
  const got = await chartBars(page).evaluateAll((els) => els.map((e) => ({ day: e.getAttribute('data-day'), total: Number(e.getAttribute('data-total')), segments: e.querySelectorAll('[data-segment-model]').length })));
  expect(got.map((g) => g.day)).toEqual(days);
  for (const [i, r] of body.byDay.entries()) {
    const day = r.day;
    const g = got.find((x) => x.day === day);
    const perModel = body.byDayModel[day];
    // 柱高口径 = 当天**所有模型的输入 + 输出**(不是四项合计;缓存读写不堆进柱子)
    const inOut = Object.values(perModel).reduce((acc, u) => acc + u.input + u.output, 0);
    expect(g.total, `柱子 ${day} 的 data-total = 当天所有模型的输入+输出`).toBe(inOut);
    expect(g.segments, `柱子 ${day} 的段数 = 当天模型数`).toBe(Object.keys(perModel).length);
  }
  // 堆叠:同柱各段 x 相同、y 递减且不重叠,总高 = 各段高之和
  const geom = await chartBars(page).first().evaluate((bar) => {
    const segs = [...bar.querySelectorAll('[data-segment-model]')].map((s) => s.getBoundingClientRect()).sort((a, b) => a.y - b.y);
    return { sameX: new Set(segs.map((s) => Math.round(s.x))).size === 1, noOverlap: segs.every((s, i) => i === 0 || s.y >= segs[i - 1].y + segs[i - 1].height - 1), sumH: segs.reduce((n, s) => n + s.height, 0), barH: bar.getBoundingClientRect().height };
  });
  expect(geom.sameX, '同柱各段左边界相同').toBe(true);
  expect(geom.noOverlap, '各段不重叠(垂直堆叠)').toBe(true);
  expect(geom.sumH).toBeLessThanOrEqual(geom.barH + 2);
});

test('C5b y 轴刻度 4–5 个且用缩写(≥1e6 出 M / ≥1e9 出 B),x 轴日期标签约每两周一个', async ({ page }) => {
  // 造 60 天的连续数据。注意 y 轴顶格 = **单日堆叠合计**(每天各模型加起来),不是历史累计 ——
  // 所以这里要单日就够大(每天 1.2B)才能出 B 档刻度。
  const days = Array.from({ length: 60 }, (_, i) => dayAgo(59 - i));
  const per = 400_000_000;   // 一天两个模型共 1.2B;60 天累计 72B
  const byDay = days.map((d) => dayEntry(d, per));
  const byDayModel = Object.fromEntries(days.map((d) => [d, {
    'big-20250101': { input: per, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
    'big-2-20250101': { input: per, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
    'big-3-20250101': { input: per, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
  }]));
  await stubUsage(page, payload({ total: { sessionCount: 1 }, byDay, byDayModel, byModel: [row('big-20250101', { input: per * 60, output: 0, cacheRead: 0, cacheWrite: 0, calls: 60 })] }));
  await gotoHome(page);
  await pickTab(page, 'models');
  const ticks = page.getByTestId('home-usage-chart-ytick');
  const n = await ticks.count();
  expect(n, 'y 轴 4–5 个刻度').toBeGreaterThanOrEqual(4);
  expect(n).toBeLessThanOrEqual(5);
  const texts = await ticks.allInnerTexts();
  expect(texts.every((t) => /^\d+(\.\d)?[KMB]$|^0$/.test(t.trim())), `刻度应是缩写:${texts.join(' / ')}`).toBe(true);
  expect(texts.some((t) => /B$/.test(t.trim())), `单日堆叠 1.2B → 应有 B 档刻度;实际 ${texts.join(' / ')}`).toBe(true);
  expect(texts[0].trim(), '第一个刻度是 0').toBe('0');
  // x 轴:约每两周一个标签
  const xs = page.getByTestId('home-usage-chart-xtick');
  const xn = await xs.count();
  expect(xn).toBeGreaterThanOrEqual(3);
  expect(xn).toBeLessThanOrEqual(6);
  const labels = (await xs.allInnerTexts()).map((t) => t.trim());
  expect(labels.every((t) => /^\d{1,2}\/\d{1,2}$/.test(t)), `日期标签形如 9/29:${labels.join(' / ')}`).toBe(true);
  // 量**标签中心**的间距:标签宽度不一("8/15" vs "10/1"),用左边缘会把宽度差算进间隔里
  const spacing = await xs.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.x + r.width / 2; }).sort((a, b) => a - b));
  const gaps = spacing.slice(1).map((x, i) => Math.round(x - spacing[i]));
  expect(gaps.every((g) => g > 0), `标签从左到右递增:${gaps.join(',')}`).toBe(true);
  // 等距:各间隔两两相差 ≤ 1px(布局取整的固有误差;要求逐像素完全相等是在测浏览器舍入)
  expect(Math.max(...gaps) - Math.min(...gaps), `标签等距(±1px),实际间隔 ${gaps.join(',')}`).toBeLessThanOrEqual(1);
});

test('C5c 悬停柱子出浮层:日期 + 当天合计 + 当天各模型 token(鼠标进显示、离开隐藏);柱子无原生 title', async ({ page }) => {
  const body = typical();
  await stubUsage(page, body);
  await gotoHome(page);
  await pickTab(page, 'models');
  const d0 = body.byDay[0].day;   // 今天:opus + sonnet 两个模型
  const bar = page.locator(`[data-testid="home-usage-chart-bar"][data-day="${d0}"]`);
  await bar.hover();
  const t = page.getByTestId('home-usage-chart-tip');
  await expect(t).toBeVisible();
  const text = (await t.innerText()).replace(/\s+/g, ' ');
  expect(text, '浮层第一行 = 日期 + 当天合计').toContain(d0);
  // 柱高/浮层合计 = 当天**输入 + 输出**(缓存读写不堆进柱子:浮层里逐行给的就是 in+out,
  // 合计必须等于逐行之和,否则两行数字加起来对不上头顶那个总数)
  const inOut0 = Object.values(body.byDayModel[d0]).reduce((acc, u) => acc + u.input + u.output, 0);
  expect(text).toContain(`${fmtInt(inOut0)} tokens`);
  for (const [model, u] of Object.entries(body.byDayModel[d0])) {
    expect(text, `浮层应含模型 ${model} 的短名`).toContain(model.replace(/-\d{8}$/, ''));
    // 浮层每行只给**输入 + 输出**两项(四项合计 = 柱子高度,图例里另有 in / out 两列)
    expect(text, `模型 ${model} 的输入+输出`).toContain(fmtInt(u.input + u.output));
  }
  await page.mouse.move(0, 0);
  await expect(t).toBeHidden();
  expect(await bar.getAttribute('title'), '柱子不设原生 title(浮层是唯一出口)').toBeNull();
  expect(await chartBars(page).first().getAttribute('title')).toBeNull();
});

test('C5d tap(触屏上下文,375×812)点柱子 → 由 click 显示并钉住浮层;点柱外关闭', async ({ browser }) => {
  const body = typical();
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 375, height: 812 }, baseURL: process.env.R131_UI_BASE, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await ctx.newPage();
  try {
    await stubUsage(page, body);
    await gotoHome(page);
    await pickTab(page, 'models');
    const d0 = body.byDay[0].day;
    await page.locator(`[data-testid="home-usage-chart-bar"][data-day="${d0}"]`).tap();
    const t = page.getByTestId('home-usage-chart-tip');
    await expect(t).toBeVisible();
    await page.getByTestId('home-usage-tab-models').tap();
    await expect(t, '点浮层外应关闭').toBeHidden();
  } finally { await ctx.close(); }
});

// ───────────── C6 375px 窄屏 ─────────────

// 375px 下图例名(11px 字号)的可见宽度下限:低于它连 "claude-" 前缀都读不全,用户无从区分 opus / sonnet。
const MIN_NAME_W = 40;

test('C6a 375×812:整页不横滚、柱状图不超容器、图例每行不溢出、长模型名真被裁(title 完整)、输入框在视口内', async ({ browser }) => {
  // 夹具三行图例:第一行的模型 id 去掉 8 位日期后缀后仍 45 字符 → 375px 下必然宽于可用列宽,
  // 于是"被裁"是可证的(而不是只看 class 名)。后两行是真 Claude / 第三方短名做对照。
  const LONG = 'claude-opus-4-1-experimental-long-variant-name-20250805';
  const t = (u, n = 1) => ({ input: u.input * n, output: u.output * n, cacheRead: u.cacheRead * n, cacheWrite: u.cacheWrite * n, calls: n });
  const day0 = today();
  const byModel = [row(LONG, t(TOK.opus, 6)), row(OPUS, t(TOK.opus, 2)), row(DEEP, t(TOK.deep, 1))];
  const byDayModel = dmOf(day0, { [LONG]: t(TOK.opus, 6), [OPUS]: t(TOK.opus, 2), [DEEP]: t(TOK.deep, 1) });
  const byDay = [dayEntry(day0, sum4(t(TOK.opus, 6)) + sum4(t(TOK.opus, 2)) + sum4(t(TOK.deep, 1)), { messages: 3, sessions: 1 })];
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: process.env.R131_UI_BASE, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await ctx.newPage();
  try {
    await stubUsage(page, payload({ total: { sessionCount: 1 }, byDay, byModel, byDayModel }));
    await gotoHome(page);
    await pickTab(page, 'models');
    const rows = legendRows(page);
    await expect(rows, '夹具三个模型各一行').toHaveCount(3);
    await expect(chartSvg(page)).toBeVisible();

    // ① 整页不横滚(html 与 body 都量,避免只压住其中一个)
    const doc = await page.evaluate(() => ({ hsw: document.documentElement.scrollWidth, bsw: document.body.scrollWidth, iw: innerWidth }));
    expect(doc.hsw, `整页不该横滚:documentElement.scrollWidth ${doc.hsw} ≤ innerWidth ${doc.iw}`).toBeLessThanOrEqual(doc.iw);
    expect(doc.bsw, `body 不该横滚:body.scrollWidth ${doc.bsw} ≤ innerWidth ${doc.iw}`).toBeLessThanOrEqual(doc.iw);

    // ② 柱状图宽度 ≤ 容器宽度,且左右两缘都落在用量块里;同时不能被压塌(要"压到容器宽"而不是留一条缝)
    const [u, svg, wrap] = await Promise.all([usage(page).boundingBox(), chartSvg(page).boundingBox(), chart(page).boundingBox()]);
    expect(u.x + u.width, `用量块右缘 ${(u.x + u.width).toFixed(1)} 也在视口内(≤ ${doc.iw})`).toBeLessThanOrEqual(doc.iw + 1);
    expect(svg.width, `SVG 宽 ${svg.width.toFixed(1)} ≤ 用量块宽 ${u.width.toFixed(1)}(+1px 子像素)`).toBeLessThanOrEqual(u.width + 1);
    expect(svg.width, `SVG 宽 ${svg.width.toFixed(1)} 应占到容器宽 ${u.width.toFixed(1)} 的 75% 以上(压到容器宽,不是塌成一条)`).toBeGreaterThan(u.width * 0.75);
    expect(svg.x, `SVG 左缘 ${svg.x.toFixed(1)} 不超出用量块左缘 ${u.x.toFixed(1)}`).toBeGreaterThanOrEqual(u.x - 1);
    expect(svg.x + svg.width, `SVG 右缘 ${(svg.x + svg.width).toFixed(1)} 不超出用量块右缘 ${(u.x + u.width).toFixed(1)}`).toBeLessThanOrEqual(u.x + u.width + 1);
    expect(wrap.x + wrap.width, '图表容器右缘不超出用量块').toBeLessThanOrEqual(u.x + u.width + 1);

    // ③ 图例每一行都不溢出它的容器:行矩形 ⊆ legend 矩形,且行内内容不撑出行的 content box
    const legendBox = await page.getByTestId('home-usage-legend').boundingBox();
    const data = await rows.evaluateAll((els) => els.map((el) => {
      const name = el.querySelector('[data-testid="home-usage-legend-name"]');
      const rb = el.getBoundingClientRect(); const nb = name.getBoundingClientRect();
      return {
        model: el.getAttribute('data-model'),
        rowOverflow: el.scrollWidth - el.clientWidth,
        rowLeft: rb.left, rowRight: rb.right,
        nameW: name.clientWidth, nameScrollW: name.scrollWidth, nameRight: nb.right,
        title: name.getAttribute('title'),
      };
    }));
    for (const d of data) {
      expect(d.rowLeft, `行 ${d.model} 左缘不超出图例容器`).toBeGreaterThanOrEqual(legendBox.x - 1);
      expect(d.rowRight, `行 ${d.model} 右缘 ${d.rowRight.toFixed(1)} 不超出图例容器右缘 ${(legendBox.x + legendBox.width).toFixed(1)}`).toBeLessThanOrEqual(legendBox.x + legendBox.width + 1);
      expect(d.rowOverflow, `行 ${d.model} 内容不溢出(scrollWidth - clientWidth = ${d.rowOverflow}px)`).toBeLessThanOrEqual(1);
      expect(d.nameRight, `行 ${d.model} 的模型名右缘不撑出行`).toBeLessThanOrEqual(d.rowRight + 1);
      // ④ 模型名的可见宽度是正数且 ≥ 40px:11px 字号一个字符约 5.5–6.5px,40px ≈ 6–7 个字符,
      //    刚好读全 "claude-" 前缀;再窄只剩 4 个字符,区分不了 opus / sonnet。
      expect(d.nameW, `模型名可见宽度 ${d.nameW}px 必须 ≥ ${MIN_NAME_W}px(${d.model})`).toBeGreaterThanOrEqual(MIN_NAME_W);
    }

    // ⑤ 名字长于可用宽度时真的被裁:先用"同字体的量具"证明完整短名确实放不下(前提非空),再看裁切结果
    expect(data[0].model, '按占比降序:长名模型应排第一行').toBe(LONG);
    const longRow = data[0];
    const longShort = LONG.replace(/-\d{8}$/, '');
    const naturalW = await rows.nth(0).locator('[data-testid="home-usage-legend-name"]').evaluate((el, shortName) => {
      const cs = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.style.position = 'absolute'; probe.style.left = '-10000px'; probe.style.top = '0'; probe.style.whiteSpace = 'nowrap';
      probe.style.fontFamily = cs.fontFamily; probe.style.fontSize = cs.fontSize; probe.style.fontWeight = cs.fontWeight;
      probe.style.fontStyle = cs.fontStyle; probe.style.letterSpacing = cs.letterSpacing; probe.style.wordSpacing = cs.wordSpacing;
      probe.textContent = shortName;
      (document.body || document.documentElement).appendChild(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    }, longShort);
    expect(naturalW, `前提:完整短名「${longShort}」(${longShort.length} 字符,自然宽 ${naturalW.toFixed(1)}px)确实放不下 ${longRow.nameW}px 的列`).toBeGreaterThan(longRow.nameW);
    expect(longRow.nameScrollW, `长名必须真被裁:scrollWidth ${longRow.nameScrollW} > clientWidth ${longRow.nameW}`).toBeGreaterThan(longRow.nameW + 1);
    expect(longRow.title, 'title 是完整模型 id(不是短名)').toBe(LONG);
    expect(data.some((d) => d.nameScrollW > d.nameW + 1), '夹具里至少有一行真的被裁').toBe(true);

    // ⑥ 输入框整个矩形都在视口内(不是只有一点露在视口里)
    const ib = await homeInput(page).boundingBox();
    expect(ib, '输入框应有几何矩形(在视口内)').not.toBeNull();
    expect(ib.x, `输入框左缘 ${ib.x.toFixed(1)} 在视口内`).toBeGreaterThanOrEqual(-1);
    expect(ib.x + ib.width, `输入框右缘 ${(ib.x + ib.width).toFixed(1)} ≤ 视口宽 375`).toBeLessThanOrEqual(375 + 1);
    expect(ib.y, `输入框上缘 ${ib.y.toFixed(1)} 在视口内`).toBeGreaterThanOrEqual(-1);
    expect(ib.y + ib.height, `输入框下缘 ${(ib.y + ib.height).toFixed(1)} ≤ 视口高 812`).toBeLessThanOrEqual(812 + 1);
  } finally { await ctx.close(); }
});

test('C6b 375×812:总览分页八卡仍两列,热力图仍在,页面不横滚', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: process.env.R131_UI_BASE, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await ctx.newPage();
  try {
    await stubUsage(page, typical());
    await gotoHome(page);
    await expect(cards(page)).toHaveAttribute('data-cols', '2');
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight }));
    expect(m.sw).toBeLessThanOrEqual(m.iw);
    expect(m.sh, '单屏首页整页不滚(溢出在图区内部滚)').toBeLessThanOrEqual(m.ih);
  } finally { await ctx.close(); }
});

// C4a 已确立的"费用列可见形式":金额(¥/$)或占位(「—」/「订阅内」)。
const FEE_COL_RE = /[¥$]|—|订阅内/;

test('C6c 费用列:窄屏(<640px)收进图例行的 title,宽屏(1440×900)在行内看得见', async ({ browser }) => {
  // 同一个载荷、只换视口宽度。三行覆盖费用列的三种可见形式(INTERFACE §C3):
  //   OPUS   = Claude + 订阅态 → 占位「订阅内」(按量计费的机器上会是金额,所以不钉死这一行)
  //   PRICED = 非 Claude + 官方价目表里有单价 → 必须显示真实金额(¥…),证明宽屏不是只会显示占位
  //   FREE   = 查不到价目 → 占位「—」
  // 375px 放不下「色块 + 名称 + in/out + 占比 + 费用」五列 → 费用列收起;1440px 必须回到行内。
  const PRICED = 'deepseek-chat';
  const FREE = 'third-party-model-no-pricing-20250101';
  const defs = [
    { model: OPUS, input: 1_200_000, output: 300_000, calls: 1 },
    { model: PRICED, input: 1_200_000, output: 300_000, calls: 1 },
    { model: FREE, input: 4_000, output: 1_000, calls: 1 },
  ];
  const day0 = today();
  const byModel = defs.map((d) => row(d.model, { input: d.input, output: d.output, cacheRead: 0, cacheWrite: 0, calls: d.calls }));
  const byDayModel = dmOf(day0, Object.fromEntries(defs.map((d) => [d.model, { input: d.input, output: d.output, cacheRead: 0, cacheWrite: 0, calls: d.calls }])));
  const byDay = [dayEntry(day0, defs.reduce((s, d) => s + d.input + d.output, 0), { messages: 2, sessions: 1 })];
  const body = payload({ total: { sessionCount: 1 }, byDay, byModel, byDayModel });
  const open = async (viewport) => {
    const ctx = await browser.newContext({ viewport, baseURL: process.env.R131_UI_BASE, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
    const page = await ctx.newPage();
    await stubUsage(page, body);
    await gotoHome(page);
    await pickTab(page, 'models');
    await expect(legendRows(page)).toHaveCount(defs.length);
    return { ctx, page };
  };
  // 行的可见文本(innerText 不含 display:none 的内容)与 title(悬浮 / 长按能看到的那份)
  const readRows = (page) => legendRows(page).evaluateAll((els) => els.map((el) => ({
    model: el.getAttribute('data-model'),
    inner: (el.innerText || '').replace(/\s+/g, ' ').trim(),
    title: el.getAttribute('title') || '',
  })));
  // 窄屏 375×812:行内看不到费用,完整信息(模型 id + 输入 + 输出 + 占比)在行 title 里
  {
    const narrow = await open({ width: 375, height: 812 });
    try {
      const got = await readRows(narrow.page);
      for (const r of got) {
        const exp = defs.find((d) => d.model === r.model);
        expect(exp, `窄屏行 ${r.model} 应是夹具里的模型`).toBeTruthy();
        expect(r.inner, `375px 行内不该出现金额/占位(费用列应收起):「${r.inner}」`).not.toMatch(FEE_COL_RE);
        expect(r.title, `行 title 要有完整模型 id(实际「${r.title}」)`).toContain(r.model);
        expect(r.title, `行 title 要有输入 ${fmtTokens(exp.input)} in`).toContain(`${fmtTokens(exp.input)} in`);
        expect(r.title, `行 title 要有输出 ${fmtTokens(exp.output)} out`).toContain(`${fmtTokens(exp.output)} out`);
        expect(r.title, `行 title 要有占比(实际「${r.title}」)`).toMatch(/\d+(\.\d+)?%/);
        // 费用列收起 ≠ 费用没有出口:窄屏时金额(或它的占位文字)必须在 title 里,
        // 否则用户在 375px 上根本看不到这个模型花了多少钱(费用列本来就是这个分页的目的之一)。
        expect(r.title, `窄屏 title 里必须有费用或它的占位文字(实际「${r.title}」)`)
          .toMatch(/[¥$]|订阅内|无定价数据/);
      }
    } finally { await narrow.ctx.close(); }
  }

  // 宽屏 1440×900:费用列回到行内可见
  {
    const wide = await open({ width: 1440, height: 900 });
    try {
      const got = await readRows(wide.page);
      for (const r of got) {
        expect(r.inner, `1440px 行内必须看得见金额或占位(实际「${r.inner}」)`).toMatch(FEE_COL_RE);
      }
      const priced = got.find((r) => r.model === PRICED);
      const free = got.find((r) => r.model === FREE);
      expect(priced.inner, `有单价的模型在宽屏行内要显示真实金额(不是占位):「${priced.inner}」`).toMatch(/[¥$]/);
      expect(free.inner, `查不到价目的模型在宽屏行内要显示占位文字:「${free.inner}」`).toMatch(/—|订阅内/);
    } finally { await wide.ctx.close(); }
  }
});

// ───────────── C7 不变项 ─────────────

test('C7a 切分页 / 切范围不发新请求(数据一次到手)', async ({ page }) => {
  const st = await stubUsage(page, typical());
  await gotoHome(page);
  await expect(cards(page)).toBeVisible();
  const n0 = st.hits.length;
  await pickRange(page, '30d');
  await pickRange(page, '7d');
  await pickTab(page, 'models');
  await pickTab(page, 'overview');
  await pickRange(page, 'all');
  await page.waitForTimeout(1200);
  expect(st.hits.length, '分页/范围切换不许触发 /api/usage').toBe(n0);
});

test('C7b 分屏(paneCount>1):整个用量块(含分页与范围)消失;回单屏后仍是模型分页', async ({ page }) => {
  await stubUsage(page, typical());
  await gotoHome(page);
  await pickTab(page, 'models');
  await expect(chart(page)).toBeVisible();
  await setPaneCount(page, 2);
  await expect(usage(page)).toHaveCount(0, { timeout: 3000 });
  await expect(page.getByTestId('home-usage-tab-models')).toHaveCount(0);
  await setPaneCount(page, 1);
  await expect(usage(page)).toBeVisible({ timeout: 8000 });
  await expect(chart(page), '回单屏后选中态还是模型分页').toBeVisible();
});

test('C7c 旧响应(没有 byDayModel / ranges 根键)也不崩:图还在,按天/按窗口的模型明细**不编造**', async ({ page }) => {
  // 注意:payload() 传 byDayModel/ranges 为 null 只是"不覆盖",helper 还会**自动生成**一份
  // (dayModelOf / rangesOf)—— 那是假的新响应,不是旧响应。要造真的旧响应必须把两个键删掉。
  const oldShape = payload({ total: { sessionCount: 2 }, byDay: [dayEntry(today(), 1000), dayEntry(dayAgo(2), 500)] });
  delete oldShape.byDayModel; delete oldShape.ranges;
  await stubUsage(page, oldShape);
  await gotoHome(page);
  await expect(cards(page)).toBeVisible();
  await pickTab(page, 'models');
  // 图还在(柱高退回 byDay 的每日合计,单序列),但这条序列**不许**冒充某个模型:
  // 以前挂的是全量第一名模型的名字,浮层会把"当天全量"读成那个模型的数(= 编造归属,
  // 跨平台审查 0.2.401 建议-2)。现在必须是明确的"合计(无模型明细)"。
  await expect(chart(page)).toBeVisible();
  await expect(chartBars(page).first()).toBeVisible();
  await chartBars(page).first().hover();
  const ctip = page.getByTestId('home-usage-chart-tip');
  await expect(ctip, '兜底序列的浮层要可见').toBeVisible();
  await expect(ctip, '兜底序列必须写明"没有模型明细"').toContainText('合计(无模型明细)');
  for (const m of oldShape.byModel.map((x) => x.model)) {
    await expect(ctip, `兜底序列的浮层不许出现真实模型 ${m}`).not.toContainText(m);
  }
  await page.keyboard.press('Escape');
  // 根上的 byModel 是**既有字段**(旧响应一直有),图例按它渲染是对的;但它只有一个全局数字,
  // 不带分时段桶 → 占比 100% 是"这个响应的真实能给出的信息",不算编造。
  // 真正不许编造的是:**按天 / 按窗口**的模型分组(byDayModel / ranges 缺了就不给假的)。
  const names = await legendRows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-model')));
  expect(names, '图例的模型来自根 byModel(旧响应也有),不允许凭空出现别的模型').toEqual(
    oldShape.byModel.map((m) => m.model),
  );
  await expect(page.getByTestId('home-usage-error')).toHaveCount(0);
});

test('C7d 旧响应缺 ranges 时切范围:卡片数字走前端兜底(不崩、不发新请求)', async ({ page }) => {
  const oldShape = payload({ total: { sessionCount: 2 }, byDay: [dayEntry(today(), 1000, { messages: 4 }), dayEntry(dayAgo(2), 500, { messages: 3 })] });
  delete oldShape.byDayModel; delete oldShape.ranges;
  const st = await stubUsage(page, oldShape);
  await gotoHome(page);
  const n0 = st.hits.length;
  await pickRange(page, '7d');
  await expect(cards(page)).toBeVisible();
  // 兜底也算得出窗口内的数字(7 天窗口含今天与 2 天前 → 消息数 7,活跃天数 2)
  await expect(card(page, 'active-days')).toHaveAttribute('data-value', '2');
  await pickRange(page, 'all');
  // 全部口径的消息数来自 overview(打桩 1234);切回全部要能复原
  await expect(card(page, 'messages')).toHaveAttribute('data-value', '1234');
  expect(st.hits.length, '切范围不发新请求').toBe(n0);
  await expect(page.getByTestId('home-usage-error')).toHaveCount(0);
});

test('C8 真隔离实例数据(UI 夹具:两条今天的会话):模型分页图例 = claude-sonnet-4-6,7 天/全部数字一致', async ({ page }) => {
  await gotoHome(page);
  await expect(cards(page)).toBeVisible({ timeout: 30_000 });
  await pickTab(page, 'models');
  await expect(legendRows(page)).toHaveCount(1);
  const r = legendRows(page).first();
  expect(await r.getAttribute('data-model'), '夹具全是 sonnet').toBe('claude-sonnet-4-6');
  const allText = (await r.innerText()).replace(/\s+/g, ' ');
  // U1 + U2 的输入 = 1200 + 800 = 2000,输出 = 300 + 200 = 500
  expect(allText).toContain(`${fmtTokens(2000)} in · ${fmtTokens(500)} out`);
  await pickRange(page, '7d');
  const d7Text = (await legendRows(page).first().innerText()).replace(/\s+/g, ' ');
  expect(d7Text, '夹具都是今天的记录 → 7 天与全部相同').toContain(`${fmtTokens(2000)} in · ${fmtTokens(500)} out`);
  await chart(page).waitFor();
  expect(await chartBars(page).count(), '只有今天一天有数据 → 一根柱').toBe(1);
  // 柱高口径 = 输入 + 输出 = (1200+800) + (300+200);缓存读写不计入柱子
  expect(Number(await chartBars(page).first().getAttribute('data-total'))).toBe(1200 + 800 + 300 + 200);
});

// ───────────── C10 视觉/坐标:三条由平台兼容审查提出的必修项 ─────────────

test('C10a 堆叠柱的段与图例色块的深浅逐级变化(色带不依赖 Tailwind 是否收录某个透明度类)', async ({ page }) => {
  await stubUsage(page, typical());
  await gotoHome(page);
  await pickTab(page, 'models');
  await expect(legendRows(page)).toHaveCount(3);
  // 图例色块:按排名由深到浅,opacity 必须严格递减
  const sw = await legendRows(page).evaluateAll((els) => els.map((el) => {
    const dot = el.querySelector('span[aria-hidden="true"]');
    return Number(getComputedStyle(dot).opacity);
  }));
  expect(sw.length).toBe(3);
  expect(sw[0], `排第一的色块该最深(${sw.join(' / ')})`).toBeGreaterThan(sw[1]);
  expect(sw[1]).toBeGreaterThan(sw[2]);
  // 柱子的段:同一天两个模型时,排名靠前的那段 opacity 必须更大(且都不是默认 1 或 NaN)
  const seg = await page.evaluate(() => {
    const rects = [...document.querySelectorAll('[data-testid="home-usage-chart-bar"] rect[data-segment-model]')];
    const byBar = new Map();
    for (const r of rects) {
      const bar = r.closest('[data-testid="home-usage-chart-bar"]');
      const day = bar.getAttribute('data-day');
      const list = byBar.get(day) || [];
      list.push({ model: r.getAttribute('data-segment-model'), op: r.getAttribute('fill-opacity'), fill: getComputedStyle(r).fill });
      byBar.set(day, list);
    }
    for (const [, list] of byBar) if (list.length >= 2) return { day: [...byBar.keys()].find((d) => byBar.get(d).length >= 2), segs: list };
    return { day: null, segs: [] };
  });
  expect(seg.day, '夹具里应有"同一天两个模型"的柱子').toBeTruthy();
  const ops = seg.segs.map((x) => Number(x.op));
  expect(ops.every((v) => Number.isFinite(v) && v > 0 && v <= 1), `段的 fill-opacity 必须是 (0,1] 的数,实际 ${JSON.stringify(seg.segs)}`).toBe(true);
  expect(Math.max(...ops), '同一根柱子里各段的深浅不全相同(否则排名色失效)').toBeGreaterThan(Math.min(...ops));
  // 段的填充色必须真的解析出来(不是 none / transparent):回落成继承色时这里会露馅
  expect(seg.segs.every((x) => x.fill && x.fill !== 'none' && !/rgba?\(0, 0, 0, 0\)/.test(x.fill)), `段必须有色,实际 ${JSON.stringify(seg.segs.map((x) => x.fill))}`).toBe(true);
});

test('C10b 逐柱悬停:浮层给的是这一根柱子那天、且落在图表容器内(界面 1.2 倍缩放下)', async ({ page }) => {
  const body = typical();
  await stubUsage(page, body);
  await gotoHome(page);
  await pickTab(page, 'models');
  const days = body.byDay.map((r) => r.day).reverse();
  for (const day of days) {
    const bar = page.locator(`[data-testid="home-usage-chart-bar"][data-day="${day}"]`);
    await bar.hover();
    const tip = page.getByTestId('home-usage-chart-tip');
    await expect(tip, `${day}: 悬停必须有浮层`).toBeVisible();
    // ① 文案必须是**这一根柱子**那天的(把 A 天的数读成 B 天,是最要紧的错法)
    await expect(tip, `${day}: 浮层第一行应是这一天`).toContainText(day);
    // ② 浮层的合计 = 该柱子的 data-total
    const total = await bar.getAttribute('data-total');
    await expect(tip, `${day}: 浮层合计应等于该柱的 data-total`).toContainText(Number(total).toLocaleString('en-US'));
    // ③ 浮层整个落在图表容器的水平范围内(1.2 倍缩放下也不许溢出到容器外)
    //    一次 evaluate 同时读柱 / 浮层 / 容器(分两次读会被 hover 触发的滚动错开)
    const geo = await page.evaluate((d) => {
      const b = document.querySelector(`[data-testid="home-usage-chart-bar"][data-day="${d}"]`);
      const el = document.querySelector('[data-testid="home-usage-chart-tip"]');
      const box = el && el.parentElement;
      if (!b || !el || !box) return null;
      const bb = b.getBoundingClientRect(); const tb = el.getBoundingClientRect(); const xb = box.getBoundingClientRect();
      return { overLeft: xb.left - tb.left, overRight: tb.right - xb.right };
    }, day);
    expect(geo, `${day}: 应能量到柱 / 浮层 / 容器三者`).toBeTruthy();
    expect(geo.overLeft, `${day}: 浮层左边不该溢出图表容器(${geo.overLeft.toFixed(1)}px)`).toBeLessThanOrEqual(1);
    expect(geo.overRight, `${day}: 浮层右边不该溢出图表容器(${geo.overRight.toFixed(1)}px)`).toBeLessThanOrEqual(1);
  }

  // 说明:本用例**只**钉两件事 —— 浮层属于哪一根柱、浮层不许溢出图表容器;"有没有精确居中"由 C10d 单独钉。
  // 定位实现返工过三轮(跨平台审查 0.2.401 必修-2 的追记):
  //   · 第一轮:混用视觉像素(rect)与布局像素(offset/client)→ 界面默认 1.2 倍缩放下整块偏移;
  //   · 第二轮:改成"由第几天 × 每柱宽算柱心"(不测量、与滚动无关),仍有 3–6px 残差,
  //     且最右柱因"右侧放不下就翻到柱子左侧"偏出 100+px;当时的实测表与"未达标、发版阻断"的判定
  //     见 `.devflow/WINDOWS-REVIEW-0.2.401.md` 附录(最左 5.8/5.8/3.2px、中 5.3/5.3/3.7px、最右 −176.4/−176.4/−119.8px);
  //   · 第三轮(= 本提交):柱心与浮层尺寸都取自 rect(同一坐标系),再用**容器自身的视觉/布局比**一次换算;
  //     居中优先、贴边兜底。同一份夹具实测(缩放 1.0 / 1.2 / 0.8 × 最左 / 中 / 最右柱):
  //     居得下的柱偏差 ≤0.5px;最右柱几何上居不下(浮层 ≈180 布局px、柱心离容器右缘 60px,
  //     居中要伸到容器外 ~30px,而容器外一圈是 `overflow:auto` 的 `home-usage-slot` → 会被裁或出横滚条),
  //     按"偏心优于溢出"贴边,浮层完整落在容器内(实测右溢 ≤0.3px、偏差 −36.0/−36.0/−25.4px)。
  //     取舍写进 C10d 与 `.devflow/INTERFACE-r131.md` 的契约条目。
});

test('C10d 浮层水平定位:能居中的柱必须居中(≤2px);贴边的柱按"偏心优于溢出"贴边且不溢出', async ({ page }) => {
  // 判据来自 `.devflow/WINDOWS-REVIEW-0.2.401.md` 必修-2(界面缩放 ≠1 时视觉像素与布局像素混用 →
  // 浮层与指针错位;默认缩放就是 1.2,不是边缘情况)。三档缩放 × 最左/中/最右柱。
  //
  // 另有一条测试自身的坑(2026-09-30 踩到并修):缩放档位不能靠写 `html.style.zoom` 来造 ——
  // App 挂载后会按档位重放 apply(),采样窗口里会半路被打回 1.2;见下面循环里的注释。
  //
  // 有一条几何事实必须先说清(实测数据):浮层宽 ≈180 布局像素,容器宽 600、柱心最右 540 ——
  // **最右柱在几何上不可能既居中又不溢出**(居中要让浮层伸到容器外 ~30px,而容器外一圈是
  // `overflow:auto` 的 `home-usage-slot`:被裁或长横滚条,两条都比"偏心"更糟)。所以判据分两种:
  //   · 居得下(柱心 ≥ 浮层宽/2 且 ≤ 容器宽 − 浮层宽/2)→ 偏差必须 ≤ 2px,且不溢出;
  //   · 居不下(贴边的柱)→ 允许偏心,但必须不溢出容器(取舍:偏心优于溢出,溢出会被裁、还会盖住邻柱)。
  // 实测参照(同一判据,2026-09-30):居得下的柱 0.36/0.48/0.05/0.48/−0.27/−0.23px;最右柱 −36.0/−36.0/−25.4px 且不溢出。
  const body = typical();
  await stubUsage(page, body);
  await gotoHome(page);
  await pickTab(page, 'models');
  const days = body.byDay.map((r) => r.day).reverse();
  const pick = [days[0], days[Math.floor(days.length / 2)], days[days.length - 1]];
  for (const scale of [1.0, 1.2, 0.8]) {
    // 界面缩放必须走**应用自己的档位**(localStorage `cgui-ui-font-scale` + 重载),不能直接写
    // `html.style.zoom`:App 的 effect 会在挂载后 60/200/500/1000ms 各重放一次 apply(),把 zoom 打回
    // 档位值 —— 实测直接写 1.0、等 250ms 后量到的仍是 1.2(判据里的"三档缩放"名不副实),而且那几次
    // 重放会落在采样窗口里半路换档:浮层按旧档量到的布局宽度失效 → 偏心 2.6px 的假红(2026-09-30 定位)。
    // 写档位 + 重载后 effect 重挂,档位值本身就是它要 apply 的值,三档才真是三档。
    await page.evaluate((v) => { localStorage.setItem('cgui-ui-font-scale', String(v)); }, scale);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await gotoHome(page);
    await pickTab(page, 'models');
    await expect.poll(async () => Number(await page.evaluate(() => getComputedStyle(document.documentElement).zoom)),
      { message: `界面缩放应切到 ${scale}`, timeout: 15_000 }).toBeCloseTo(scale, 3);
    await page.waitForTimeout(150);
    for (const day of pick) {
      await page.locator(`[data-testid="home-usage-chart-bar"][data-day="${day}"]`).hover();
      await expect(page.getByTestId('home-usage-chart-tip')).toBeVisible();
      // 入场动画带 transform:多采样取最小偏差(动画只会从偏收敛到准)
      let best = null;
      for (let i = 0; i < 24; i += 1) {
        const g = await page.evaluate((d) => {
          const hit = document.querySelector(`[data-testid="home-usage-chart-bar"][data-day="${d}"] [data-hit]`);
          const tip = document.querySelector('[data-testid="home-usage-chart-tip"]');
          if (!hit || !tip) return null;
          const box = tip.parentElement;
          const br = box.getBoundingClientRect();
          const ar = hit.getBoundingClientRect();
          const tr = tip.getBoundingClientRect();
          const k = br.width && box.offsetWidth ? br.width / box.offsetWidth : 1;
          const vw = tr.width / k;                       // 浮层宽(布局像素)
          const cx = (ar.left + ar.width / 2 - br.left) / k;   // 柱心(布局像素,相对容器)
          return {
            dev: Math.abs(tr.left + tr.width / 2 - (ar.left + ar.width / 2)),
            vw, cx, boxW: box.offsetWidth,
            overL: br.left - tr.left, overR: tr.right - br.right,
          };
        }, day);
        if (!g) continue;
        if (!best || g.dev < best.dev) best = g;
        if (best.dev <= 0.5) break;
        await page.waitForTimeout(40);
      }
      expect(best, `zoom=${scale} ${day}: 应能量到柱与浮层`).toBeTruthy();
      const centerable = best.cx >= best.vw / 2 && best.cx <= best.boxW - best.vw / 2;
      if (centerable) {
        expect(best.dev, `zoom=${scale} ${day}: 居得下 → 偏差 ${best.dev.toFixed(1)}px 应 ≤ 2px`).toBeLessThanOrEqual(2);
      } else {
        // 贴边的柱:不要求居中,但必须落在容器内(否则会被裁)
        expect(best.overL, `zoom=${scale} ${day}: 贴边柱也不许溢出左边(${best.overL.toFixed(1)}px)`).toBeLessThanOrEqual(1);
        expect(best.overR, `zoom=${scale} ${day}: 贴边柱也不许溢出右边(${best.overR.toFixed(1)}px)`).toBeLessThanOrEqual(1);
      }
      expect(best.overL, `zoom=${scale} ${day}: 浮层不该溢出容器左侧(${best.overL.toFixed(1)}px)`).toBeLessThanOrEqual(1);
      expect(best.overR, `zoom=${scale} ${day}: 浮层不该溢出容器右侧(${best.overR.toFixed(1)}px)`).toBeLessThanOrEqual(1);
    }
  }
  await page.evaluate(() => { localStorage.setItem('cgui-ui-font-scale', '1.2'); });   // 收尾回默认档
});

test('C10c 375×812(含界面缩放余量)用量块顶行不横滚', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: process.env.R131_UI_BASE, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await ctx.newPage();
  try {
    await stubUsage(page, typical());
    await gotoHome(page);
    // 分页与范围两组都必须在容器里放得下(或被允许换行),不许把整页撑出横向滚动
    const m = await page.evaluate(() => {
      const head = document.querySelector('[data-testid="home-usage-tabs"]').parentElement;
      const ranges = document.querySelector('[data-testid="home-usage-ranges"]');
      return {
        sw: document.documentElement.scrollWidth, iw: innerWidth,
        headRight: head.getBoundingClientRect().right, rangeRight: ranges.getBoundingClientRect().right,
        usageRight: document.querySelector('[data-testid="home-usage"]').getBoundingClientRect().right,
      };
    });
    expect(m.sw, `顶行不该把页面撑横滚(scrollWidth ${m.sw} ≤ ${m.iw})`).toBeLessThanOrEqual(m.iw);
    expect(m.rangeRight, '范围组右缘不超出用量块').toBeLessThanOrEqual(m.usageRight + 1);
    expect(m.headRight, '顶行右缘不超出用量块').toBeLessThanOrEqual(m.usageRight + 1);
  } finally { await ctx.close(); }
});

test('C10e 320×568 × 缩放 1.2 / 1.0:顶行与整页都不横滚(跨平台审查 0.2.401 建议-3 的判据)', async ({ browser }) => {
  // 建议-3 的验收判据:C4 的「scrollWidth ≤ innerWidth」要在 375×812 **与 320×568** 两档 ×
  // 默认缩放 1.2 与 1.0 全部成立。顶行能不能放下靠 `flex-wrap`(792fbe19 起),这条锁钉的是
  // **结果**(不横滚 + 两组控件仍可见),换成别的实现写法也一样过。
  for (const zoom of [1.2, 1.0]) {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, baseURL: process.env.R131_UI_BASE, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
    const page = await ctx.newPage();
    try {
      // 缩放档走应用自己的档位(localStorage),不能直接写 html.style.zoom —— App 的 effect 会把
      // 它打回档位值(详见 C10d 的注释),这里用 addInitScript 保证每次导航前就写好。
      await page.addInitScript((v) => { try { localStorage.setItem('cgui-ui-font-scale', String(v)); } catch { /* 忽略 */ } }, zoom);
      await stubUsage(page, typical());
      await gotoHome(page);
      await expect.poll(async () => Number(await page.evaluate(() => getComputedStyle(document.documentElement).zoom)),
        { message: `界面缩放应切到 ${zoom}`, timeout: 15_000 }).toBeCloseTo(zoom, 3);
      const m = await page.evaluate(() => {
        const head = document.querySelector('[data-testid="home-usage-tabs"]').parentElement;
        const tabs = document.querySelector('[data-testid="home-usage-tabs"]');
        const ranges = document.querySelector('[data-testid="home-usage-ranges"]');
        return {
          sw: document.documentElement.scrollWidth, iw: innerWidth,
          headRight: head.getBoundingClientRect().right,
          usageRight: document.querySelector('[data-testid="home-usage"]').getBoundingClientRect().right,
          tabsW: tabs.getBoundingClientRect().width, rangesW: ranges.getBoundingClientRect().width,
        };
      });
      expect(m.sw, `320px + 缩放 ${zoom}:整页不该横滚(scrollWidth ${m.sw} ≤ ${m.iw})`).toBeLessThanOrEqual(m.iw);
      expect(m.headRight, `320px + 缩放 ${zoom}:顶行右缘不超出用量块`).toBeLessThanOrEqual(m.usageRight + 1);
      expect(m.tabsW > 0 && m.rangesW > 0, `320px + 缩放 ${zoom}:分页与范围两组都还要有可见宽度(tabs ${m.tabsW} / ranges ${m.rangesW})`).toBe(true);
    } finally { await ctx.close(); }
  }
});
