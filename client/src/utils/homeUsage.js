// r130:首页用量总览 + 热力图的纯函数层(client/src/components/HomeUsage.jsx 只做取数与渲染)。
// 契约 .devflow/INTERFACE-r130.md §C;单测 tests/unit/check-r130-home-usage-pure.mjs。
// 日期算术与服务端共用 server/utils/usage-calendar.js(vite.config.js fs.allow 已放行 ../server/utils,
// 先例 client/src/utils/plan.js)。"本地今天" = 页面时区,与服务端各算各的(INTERFACE §0)。
// r131 在同一文件追加「范围切换 / 模型分页」的纯函数(下半部分;契约 .devflow/INTERFACE-r131.md §C,
// 单测 tests/unit/check-r131-usage-views-pure.mjs)。口径 = **范围只改数字、图不裁**,与 CLI /stats 一致。
import { shiftDayKey, mondayIndex, dayKeyOf, computeStreaks } from '../../../server/utils/usage-calendar.js';

export const CARD_KEYS = ['sessions', 'messages', 'tokens', 'active-days', 'current-streak', 'longest-streak', 'peak-hour', 'favorite-model'];
const CARD_LABELS = { sessions: '会话数', messages: '消息数', tokens: '总 token', 'active-days': '活跃天数', 'current-streak': '当前连续', 'longest-streak': '最长连续', 'peak-hour': '高峰时段', 'favorite-model': '常用模型' };
export const DASH = '—';

/** 四项 token 合计(缺项按 0)。 */
export const tokensOf = (r) => (r?.input || 0) + (r?.output || 0) + (r?.cacheRead || 0) + (r?.cacheWrite || 0);

/** 输入 + 输出两项(柱状图的高度口径、浮层逐行显示的那个数;不含 cache 读写)。 */
export const inputOutputOf = (r) => (r?.input || 0) + (r?.output || 0);

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

/** 当前连续的显示值:服务端 sig 不变就不重算,跨午夜后 currentStreak 会陈旧;lastActiveDay 不是本地今天 / 昨天 → 0。
 *  overview 为 null(旧缓存回放 / 范围里没有这一项) → null,由调用方显示「—」。 */
export function displayStreak(overview, todayKey) {
  if (!overview) return null;
  const last = overview.lastActiveDay;
  // 源里根本没有 currentStreak(旧缓存回放 / ranges 缺这一项)→ 保持 null,别把"没有"显示成 0
  if (overview.currentStreak == null) return null;
  if (last === todayKey || last === shiftDayKey(todayKey, -1)) return overview.currentStreak;
  return 0;
}

/** 空态 = 没有会话且 byDay 里没有真实日期的行(只有 'unknown' 行不算空 —— 那是正常态、热力图全 0 级)。 */
export function isEmptyStats(stats) {
  return (stats?.total?.sessionCount || 0) === 0 && !(stats?.byDay || []).some((r) => r && r.day !== 'unknown');
}

/** 八卡:{ key, label, value(data-value 原始值;null / 缺失 → ''), text(显示文本;0 / null / 缺失 → 「—」,peak-hour 的 0 例外) }。 */
export function cardValues(stats, todayKey) {
  return cardValuesFor(stats, 'all', todayKey);
}

/** 范围 → 「会话数 / 消息数 / 总 token / 活跃天数」的取值源(rangeFacts 的四个数字)。
 *  'all' 直接读 total + overview;7d / 30d 读 ranges.<key>(后端算好的窗口聚合),缺 ranges 就前端兜底自算。
 *  null / 缺失 → null(卡面显示「—」,与旧缓存回放同一套占位)。 */
export function rangeCounts(stats, range, todayKey = localTodayKey()) {
  const f = rangeFacts(stats, range, todayKey);
  return { sessions: f.sessions, messages: f.messages, tokens: f.tokens, activeDays: f.activeDays };
}

/**
 * 八卡(按范围)。range = 'all' | '30d' | '7d'(不认识的键按 'all' 处理)。
 * 会话数 / 消息数 / 总 token / 活跃天数 / 连续天数 / 高峰时段 / 常用模型**全部**走 rangeFacts ——
 * 两条数据路径(ranges 直读 / 前端兜底)都在它里面,卡面不许一半按范围一半取全量。
 */
export function cardValuesFor(stats, range, todayKey) {
  const f = rangeFacts(stats, range, todayKey);
  const num = (v) => (Number.isFinite(v) ? v : null);
  const raw = {
    sessions: num(f.sessions),
    messages: num(f.messages),
    tokens: num(f.tokens),
    'active-days': num(f.activeDays),
    'current-streak': num(displayStreak(f, todayKey)),
    'longest-streak': num(f.longestStreak),
    'peak-hour': num(f.peakHour),
    'favorite-model': typeof f.favoriteModel === 'string' && f.favoriteModel ? f.favoriteModel : null,
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

/** 分页 / 范围的内部键;界面文案由组件给(这里只管取值)。 */
export const RANGE_KEYS = ['all', '30d', '7d'];
export const RANGE_DAYS = { '7d': 7, '30d': 30 };
/** 图例默认显示几行,其余收进「显示其余 N 个」。 */
export const LEGEND_DEFAULT_ROWS = 6;
/** 无日期的时间桶键(与后端 byDay / byDayModel 的 'unknown' 一致)。 */
export const UNKNOWN_DAY = 'unknown';

const num = (v) => (Number.isFinite(v) ? v : 0);

/** 范围窗口的起始日(含今天在内的 N 天):'7d' → 今天 − 6 天。'all' → null。 */
export const rangeStartKey = (todayKey, range) => {
  const days = RANGE_DAYS[range];
  return days ? shiftDayKey(todayKey, -(days - 1)) : null;
};

/** 某天是否落在范围内(与后端 ranges 的窗口判据逐字对应:'unknown' 与未来日两边都不计)。 */
export function inRange(day, todayKey, range) {
  if (!day || day === UNKNOWN_DAY || day > todayKey) return false;
  const from = rangeStartKey(todayKey, range);
  return !from || day >= from;
}

/** 空的范围聚合(与后端 ranges.<key> 的空账同形:数值 0、可空字段 null、hourCounts 24 个 0)。 */
export const emptyRange = () => ({
  sessions: null, messages: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0,
  activeDays: null, firstDay: null, lastActiveDay: null,
  currentStreak: 0, longestStreak: 0, hourCounts: Array(24).fill(0), peakHour: null, favoriteModel: null,
  byModel: [], totalTokens: 0,
});

/** 常用模型(与后端 pickFavorite 同口径):四项合计最高,排除 'unknown' / '<synthetic>',并列取字符串较小者。 */
export function favoriteOf(rows) {
  let best = null;
  let bestTotal = -1;
  for (const m of rows || []) {
    if (!m || m.model === UNKNOWN_DAY || m.model === '<synthetic>') continue;
    const t = tokensOf(m);
    if (t > bestTotal || (t === bestTotal && m.model < best)) { bestTotal = t; best = m.model; }
  }
  return best;
}

/**
 * 范围内聚合的前端兜底(后端没给 ranges 时用:旧缓存回放的第一帧就是这条路)。
 * **能算准的**:四个 token / calls / byModel 分组(byDayModel,没有就退回按 byDay 每日合计)、
 * 消息数 / 活跃天 / 当前与最长连续(byDay 的八键里就有 messages)。
 * **算不准的**(已知短板,写在这里免得下一个人重新踩):
 *   · 跨天去重的会话数 —— byDay[].sessions 是"当天各自的会话数",直接相加会多算,这里只取
 *     "窗口内单日最大值"当下界估计;真正去重的数只有后端 ranges 有;
 *   · 高峰时段 —— 需要窗口内的 (日, 小时) 分布,前端拿不到,只能退回全量的 peakHour。
 * 所以它只是兜底:正常情况下都应该走 ranges(后端算准的那份)。
 */
export function rangeOverview(stats, range, todayKey) {
  const out = emptyRange();
  const rows = (stats?.byDay || []).filter((r) => inRange(r?.day, todayKey, range));
  const models = new Map();
  for (const [day, byModel] of Object.entries(stats?.byDayModel || {})) {
    if (!inRange(day, todayKey, range)) continue;
    for (const [model, u] of Object.entries(byModel || {})) {
      const cur = models.get(model) || { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      cur.input += num(u?.input); cur.output += num(u?.output);
      cur.cacheRead += num(u?.cacheRead); cur.cacheWrite += num(u?.cacheWrite);
      cur.calls += num(u?.calls);
      models.set(model, cur);
    }
  }
  if (!models.size) {
    // 没有 byDayModel(旧响应):**按天的模型明细在 byDay 行里根本不存在**,所以这里**不编造**分组。
    // 早先的写法把窗口内全部 token 挂在"全量第一名模型"名下 → 图例显示一个模型、占比 100%,
    // 用户会当成事实读(代码审查 R2)。现在只把四项 token 与 calls 汇总到卡片能用的字段里,
    // out.byModel 留空,界面自己说"这些天的用量没有模型明细"。
    for (const r of rows) {
      out.input += num(r.input); out.output += num(r.output);
      out.cacheRead += num(r.cacheRead); out.cacheWrite += num(r.cacheWrite); out.calls += num(r.calls);
    }
  }
  if (models.size) {
    out.input = 0; out.output = 0; out.cacheRead = 0; out.cacheWrite = 0; out.calls = 0;
    for (const m of models.values()) {
      out.input += m.input; out.output += m.output;
      out.cacheRead += m.cacheRead; out.cacheWrite += m.cacheWrite; out.calls += m.calls;
    }
  }
  out.totalTokens = out.input + out.output + out.cacheRead + out.cacheWrite;
  out.byModel = [...models.values()].sort((a, b) => (tokensOf(b) - tokensOf(a)) || (a.model < b.model ? -1 : 1));
  const active = rows.filter((r) => num(r.messages) > 0);
  out.messages = rows.reduce((s, r) => s + num(r.messages), 0);
  out.activeDays = active.length;
  out.firstDay = active.length ? active[active.length - 1].day : null;
  out.lastActiveDay = active.length ? active[0].day : null;
  // 窗口内没有任何活跃日 → 保持 null(与"连续 0 天"区分开:前者是没数据,后者是断了)
  const streak = active.length ? computeStreaks(active.map((r) => r.day), todayKey) : null;
  out.currentStreak = streak ? streak.currentStreak : null;
  out.longestStreak = streak ? streak.longestStreak : null;
  out.sessions = rows.reduce((best, r) => Math.max(best, num(r.sessions)), 0) || null;
  out.peakHour = Number.isFinite(stats?.overview?.peakHour) ? stats.overview.peakHour : null;
  out.favoriteModel = favoriteOf(out.byModel);
  return out;
}

/** 范围内八卡口径的四个数字 + 连续 / 高峰 / 常用模型(与后端 ranges.<key> 同形;缺则前端兜底)。 */
export function rangeFacts(stats, range, todayKey) {
  if (!range || range === 'all') {
    const ov = stats?.overview || null;
    return {
      sessions: Number.isFinite(stats?.total?.sessionCount) ? stats.total.sessionCount : null,
      messages: Number.isFinite(ov?.messages) ? ov.messages : null,
      tokens: stats?.total ? tokensOf(stats.total) : null,
      activeDays: Number.isFinite(ov?.activeDays) ? ov.activeDays : null,
      // 缺 overview(旧缓存回放)时**保持"没有"**:给 0 会让卡面 data-value 从 '' 变成 '0',
      // 把"这一项没数据"谎报成"这一项是 0"(r130 C3e 与 check-r130-home-usage-pure 都钉着)。
      currentStreak: ov ? (ov.currentStreak ?? null) : null,
      longestStreak: ov ? (ov.longestStreak ?? null) : null,
      lastActiveDay: ov?.lastActiveDay ?? null,
      peakHour: ov?.peakHour ?? null,
      favoriteModel: ov?.favoriteModel ?? null,
    };
  }
  const r = stats?.ranges?.[range];
  if (r) {
    return {
      sessions: Number.isFinite(r.sessions) ? r.sessions : null,
      messages: Number.isFinite(r.messages) ? r.messages : null,
      tokens: tokensOf(r),
      activeDays: Number.isFinite(r.activeDays) ? r.activeDays : null,
      currentStreak: r.currentStreak ?? null,
      longestStreak: r.longestStreak ?? null,
      lastActiveDay: r.lastActiveDay ?? null,
      peakHour: r.peakHour ?? null,
      favoriteModel: r.favoriteModel ?? null,
    };
  }
  const f = rangeOverview(stats, range, todayKey);
  return { ...f, tokens: f.totalTokens };
}

/** 某个范围的 byModel 行(图例与金额都从这里取)。'all' 用响应的 byModel(带 byPeriod,分时计价才算得对)。 */
export function modelsInRange(stats, range, todayKey) {
  if (!range || range === 'all') return stats?.byModel || [];
  const r = stats?.ranges?.[range];
  if (r?.byModel) return r.byModel;
  return rangeOverview(stats, range, todayKey).byModel;
}

/**
 * 色带(同一色相 = 主题 accent,按**占比排名**由深到浅)。排名超出色带 → 最浅那档。
 * 两个出口缺一不可:图例色块是 div(`bg-*` 背景色),柱状图的段是 SVG rect ——
 * Tailwind 的 `bg-*` 只写 background-color,SVG 图形**不认**(rect 得用 fill)。
 * 所以 SVG 那边用 `fill="currentColor"` + 同色系的 `text-*`,不复制第二套色值。
 */
export const MODEL_SHADES = [
  'bg-accent', 'bg-accent/80', 'bg-accent/64', 'bg-accent/50', 'bg-accent/38', 'bg-accent/28', 'bg-accent/20',
];
/** SVG 段用的颜色 class(text-* 只改 fill;rect 上用 fill="currentColor" 吃它)。 */
export const modelFill = (rank) => MODEL_SHADES[Math.min(Math.max(rank, 0), MODEL_SHADES.length - 1)].replace(/^bg-/, 'text-');
export const shadeClass = (rank) => MODEL_SHADES[Math.min(Math.max(rank, 0), MODEL_SHADES.length - 1)];

/**
 * 模型图例:按四项合计降序 → [{ model, name(短名), input, output, total(四项合计), share(占全部模型四项
 * 合计的百分比), calls, shade(色块 class), rank }]。分母为 0 → share 全 0(不显示 NaN)。
 */
export function legendItems(stats, range, todayKey) {
  const rows = modelsInRange(stats, range, todayKey)
    .map((m) => ({
      model: m?.model ?? UNKNOWN_DAY,
      input: num(m?.input), output: num(m?.output), cacheRead: num(m?.cacheRead), cacheWrite: num(m?.cacheWrite), calls: num(m?.calls),
    }));
  for (const m of rows) m.total = tokensOf(m);
  rows.sort((a, b) => (b.total - a.total) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  const grand = rows.reduce((s, m) => s + m.total, 0);
  return rows.map((m, rank) => ({
    ...m,
    name: shortModelName(m.model),
    share: grand > 0 ? (m.total / grand) * 100 : 0,
    shade: shadeClass(rank),
    block: String(Math.min(rank, MODEL_SHADES.length - 1)),
    rank,
  }));
}

/**
 * 堆叠柱状图的数据:每天一柱(时间跨度 = 全部历史,**不随范围裁**),每柱按模型堆叠。
 * 返回 { series:[{ model, name, shade, rank }], days:[{ day, total, values, segments }] }。
 * 数据源 = byDayModel;缺它就退回 byDay 的每日合计(单序列"常用模型",图上仍能看总量)。
 * maxBar > 0 时只保留最近 maxBar 天(375px 下 400 根柱子挤成一片,截断只影响像素密度,
 * 语义仍是"全部历史";热力图同样是按容器宽度决定的窗口)。
 */
export function stackedByDay(stats, { maxBar = 0 } = {}) {
  const edges = (stats?.byDay || [])
    .filter((r) => r?.day && r.day !== UNKNOWN_DAY)
    .map((r) => r.day)
    .sort();
  if (!edges.length) return { series: [], days: [] };
  const days = edges.slice(maxBar > 0 ? Math.max(0, edges.length - maxBar) : 0);
  const index = new Map(days.map((d, i) => [d, i]));
  const modelTotals = new Map();
  const daysOut = days.map((day) => ({ day, total: 0, values: Object.create(null), segments: [] }));
  const byDayModel = stats?.byDayModel;
  if (byDayModel && typeof byDayModel === 'object') {
    for (const [day, byModel] of Object.entries(byDayModel)) {
      const bucket = daysOut[index.get(day)];
      if (!bucket) continue;
      for (const [model, u] of Object.entries(byModel || {})) {
        // 一根柱子 = 当天该模型的**输入 + 输出**(与浮层逐行显示的两个数、与 CLI 面板的
        // "586.8k in · 61.2M out" 同一口径;cache 读写不堆进柱子,否则浮层里各段之和 ≠ 柱高)
        const t = inputOutputOf(u);
        if (!t) continue;
        bucket.values[model] = t;
        bucket.total += t;
        modelTotals.set(model, (modelTotals.get(model) || 0) + t);
      }
    }
  } else {
    const name = stats?.byModel?.[0]?.model ?? UNKNOWN_DAY;
    for (const r of stats?.byDay || []) {
      const bucket = daysOut[index.get(r.day)];
      if (!bucket) continue;
      const t = inputOutputOf(r);
      if (!t) continue;
      bucket.values[name] = t;
      bucket.total += t;
      modelTotals.set(name, (modelTotals.get(name) || 0) + t);
    }
  }
  const series = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model], i) => ({ model, name: shortModelName(model), shade: shadeClass(i), fill: modelFill(i), rank: i, block: String(Math.min(i, MODEL_SHADES.length - 1)) }));
  for (const d of daysOut) d.segments = series.filter((s) => num(d.values[s.model]) > 0);
  const max = daysOut.reduce((m, d) => Math.max(m, d.total), 0);
  return { series, days: daysOut, max };
}

/** x 轴标签间隔(天):按跨度挑一个,目标 4–6 个标签、约每两周一个。 */
export function xTickDays(span) {
  for (const step of [7, 14, 28, 56, 91, 182, 364]) {
    const n = Math.ceil((span || 0) / step);
    if (n >= 4 && n <= 6) return step;
  }
  return 14;
}

/**
 * x 轴标签的柱子索引(升序、**等距**,最后一个恰好落在末端那根柱子上)。
 * 第一版把"最后一天"硬追加进等距序列,结果最后两个标签挤在一起(C5b 的"标签等距"断言抓到)。
 * 现在:step = round((n−1)/k) 从末尾往前取,序列天然以末端结尾;柱子太少时只标 3 个,别把轴标满。
 */
export function xTickIndexes(n, span) {
  if (!n) return [];
  if (n === 1) return [0];
  const k = Math.max(3, Math.min(5, Math.round((span || n) / xTickDays(span || n))));
  const step = Math.max(1, Math.round((n - 1) / k));
  const out = [];
  for (let i = n - 1; i >= 0 && out.length <= k; i -= step) out.push(i);
  let idx = out.reverse();
  // 柱子太少(step < 3)时上面会给"每根柱子一个标签"的密集结果 → 收成 3 个
  if (step < 3) idx = [0, Math.round((n - 1) / 2), n - 1];
  return [...new Set(idx)];
}

/** x 轴标签的日期键列表(= days 里被选中的那些)。 */
export function xTicks(days, span) {
  return xTickIndexes(days.length, span).map((i) => days[i]);
}

/** y 轴刻度(4–5 个,0 必在,顶格 ≥ 最大值):nice step = 1/2/2.5/5 × 10^k,文本走四档缩写。 */
export function yTicks(maxValue) {
  const max = Number.isFinite(maxValue) && maxValue > 0 ? maxValue : 0;
  if (max === 0) return [{ value: 0, text: '0' }];
  // raw 按"最多 4 段"取:segments = ceil(max/step) ≤ 4 → 含 0 共 5 个刻度
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = mag * 10;
  for (const m of [1, 2, 2.5, 5, 10]) { if (mag * m >= raw) { step = mag * m; break; } }
  let segments = Math.ceil(max / step);
  // 段数太少(只有 2–3 个刻度)就再往细取一档:目标 3–4 段 = 4–5 个刻度
  for (const m of [0.5, 0.5, 0.5]) {
    if (segments >= 3) break;
    const finer = step * m;
    if (Math.ceil(max / finer) > 4) break;
    step = finer;
    segments = Math.ceil(max / step);
  }
  const out = [];
  for (let v = 0; v <= segments; v += 1) out.push({ value: v * step, text: abbrevTokens(v * step) });
  // 上限兜底:段数是 nice step 推出来的,理论上 ≤ 4,但极端 max 下仍可能多一格 —— 掐到 5 个。
  return out.length <= 5 ? out : [out[0], out[1], out[2], out[3], out[out.length - 1]];
}

/** 柱状图浮层:日期 + 当天各模型 token(降序)+ 当天合计。 */
export function chartTip(day) {
  const segs = [...(day?.segments || [])].sort((a, b) => num(day?.values?.[b.model]) - num(day?.values?.[a.model]));
  return {
    day: day?.day ?? '',
    total: `${fmtInt(day?.total || 0)} tokens`,
    rows: segs.map((s) => ({ model: s.model, name: s.name, value: num(day.values[s.model]) })),
  };
}
