// r151m:第三方 provider 下的 claude 模型名兜底映射。
//
// 为什么需要:第三方 provider 激活时,GUI 只通过 settings.json 的 ANTHROPIC_MODEL /
// ANTHROPIC_DEFAULT_*_MODEL 把「CLI 自己会读的模型名」指到 provider 模型。不读这些
// 变量的客户端(官方插件的 hook、bot 等)会硬编码 claude-opus-4-7 / claude-sonnet-4-6
// 直接发给代理,代理原样透传 → 上游 400 "Model ... must be called via ..."。
// 这里在代理转发前做最后一道兜底:只改「上游明明不认识的 claude 名」,不动列表内模型、
// 不动非 claude 名字(上游报错就报错,不掩盖拼写错误)。
//
// 纯函数 resolveFallbackModel 不读写模块状态,便于单测;noteModelFallback 的日志去重
// 状态是进程级的 —— 同一 (requested→mapped) 组合只打一次,避免每轮对话刷屏。

// 接口第 2 节规则 3:claude、claude-opus-4-7、claude-sonnet-4-6、claude_3 等。
const CLAUDE_MODEL_RE = /^claude([-_].*)?$/i;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 按接口第 2 节规则 1–4 推导实际发往上游的模型名。入参只读,不改调用方对象。
 *
 * 1. 请求 model 缺失/空/非字符串 → 原样返回;
 * 2. models 列表里显式包含请求 model → 原样返回(规则 2 优先于规则 3);
 * 3. claude 名且不在列表 → defaultModel,缺失时 models[0],都缺失则原样;
 * 4. 其它名字 → 原样返回。
 *
 * @param {unknown} requested 客户端请求体里的 model
 * @param {{ models?: unknown, defaultModel?: unknown }} [opts] 当前 provider 的模型列表与默认模型
 * @returns {unknown} effectiveModel(未映射时与 requested 逐值相同)
 */
export function resolveFallbackModel(requested, { models, defaultModel } = {}) {
  if (!isNonEmptyString(requested)) return requested; // 规则 1
  const list = Array.isArray(models)
    ? models.filter((m) => isNonEmptyString(m))
    : [];
  if (list.includes(requested)) return requested; // 规则 2
  if (!CLAUDE_MODEL_RE.test(requested)) return requested; // 规则 4
  // 规则 3:defaultModel > models[0];都没有就原样(不凭空猜)。
  const fallback = isNonEmptyString(defaultModel)
    ? defaultModel
    : (list.length > 0 ? list[0] : '');
  return fallback || requested;
}

// 进程级去重表。key 用 NUL 分隔,模型名里不会出现,避免 ("a b","c") / ("a","b c") 撞车。
const loggedPairs = new Set();

/**
 * 记录一次映射日志(console.warn)。同一 (requested→mapped) 组合只打一次。
 * 只含两个模型名,不带 key/token;日志失败不影响转发。
 *
 * @param {unknown} requested 客户端原始 model
 * @param {unknown} mapped 映射后的 model
 * @param {{ warn?: Function }} [logger] 可注入的日志出口(单测用),默认 console
 * @returns {boolean} 本次是否真的记了日志
 */
export function noteModelFallback(requested, mapped, logger = console) {
  if (!isNonEmptyString(requested) || !isNonEmptyString(mapped)) return false;
  if (requested === mapped) return false; // 没有发生映射
  const key = `${requested}\u0000${mapped}`;
  if (loggedPairs.has(key)) return false;
  loggedPairs.add(key);
  try {
    const sink = logger && typeof logger.warn === 'function' ? logger : console;
    sink.warn(`[model-fallback] 请求模型 ${requested} 不在当前 provider 模型列表,已映射为 ${mapped}`);
  } catch { /* 日志失败不影响转发本身 */ }
  return true;
}

/** 清空日志去重表(仅供单测;产品路径不应调用)。 */
export function resetModelFallbackLogState() {
  loggedPairs.clear();
}
