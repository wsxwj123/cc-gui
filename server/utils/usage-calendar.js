// r130:用量日历的纯日期算术(服务端聚合 usage-stats.js 与首页热力图 client/src/utils/homeUsage.js 共用)。
// 硬约束:纯函数、零依赖、零 IO、不引入 Node 内置模块 —— 前端经 vite 直接 import 本文件
// (先例 client/src/utils/plan.js → server/utils/plan.js;vite.config.js fs.allow 含 ../server/utils)。
// "本地" = **运行环境的时区**:服务端是进程 TZ,浏览器是页面时区;两边各算各的"今天"
// (契约 .devflow/INTERFACE-r130.md §0/§A)。日期加减/求星期一律按 UTC 分量做,避开 DST。

const pad2 = (n) => String(n).padStart(2, '0');
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Date → 本地 YYYY-MM-DD;非法 Date → null。 */
export function dayKeyOf(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 记录时间戳(ISO 串 / 毫秒数)→ 本地 YYYY-MM-DD;无 / 非法 → null(调用方决定落 'unknown')。 */
export function localDayKey(ts) {
  if (ts == null || ts === '') return null;
  return dayKeyOf(new Date(ts));
}

/** 记录时间戳 → 本地小时 0–23;无 / 非法 → null。 */
export function localHour(ts) {
  if (ts == null || ts === '') return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.getHours();
}

/** YYYY-MM-DD → 该日 UTC 正午的毫秒数(只做日期算术,与本地时区无关);非法 → NaN。 */
function keyToUtcNoon(key) {
  const m = KEY_RE.exec(String(key ?? ''));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
}

/** YYYY-MM-DD 加 n 天(n 可负、可为 0)。跨月 / 跨年 / 闰日由 Date.UTC 进位;非法 → null。 */
export function shiftDayKey(key, n) {
  const t = keyToUtcNoon(key);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** YYYY-MM-DD → 星期索引(周一 0 … 周日 6;热力图行号);非法 → null。 */
export function mondayIndex(key) {
  const t = keyToUtcNoon(key);
  if (Number.isNaN(t)) return null;
  return (new Date(t).getUTCDay() + 6) % 7;
}

/** 两个 YYYY-MM-DD 之差(a − b,天);任一非法 → null。 */
export function dayDiff(a, b) {
  const ta = keyToUtcNoon(a);
  const tb = keyToUtcNoon(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((ta - tb) / DAY_MS);
}

/**
 * 连续天数(INTERFACE §A)。activeDayKeys:活跃日 YYYY-MM-DD 数组(可重复、可乱序;**调用方先滤掉
 * 'unknown' 与未来日**,非法键在此静默忽略);todayKey:今天(本地)。
 *  · currentStreak:today 活跃 → 从 today 往前连续活跃天数;否则 yesterday 活跃 → 从 yesterday
 *    往前数;否则 0。
 *  · longestStreak:活跃日集合里最长的连续段(无 → 0;孤立一天 → 1)。
 */
export function computeStreaks(activeDayKeys, todayKey) {
  const set = new Set();
  for (const k of activeDayKeys || []) if (KEY_RE.test(String(k))) set.add(k);
  let longestStreak = 0;
  for (const k of set) {
    if (set.has(shiftDayKey(k, -1))) continue;   // 不是某段的起点,由起点那次一起数
    let len = 1;
    while (set.has(shiftDayKey(k, len))) len += 1;
    if (len > longestStreak) longestStreak = len;
  }
  const yesterday = shiftDayKey(todayKey, -1);
  let cursor = set.has(todayKey) ? todayKey : (set.has(yesterday) ? yesterday : null);
  let currentStreak = 0;
  while (cursor && set.has(cursor)) { currentStreak += 1; cursor = shiftDayKey(cursor, -1); }
  return { currentStreak, longestStreak };
}
