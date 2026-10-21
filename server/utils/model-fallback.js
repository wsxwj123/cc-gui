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
//
// r151q(第 3、4 项):代理转发前经 resolveUpstreamModel 读用户级 ~/.claude/settings.json ——
//   · 映射目标跟随 settings 的当前主模型(换主模型只改 settings,不会调 setter;公开版没有常驻代理监听 settings);
//   · 这家 provider 卖 claude(列表里本来就有 claude 名)时,settings 里配置的名字即使不在列表也原样转发。
// 只用 Node 内置模块(本文件会被固化进常驻代理仓的 vendor,不能引项目里的其它模块)。

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 接口第 2 节规则 3:claude、claude-opus-4-7、claude-sonnet-4-6、claude_3 等。
const CLAUDE_MODEL_RE = /^claude([-_].*)?$/i;

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function cleanModelList(models) {
  return Array.isArray(models) ? models.filter((m) => isNonEmptyString(m)) : [];
}

function isProtectedName(protectedNames, name) {
  if (protectedNames instanceof Set) return protectedNames.has(name);
  return Array.isArray(protectedNames) && protectedNames.includes(name);
}

/**
 * 按接口第 2 节规则 1–4 推导实际发往上游的模型名。入参只读,不改调用方对象。
 *
 * 1. 请求 model 缺失/空/非字符串 → 原样返回;
 * 2. models 列表里显式包含请求 model → 原样返回(规则 2 优先于规则 3);
 * 3. claude 名且不在列表 → settingsTarget,其次 defaultModel,再次 models[0],都缺失则原样;
 *    例外(r151q):列表里本来就有 claude 名(这家卖 claude)且请求名在 protectedNames 里 → 原样。
 *    列表里没有 claude 名时 protectedNames 不起作用(残留的 claude 名照旧映射,与改动前相同)。
 * 4. 其它名字 → 原样返回。
 *
 * @param {unknown} requested 客户端请求体里的 model
 * @param {{ models?: unknown, defaultModel?: unknown, settingsTarget?: unknown, protectedNames?: Set<string>|string[] }} [opts]
 *   当前 provider 的模型列表与默认模型(setter 给的);settingsTarget / protectedNames 来自用户级 settings(见 readModelSettings)
 * @returns {unknown} effectiveModel(未映射时与 requested 逐值相同)
 */
export function resolveFallbackModel(requested, { models, defaultModel, settingsTarget, protectedNames } = {}) {
  if (!isNonEmptyString(requested)) return requested; // 规则 1
  const list = cleanModelList(models);
  if (list.includes(requested)) return requested; // 规则 2
  if (!CLAUDE_MODEL_RE.test(requested)) return requested; // 规则 4
  if (isProtectedName(protectedNames, requested) && list.some((m) => CLAUDE_MODEL_RE.test(m))) return requested;
  // 规则 3:settings 的主模型 > defaultModel > models[0];都没有就原样(不凭空猜)。
  let fallback = '';
  if (isNonEmptyString(settingsTarget)) fallback = settingsTarget;
  else if (isNonEmptyString(defaultModel)) fallback = defaultModel;
  else if (list.length > 0) fallback = list[0];
  return fallback || requested;
}

// ── r151q:用户级 settings.json 里的模型配置 ──────────────────────────────────────────

// CLI 的模型别名:不是上游认得的模型名,不能当映射目标(写成别名时退回 setter 给的目标)。
const CLI_MODEL_ALIASES = new Set(['default', 'best', 'sonnet', 'opus', 'haiku', 'fable', 'opusplan']);

/** 规范化 settings 里的模型名:去首尾空白与结尾的 [1m](不分大小写)。非字符串 → ''。 */
export function normalizeModelName(v) {
  return typeof v === 'string' ? v.trim().replace(/\[1m\]$/i, '').trim() : '';
}

/**
 * 从已解析的 settings 对象推出 { target, protectedNames }(纯函数,export 仅为可单测)。
 *   target         映射目标:env.ANTHROPIC_MODEL,其次顶层 model(规范化后;是 CLI 别名的跳过);都没有 → ''
 *   protectedNames env 里所有以 _MODEL 结尾的键的值 + 顶层 model,规范化后的集合
 */
export function modelSettingsFrom(settings) {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const env = s.env && typeof s.env === 'object' && !Array.isArray(s.env) ? s.env : {};
  const protectedNames = new Set();
  for (const [key, value] of Object.entries(env)) {
    const name = key.endsWith('_MODEL') ? normalizeModelName(value) : '';
    if (name) protectedNames.add(name);
  }
  const top = normalizeModelName(s.model);
  if (top) protectedNames.add(top);
  const asTarget = (v) => {
    const name = normalizeModelName(v);
    return name && !CLI_MODEL_ALIASES.has(name.toLowerCase()) ? name : '';
  };
  return { target: asTarget(env.ANTHROPIC_MODEL) || asTarget(s.model), protectedNames };
}

// 上一次成功读到的结果(按文件路径 + mtime/size 缓存);读失败不缓存,下次照样重读。
let settingsCache = null; // { file, key, snap }
let lastFailureLogged = ''; // 同一文件同一错误类型只记一次日志,坏文件不至于每个请求刷一行
// mtime 精度粗的文件系统上,同一时间刻内两次等长写入的 mtime+size 相同;刚改过的文件不信缓存,每次重读。
const RACY_WINDOW_MS = 2000;

function settingsReadFailed(err, file, logger) {
  // 日志只写错误类型:JSON.parse 的错误原文会带出文件片段(可能含 token),env 也不能进日志。
  const type = String((err && (err.code || err.name)) || 'Error');
  const sig = `${file}\u0000${type}`;
  if (lastFailureLogged !== sig) {
    lastFailureLogged = sig;
    try {
      const sink = logger && typeof logger.warn === 'function' ? logger : console;
      sink.warn(`[model-fallback] settings 读取失败(${type})`);
    } catch { /* 日志失败不影响转发 */ }
  }
  return settingsCache && settingsCache.file === file ? settingsCache.snap : null;
}

/**
 * 读用户级 settings.json 的模型配置({ target, protectedNames },没有可用结果时 null)。
 * 先看 mtime+size,没变就用缓存;变了就重读。解析失败沿用上一次成功的结果(不缓存失败);
 * 从来没成功过 → null(调用方退回 setter 给的值)。文件不存在 = 没有 settings → null。
 *
 * @param {{ file?: string, logger?: { warn?: Function }, now?: number }} [opts] file 默认 os.homedir()/.claude/settings.json(跟随 HOME)
 */
export function readModelSettings({ file = join(homedir(), '.claude', 'settings.json'), logger = console, now = Date.now() } = {}) {
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      settingsCache = { file, key: 'missing', snap: null };
      lastFailureLogged = '';
      return null;
    }
    return settingsReadFailed(err, file, logger);
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (settingsCache && settingsCache.file === file && settingsCache.key === key && now - st.mtimeMs > RACY_WINDOW_MS) {
    return settingsCache.snap;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    return settingsReadFailed(err, file, logger);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return settingsReadFailed({ name: 'NotAnObject' }, file, logger);
  const snap = modelSettingsFrom(parsed);
  settingsCache = { file, key, snap };
  lastFailureLogged = '';
  return snap;
}

/**
 * 代理转发前调用:按当前 provider(up.models / up.defaultModel)与用户级 settings 推导发往上游的模型名。
 * 只有"claude 名且不在列表"才可能改写,也只有这时才读 settings;其余原样返回,不碰文件。
 *
 * @param {unknown} requested 客户端请求体里的 model
 * @param {{ models?: unknown, defaultModel?: unknown } | null} up 代理当前的上游快照
 * @param {{ file?: string, logger?: object, now?: number }} [opts] 透传给 readModelSettings(单测用)
 */
export function resolveUpstreamModel(requested, up, opts) {
  const models = up ? up.models : undefined;
  const defaultModel = up ? up.defaultModel : undefined;
  if (!isNonEmptyString(requested) || !CLAUDE_MODEL_RE.test(requested) || cleanModelList(models).includes(requested)) {
    return requested;
  }
  const snap = readModelSettings(opts);
  return resolveFallbackModel(requested, {
    models,
    defaultModel,
    settingsTarget: snap ? snap.target : '',
    protectedNames: snap ? snap.protectedNames : undefined,
  });
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

/** 清空日志去重表与 settings 缓存(仅供单测;产品路径不应调用)。 */
export function resetModelFallbackLogState() {
  loggedPairs.clear();
  settingsCache = null;
  lastFailureLogged = '';
}
