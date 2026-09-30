#!/usr/bin/env node
// r131 · 首页用量块的「范围切换 / 模型分页」纯函数层(client/src/utils/homeUsage.js 下半部分)。
// 契约 .devflow/INTERFACE-r131.md §A/§C;纯 JS,node 直接 import。
// 覆盖:范围窗口边界(含今天在内 N 天)、rangeFacts 两条路径(ranges 直读 vs 前端兜底)数值一致、
//      八卡按范围映射(0/null → 「—」、peak-hour 0 例外)、图例排序/占比/色带、堆叠图(每天一柱、
//      段序 = 排名、不随范围裁)、y 轴 4–5 个 nice 刻度、x 轴等距标签、浮层文案。
import assert from 'node:assert/strict';
import {
  RANGE_KEYS, RANGE_DAYS, LEGEND_DEFAULT_ROWS, rangeStartKey, inRange, rangeFacts, rangeOverview,
  cardValuesFor, legendItems, stackedByDay, yTicks, xTickDays, xTicks, xTickIndexes, chartTip,
  shadeClass, MODEL_SHADES, tokensOf, inputOutputOf, favoriteOf, LEGACY_TOTAL_MODEL, LEGACY_TOTAL_LABEL,
  snakeRoute,
} from '../../client/src/utils/homeUsage.js';

let n = 0;
const eq = (a, b, msg) => { n += 1; assert.deepEqual(a, b, msg); };
const ok = (c, msg) => { n += 1; assert.ok(c, msg); };

// ── 1. 窗口边界:含今天在内的 N 天 ─────────────────────────────────────────
{
  const today = '2026-09-29';
  eq(rangeStartKey(today, '7d'), '2026-09-23', '7d = 今天往前数 7 个本地日(今天 − 6)');
  eq(rangeStartKey(today, '30d'), '2026-08-31', '30d = 今天 − 29');
  eq(rangeStartKey(today, 'all'), null, 'all 没有起始日');
  eq(RANGE_DAYS, { '7d': 7, '30d': 30 }, '窗口天数表');
  eq(RANGE_KEYS, ['all', '30d', '7d'], '范围键(界面上按 全部 → 7 天 的顺序排)');
  ok(inRange('2026-09-23', today, '7d'), '边界当天算在窗口里');
  ok(!inRange('2026-09-22', today, '7d'), '边界前一天不算(否则窗口变 8 天)');
  ok(inRange(today, today, '7d'), '今天算在窗口里');
  ok(!inRange('2026-09-30', today, '7d'), '未来日不算');
  ok(!inRange('unknown', today, '7d'), "'unknown' 不是一天,两边都不算");
  ok(!inRange(null, today, '7d'), '空 day 不算');
  ok(inRange('2000-01-01', today, 'all'), 'all 窗口里历史任意一天都算');
  ok(!inRange('2026-09-30', today, 'all'), 'all 窗口也不含未来日');
  // 跨月 / 跨年
  eq(rangeStartKey('2026-01-03', '7d'), '2025-12-28', '跨年边界');
  eq(rangeStartKey('2026-03-01', '30d'), '2026-01-31', '跨月边界');
}

// ── 2. 夹具:三条时间线的数据 ──────────────────────────────────────────────
const T = '2026-09-29';   // 今天(测试里一切按这个假今天算,不读真实时钟)
const mkDay = (day, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, calls = 0, sessions = 0, messages = 0 } = {}) =>
  ({ day, input, output, cacheRead, cacheWrite, calls, sessions, messages });
/** 后端口径的 ranges(数值与下面 stats.byDay / byDayModel 手算一致)。 */
const STATS = {
  total: { input: 1050, output: 215, cacheRead: 1700, cacheWrite: 160, sessionCount: 3 },
  byDay: [
    mkDay('2026-09-29', { input: 1000, output: 200, cacheRead: 800, cacheWrite: 40, calls: 2, sessions: 1, messages: 5 }),
    mkDay('2026-09-28', { input: 20, output: 5, calls: 1, sessions: 1, messages: 2 }),
    mkDay('2026-09-01', { input: 3000, output: 600, cacheRead: 900, cacheWrite: 120, calls: 3, sessions: 2, messages: 6 }),
    mkDay('2026-06-01', { input: 50, output: 10, calls: 1, sessions: 1, messages: 1 }),
    mkDay('unknown', { calls: 1, sessions: 1, messages: 1 }),   // 无时间戳的 token 不计入任何窗口,只留 calls / messages
  ],
  byPeriod: {},
  byDayModel: {
    '2026-09-29': { 'claude-opus-4-1-20250805': { input: 1000, output: 200, cacheRead: 800, cacheWrite: 40, calls: 2 } },
    '2026-09-28': { 'deepseek-v3.2': { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, calls: 1 } },
    '2026-09-01': { 'claude-opus-4-1-20250805': { input: 3000, output: 600, cacheRead: 900, cacheWrite: 120, calls: 3 } },
    '2026-06-01': { 'old-model-20250101': { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, calls: 1 } },
    unknown: {},   // byDayModel 里也可以没有 unknown(它不进任何窗口)
  },
  byModel: [
    { model: 'claude-opus-4-1-20250805', input: 4000, output: 800, cacheRead: 1700, cacheWrite: 160, calls: 5, byPeriod: {} },
    { model: 'deepseek-v3.2', input: 25, output: 10, cacheRead: 0, cacheWrite: 0, calls: 2, byPeriod: {} },
    { model: 'old-model-20250101', input: 50, output: 10, cacheRead: 0, cacheWrite: 0, calls: 1, byPeriod: {} },
  ],
  ranges: {
    '7d': {
      sessions: 2, messages: 7, input: 1020, output: 205, cacheRead: 800, cacheWrite: 40, calls: 3,   // 9-29(1020/205/800/40)+ 9-28(0/0/0/0)
      activeDays: 2, firstDay: '2026-09-28', lastActiveDay: '2026-09-29',
      currentStreak: 2, longestStreak: 2, hourCounts: [...Array(24).fill(0)], peakHour: 9, favoriteModel: 'claude-opus-4-1-20250805',
      byModel: [
        { model: 'claude-opus-4-1-20250805', input: 1000, output: 200, cacheRead: 800, cacheWrite: 40, calls: 2 },
        { model: 'deepseek-v3.2', input: 20, output: 5, cacheRead: 0, cacheWrite: 0, calls: 1 },
      ],
    },
    '30d': {
      sessions: 3, messages: 13, input: 4020, output: 805, cacheRead: 1700, cacheWrite: 160, calls: 6,
      activeDays: 3, firstDay: '2026-09-01', lastActiveDay: '2026-09-29',
      currentStreak: 2, longestStreak: 2, hourCounts: [...Array(24).fill(0)], peakHour: 9, favoriteModel: 'claude-opus-4-1-20250805',
      byModel: [
        { model: 'claude-opus-4-1-20250805', input: 4000, output: 800, cacheRead: 1700, cacheWrite: 160, calls: 5 },
        { model: 'deepseek-v3.2', input: 20, output: 5, cacheRead: 0, cacheWrite: 0, calls: 1 },
      ],
    },
  },
  overview: {
    messages: 16, activeDays: 5, firstDay: '2026-06-01', lastActiveDay: '2026-09-29',
    currentStreak: 2, longestStreak: 4, hourCounts: [...Array(24).fill(0)], peakHour: 10,
    favoriteModel: 'claude-opus-4-1-20250805',
  },
};

// ── 3. rangeFacts:ranges 直读 ─────────────────────────────────────────────
{
  const f = rangeFacts(STATS, 'all', T);
  eq(f.tokens, tokensOf(STATS.total), 'all 的总 token = total 四项合计');
  eq(f.sessions, 3, 'all 的会话数 = total.sessionCount');
  eq(f.messages, 16, 'all 的消息数 = overview.messages');
  eq(f.peakHour, 10, 'all 的高峰时段 = overview.peakHour');
  const r7 = rangeFacts(STATS, '7d', T);
  eq(r7.tokens, 1020 + 205 + 800 + 40, '7d 总 token = ranges 四项之和(ranges 里没有 total 对象)');
  eq(r7.sessions, 2, '7d 会话数 = 去重后的 2(不是逐日 sessions 相加)');
  eq([r7.activeDays, r7.currentStreak, r7.longestStreak, r7.peakHour], [2, 2, 2, 9], '7d 的窗口内统计');
  eq(r7.favoriteModel, 'claude-opus-4-1-20250805', '7d 常用模型');
  const r30 = rangeFacts(STATS, '30d', T);
  eq(r30.tokens, 4020 + 805 + 1700 + 160, '30d 总 token(9-01 也进了 30 天窗口)');
  eq(r30.sessions, 3, '30d 里三个会话都在');
}

// ── 4. rangeFacts 兜底:没有 ranges 时前端自算,数值与后端口径一致 ────────────
{
  const { ranges, ...noRanges } = STATS;
  for (const key of ['7d', '30d']) {
    const f = rangeFacts(noRanges, key, T);
    const exp = ranges[key];
    eq(tokensOf(f), tokensOf(exp), `${key} 兜底:四项 token 与后端一致`);
    eq(f.messages, exp.messages, `${key} 兜底:消息数一致(byDay 八键里就有 messages)`);
    eq(f.activeDays, exp.activeDays, `${key} 兜底:活跃天数一致`);
    eq(f.firstDay, exp.firstDay, `${key} 兜底:首日一致`);
    eq(f.lastActiveDay, exp.lastActiveDay, `${key} 兜底:最后活跃日一致`);
    eq(f.longestStreak, exp.longestStreak, `${key} 兜底:最长连续一致`);
    eq(f.favoriteModel, exp.favoriteModel, `${key} 兜底:常用模型一致`);
  }
  // 已知短板写进断言:兜底算不出"跨天去重的会话数"(byDay[].sessions 是每天各自的数),
  // 只能给"窗口内单日最大值"当下界;高峰时段也只能退回全量的。
  const f7 = rangeFacts(noRanges, '7d', T);
  eq(f7.sessions, 1, '7d 兜底会话数 = 窗口内单日最大值(9-28 / 9-29 各 1;9-01 在 7 天窗口外)');
  const noRangesDay = { ...noRanges, byDay: noRanges.byDay.map((r) => (r.day === '2026-09-29' ? { ...r, sessions: 5 } : r)) };
  eq(rangeFacts(noRangesDay, '7d', T).sessions, 5, '真值只有后端有;兜底给的是下界(单日最大 5 > 真去重值)');
  eq(rangeFacts(noRanges, '7d', T).peakHour, 10, '兜底高峰时段退回全量 overview 的值(接口契约里的已知短板,真实值只有 ranges 里有)');
}

// ── 5. 八卡按范围映射 ────────────────────────────────────────────────────
{
  const cards = (range) => Object.fromEntries(cardValuesFor(STATS, range, T).map((c) => [c.key, c]));
  const all = cards('all'); const d7 = cards('7d');
  eq(Object.keys(all), ['sessions', 'messages', 'tokens', 'active-days', 'current-streak', 'longest-streak', 'peak-hour', 'favorite-model'], '八卡的键与顺序不变');
  eq(all.tokens.value, String(tokensOf(STATS.total)), 'all 卡 data-value');
  eq(d7.tokens.value, String(1020 + 205 + 800 + 40), '7d 卡 data-value 按范围重算');
  ok(Number(d7.tokens.value) < Number(all.tokens.value), '7d ≤ all');
  eq(d7['favorite-model'].text, 'claude-opus-4-1', '常用模型走短名规则');
  eq(d7['peak-hour'].text, '9 时', '高峰时段按范围(ranges.7d.peakHour = 9,不是全量的 10)');
  // peak-hour 的 0 例外(唯一一个 0 不显示「—」的卡)
  const zeroPeak = { ...STATS, ranges: { ...STATS.ranges, '7d': { ...STATS.ranges['7d'], peakHour: 0 } } };
  eq(Object.fromEntries(cardValuesFor(zeroPeak, '7d', T).map((c) => [c.key, c]))['peak-hour'].text, '0 时', 'peakHour=0 是合法的凌晨 0 时');
  const nullPeak = { ...STATS, ranges: { ...STATS.ranges, '7d': { ...STATS.ranges['7d'], peakHour: null } } };
  eq(Object.fromEntries(cardValuesFor(nullPeak, '7d', T).map((c) => [c.key, c]))['peak-hour'].text, '—', 'peakHour=null → 「—」');
  // current-streak:lastActiveDay 不是今天/昨天 → 0 → 「—」
  const stale = { ...STATS, ranges: { ...STATS.ranges, '7d': { ...STATS.ranges['7d'], lastActiveDay: '2026-09-20' } } };
  eq(Object.fromEntries(cardValuesFor(stale, '7d', T).map((c) => [c.key, c]))['current-streak'].text, '—', '连续已断 → 0 → 「—」');
  // 缺 ranges 的旧响应:走兜底而不是全空
  const { ranges, ...noRanges } = STATS;
  eq(Object.fromEntries(cardValuesFor(noRanges, '7d', T).map((c) => [c.key, c]))['tokens'].value, String(1020 + 205 + 800 + 40), '缺 ranges 时八卡走兜底');
}

// ── 6. 图例:排序 / 占比 / 色带 ───────────────────────────────────────────
{
  const all = legendItems(STATS, 'all', T);
  eq(all.map((m) => m.model), ['claude-opus-4-1-20250805', 'old-model-20250101', 'deepseek-v3.2'], '按四项合计降序(6660 > 60 > 35)');
  const grand = 6660 + 60 + 35;
  eq(all[0].share, (6660 / grand) * 100, '占比 = 该模型四项合计 / 全部模型四项合计');
  eq(all[0].name, 'claude-opus-4-1', '短名');
  eq(all[0].output + all[0].input, 4800, '图例 in/out 只列输入与输出两项(4800 = 4000 + 800)');
  eq(all.map((m) => m.shade), MODEL_SHADES.slice(0, 3), '色带按排名由深到浅');
  eq(all.map((m) => m.block), ['0', '1', '2'], '色块编号按排名');
  // 7d 窗口只含两个模型 → 占比按窗内重算
  const d7 = legendItems(STATS, '7d', T);
  eq(d7.map((m) => m.model), ['claude-opus-4-1-20250805', 'deepseek-v3.2'], '7d 只列窗口内的模型');
  eq(d7[0].share, (2040 / (2040 + 25)) * 100, '7d 占比在窗口内部重算');
  ok(d7[0].share !== all[0].share, '7d 与 all 的占比不同(否则说明范围没生效)');
  // 0 分母 → 0 而不是 NaN
  const emptyLegend = legendItems({ byModel: [], byDay: [], byDayModel: {}, ranges: {} }, '7d', T);
  eq(emptyLegend, [], '没有模型 → 空图例');
  // 超出色带长度 → 取最浅那档
  eq(shadeClass(99), MODEL_SHADES[MODEL_SHADES.length - 1], '排名超出色带取最浅');
  eq(shadeClass(-3), MODEL_SHADES[0], '负排名取最深');
}

// ── 7. 图例默认 6 行 ─────────────────────────────────────────────────────
{
  eq(LEGEND_DEFAULT_ROWS, 6, '图例默认 6 行(其余收进「显示其余 N 个」)');
}

// ── 8. 堆叠图:每天一柱、段序 = 排名、不随范围裁 ────────────────────────────
{
  const s = stackedByDay(STATS);
  eq(s.days.map((d) => d.day), ['2026-06-01', '2026-09-01', '2026-09-28', '2026-09-29'], "'unknown' 不进图;时间从左到右递增");
  eq(s.days.map((d) => d.total), [60, 3600, 25, 1200], '柱高 = 当天**输入 + 输出**(不含缓存读写)');
  eq(s.days[3].segments.map((x) => x.model), ['claude-opus-4-1-20250805'], '当天只有一个模型 → 一段');
  eq(s.days[1].segments.length, 1, '9-01 只有一个模型');
  // 段序 = 模型总排名(与图例同源):opus 在所有柱里都在最下面
  const twoModel = {
    byDay: [mkDay('2026-09-29', { input: 10, output: 0, calls: 2, sessions: 1, messages: 2 }), mkDay('2026-09-28', { input: 10, output: 0, calls: 2, sessions: 1, messages: 2 })],
    byDayModel: {
      '2026-09-29': { small: { input: 1, output: 1 }, big: { input: 100, output: 100 } },
      '2026-09-28': { small: { input: 2, output: 2 }, big: { input: 5, output: 5 } },
    },
  };
  const s2 = stackedByDay(twoModel);
  eq(s2.series.map((x) => x.model), ['big', 'small'], '序列按累计大小排序');
  eq(s2.days[1].segments.map((x) => x.model), ['big', 'small'], '每柱段序 = 序列序(同色同序)');
  // 柱高 = 当天各模型「输入 + 输出」;注意它**不等于** byDay 行的 input(那是四项汇总的另一套口径)
  eq(s2.days.map((d) => d.total), [14, 202], '柱高 = 当天各模型输入+输出之和(9-28: 5+5+2+2=14;9-29: 100+100+1+1=202)');
  // 缺 byDayModel 的旧响应:退回单序列(当天合计的形状还在),但**不许**冒充某个模型
  // (跨平台审查 0.2.401 建议-2:以前挂的是全量第一名的名字,浮层会把"当天全量"读成那个模型的数)
  const legacy = stackedByDay({ byDay: STATS.byDay, byModel: STATS.byModel });
  eq(legacy.series.length, 1, '缺 byDayModel → 单序列兜底');
  eq(legacy.series[0].model, LEGACY_TOTAL_MODEL, '兜底序列用"合计"占位名,不许拿 byModel 第一名冒充');
  eq(legacy.series[0].name, LEGACY_TOTAL_LABEL, '兜底序列的显示名要自带"没有模型明细"');
  ok(!STATS.byModel.some((m) => m.model === legacy.series[0].model), '占位名不得等于任何真实模型 id');
  eq(legacy.days.map((d) => d.total), [60, 3600, 25, 1200], '兜底柱高口径与正式路径一致');
  eq(chartTip(legacy.days[0]).rows[0].model, LEGACY_TOTAL_MODEL, '浮层行的 model 字段也是占位名');
  eq(chartTip(legacy.days[0]).rows[0].name, LEGACY_TOTAL_LABEL, '浮层第一行也要说明"没有模型明细"');
  // maxBar:只保留最近 N 天(375px 下 400 根柱子挤成一片)
  const cut = stackedByDay(STATS, { maxBar: 2 });
  eq(cut.days.map((d) => d.day), ['2026-09-28', '2026-09-29'], 'maxBar 只裁显示天数(仍是最新的那几天)');
  eq(stackedByDay({ byDay: [] }).days, [], '没有 byDay → 空图');
}

// ── 9. y 轴刻度:4–5 个、nice、缩写 ────────────────────────────────────────
{
  eq(yTicks(0), [{ value: 0, text: '0' }], '全 0 → 只有一个 0 刻度');
  for (const max of [1, 460, 1000, 6200, 3_500_000, 9_000_000, 250_000_000, 1.2e9, 24e9]) {
    const t = yTicks(max);
    ok(t.length >= 2 && t.length <= 5, `yTicks(${max}) 刻度数 ${t.length} 应在 2–5`);
    eq(t[0], { value: 0, text: '0' }, `yTicks(${max}) 第一个刻度是 0`);
    ok(t[t.length - 1].value >= max, `yTicks(${max}) 顶格 ${t[t.length - 1].value} 应 ≥ 最大值`);
    // 等距
    const gaps = new Set(t.slice(1).map((x, i) => x.value - t[i].value));
    eq(gaps.size, 1, `yTicks(${max}) 刻度等距`);
    // 文本是四档缩写(0 除外)
    // 文本走 abbrevTokens 四档:≥1e3 才是 K/M/B,更小的刻度是原数(如 0.25 / 500)
    for (const x of t.slice(1)) ok(/^\d+(\.\d+)?([KMB])?$/.test(x.text), `yTicks(${max}) 的 ${x.value} 文本应为数字或 K/M/B,实际 "${x.text}"`);
  }
  const big = yTicks(24e9);
  ok(big.some((x) => /B$/.test(x.text)), '24B 的数据必有 B 档刻度');
  ok(big.length >= 4 && big.length <= 5, '24B → 4–5 个刻度');
}

// ── 10. x 轴标签:等距(等步长)、约每两周一个 ───────────────────────────────
{
  eq(xTickDays(60), 14, '两个月 → 每两周一个标签');
  eq(xTickDays(400), 91, '一年以上 → 每季度一个标签');
  for (const len of [1, 5, 7, 30, 60, 120, 400]) {
    const days = Array.from({ length: len }, (_, i) => `d${i}`);
    const idx = xTickIndexes(len, len);
    ok(idx.length >= 1 && idx.length <= 6, `n=${len} 的标签数 ${idx.length} 应在 1–6`);
    ok(idx.every((v, i) => i === 0 || v > idx[i - 1]), `n=${len} 的索引严格递增`);
    ok(idx[idx.length - 1] === len - 1, `n=${len} 的最后一个标签落在末端柱子上`);
    if (idx.length > 1) {
      const gaps = new Set(idx.slice(1).map((v, i) => v - idx[i]));
      eq(gaps.size, 1, `n=${len} 的索引等步长`);
    }
    eq(xTicks(days, len).length, idx.length, 'xTicks = 按索引取 days');
    ok(xTicks(days, len).every((d) => days.includes(d)), 'xTicks 返回的键都来自 days');
  }
}

// ── 11. 浮层:日期 + 各模型 token 降序 + 当天合计 ────────────────────────────
{
  const s = stackedByDay(STATS);
  const tip = chartTip(s.days[3]);
  eq(tip.day, '2026-09-29', '浮层第一行 = 日期');
  eq(tip.total, '1,200 tokens', '浮层合计 = 千分位 + tokens');
  eq(tip.rows.map((r) => r.model), ['claude-opus-4-1-20250805'], '模型按 token 降序');
  const two = stackedByDay({
    byDay: [mkDay('2026-09-29', { input: 10, output: 0, calls: 2, sessions: 1, messages: 2 })],
    byDayModel: { '2026-09-29': { small: { input: 1, output: 1 }, big: { input: 100, output: 100 } } },
  });
  const t2 = chartTip(two.days[0]);
  eq(t2.rows.map((r) => r.model), ['big', 'small'], '浮层里模型按当天 token 降序');
  eq(t2.total, '202 tokens', '当天合计');
  eq(chartTip(null).rows, [], '空柱不抛');
}

// ── 12. 口径函数 ─────────────────────────────────────────────────────────
{
  eq(tokensOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10, '四项合计');
  eq(inputOutputOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 3, '输入 + 输出');
  eq(tokensOf({}), 0, '缺字段按 0');
  eq(inputOutputOf(null), 0, 'null 按 0');
  eq(favoriteOf([{ model: 'unknown', input: 999 }, { model: '<synthetic>', input: 999 }, { model: 'b', input: 5 }, { model: 'a', input: 5 }]), 'a', "常用模型排除 unknown / <synthetic>,并列取字符串较小者");
  eq(favoriteOf([]), null, '没有模型 → null');
}

// ── 13. 与后端 ranges 的窗口判据一致(前端兜底不许自己发明窗口)──────────────
{
  const { ranges, ...noRanges } = STATS;
  // 只留 7 天边界两侧各一天:起点算、起点前一天不算
  const edge = {
    ...noRanges,
    byDay: [mkDay(rangeStartKey(T, '7d'), { input: 1, calls: 1, sessions: 1, messages: 1 }), mkDay('2026-09-22', { input: 999, calls: 1, sessions: 1, messages: 1 })],
    byDayModel: {},
  };
  const o = rangeOverview(edge, '7d', T);
  eq(o.input, 1, '兜底窗口 = [今天 − 6, 今天],起点当天的算、前一天的不算');
  ok(!('2026-09-22' in (o.byDay || {})), '窗口外的天不参与');
  // 没有 byDayModel 时**不编造**模型分组:byDay 行里根本没有模型维度,凭全量第一名冒充会让
  // 图例显示"一个模型、占比 100%"(代码审查 R2)。byModel 留空,由界面说明"没有模型明细"。
  eq(o.byModel, [], '缺 byDayModel 的兜底:byModel 为空,不编造分组');
  eq(o.tokens ?? tokensOf(o), tokensOf(o), '四项 token 仍然算得出来(卡片数字不受影响)');
  const legacy = { ...edge, byModel: [{ model: 'real-top-model', input: 1, calls: 1 }] };
  eq(rangeOverview(legacy, '7d', T).byModel, [], '就算全量 byModel 有名字也不拿来冒充窗口内的分组');
}

// ── 14. r135 贪吃蛇路线(照 Platane/snk:按等级从浅到深 + 同级就近 + 相邻不瞬移)──
{
  const mkRng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows = 7;
  const mk = (cols, lv) => {
    const cells = [];
    for (let c = 0; c < cols; c += 1) for (let r = 0; r < rows; r += 1) cells.push({ col: c, row: r, day: `d${c}-${r}`, level: 0, future: false });
    for (const [idx, v] of Object.entries(lv)) cells[Number(idx)].level = v;
    return cells;
  };
  // 三列:浅(1)在左、深(3)在右,中间夹一个空格子
  const cells = mk(5, { 15: 1, 19: 1, 31: 3 });   // 5×7:int15=(2,1) 与 int19=(2,5) 对入场点(0,3)等距;int31=(4,3) 深一级
  const r = snakeRoute(cells, rows, mkRng(3));
  // ① 目标全是"有量"的格子,且每个恰好被吃一次
  const eaten = r.eatAt.map((k) => r.path[k]);
  eq([...eaten].sort((a, b) => a - b), [15, 19, 31], '有量的格子一个不落、各吃一次');
  // ② 顺序:等级从浅到深(1 级先于 3 级)
  const levels = eaten.map((i2) => cells[i2].level);
  eq(levels, [...levels].sort((a, b) => a - b), `吃的顺序必须按等级升序,实得 ${levels.join(',')}`);
  // ③ 路径每一步都相邻(不瞬移),且**从不落到 future 格**
  const bad = [];
  for (let i2 = 1; i2 < r.path.length; i2 += 1) {
    const a = r.path[i2 - 1];
    const b = r.path[i2];
    const d = Math.abs(Math.floor(a / rows) - Math.floor(b / rows)) + Math.abs((a % rows) - (b % rows));
    if (d !== 1) bad.push(`${a}→${b}(距离 ${d})`);
  }
  eq(bad, [], `每步都该相邻,实得违规 ${bad.slice(0, 3).join(' ')}`);
  // ④ 没量的格子永不被吃(level=0 的下标不出现在 eaten 里)
  ok(eaten.every((i2) => cells[i2].level > 0), '无消耗的格子永远不是目标');
  // ⑤ 每趟重新随机:同种子可复现、换种子会不同
  eq(snakeRoute(cells, rows, mkRng(3)).path, r.path, '同样的随机序列可复现');
  // rng 真的决定并列取舍:全取 0 与全取 0.999 必须给出不同路线(比"换个种子"更稳,不靠种子运气)
  ok(snakeRoute(cells, rows, () => 0).path.join(',') !== snakeRoute(cells, rows, () => 0.999).path.join(','), 'rng 应决定并列目标的取舍');
  eq(snakeRoute([], rows).path, [], '没有格子 → 空');
}

console.log(`check-r131-usage-views-pure: PASS(${n} 条断言)`);
