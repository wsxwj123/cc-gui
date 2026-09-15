// r16-2:第三方 provider 的余额 / 额度。**零 IO 纯函数层** —— 候选端点选择、响应解析、
// 方向/周期归一化、低额度阈值判定。网络与文件读写全在 routes/provider-quota.js,
// 单测(tests/unit/check-provider-quota-*.mjs)直接 import 本文件的真函数。
//
// 设计:不按 baseURL 猜"套餐还是按量",而是**探测** —— 每家按序请求候选端点,
// 第一个 HTTP 200 且字段能解析成功的即采纳。依据:智谱/MiniMax 的按量线与套餐线
// 同 host、同一把 key,baseURL 判不出;而失败信号干净(Kimi 套餐 key 打按量余额端点
// 返回 404 而不是返回 0),能区分"路由不存在"与"数据就是 0"。
//
// 仍守住"零 IO":唯一带"算身份"味道的是 pickCandidates 里那次 **纯字符串比对**
// (matchPresetByBaseURL 只做 new URL + 表内查找,不发请求、不读文件)。
import { matchPresetByBaseURL } from '../utils/builtin-providers.js';

// 身份分派表(INTERFACE §10.4 定死):分派键 = matchPresetByBaseURL 命中的**预设 id**,
// 不是 host 字面量 —— 同一家的 openai / anthropic 兼容入口同属一条身份。
// 为什么要有这三张表:预设表本身只有 id/name/type/baseURL/note/docs,不为本项加字段。
const ZHIPU_CN_PRESETS = ['zhipu-glm', 'glm-coding', 'glm-anthropic']; // host = open.bigmodel.cn
const ZAI_PRESETS = ['zai-intl', 'zai-coding', 'zai-coding-anthropic']; // host = api.z.ai
// 智谱 CN 账户余额。**只发智谱 CN 域族**:余额端点在 www.bigmodel.cn,而判据是 provider
// 的 baseURL —— 两者是两件事(判据看预设身份,请求地址是这一条固定 URL)。
// 路径来自用户实测(不是探测出来的:智谱对**任意路径**都回 200 + code:1001,探测无区分力)。
const ZHIPU_BALANCE_URL = 'https://www.bigmodel.cn/api/biz/account/query-customer-account-report';

// One-API 系"无限额度"的哨兵值。见 parseOneAPI。
const UNLIMITED = 1e8;

// 明确没有额度接口的 host(探针实证:MiMo 四域名 × 七种路径全 404,而 /v1/models 401
// 证明 host 正常;四家云厂商的计费 API 要 AK/SK 签名,GUI 只有一把推理 key 拿不到)。
// 命中即不发任何请求,直接按 D-4 的第②类文案说明(这批 host 有额度接口,只是本期未接入)。
const NO_QUOTA_HOSTS = ['xiaomimimo', 'aliyuncs', 'dashscope', 'volces', 'tencentcloud', 'hunyuan', 'baidubce', 'qianfan'];

// D-4 第②类识别名单(INTERFACE §10.4)= 上面这批 host + anthropic.com。这两批是**同一个
// 集合的两半**:NO_QUOTA_HOSTS 是"探针实证过没有可用额度端点"的(它们有额度**网页**,
// 只是要浏览器 Cookie,本期不接);anthropic.com 是"官方额度已另有通道"(CLI 控制通道的
// 5h/7d 窗口,不在此接第三方端点)。
// 名单内 vs 未登记要分开说:前者是"我们还没做",后者是"这家没登记过" —— 一律说成后者
// 会让用户以为自己的 provider 填错了。
export const NO_ENDPOINT_KNOWN_HOSTS = ['anthropic.com', ...NO_QUOTA_HOSTS];
export const NO_ENDPOINT_KNOWN_NOTE = '该 provider 有额度接口，本期尚未接入，请去官网查看';

/**
 * 候选为空时该说哪一档(第②类 / 第③类)。判据 = provider 的 host 是否命中识别名单。
 * 兜底是 reasonNote('no-endpoint')(第③类串)。
 */
export function noEndpointNote(provider) {
  const host = safeURL(provider?.baseURL)?.hostname.toLowerCase() || '';
  return NO_ENDPOINT_KNOWN_HOSTS.some((h) => host.includes(h))
    ? NO_ENDPOINT_KNOWN_NOTE
    : reasonNote('no-endpoint');
}

// 字符串数字(DeepSeek 的 total_balance / SiliconFlow 的 balance 都是字符串)统一收口:
// 先 Number() 再 Number.isFinite。空串/布尔/null 一律判不可用 —— Number('') === 0 会把
// "字段缺失"伪装成"余额 0"。
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

const arr = (v) => (Array.isArray(v) ? v : []);

// ISO8601 / epoch(秒或毫秒)→ 毫秒时间戳。给前端放 tooltip 用,解析不出给 null。
export function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v : Math.round(v * 1000);
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// 周期词。数字按秒折算,字符串按常见枚举映射;认不出就原样回显(**绝不猜成"本月"** ——
// 标错周期比不标更坏)。
export function windowLabel(w, fallback = '额度') {
  const n = typeof w === 'number' ? w : null;
  if (n !== null && Number.isFinite(n) && n > 0) {
    if (n % 604800 === 0) return n === 604800 ? '周' : `${n / 604800} 周`;
    if (n % 86400 === 0) return n === 86400 ? '日' : `${n / 86400} 天`;
    if (n % 3600 === 0) return `${n / 3600} 小时`;
    return `${n} 秒`;
  }
  const s = String(w || '').trim().toLowerCase();
  if (!s) return fallback;
  if (s === 'weekly' || s === 'week' || s === '7d') return '周';
  if (s === 'daily' || s === 'day' || s === '1d') return '日';
  if (s === 'monthly' || s === 'month' || s === '30d') return '月';
  if (s === 'rolling' || s === 'session') return '滚动窗口';
  const hour = s.match(/^(\d+)\s*h(ours?)?$/);
  if (hour) return `${Number(hour[1])} 小时`;
  return String(w);
}

// 只认 http(s):`new URL('ftp:/x')` 同样能过,不拦就会拿着 key 去请求非 HTTP 协议。
// base 已以 /v1 结尾就直接拼,否则补一层 —— Kimi 与 opencode 两条线共用同一套防御,
// 别拼成 /v1/v1。
const v1 = (base, path) => (/\/v1$/.test(base) ? `${base}/${path}` : `${base}/v1/${path}`);

function safeURL(baseURL) {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return null;
  try {
    const u = new URL(baseURL.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u : null;
  } catch { return null; }
}

// 同源判定(密钥边界用,零 IO)。两条规则与 POST /api/custom-providers/test 的
// 「用存储 key 时 baseURL 取存储值」同一语义,只是额度端点有两个地址要判。
// 判定方向要保守:解析不了的 URL 一律当"不同源/不相等",宁可多要用户填一次密钥。
/** 两个 URL 规范化后是否相等(host 大小写、默认端口、相对路径归一)。解析不了 → trim 后逐字比。 */
export function sameQuotaURL(a, b) {
  const norm = (s) => {
    const t = String(s ?? '').trim();
    try { return new URL(t).href; } catch { return t; }
  };
  return norm(a) === norm(b);
}

/** 两个 URL 是否同 host(含端口)。任一侧解析不了 → false(按"跨源"处理)。 */
export function sameHostURL(a, b) {
  const host = (s) => { try { return new URL(String(s ?? '').trim()).host; } catch { return null; } };
  const ha = host(a);
  return !!ha && ha === host(b);
}

// ── 自定义额度端点(手填通道,INTERFACE-quota-endpoint §B/§C) ────────────────────
// 用户自己登记"额度接口地址 + 取值路径"。**只做纯属性查找**(点号分层 + [n] 下标),
// 无 eval / 无 Function / 不支持表达式 —— 用户填的字符串永远不参与求值。
export const QUOTA_URL_MAX = 2048;
export const QUOTA_PATH_MAX = 200;
const QUOTA_URL_ERR = '额度查询接口必须是 http(s) 地址';
const QUOTA_PATH_ERR = `取值路径非法（上限 ${QUOTA_PATH_MAX} 字符，不含 __proto__ / constructor / prototype）`;
// 原型链三类键名:它们能把纯属性查找变成"取到 Object.prototype 上的东西"。
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** 单个路径段:`name[0][1]` / `[0]` 合法,空段与含非法键名的不合法。 */
function validPathSegment(seg) {
  const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
  if (!m) return false;
  const name = m[1];
  if (!name && !m[2]) return false; // 空段("a..b" / 结尾的点)
  return !FORBIDDEN_SEGMENTS.has(name);
}

/** 取值路径的合法性(§B.2/B.3)。返回人话错误串或 null(= 合法)。 */
export function quotaPathError(path) {
  if (path.length > QUOTA_PATH_MAX) return QUOTA_PATH_ERR;
  if (path && !path.split('.').every(validPathSegment)) return QUOTA_PATH_ERR;
  return null;
}

/**
 * §B.2/B.3 的同步校验(写入端与 quota-test 共用)。返回 { url, path, auth, currency }
 * 或 { error }。**不做 SSRF 判定** —— 那是异步 DNS,由调用点跑 assertQuotaPublicURL。
 * auth/currency 非法值静默回落(不报错,§B.2 的"静默回落"列)。
 */
export function checkQuotaConfig(raw) {
  const urlIn = typeof raw?.quotaURL === 'string' ? raw.quotaURL.trim() : '';
  if (!urlIn) return { error: QUOTA_URL_ERR };
  if (urlIn.length > QUOTA_URL_MAX) return { error: `额度查询接口地址过长（上限 ${QUOTA_URL_MAX} 字符）` };
  let u;
  try { u = new URL(urlIn); } catch { return { error: QUOTA_URL_ERR }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: QUOTA_URL_ERR };
  const path = typeof raw?.quotaPath === 'string' ? raw.quotaPath.trim() : '';
  const pErr = quotaPathError(path);
  if (pErr) return { error: pErr };
  return {
    url: urlIn,
    path,
    auth: raw?.quotaAuth === 'raw' || raw?.quotaAuth === 'none' ? raw.quotaAuth : 'bearer',
    currency: raw?.quotaCurrency === 'CNY' || raw?.quotaCurrency === 'USD' ? raw.quotaCurrency : null,
  };
}

/**
 * 按取值路径取数。语法:点号分层 + `[n]` 下标(`balance_infos[0].total_balance`)。
 * 纯属性查找(own property,不穿原型链),取不到一律 undefined —— 不抛、不猜。
 * 空 path → 返回 obj 本身(= 把整个响应体当一个值)。见 INTERFACE §D.1。
 */
export function readByPath(obj, path) {
  const p = typeof path === 'string' ? path.trim() : '';
  if (!p) return obj;
  let cur = obj;
  for (const seg of p.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
    if (!m) return undefined;
    const name = m[1];
    if (name) {
      if (FORBIDDEN_SEGMENTS.has(name)) return undefined;
      if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, name)) return undefined;
      cur = cur[name];
    }
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx[1])];
    }
  }
  return cur;
}

/**
 * 自定义端点 host(卡片/测试文案只回 host,**绝不回完整 URL** —— 用户可能把 token
 * 写在 path 或 query 里,回显整条就等于把它带进前端/截图/粘贴,INTERFACE §E.5)。
 */
export function customHost(candidate) {
  try { return new URL(arr(candidate?.urls)[0]).host; } catch { return ''; }
}

/**
 * §E.5:手填通道失败时的人话文案。**必须点名"自定义额度接口"** —— 落进既有的
 * 「该 provider 未登记额度接口」会让用户以为配置没生效(他明明登记了)。
 */
export function customNote(reason, candidate) {
  const host = customHost(candidate);
  if (reason === 'auth') return `自定义额度接口拒绝了当前密钥（HTTP 401/403）：${host}`;
  if (reason === 'network') return `自定义额度接口请求失败（网络不可达或超时）：${host}`;
  if (reason === 'blocked') return `自定义额度接口指向内网地址，已拒绝查询（SSRF 防护）：${host}`;
  const path = candidate?.path || '';
  return `自定义额度接口未返回可读的余额：${host}`
    + (path ? `（请求失败，或响应中没有「${path}」）` : '（请求失败，或响应不是可读的数字）');
}

/**
 * 响应键名骨架(可裁剪项 T7):上游 200 但路径取不到时,给用户一张"这响应里有哪些键"
 * 的地图 —— 路径写对是唯一的上手门槛。
 * **只有键名,绝不含任何值**;深度 ≤3、最多 60 条、单条 ≤80 字符、跳过 >40 字符的键名
 * (防把 token 当键名回显)与原型链三类(INTERFACE §C.3)。
 */
export function pathHintsFor(body, { depth = 3, max = 60 } = {}) {
  const out = [];
  const walk = (node, prefix, d) => {
    if (out.length >= max || d > depth || node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (out.length >= max) return;
      if (!k || k.length > 40 || FORBIDDEN_SEGMENTS.has(k)) continue;
      const p = prefix ? `${prefix}.${k}` : k;
      if (p.length > 80) continue;
      out.push(p);
      if (v !== null && typeof v === 'object') walk(v, p, d + 1);
    }
  };
  walk(body, '', 1);
  return out;
}

/**
 * provider 配置 → 手填候选;未配置(或 URL 非法,只有手改文件能做到)返回 null
 * = 视同未配置,回落自动识别通道。见 INTERFACE §D.1。
 */
export function customCandidateOf(provider) {
  const url = typeof provider?.quotaURL === 'string' ? provider.quotaURL.trim() : '';
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return {
    vendor: 'custom',
    auth: provider?.quotaAuth === 'raw' || provider?.quotaAuth === 'none' ? provider.quotaAuth : 'bearer',
    urls: [url],
    path: typeof provider?.quotaPath === 'string' ? provider.quotaPath.trim() : '',
    currency: provider?.quotaCurrency === 'CNY' || provider?.quotaCurrency === 'USD' ? provider.quotaCurrency : null,
  };
}

/**
 * 自定义端点响应 → { kind, currency, items } 或 null。
 * 取数后**必须**过 num():空串/布尔/null 一律判不可用(Number('') === 0 会把"字段缺失"
 * 伪装成"余额 0",I1 不许)。
 */
function parseCustomQuota(body, candidate) {
  const v = num(readByPath(body, candidate?.path));
  if (v === null) return null;
  return { kind: 'amount', currency: candidate?.currency ?? null, items: [item({ label: '余额', direction: 'left', value: v })] };
}

/**
 * provider 配置 → 候选端点列表(按探测顺序)。**只认调研实证过的端点,不凭记忆补充**。
 * 每个候选:{ vendor, auth:'bearer'|'raw', urls:[...], currency? };urls 多于一条时
 * 表示"两条都要"(One-API 系的额度与已用量分两个端点),缺一即该候选失败。
 * 返回空数组 = 该 provider 没有可查的额度接口(UI 明写原因,不留空白)。
 */
export function pickCandidates(provider) {
  // 手填通道**独占**:用户显式登记了额度接口就不再按 host/预设猜(§4.4 的决策 ——
  // "手填优先、失败回落"会让用户看到不是他配的那条产生的数字,静默分叉)。
  const custom = customCandidateOf(provider);
  if (custom) return [custom];
  const u = safeURL(provider?.baseURL);
  if (!u) return [];
  const host = u.hostname.toLowerCase();
  const base = provider.baseURL.trim().replace(/\/+$/, '');
  const origin = u.origin;
  // 身份判定统一走预设表(见文件头的三张表);未命中任何预设(null)= 自填第三方,走原逻辑。
  const matched = matchPresetByBaseURL(provider?.baseURL, { type: provider?.type });
  const presetId = matched.matched ? matched.preset.id : null;

  // Kimi Code(套餐):/v1/usages —— **复数**,官方文档未收录(证据是第三方插件实现)。
  if (host === 'api.kimi.com' && u.pathname.includes('/coding')) {
    return [{ vendor: 'kimi-coding', auth: 'bearer', urls: [v1(base, 'usages')] }];
  }
  // Moonshot(按量):余额端点在顶级 /v1,不跟用户填的 path 走。.cn 计人民币,.ai 计美元。
  if (host === 'api.moonshot.cn' || host === 'api.moonshot.ai') {
    return [{
      vendor: 'moonshot', auth: 'bearer',
      urls: [`${origin}/v1/users/me/balance`],
      currency: host.endsWith('.cn') ? 'CNY' : 'USD',
    }];
  }
  // DeepSeek:余额是**顶级路径** /user/balance,要剥掉用户填的 /anthropic 等 path。
  if (host === 'api.deepseek.com') {
    return [{ vendor: 'deepseek', auth: 'bearer', urls: ['https://api.deepseek.com/user/balance'] }];
  }
  // 智谱:**裸 token,不加 Bearer**(加了就 401)。判据 = **预设身份**(matchPresetByBaseURL),
  // 不按 host 字面量 —— 用户口径是"看是不是走官方的哪个预设接口",同一家的任意协议入口
  // (openai 兼容 / anthropic 兼容)都算同一条身份。分派键 = 命中的预设 id。
  if (presetId && ZHIPU_CN_PRESETS.includes(presetId)) {
    // CN 域族:quota/limit 与**账户余额**两个独立候选**都发**。余额必须独立成候选 ——
    // 一条候选多条 urls 的语义是"两条都要",并进去会让余额失败把套餐额度一起拖垮。
    return [
      { vendor: 'zhipu', auth: 'raw', urls: [`${origin}/api/monitor/usage/quota/limit`], accumulate: true },
      { vendor: 'zhipu-cn-balance', auth: 'raw', urls: [ZHIPU_BALANCE_URL], currency: 'CNY' },
    ];
  }
  // Z.ai 全球站:只走 quota/limit,**不发余额端点** —— 余额端点在 www.bigmodel.cn,
  // 拿 Z.ai 的 key 跨域族发过去是凭证面红线(反之亦然)。
  if (presetId && ZAI_PRESETS.includes(presetId)) {
    return [{ vendor: 'zhipu', auth: 'raw', urls: [`${origin}/api/monitor/usage/quota/limit`] }];
  }
  // OpenAI 官方:走本机 codex 通道(candidate 只作分派标记,urls 为空 = 不发任何带 key 的 HTTP)。
  if (presetId === 'openai') return [{ vendor: 'codex', auth: 'none', urls: [] }];
  if (host.includes('minimaxi.com') || host.includes('minimax.io')) {
    return [{ vendor: 'minimax', auth: 'bearer', urls: [`${origin}/v1/token_plan/remains`] }];
  }
  if (host === 'opencode.ai') {
    return [{ vendor: 'opencode', auth: 'bearer', urls: [v1(base, 'usage')] }];
  }
  if (host.includes('siliconflow')) {
    return [{ vendor: 'siliconflow', auth: 'bearer', urls: [`${base}/user/info`] }];
  }
  // OpenRouter 有两条端点、要两把不同的 key,按有无 quotaKey 分流:
  //  ① 无 quotaKey → /api/v1/key。推理 key 就能读,但读到的是**该 key 自己的花费上限**,
  //     未给 key 设上限时 limit/limit_remaining 全为 null(账户余额一个字都读不到)。
  //  ② 有 quotaKey → /api/v1/credits。这是账户真实余额,只认 management key
  //     (跟推理 key 不是一把,拿推理 key 打它是 401)。
  if (host === 'openrouter.ai') {
    if (String(provider?.quotaKey || '').trim()) {
      return [{ vendor: 'openrouter-credits', auth: 'bearer', urls: ['https://openrouter.ai/api/v1/credits'], currency: 'USD' }];
    }
    return [{ vendor: 'openrouter', auth: 'bearer', urls: ['https://openrouter.ai/api/v1/key'], currency: 'USD' }];
  }
  if (NO_QUOTA_HOSTS.some((h) => host.includes(h))) return [];
  // 兜底:其余 openai 协议 provider 走 One-API 系的两条 dashboard 端点(两条都要)。
  if (provider?.type === 'openai') {
    return [{
      vendor: 'oneapi', auth: 'bearer',
      urls: [`${base}/dashboard/billing/subscription`, `${base}/dashboard/billing/usage`],
    }];
  }
  return [];
}

// 认证头。智谱是唯一的裸 token(不加 Bearer)—— 这一位写错就是 401,单测钉死。
// 'none' = 不带认证头(自定义额度端点专用:有些面板站按内网/白名单放行,发个空的
// `Authorization: Bearer ` 反而会被中间件判成"带了无效凭证")。
export function authHeaders(auth, apiKey) {
  if (auth === 'none') return {};
  // 没有密钥就**不发**认证头:`Authorization: Bearer `(空值)不是"没有凭证",不少上游
  // 把它当坏请求回 4xx —— 用户看到"地址或路径有问题",而真实原因是这里没 key 可发
  // (跨 host 的自定义额度端点不给 apiKey 时就是这种情况)。
  if (!apiKey) return {};
  return { Authorization: auth === 'raw' ? String(apiKey) : `Bearer ${apiKey}` };
}

const item = (o) => {
  const it = { label: o.label, direction: o.direction };
  if (typeof o.percent === 'number') it.percent = Math.round(o.percent * 10) / 10;
  if (typeof o.value === 'number') it.value = o.value;
  if (typeof o.max === 'number') it.max = o.max;
  it.resetAt = o.resetAt ?? null;
  it.unlimited = !!o.unlimited;
  // r26-J7:上限口径三态('set' 有上限 / 'none' 密钥未设上限 / 'unknown' 读不到),
  // 前端按它区分文案,不再把"未设上限"笼统显示成「无限」。
  if (o.limitKind) it.limitKind = o.limitKind;
  return it;
};

// ── 各家解析(全部返回 {kind, currency, items} 或 null;null = 静默降级) ──────────

// Kimi Code:usage.{remaining,limit} 是总量,limits[] 按窗口分。方向 = 剩余量(绝对数),
// 单位是 token/次数一类,**不是钱** → currency 恒 null,UI 不加货币符号。
function parseKimiCoding(j) {
  const items = [];
  const remaining = num(j?.usage?.remaining);
  const limit = num(j?.usage?.limit);
  if (remaining !== null) items.push(item({ label: '额度', direction: 'left', value: remaining, max: limit ?? undefined }));
  for (const l of arr(j?.limits)) {
    const d = (l && typeof l.detail === 'object' && l.detail) || l || {};
    const left = num(d.remaining);
    if (left === null) continue;
    items.push(item({
      label: windowLabel(l?.window), direction: 'left',
      value: left, max: num(d.limit) ?? undefined, resetAt: toMs(d.resets_at ?? d.resetsAt),
    }));
  }
  return items.length ? { kind: 'amount', currency: null, items } : null;
}

function parseMoonshot(j, currency) {
  const v = num(j?.data?.available_balance);
  if (v === null) return null;
  return { kind: 'amount', currency: currency || null, items: [item({ label: '余额', direction: 'left', value: v })] };
}

// DeepSeek:balance_infos[] 的金额是**字符串**。多币种账户取第一条能解析的
// (统一响应形态只带一个 currency)。
function parseDeepseek(j) {
  for (const b of arr(j?.balance_infos)) {
    const v = num(b?.total_balance);
    if (v === null) continue;
    const cur = b?.currency === 'USD' ? 'USD' : b?.currency === 'CNY' ? 'CNY' : null;
    return { kind: 'amount', currency: cur, items: [item({ label: '余额', direction: 'left', value: v })] };
  }
  return null;
}

// 智谱窗口:靠 unit+number 判,**别抄官方脚本**(它把两条 TOKENS_LIMIT 都写成 5 小时)。
function zhipuLabel(l) {
  if (l?.type === 'TIME_LIMIT') return '月';
  const unit = num(l?.unit);
  const n = num(l?.number);
  if (unit === 3 && n !== null) return `${n} 小时`;
  if (unit === 6 && n !== null) return n === 1 ? '周' : `${n} 周`;
  return '额度';
}

// 智谱:**出错时 HTTP 仍是 200**,错误在 body 的 code(成功是 200/0)→ 必须看 body。
function parseZhipu(j) {
  const code = num(j?.code);
  if (code !== null && code !== 200 && code !== 0) return null;
  const items = [];
  for (const l of arr(j?.data?.limits)) {
    const p = num(l?.percentage);
    if (p === null) continue;
    items.push(item({ label: zhipuLabel(l), direction: 'used', percent: p, resetAt: toMs(l?.reset_time ?? l?.resetTime) }));
  }
  return items.length ? { kind: 'percent', currency: null, items } : null;
}

// 智谱 CN 账户余额(与上面的套餐 quota/limit **两条端点、各自独立**)。响应形态来自
// 真实客户端的实测登记:`{success, data:{balance, rechargeAmount, giveAmount,
// totalSpendAmount, frozenBalance, availableBalance}}`,一律包在 data 下。
// 取 `availableBalance`(可用余额)而不是 `balance`(账户余额):冻结/在途的钱花不出去,
// 用户要判断"还能不能继续用"看的是可用余额。
// **缺必需字段 → 整条降级**:余额显示错的数字比"查不到"坏得多(用户会据此判断要不要充值),
// 所以这里不写 0、不回部分字段、不拿 balance 顶替 availableBalance(那是另一个口径)。
function parseZhipuCnBalance(j, currency) {
  const code = num(j?.code);
  if (code !== null && code !== 200 && code !== 0) return null;
  const d = j?.data;
  if (!d || typeof d !== 'object') return null;
  const available = num(d.availableBalance);
  if (available === null) return null;
  return {
    kind: 'amount', currency: currency || 'CNY',
    items: [item({ label: '余额', direction: 'left', value: available })],
  };
}

// MiniMax:出错同样 HTTP 200,错误在 base_resp.status_code(成功为 0)。
// 百分比**直接读 percent 字段** —— total_count/usage_count 可能双 0(配额未下发),
// 用它们反算既会除零又会得出假的 100%。
function parseMinimax(j) {
  const st = num(j?.base_resp?.status_code);
  if (st !== null && st !== 0) return null;
  const m = arr(j?.model_remains)[0];
  if (!m) return null;
  const items = [];
  const five = num(m.current_interval_remaining_percent);
  if (five !== null) items.push(item({ label: '5 小时', direction: 'left', percent: five, resetAt: toMs(m.interval_reset_time ?? m.next_reset_time) }));
  const week = num(m.current_weekly_remaining_percent);
  if (week !== null) items.push(item({ label: '周', direction: 'left', percent: week, resetAt: toMs(m.weekly_reset_time) }));
  return items.length ? { kind: 'percent', currency: null, items } : null;
}

// opencode:usage.{rolling,weekly,monthly}.{percent,resetsAt},方向 = 已用%。
function parseOpencode(j) {
  const u = j?.usage;
  if (!u || typeof u !== 'object') return null;
  const items = [];
  for (const [key, label] of [['rolling', '滚动窗口'], ['weekly', '周'], ['monthly', '月']]) {
    const p = num(u[key]?.percent);
    if (p === null) continue;
    items.push(item({ label, direction: 'used', percent: p, resetAt: toMs(u[key]?.resetsAt) }));
  }
  return items.length ? { kind: 'percent', currency: null, items } : null;
}

// SiliconFlow:data.balance 是**剩余可用**;totalBalance 是充值+赠送之和,用它会虚高。
// 计价单位站点侧未在响应里回传 → currency 留 null,UI 不加符号。
function parseSiliconflow(j) {
  const v = num(j?.data?.balance);
  if (v === null) return null;
  return { kind: 'amount', currency: null, items: [item({ label: '余额', direction: 'left', value: v })] };
}

// OpenRouter:limit 与 limit_remaining 同为 null = 该密钥未设花费上限 —— r26-J7:这不是
// 「无限额度」,只是【这把 key 没设 cap】;账户余额一个字都读不到(要 management key 走
// /credits)。标 limitKind:'none' 让前端说实话,**不显示百分比**(没有分母)。
// limit_reset 为 null 时是**终身累计**上限,绝不能标"本月"。
function parseOpenrouter(j, currency) {
  const d = j?.data;
  if (!d || typeof d !== 'object') return null;
  // 「两者为 null = 无上限」的判据是**两个键都在且都为 null**。用 `== null` 会把"响应里
  // 压根没这两个键"(字段改名/换了个上游)也判成无限 —— 那是拿"读不到"冒充"没上限"。
  const has = (k) => Object.prototype.hasOwnProperty.call(d, k);
  if (has('limit') && has('limit_remaining') && d.limit === null && d.limit_remaining === null) {
    return { kind: 'amount', currency, items: [item({ label: '额度', direction: 'left', unlimited: true, limitKind: 'none' })] };
  }
  // 读不到剩余量就整条降级成"查不到"。只有 max 没有 value 会渲染出一行光秃秃的周期词
  // (没数字、没方向词、没进度条),比明写"查不到"更像是坏了。
  const left = num(d.limit_remaining);
  if (left === null) return null;
  const max = num(d.limit);
  const label = d.limit_reset == null ? '累计（终身）' : windowLabel(d.limit_reset, '额度');
  return {
    kind: 'amount', currency,
    items: [item({ label, direction: 'left', value: left, max: max ?? undefined, limitKind: 'set' })],
  };
}

// OpenRouter(management key 走 /credits):账户余额 = total_credits − total_usage。
// 任一字段缺失/非有限数 → 整条降级成"查不到"。**绝不拿 0 冒充余额** —— 两个字段都读不到时
// 0 − 0 = 0 会渲染成"余额 0",用户会以为欠费停机,比明写"查不到"坏得多。
function parseOpenrouterCredits(j, currency) {
  const total = num(j?.data?.total_credits);
  const used = num(j?.data?.total_usage);
  if (total === null || used === null) return null;
  return {
    kind: 'amount', currency,
    items: [item({ label: '余额', direction: 'left', value: Math.round((total - used) * 100) / 100 })],
  };
}

// One-API 系兜底:余额 = hard_limit_usd − total_usage/100(total_usage **已 ×100**)。
// 两个坑:①无限额度返回 1e8,要识别成"无限"而不是显示一亿;②单位不可靠(站点侧
// QuotaDisplayType 可配 USD/CNY/甚至 token 数,接口不回传口径)→ currency 恒 null。
function parseOneAPI([sub, used]) {
  const hard = num(sub?.hard_limit_usd);
  if (hard === null) return null;
  if (hard >= UNLIMITED) {
    return { kind: 'amount', currency: null, items: [item({ label: '额度', direction: 'left', unlimited: true })] };
  }
  // 「两条都要」:拿不到已用量就算不出余额 —— 此时宁可整条候选失败(UI 明写查不到),
  // 也不能把 hard_limit 当成余额显示(那是"还剩满额"的假象)。
  const total = num(used?.total_usage);
  if (total === null) return null;
  const left = hard - total / 100;
  return { kind: 'amount', currency: null, items: [item({ label: '额度', direction: 'left', value: Math.round(left * 100) / 100, max: hard })] };
}

/** 候选 + 各端点响应体 → {kind, currency, items};任何一步不认得就返回 null(静默降级)。 */
export function parseQuota(candidate, bodies) {
  const b = arr(bodies);
  switch (candidate?.vendor) {
    case 'kimi-coding': return parseKimiCoding(b[0]);
    case 'moonshot': return parseMoonshot(b[0], candidate.currency);
    case 'deepseek': return parseDeepseek(b[0]);
    case 'zhipu': return parseZhipu(b[0]);
    case 'zhipu-cn-balance': return parseZhipuCnBalance(b[0], candidate.currency);
    case 'minimax': return parseMinimax(b[0]);
    case 'opencode': return parseOpencode(b[0]);
    case 'siliconflow': return parseSiliconflow(b[0]);
    case 'openrouter': return parseOpenrouter(b[0], candidate.currency || 'USD');
    case 'openrouter-credits': return parseOpenrouterCredits(b[0], candidate.currency || 'USD');
    case 'oneapi': return parseOneAPI(b);
    case 'custom': return parseCustomQuota(b[0], candidate);
    default: return null;
  }
}

// ── OpenAI 的本地 codex 通道(④ 类;协议与实测记录见 services/codex-quota.js) ──────
// 卡片必带的标注(逐字):这是**本机 codex 登录的那个账户**的额度,与当前 provider 的
// API key 没有任何绑定 —— 两者不是同一账号时,这里的数字跟 API 账单对不上。
export const CODEX_ANNOTATION = '本机 codex 登录的 ChatGPT/Codex 账户额度，与当前 API key 无绑定';

// ④ 类文案(逐字,INTERFACE §10.4)。② 类与 ④a 的串**由路由层在判据命中时显式给出**
// (见 routes/provider-quota.js 的 noEndpointNote),不走 reasonNote 的兜底。
export const CODEX_NOTES = {
  'no-binary': '本机未找到 codex（ChatGPT 应用），无法读取 OpenAI 额度，请去官网查看',
  'not-logged-in': '本机 codex 未登录 ChatGPT 账户，无法读取额度，请去官网查看',
  failed: 'codex 额度查询失败（超时或返回异常），请稍后重试',
};

/**
 * codex 的 account/rateLimits/read 应答 → 现有 items[] 形状(**不新造形状**)。
 * 键名照 V-D4 实测(camelCase:`usedPercent` / `windowDurationMins` / `resetsAt`),
 * 不是二进制里的 snake_case 结构体名。
 *
 * 桶的取法:`rateLimitsByLimitId` 有内容就用它(它是多桶视图,除默认的 `codex` 外还有
 * 按模型的限额桶,如 `codex_bengalfox`);否则回落到**兼容单桶视图** `rateLimits`。
 * 一个桶的 primary/secondary = 两个窗口(如 5 小时 + 周),各出一行。
 * 一行都出不来 → null(整条降级 ④c,不编造)。
 */
export function projectCodexRateLimits(result) {
  const multi = result?.rateLimitsByLimitId;
  const buckets = (multi && typeof multi === 'object' && Object.keys(multi).length)
    ? Object.values(multi)
    : (result?.rateLimits && typeof result.rateLimits === 'object' ? [result.rateLimits] : []);
  const items = [];
  for (const b of buckets) {
    if (!b || typeof b !== 'object') continue;
    const name = typeof b.limitName === 'string' ? b.limitName.trim() : '';
    for (const w of [b.primary, b.secondary]) {
      const used = num(w?.usedPercent);
      if (used === null) continue;
      const mins = num(w?.windowDurationMins);
      // windowDurationMins 是**分钟**,windowLabel 吃的是秒。读不到窗口长度就标「额度」,
      // 绝不猜成"本月"(标错周期比不标更坏)。
      const win = mins !== null && mins > 0 ? windowLabel(mins * 60, '额度') : '额度';
      items.push(item({
        label: name ? `${win} · ${name}` : win,
        direction: 'used', percent: used, resetAt: toMs(w?.resetsAt),
      }));
    }
  }
  return items.length ? { kind: 'percent', currency: null, items } : null;
}

/**
 * OpenAI 预设的探测入口(与 probeQuota 同形,便于路由走同一条缓存/冷却/在飞合并路径)。
 * `read` / `locate` 注入:本文件不 import fs / child_process,IO 全在 codex-quota.js。
 *
 * 三档降级(逐字文案见 CODEX_NOTES):找不到可执行文件 → ④a(连进程都不起);
 * RPC 回鉴权类错误 → ④b;spawn 失败 / RPC 报错 / 超时 / 解析不出 → ④c。
 */
export async function probeCodexQuota(read, locate) {
  const bin = locate();
  if (!bin) return { ok: false, reason: 'no-endpoint', note: CODEX_NOTES['no-binary'] };
  let r = null;
  try { r = await read(bin); } catch { r = null; } // read 自己也不抛;这里再兜一层
  if (!r?.ok) {
    const code = r?.code === 'not-logged-in' ? 'not-logged-in' : 'failed';
    return { ok: false, reason: code === 'not-logged-in' ? 'auth' : 'network', note: CODEX_NOTES[code] };
  }
  const parsed = projectCodexRateLimits(r.result);
  if (!parsed) return { ok: false, reason: 'network', note: CODEX_NOTES.failed };
  return { ok: true, endpoint: 'codex', annotation: CODEX_ANNOTATION, ...parsed };
}

const REASON_RANK = { 'no-endpoint': 0, network: 1, auth: 2 };

/**
 * 按序探测候选端点。fetcher(url, candidate) → { status, body } —— 网络在调用方,
 * 本函数零 IO(单测注入假 fetcher)。任何失败都**不抛**,返回 {ok:false, reason}。
 * 401/403 记 auth(密钥没开通该接口),网络异常记 network,其余(404 等)记 no-endpoint。
 */
export async function probeQuota(candidates, fetcher) {
  const list = arr(candidates);
  let reason = 'no-endpoint';
  let winner = null;
  const note = (r) => { if (REASON_RANK[r] > REASON_RANK[reason]) reason = r; };
  for (const c of list) {
    const bodies = [];
    let failed = false;
    for (const url of arr(c.urls)) {
      let r;
      try { r = await fetcher(url, c); } catch { note('network'); failed = true; break; }
      if (r?.status === 401 || r?.status === 403) { note('auth'); failed = true; break; }
      if (r?.status !== 200) { failed = true; break; }
      bodies.push(r.body);
    }
    if (failed) continue;
    const parsed = parseQuota(c, bodies);
    if (!parsed) continue;
    if (winner) {
      // 命中过一条后又拿到一条:只有声明 accumulate 的候选才有资格被后面的候选追加。
      // 智谱 CN 就是这一类 —— 套餐额度与账户余额是**两条独立端点**,两条都要发、各自
      // 独立计成败:余额挂了不影响上面的套餐额度,余额好了就在同一条 payload 里多一行。
      winner.items.push(...parsed.items);
      // 单位只在原本未知时补:两条候选币种不同时保留先到的那条,不覆盖已知口径。
      if (winner.currency == null) winner.currency = parsed.currency ?? null;
      continue;
    }
    // kind 取**第一条命中**的(合并进来的追加条目不改它):kind 只描述"这批条目以什么为主",
    // 每项的 direction/percent/value 自带渲染口径,前端逐项读,不看 kind。
    winner = { ok: true, endpoint: c.vendor, kind: parsed.kind, currency: parsed.currency, items: parsed.items };
    // 命中即停 —— 不再白打后面的候选(除非本条声明 accumulate)。
    if (!c.accumulate) break;
  }
  return winner || { ok: false, reason };
}

// 低额度阈值。钱类默认 ¥10 / $2,百分比类默认「已用 ≥90% 或剩余 ≤10%」。
export const DEFAULT_THRESHOLDS = { usedPercent: 90, leftPercent: 10, cny: 10, usd: 2 };

export function normalizeThresholds(raw) {
  const t = { ...DEFAULT_THRESHOLDS };
  if (!raw || typeof raw !== 'object') return t;
  for (const k of Object.keys(DEFAULT_THRESHOLDS)) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) t[k] = v;
  }
  return t;
}

/**
 * 是否触发低额度红点。方向词是判据的一半:'used' 看是否超过上限阈值,'left' 看是否低于
 * 下限阈值 —— 读反就会在余额充足时天天报警(或耗尽时一声不吭)。
 * 绝对数有 max 时按比例判(Kimi 的 token 数用钱的阈值毫无意义),无 max 才用钱阈值。
 */
export function computeLow(payload, thresholds = DEFAULT_THRESHOLDS) {
  const t = normalizeThresholds(thresholds);
  const currency = payload?.currency;
  return arr(payload?.items).some((it) => {
    if (!it || it.unlimited) return false;
    if (typeof it.percent === 'number') {
      return it.direction === 'used' ? it.percent >= t.usedPercent : it.percent <= t.leftPercent;
    }
    if (typeof it.value !== 'number') return false;
    if (typeof it.max === 'number' && it.max > 0) return (it.value / it.max) * 100 <= t.leftPercent;
    return it.value <= (currency === 'USD' ? t.usd : t.cny);
  });
}

// r26-J10:红点滞回 —— 用量占比 ≥90% 亮、降到 <85% 才灭(单点阈值在边界抖动会让红点闪)。
// 亮/灭按【方向跨阈才翻转】:prevOn 时看灭阈,否则看亮阈。带宽 5 个百分点。
export const QUOTA_ALERT_ON = 0.9;
export const QUOTA_ALERT_OFF = 0.85;

/**
 * 带滞回的红点判定。prevOn = 该槽位上一次的红点状态(按 providerId+baseURL 指纹分键,
 * 状态残留在 provider 切换后不串)。亮阈按条目方向取:'used' 用 usedPercent,'left'
 * 用 leftPercent(= 剩余 ≤ leftPercent% 亮);灭阈 = 亮阈 − 滞回带宽
 * (QUOTA_ALERT_ON − QUOTA_ALERT_OFF)。默认两阈同为 90%/85% 已用口径。
 * 钱类(无分母的绝对余额)不做滞回:耗尽风险不该等回落确认,保持单点阈值。
 */
export function computeAlert(payload, thresholds = DEFAULT_THRESHOLDS, prevOn = false) {
  const t = normalizeThresholds(thresholds);
  const currency = payload?.currency;
  const band = QUOTA_ALERT_ON - QUOTA_ALERT_OFF; // 滞回带宽(已用占比 5 个百分点)
  for (const it of arr(payload?.items)) {
    if (!it || it.unlimited) continue;
    if (typeof it.percent === 'number' || (typeof it.value === 'number' && typeof it.max === 'number' && it.max > 0)) {
      // 统一折算成「已用占比」(0..1)再比阈
      const f = typeof it.percent === 'number'
        ? (it.direction === 'used' ? it.percent / 100 : 1 - it.percent / 100)
        : (it.direction === 'used' ? it.value / it.max : 1 - it.value / it.max);
      const on = it.direction === 'used' ? t.usedPercent / 100 : 1 - t.leftPercent / 100;
      const off = Math.max(0, on - band);
      if (prevOn ? f >= off : f >= on) return true;
      continue;
    }
    if (typeof it.value === 'number' && it.value <= (currency === 'USD' ? t.usd : t.cny)) return true;
  }
  return false;
}

// ok:false 时给人话原因(留空白用户会以为查询坏了)。
// 兜底那串 = 第③类「未登记」:它同时是"候选为空但不在识别名单里"与"非空候选全失败还
// 落回 no-endpoint"两条路的兜底语义(INTERFACE §10.4)。第②类与 ④a 的串另有出处
// (noEndpointNote / CODEX_NOTES),不从这里出。
export function reasonNote(reason) {
  if (reason === 'auth') return '额度接口拒绝了当前密钥（可能未开通该接口或权限不足）';
  if (reason === 'network') return '额度接口请求失败（网络不可达或超时）';
  if (reason === 'blocked') return '该 provider 的地址指向内网，已拒绝查询额度（SSRF 防护）';
  return '该 provider 未登记额度接口，请去官网查看';
}
