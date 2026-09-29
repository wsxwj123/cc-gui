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
const tabActive = (page) => page.locator('[data-testid^="home-usage-tab-"][aria-pressed="true"]');
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
  await expect(page.getByTestId('home-usage-tab-models')).toHaveAttribute('aria-pressed', 'true');
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

test('C6a 375×812:无横滚,柱状图横向压到容器宽,图例文字截断', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: process.env.R131_UI_BASE, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await ctx.newPage();
  try {
    await stubUsage(page, typical());
    await gotoHome(page);
    await pickTab(page, 'models');
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(m.sw, `不该横滚(scrollWidth ${m.sw} ≤ innerWidth ${m.iw})`).toBeLessThanOrEqual(m.iw);
    const u = await usage(page).boundingBox();
    const svg = await chartSvg(page).boundingBox();
    expect(svg.width, '柱状图宽度不超过容器').toBeLessThanOrEqual(u.width + 1);
    expect(svg.width).toBeGreaterThan(200);
    // 图例行整体不许溢出容器(模型名 + in/out + 占比在 375px 下要放得下)
    const rowOverflow = await legendRows(page).first().evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(rowOverflow, `图例行不该溢出容器(scrollWidth - clientWidth = ${rowOverflow};1px 是子像素取整)`).toBeLessThanOrEqual(1);
    // truncate 机制仍在:超长模型名必须被裁掉,完整名字靠 title 保底
    const long = legendRows(page).first().locator('[data-testid="home-usage-legend-name"]');
    const clipped = await long.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.classList.contains('truncate'));
    expect(clipped, '模型名必须有 truncate(超长时裁掉,title 里是完整 id)').toBe(true);
    expect(await long.getAttribute('title'), 'title = 完整模型 id').toBeTruthy();
    await expect(homeInput(page)).toBeVisible();
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

test('C7c 旧响应(没有 byDayModel / ranges 根键)也不崩:分页仍在,模型分页用 byDay 兜底或给空态', async ({ page }) => {
  await stubUsage(page, payload({ total: { sessionCount: 2 }, byDay: [dayEntry(today(), 1000), dayEntry(dayAgo(2), 500)], byDayModel: null, ranges: null }));
  await gotoHome(page);
  await expect(cards(page)).toBeVisible();
  await pickTab(page, 'models');
  await expect(chart(page)).toBeVisible();
  await expect(legendRows(page).first()).toBeVisible();
  await expect(legendRows(page).first().getAttribute('data-model')).toBeTruthy();
  await expect(page.getByTestId('home-usage-error')).toHaveCount(0);
});

// ───────────── C8 真数据端到端 ─────────────

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
