// R22/R23:用量的唯一归一出口(纯函数,可单测)。
//
// 输出五类量 + TTL 分项,逐字按 .devflow/INTERFACE.md:
//   input / output / cache_read_input_tokens / cache_creation_input_tokens
//   + cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens(嵌套)
//
// 三条硬规矩:
// 1. 顶层 creation 与两个 TTL 分项【不重复相加】:它们是同一笔写量的两种粒度,
//    求和只在各自的字段上做,命中率分母里 creation 只算一次。
// 2. Chat Completions 口径:prompt_tokens 含读写(15000 总输入/read 12000/write 3000 →
//    普通 input 0),这个减法在上游转换处(utils/openai-usage.js)完成,本模块只按
//    Anthropic 命名读数(Anthropic 的 input 已排除缓存,不再扣)。
// 3. 无效负数/非有限字段标 USAGE_INVALID 且【保留原始数字】,不计算负费用;
//    分项与总量冲突标 USAGE_INCONSISTENT,同样保留原数据供说明。

export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export const USAGE_CODES = ['USAGE_INVALID', 'USAGE_INCONSISTENT'];

/** 读一个可能不存在的数值字段:非数字/NaN 归一为 null(缺字段),数字原样返回(含负数)。 */
function readNum(value) {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return NaN; // 非有限:不是"缺字段",是无效值
  return n;
}

function isValidNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_SAFE;
}

/**
 * 一条 usage → { input, output, cacheRead, cacheCreation, cacheCreation5m, cacheCreation1h,
 *                codes, raw, invalid }。
 * - 字段缺失按 0 计,但【原始值】仍在 raw 里可回读;
 * - 负数/非有限/超 MAX_SAFE_INTEGER → codes 带 USAGE_INVALID,值按原样保留(不 clamp);
 * - 上游转换层带的 ccgui_usage.codes(如 Chat Completions 的读写超总量)合并进来。
 */
export function normalizeUsageRecord(usage) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  const nested = (u.cache_creation && typeof u.cache_creation === 'object') ? u.cache_creation : {};
  const codes = new Set();
  const upstream = u.ccgui_usage && typeof u.ccgui_usage === 'object' ? u.ccgui_usage : {};
  for (const code of upstream.codes || []) if (USAGE_CODES.includes(code)) codes.add(code);

  // 代理侧的原始上游数字(可选):存在服务端存储里,由 attachUsageIssues 补进来,
  // 供展示处说明「上游到底报了什么」——CLI 转写里那份可能已被归一压过。
  const upstreamRaw = (u.ccgui_usage && typeof u.ccgui_usage === 'object' && u.ccgui_usage.raw)
    ? u.ccgui_usage.raw : null;

  const raw = {
    input_tokens: readNum(u.input_tokens),
    output_tokens: readNum(u.output_tokens),
    cache_read_input_tokens: readNum(u.cache_read_input_tokens),
    cache_creation_input_tokens: readNum(u.cache_creation_input_tokens),
    ephemeral_5m_input_tokens: readNum(nested.ephemeral_5m_input_tokens),
    ephemeral_1h_input_tokens: readNum(nested.ephemeral_1h_input_tokens),
    ...(upstreamRaw ? { upstream: upstreamRaw } : {}),
  };

  const invalidFields = [];
  const value = (key) => {
    const n = raw[key];
    if (n === null) return 0;
    if (!isValidNumber(n)) { invalidFields.push(key); codes.add('USAGE_INVALID'); return n; }
    return n;
  };

  return {
    input: value('input_tokens'),
    output: value('output_tokens'),
    cacheRead: value('cache_read_input_tokens'),
    cacheCreation: value('cache_creation_input_tokens'),
    cacheCreation5m: value('ephemeral_5m_input_tokens'),
    cacheCreation1h: value('ephemeral_1h_input_tokens'),
    codes: [...codes],
    raw,
    invalid: invalidFields.length > 0,
  };
}

/** usageTotals 的空壳(字段名逐字对外)。 */
export function emptyUsageTotals() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    apiCalls: 0,
    codes: [],
    issues: [],
  };
}

/**
 * 一组 usage 记录 → usageTotals。
 * 任一条无效 → 总计带 USAGE_INVALID 并保留各条原始数字(messages[] 供说明,不静默改写)。
 */
export function accumulateUsage(records) {
  const totals = emptyUsageTotals();
  const codes = new Set();
  for (const record of records || []) {
    const one = normalizeUsageRecord(record);
    totals.input += one.input;
    totals.output += one.output;
    totals.cacheRead += one.cacheRead;
    totals.cacheCreation += one.cacheCreation;
    totals.cacheCreation5m += one.cacheCreation5m;
    totals.cacheCreation1h += one.cacheCreation1h;
    totals.apiCalls += 1;
    for (const code of one.codes) codes.add(code);
    if (one.codes.length) {
      totals.issues.push({ codes: one.codes, raw: one.raw });
    }
  }
  totals.codes = [...codes];
  return totals;
}

/**
 * 前缀缓存命中率(百分比)。分母 = 普通 input + read + creation(creation 只算一次,
 * 不把 5m/1h 分项再加一遍);分母 0 → null(展示层显示「—」,不是 0%)。
 */
export function hitRatePercent({ input = 0, cacheRead = 0, cacheCreation = 0 } = {}) {
  const denominator = input + cacheRead + cacheCreation;
  if (!(denominator > 0)) return null;
  return (cacheRead / denominator) * 100;
}

/** 一条写量有 TTL 分配吗(有分项且分项之和与顶层一致)。缺分配时写费只能标未知。 */
export function hasTtlSplit({ cacheCreation = 0, cacheCreation5m = 0, cacheCreation1h = 0 } = {}) {
  if (!(cacheCreation > 0)) return false;
  return cacheCreation5m + cacheCreation1h > 0;
}
