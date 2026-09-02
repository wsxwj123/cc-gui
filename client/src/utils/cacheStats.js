// r89 前缀缓存命中率:usage 解析 + 命中率公式(纯函数,可单测)。
//
// 字段命名两套,主用 Anthropic 命名、DeepSeek 命名兜底:
//  · Anthropic:input_tokens / cache_creation_input_tokens / cache_read_input_tokens
//    (V1 真机实测:DeepSeek 的 /anthropic 端点返回的就是这套命名)
//  · DeepSeek 原生:prompt_cache_hit_tokens / prompt_cache_miss_tokens
//    (openai 网关路径已在 openai-proxy 里翻成 Anthropic 命名,这里是直连/中转的兜底)
//
// 命中率 = read / (read + creation + input);未命中(miss)= creation + input,
// 即按未命中价计费的那部分提示 token。
//
// 口径注意:徽章「本轮」必须用【单次 API 调用】的 usage(message_start / ctxUsage),
// 不能用 result.usage —— 后者是整轮多次调用的累加,cache_read 会被加 N 遍。
// 「会话累计 / 全局累计」用的是消耗口径(每次调用求和),两者不要混。

export const EMPTY_CACHE_USAGE = { read: 0, creation: 0, input: 0 };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// 命中率(百分比,0~100)。分母为 0 时返回 0,永不 NaN。
export function cacheHitPct(read, creation, input) {
  const total = num(read) + num(creation) + num(input);
  return total > 0 ? (num(read) / total) * 100 : 0;
}

// 一条 usage → { read, creation, input, miss, total, hitPct }。
// 非对象 / 缺字段一律按 0 处理。
export function readCacheUsage(usage) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  const read = num(u.cache_read_input_tokens) || num(u.prompt_cache_hit_tokens);
  const creation = num(u.cache_creation_input_tokens);
  const input = num(u.input_tokens) || num(u.prompt_cache_miss_tokens);
  return {
    read, creation, input,
    miss: creation + input,
    total: read + creation + input,
    hitPct: cacheHitPct(read, creation, input),
  };
}

// 累加器:把一条 usage 并进 { read, creation, input } 累计,返回带派生字段的新对象。
export function addCacheUsage(acc, usage) {
  const a = (acc && typeof acc === 'object') ? acc : EMPTY_CACHE_USAGE;
  const u = readCacheUsage(usage);
  const read = num(a.read) + u.read;
  const creation = num(a.creation) + u.creation;
  const input = num(a.input) + u.input;
  return {
    read, creation, input,
    miss: creation + input,
    total: read + creation + input,
    hitPct: cacheHitPct(read, creation, input),
  };
}

// 显示用:命中率取一位小数;≥99.95 时多给一位,避免把 99.97% 显示成 100.0% 造成"全命中"的错觉。
export function formatHitPct(pct) {
  const p = Number.isFinite(pct) ? pct : 0;
  return p >= 99.95 && p < 100 ? `${p.toFixed(2)}%` : `${p.toFixed(1)}%`;
}
