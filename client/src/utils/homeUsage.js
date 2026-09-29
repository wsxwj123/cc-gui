// r130:首页用量总览 + 热力图的纯函数层(client/src/components/HomeUsage.jsx 只做取数与渲染)。
// 契约 .devflow/INTERFACE-r130.md §C;单测 tests/unit/check-r130-home-usage-pure.mjs。
// 日期算术与服务端共用 server/utils/usage-calendar.js(vite.config.js fs.allow 已放行 ../server/utils,
// 先例 client/src/utils/plan.js)。"本地今天" = 页面时区,与服务端各算各的(INTERFACE §0)。
import { shiftDayKey, mondayIndex, dayKeyOf } from '../../../server/utils/usage-calendar.js';

export const CARD_KEYS = ['sessions', 'messages', 'tokens', 'active-days', 'current-streak', 'longest-streak', 'peak-hour', 'favorite-model'];
const CARD_LABELS = { sessions: '会话数', messages: '消息数', tokens: '总 token', 'active-days': '活跃天数', 'current-streak': '当前连续', 'longest-streak': '最长连续', 'peak-hour': '高峰时段', 'favorite-model': '常用模型' };
export const DASH = '—';

/** 四项 token 合计(缺项按 0)。 */
export const tokensOf = (r) => (r?.input || 0) + (r?.output || 0) + (r?.cacheRead || 0) + (r?.cacheWrite || 0);

/** token 缩写四档:≥1e9 B / ≥1e6 M / ≥1e3 K / 原数。与 UsagePanel.jsx 的 formatNum 档位不同(它无 B 档),下一轮统一(PLAN §3-7)。 */
export function abbrevTokens(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
export const fmtInt = (n) => Number(n).toLocaleString('en-US');

/** 模型显示名:去掉 [..] 段与结尾 -8 位日期(同 ModelBadge.jsx getModelStyle 的 clean 正则;它在 pricing.js 也有三处重复,统一抽取不在本轮)。 */
export function shortModelName(id) {
  const s = String(id ?? '');
  return s.replace(/\[.*?\]/g, '').replace(/-\d{8}$/, '').trim() || s;
}

/** 当前连续的显示值:服务端 sig 不变就不重算,跨午夜后 currentStreak 会陈旧;lastActiveDay 不是本地今天 / 昨天 → 0。 */
export function displayStreak(overview, todayKey) {
  if (!overview) return null;
  const last = overview.lastActiveDay;
  if (last === todayKey || last === shiftDayKey(todayKey, -1)) return overview.currentStreak ?? null;
  return 0;
}

/** 空态 = 没有会话且 byDay 里没有真实日期的行(只有 'unknown' 行不算空 —— 那是正常态、热力图全 0 级)。 */
export function isEmptyStats(stats) {
  return (stats?.total?.sessionCount || 0) === 0 && !(stats?.byDay || []).some((r) => r && r.day !== 'unknown');
}

/** 八卡:{ key, label, value(data-value 原始值;null / 缺失 → ''), text(显示文本;0 / null / 缺失 → 「—」,peak-hour 的 0 例外) }。 */
export function cardValues(stats, todayKey) {
  const ov = stats?.overview || null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  const raw = {
    sessions: num(stats?.total?.sessionCount),
    messages: num(ov?.messages),
    tokens: stats?.total ? tokensOf(stats.total) : null,
    'active-days': num(ov?.activeDays),
    'current-streak': num(displayStreak(ov, todayKey)),
    'longest-streak': num(ov?.longestStreak),
    'peak-hour': num(ov?.peakHour),
    'favorite-model': typeof ov?.favoriteModel === 'string' && ov.favoriteModel ? ov.favoriteModel : null,
  };
  const special = {
    tokens: raw.tokens ? abbrevTokens(raw.tokens) : DASH,
    // peak-hour 是"0 → —"的唯一例外:0 是合法的凌晨 0 时;只有 null / 缺失才「—」(INTERFACE 2026-09-28 修订)。
    'peak-hour': raw['peak-hour'] == null ? DASH : `${raw['peak-hour']} 时`,
    'favorite-model': raw['favorite-model'] ? shortModelName(raw['favorite-model']) : DASH,
  };
  return CARD_KEYS.map((key) => ({
    key,
    label: CARD_LABELS[key],
    value: raw[key] == null ? '' : String(raw[key]),
    text: key in special ? special[key] : (raw[key] ? fmtInt(raw[key]) : DASH),
  }));
}

/** 容器宽 → 卡片列数(< 480 两列)与热力图周数(格 11 + 间距 2 = 13/列,左侧周标签 22;夹在 8..53)。未量到宽(0)按最窄。 */
export const cardCols = (width) => (width < 480 ? 2 : 4);
export const heatWeeks = (width) => Math.max(8, Math.min(53, Math.floor(((width || 0) - 22) / 13)));

/** 分级阈值:vals = tokens>0 升序,q_k = vals[min(n-1, floor(n*k/4))];n=0 → null(全 0 级)。n ≤ 4 时 q3 = 最大值,出不了 4 级(契约明示)。 */
export function heatThresholds(tokensList) {
  const vals = tokensList.filter((v) => v > 0).sort((a, b) => a - b);
  const n = vals.length;
  if (!n) return null;
  const q = (k) => vals[Math.min(n - 1, Math.floor((n * k) / 4))];
  return [q(1), q(2), q(3)];
}
export function heatLevel(tokens, thresholds) {
  if (!thresholds || !(tokens > 0)) return 0;
  const [q1, q2, q3] = thresholds;
  return tokens <= q1 ? 1 : tokens <= q2 ? 2 : tokens <= q3 ? 3 : 4;
}

/**
 * 周网格:weeks 列 × 7 行,**列优先平铺**(CSS grid grid-auto-flow:column 的 DOM 顺序),行 0 = 周一,
 * 最右列 = 含今天的那一周;今天之后的格 future(无 day、不可交互)。'unknown' 行与未来日的行不进图。
 * 每格 { col, row, day, tokens, level, known(byDay 有该天;tokens=0 的行也算有), today, future }。
 * 分级只看显示窗口内的天。
 */
export function heatmapGrid({ byDay, todayKey, weeks }) {
  const index = new Map();
  for (const r of byDay || []) {
    if (!r || typeof r.day !== 'string' || r.day === 'unknown' || r.day > todayKey) continue;
    index.set(r.day, tokensOf(r));
  }
  const thisMonday = shiftDayKey(todayKey, -mondayIndex(todayKey));
  const cells = [];
  for (let col = 0; col < weeks; col += 1) {
    const monday = shiftDayKey(thisMonday, -7 * (weeks - 1 - col));
    for (let row = 0; row < 7; row += 1) {
      const day = shiftDayKey(monday, row);
      if (day > todayKey) { cells.push({ col, row, day: null, tokens: 0, level: 0, known: false, today: false, future: true }); continue; }
      cells.push({ col, row, day, tokens: index.get(day) ?? 0, level: 0, known: index.has(day), today: day === todayKey, future: false });
    }
  }
  const thresholds = heatThresholds(cells.filter((c) => !c.future).map((c) => c.tokens));
  for (const c of cells) c.level = c.future ? 0 : heatLevel(c.tokens, thresholds);
  return { cells, thresholds };
}

/** 浮层文案:byDay 有该天 → 「YYYY-MM-DD · N tokens」(千分位);无 → 「YYYY-MM-DD · 无记录」。 */
export const tipText = (cell) => (cell.known ? `${cell.day} · ${fmtInt(cell.tokens)} tokens` : `${cell.day} · 无记录`);

/** 前端本地今天(页面时区)。 */
export const localTodayKey = () => dayKeyOf(new Date());
