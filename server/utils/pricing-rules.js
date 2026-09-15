// 计价规则常量与判定纯函数(2026-09-11 计价准确性修正)。
//
// 为什么放在 server/utils 而不是客户端:客户端已在多处直接 import 这个目录的共用模块
// (builtin-providers.js / usage-*),而「哪个时刻属于哪一档」这个判定**历史回看(客户端逐条
// 消息)与用量面板(服务端聚合)都要用同一个答案** —— 两份时段表迟早会分叉。
//
// 硬约束:纯函数、零依赖、不抛异常(非法输入返回 unknown/空串,不返回 NaN/undefined/抛错)。
// 本文件被浏览器打包(客户端 import),不得引入 Node 内置模块。

/** 时刻 → 判定时区:固定偏移 +08:00(Asia/Shanghai,无夏令时)。 */
const UTC_OFFSET_MINUTES = 480;
const OFFSET_MS = UTC_OFFSET_MINUTES * 60 * 1000;

/**
 * 分时段价目表。**当前只有这一个 key**,`periodFor` 也不接受 schedule 参数 ——
 * 多出来的参数/分支是无人消费的预留;将来真有第二家分时段计价时再新开 key。
 * 采集器若在 `conditions.schedule` 给出与本表不同的 key,该 quote 判**不适用**(宁缺勿猜)。
 */
export const PERIOD_SCHEDULES = {
  'deepseek-cn-peak': {
    timezone: 'Asia/Shanghai', utcOffsetMinutes: 480,
    weekdays: [1, 2, 3, 4, 5],                 // 周一=1 … 周日=0/7
    peakWindows: [[540, 720], [840, 1080]],    // 当天第几分钟,半开区间:09:00–12:00、14:00–18:00
    // 官方价目页注:高峰为北京时间周一至周五 9:00–12:00、14:00–18:00,其余为空闲;空闲价=高峰价的一半
    // (核对日期 2026-09-11,来源见 PRESET_SOURCES 的 deepseek-official)
    note: '官方价目页注:高峰为北京时间周一至周五 9:00–12:00、14:00–18:00,其余为空闲;空闲价=高峰价的一半',
  },
};

/** 唯一的 schedule key —— periodFor 与 conditions.schedule 判定都用它。 */
export const DEFAULT_SCHEDULE_KEY = 'deepseek-cn-peak';

/** DeepSeek 峰谷价的生效时刻(官方公告):早于此刻的请求不得套用峰谷价。 */
export const DEEPSEEK_PEAK_VALID_FROM = '2026-08-17T00:00:00+08:00';

/**
 * 长上下文阈值(每 1M token 计价的「长档」触发线)。
 *
 * 官方原文(gpt-5.6 各模型页逐字一致):
 *   Prompts with >272K input tokens are priced at 2x input and 1.5x output for the full request.
 * 【口径】官方**没有**明确定义这个 "input tokens" 是否含缓存读写。本表采用:
 *   判据 = API 字段 `usage.input_tokens` 的**原值**(该字段在 OpenAI 语义下属「含缓存读写的
 *   总量」,依据官方缓存指南 ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens,
 *   且定价页长档对 cached / cache write 同样收 2×)。**官方若明确则改。**
 *   即:**不得**把 cache_read / cache_creation 加到 input_tokens 上再比。
 * 比较符:严格大于(> 272000;272000 仍走短档)。触发后整段请求按长档价。
 * 数字来源:https://developers.openai.com/api/docs/pricing(2026-09-11 抓取)
 * 未登记的模型不套长上下文档(其 (long context) 报价视为不适用)。
 * 不登记:gpt-5.6-cyber —— 官方定价页长档四格全为 "-"(未单列),按「长档不适用」处理。
 */
export const LONG_CONTEXT_THRESHOLDS = {
  'gpt-5.6-sol': 272000,
  'gpt-5.6-terra': 272000,
  'gpt-5.6-luna': 272000,
};

/**
 * 聚合(用量面板)的**显式代表时点** —— 面板拿到的是按模型汇总的 token,没有时间;
 * 分时段模型要出金额就得挑一个代表时刻。这两个常量写死(不读「现在」,否则同一份数据
 * 每次打开金额都变):peak = 2026-01-05(周一)北京 10:00;offPeak = 2026-01-03(周六)北京 10:00。
 */
// 【时点必须晚于峰谷价的生效日】:代表时点若早于 validFrom(2026-08-17),分时段报价会被
// 「尚未生效」整条排除 → 面板上所有分时段模型都变成「无价」。所以取生效日之后的第一个
// 周一/周六(北京时间 10:00)。
export const AGGREGATE_PERIOD_AT = {
  peak: '2026-09-07T02:00:00.000Z',     // 周一北京 10:00
  offPeak: '2026-09-05T02:00:00.000Z',  // 周六北京 10:00
};

/** 时间戳形态(契约 §1):ISO-8601 带 Z / 带偏移 的字符串,或 epoch 毫秒数。其余一律「时间未知」。 */
function toEpochMs(timestamp) {
  if (typeof timestamp === 'number') {
    if (!Number.isFinite(timestamp)) return null;
    const ms = new Date(timestamp).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof timestamp !== 'string') return null;    // null/undefined/对象/数组 → 未知
  if (!timestamp.trim()) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

/** 固定 +08:00 的本地时间串(秒精度,与契约 §4.2 的样例逐字一致)。 */
function toLocalISO(ms) {
  const local = new Date(ms + OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}+08:00`;
}

/**
 * 判定某个时刻落在哪一档。判定**只来自入参**,不读「现在」、不看会话最后活动时间。
 * 返回 { key:'peak'|'off-peak', localISO } 或 { key:'unknown', reason:'INVALID_TIMESTAMP' }。
 */
export function periodFor(timestamp) {
  const ms = toEpochMs(timestamp);
  if (ms === null) return { key: 'unknown', reason: 'INVALID_TIMESTAMP' };
  const schedule = PERIOD_SCHEDULES[DEFAULT_SCHEDULE_KEY];
  const local = new Date(ms + OFFSET_MS);
  const weekday = local.getUTCDay();
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const inPeak = schedule.weekdays.includes(weekday)
    && schedule.peakWindows.some(([start, end]) => minutes >= start && minutes < end);
  return { key: inPeak ? 'peak' : 'off-peak', localISO: toLocalISO(ms) };
}

/**
 * 官方显示名 → 可比较的名字:丢掉**尾部**括号段(采集器会把 markdown 链接一起带进来)、
 * trim、折叠连续空白。非字符串返回空串(不抛)。
 */
export function normalizeOfficialName(displayName) {
  if (typeof displayName !== 'string') return '';
  const collapsed = displayName.trim().replace(/\s+/g, ' ');
  if (!collapsed.endsWith(')')) return collapsed;
  // 从右往左配对括号:尾部括号段里还嵌着 markdown 链接的括号(实测
  // '([limited availability](https://anthropic.com/glasswing))'),单层正则吃不下。
  let depth = 0;
  for (let i = collapsed.length - 1; i >= 0; i -= 1) {
    const ch = collapsed[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      depth -= 1;
      if (depth === 0) return collapsed.slice(0, i).trim();
    }
  }
  return collapsed;   // 括号不配对的畸形名:原样保留,不猜
}

/**
 * 客户端 model id → 归一化后的官方显示名。**只登记有证据的条目**
 * (证据 = 官方页当次采集到的显示名 + 本机历史里出现过的 id)。
 * 未登记的 id 不得用「去空格/去点」之类规则现场生成映射(那是猜);
 * 这张表是封闭枚举、模型 id 是开放集合,盖不住的新模型靠 matchedExactly=false 变可见。
 * 经本表命中属「精确命中」——它等价于「有人核对过这两个 id 是同一个模型」。
 */
export const OFFICIAL_MODEL_ALIASES = {
  'claude-fable-5-1': 'Claude Fable 5.1',
  'claude-mythos-5-1': 'Claude Mythos 5.1',
  'claude-fable-5': 'Claude Fable 5',
  'claude-mythos-5': 'Claude Mythos 5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  // deepseek-flash / deepseek-v4-pro 与官方显示名逐字相同,不需要别名(精确匹配即命中)。
  // OpenAI 采集器直接写 modelId = 表格模型列原文(gpt-5.6-* 全系即 API id),也不需要别名。
};

/** 该 model 的官方显示名(无别名登记则返回空串)。 */
export function officialAliasFor(model) {
  return (typeof model === 'string' && OFFICIAL_MODEL_ALIASES[model]) || '';
}
