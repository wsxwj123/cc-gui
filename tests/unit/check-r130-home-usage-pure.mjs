#!/usr/bin/env node
// r130 · 首页用量纯函数(client/src/utils/homeUsage.js):缩写四档、模型短名、分级公式(n≤4 无 4 级)、
// 周网格(列优先 / 周一行 0 / 最右列含今天 / future 格)、八卡映射(0/null/缺失 → 「—」,peak-hour 0 例外)、
// current-streak 显示修正、空态判定、列数与周数。纯 JS,node 直接 import。
import assert from 'node:assert/strict';
import { abbrevTokens, shortModelName, displayStreak, isEmptyStats, cardValues, cardCols, heatWeeks, heatThresholds, heatLevel,
  heatmapGrid, tipText, CARD_KEYS, DASH } from '../../client/src/utils/homeUsage.js';

// ── 缩写 / 短名 ──
for (const [n, t] of [[0, '0'], [999, '999'], [1000, '1.0K'], [1500, '1.5K'], [6300, '6.3K'], [11000, '11.0K'], [2_500_000, '2.5M'], [999_999_999, '1000.0M'], [1_200_000_000, '1.2B']]) {
  assert.equal(abbrevTokens(n), t, `abbrevTokens(${n})`);
}
assert.equal(shortModelName('claude-opus-4-1-20250805[1m]'), 'claude-opus-4-1');
assert.equal(shortModelName('claude-opus-4-1-20250805'), 'claude-opus-4-1');
assert.equal(shortModelName('claude-sonnet-4-6'), 'claude-sonnet-4-6', '无日期后缀不动');
assert.equal(shortModelName('deepseek-v3.2'), 'deepseek-v3.2');
assert.equal(shortModelName('[1m]'), '[1m]', '全被去掉时退回原 id');

// ── 分级:契约公式;n=8 只有最大 1 个 4 级;n≤4 永远出不了 4 级 ──
const eight = [1, 2, 3, 5, 8, 13, 21, 34].map((n, i) => (i + 1) * 1000 + i);   // 与验收 C4f 的典型载荷同:1000, 2001, …, 8007
const th8 = heatThresholds(eight);
assert.deepEqual(th8, [3002, 5004, 7006], 'q_k = vals[min(n-1, floor(n*k/4))]:n=8 → vals[2] / vals[4] / vals[6]');
assert.deepEqual(eight.map((t) => heatLevel(t, th8)), [1, 1, 1, 2, 2, 3, 3, 4]);
assert.equal(heatLevel(0, th8), 0, 'tokens=0 → 0 级');
const th4 = heatThresholds([100, 200, 300, 400]);
assert.deepEqual(th4, [200, 300, 400], 'n=4:q1=vals[1] q2=vals[2] q3=vals[3](= 最大值)');
assert.deepEqual([100, 200, 300, 400].map((t) => heatLevel(t, th4)), [1, 1, 2, 3], 'n=4:最大只到 3 级(400 ≤ q3),永远出不了 4 级');
assert.equal(heatThresholds([0, 0]), null, '没有 >0 的天 → null');
assert.equal(heatLevel(5, null), 0);
assert.deepEqual(heatThresholds([7]), [7, 7, 7], '单日:三阈值都是它自己 → 1 级');

// ── 周网格:todayKey 固定为周一 2026-09-28 与周三 2026-09-30 ──
const byDay = [
  { day: '2026-09-28', input: 100, output: 20, cacheRead: 300, cacheWrite: 40 },   // 今天 460
  { day: '2026-09-20', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 },
  { day: '2026-09-10', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },  // 有行但 tokens=0
  { day: 'unknown', input: 9e6, output: 0, cacheRead: 0, cacheWrite: 0 },
  { day: '2026-10-05', input: 8e6, output: 0, cacheRead: 0, cacheWrite: 0 },       // 未来日
];
const g = heatmapGrid({ byDay, todayKey: '2026-09-28', weeks: 8 });
assert.equal(g.cells.length, 56, '8 周 × 7');
assert.deepEqual([g.cells[0].col, g.cells[0].row, g.cells[0].day], [0, 0, '2026-08-10'], '第 0 列周一 = 本周一 − 49 天;列优先平铺');
assert.deepEqual([g.cells[6].row, g.cells[6].day], [6, '2026-08-16'], '行 6 = 周日');
assert.deepEqual([g.cells[7].col, g.cells[7].day], [1, '2026-08-17'], '第 1 列从第 8 格开始');
const todayCell = g.cells.find((c) => c.today);
assert.deepEqual([todayCell.day, todayCell.col, todayCell.row, todayCell.tokens, todayCell.known], ['2026-09-28', 7, 0, 460, true], '今天格在最右列,tokens = 四项和');
assert.equal(g.cells.filter((c) => c.future).length, 6, '周一 = 今天 → 本周后 6 格 future');
assert.ok(g.cells.filter((c) => c.future).every((c) => c.day === null && c.col === 7 && c.row > 0), 'future 格无 day、在最右列、在今天之后');
assert.equal(g.cells.some((c) => c.day === 'unknown' || c.day === '2026-10-05'), false, "'unknown' 与未来日不进图");
const c0910 = g.cells.find((c) => c.day === '2026-09-10');
assert.deepEqual([c0910.tokens, c0910.known, c0910.level], [0, true, 0], 'tokens=0 的行:known 但 0 级');
assert.deepEqual([g.cells.find((c) => c.day === '2026-09-11').known, g.cells.find((c) => c.day === '2026-09-11').tokens], [false, 0], '无记录的天');
assert.deepEqual(g.thresholds, [460, 1000, 1000], '窗口内 >0 的只有 460 与 1000');
assert.deepEqual([g.cells.find((c) => c.day === '2026-09-20').level, todayCell.level], [2, 1], 'n=2:q = [460, 1000, 1000],1000 ≤ q2 → 2 级(出不了 4 级);460 ≤ q1 → 1 级');
const g3 = heatmapGrid({ byDay: [], todayKey: '2026-09-30', weeks: 12 });
assert.equal(g3.cells.filter((c) => c.future).length, 4, '周三 → 本周后 4 格 future');
assert.equal(g3.cells.find((c) => c.today).row, 2, '周三在第 2 行');
assert.equal(g3.cells[0].day, '2026-07-13', '12 周:第 0 列周一 = 2026-09-28 − 77 天');
assert.equal(g3.thresholds, null);
assert.ok(g3.cells.every((c) => c.level === 0 && !c.known), '没有数据:全 0 级、全无记录');

// ── 八卡映射(验收 C3 系列的典型 / 全零 / 缺 overview / 例外) ──
const T = '2026-09-28';
const hc = Array(24).fill(0); hc[8] = 5;
const full = { total: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 100, sessionCount: 12 }, byDay: [], meta: { scannedAt: 1, stale: false },
  overview: { messages: 1234, activeDays: 7, firstDay: '2026-08-29', lastActiveDay: T, currentStreak: 3, longestStreak: 5, hourCounts: hc, peakHour: 8, favoriteModel: 'claude-opus-4-1-20250805' } };
const cv = (stats) => Object.fromEntries(cardValues(stats, T).map((c) => [c.key, [c.value, c.text]]));
assert.deepEqual(cardValues(full, T).map((c) => c.key), CARD_KEYS, 'DOM 顺序 = CARD_KEYS');
assert.ok(cardValues(full, T).every((c) => typeof c.label === 'string' && c.label), '每卡有标签');
assert.deepEqual(cv(full), { sessions: ['12', '12'], messages: ['1234', '1,234'], tokens: ['6300', '6.3K'], 'active-days': ['7', '7'], 'current-streak': ['3', '3'], 'longest-streak': ['5', '5'], 'peak-hour': ['8', '8 时'], 'favorite-model': ['claude-opus-4-1-20250805', 'claude-opus-4-1'] });
const zero = { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessionCount: 0 }, byDay: [],
  overview: { messages: 0, activeDays: 0, firstDay: null, lastActiveDay: null, currentStreak: 0, longestStreak: 0, hourCounts: Array(24).fill(0), peakHour: null, favoriteModel: null } };
assert.deepEqual(cv(zero), { sessions: ['0', DASH], messages: ['0', DASH], tokens: ['0', DASH], 'active-days': ['0', DASH], 'current-streak': ['0', DASH], 'longest-streak': ['0', DASH], 'peak-hour': ['', DASH], 'favorite-model': ['', DASH] }, '0 → 「—」且 data-value "0";null → ""');
const nv = cv({ total: full.total, byDay: [], meta: {} });
assert.deepEqual([nv.sessions, nv.tokens], [['12', '12'], ['6300', '6.3K']], '缺 overview(旧缓存回放):sessions / tokens 照常');
for (const k of CARD_KEYS.filter((x) => x !== 'sessions' && x !== 'tokens')) assert.deepEqual(nv[k], ['', DASH], `缺 overview:${k} → "" / —`);
assert.deepEqual(cv({ ...full, overview: { ...full.overview, peakHour: 0 } })['peak-hour'], ['0', '0 时'], 'peak-hour 0 是"0 → —"的唯一例外');
assert.deepEqual(cv({ ...full, overview: { ...full.overview, favoriteModel: 'claude-opus-4-1-20250805[1m]' } })['favorite-model'], ['claude-opus-4-1-20250805[1m]', 'claude-opus-4-1'], 'data-value 原 id,文本去后缀');
assert.deepEqual(cv({ ...full, overview: { ...full.overview, lastActiveDay: '2026-09-26', currentStreak: 4 } })['current-streak'], ['0', DASH], 'lastActiveDay 是前天 → 按 0 显示');
assert.deepEqual(cv({ ...full, overview: { ...full.overview, lastActiveDay: '2026-09-27', currentStreak: 4 } })['current-streak'], ['4', '4'], 'lastActiveDay 是昨天 → 原值');
assert.equal(displayStreak(null, T), null);
assert.equal(displayStreak({ lastActiveDay: T, currentStreak: 2 }, T), 2);
assert.equal(displayStreak({ lastActiveDay: '2026-09-01', currentStreak: 9 }, T), 0);

// ── 空态 / 列数 / 周数 / 浮层文案 ──
assert.equal(isEmptyStats({ total: { sessionCount: 0 }, byDay: [] }), true);
assert.equal(isEmptyStats({ total: { sessionCount: 0 }, byDay: [{ day: 'unknown' }] }), true, '只有 unknown 行且无会话 → 空');
assert.equal(isEmptyStats({ total: { sessionCount: 3 }, byDay: [{ day: 'unknown' }] }), false, 'sessionCount>0 → 正常态');
assert.equal(isEmptyStats({ total: { sessionCount: 0 }, byDay: [{ day: '2026-09-01' }] }), false, '有真实日期的行 → 正常态');
assert.equal(isEmptyStats(null), true);
assert.deepEqual([cardCols(0), cardCols(479), cardCols(480), cardCols(600)], [2, 2, 4, 4]);
assert.deepEqual([heatWeeks(0), heatWeeks(126), heatWeeks(127), heatWeeks(327), heatWeeks(600), heatWeeks(5000)], [8, 8, 8, 23, 44, 53], '(w−22)/13 夹 8..53;375 视口(容器 327)23 周、600 容器 44 周');
assert.equal(tipText({ day: '2026-09-08', known: true, tokens: 322157959 }), '2026-09-08 · 322,157,959 tokens');
assert.equal(tipText({ day: '2026-09-08', known: true, tokens: 0 }), '2026-09-08 · 0 tokens', 'byDay 有该天但 0 也报 tokens');
assert.equal(tipText({ day: '2026-09-09', known: false, tokens: 0 }), '2026-09-09 · 无记录');

console.log('check-r130-home-usage-pure: PASS');
