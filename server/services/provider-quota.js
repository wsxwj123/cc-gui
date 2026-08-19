// r16-2:第三方 provider 的余额 / 额度。**零 IO 纯函数层** —— 候选端点选择、响应解析、
// 方向/周期归一化、低额度阈值判定。网络与文件读写全在 routes/provider-quota.js,
// 单测(tests/unit/check-provider-quota-*.mjs)直接 import 本文件的真函数。
//
// 设计:不按 baseURL 猜"套餐还是按量",而是**探测** —— 每家按序请求候选端点,
// 第一个 HTTP 200 且字段能解析成功的即采纳。依据:智谱/MiniMax 的按量线与套餐线
// 同 host、同一把 key,baseURL 判不出;而失败信号干净(Kimi 套餐 key 打按量余额端点
// 返回 404 而不是返回 0),能区分"路由不存在"与"数据就是 0"。

// One-API 系"无限额度"的哨兵值。见 parseOneAPI。
const UNLIMITED = 1e8;

// 明确没有额度接口的 host(探针实证:MiMo 四域名 × 七种路径全 404,而 /v1/models 401
// 证明 host 正常;四家云厂商的计费 API 要 AK/SK 签名,GUI 只有一把推理 key 拿不到)。
// 命中即不发任何请求,直接告诉用户"该 provider 不提供额度接口"。
const NO_QUOTA_HOSTS = ['xiaomimimo', 'aliyuncs', 'dashscope', 'volces', 'tencentcloud', 'hunyuan', 'baidubce', 'qianfan'];

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

/**
 * provider 配置 → 候选端点列表(按探测顺序)。**只认调研实证过的端点,不凭记忆补充**。
 * 每个候选:{ vendor, auth:'bearer'|'raw', urls:[...], currency? };urls 多于一条时
 * 表示"两条都要"(One-API 系的额度与已用量分两个端点),缺一即该候选失败。
 * 返回空数组 = 该 provider 没有可查的额度接口(UI 明写原因,不留空白)。
 */
export function pickCandidates(provider) {
  const u = safeURL(provider?.baseURL);
  if (!u) return [];
  const host = u.hostname.toLowerCase();
  const base = provider.baseURL.trim().replace(/\/+$/, '');
  const origin = u.origin;

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
  // 智谱:**裸 token,不加 Bearer**(加了就 401)。
  if (host === 'open.bigmodel.cn' || host === 'api.z.ai') {
    return [{ vendor: 'zhipu', auth: 'raw', urls: [`${origin}/api/monitor/usage/quota/limit`] }];
  }
  if (host.includes('minimaxi.com') || host.includes('minimax.io')) {
    return [{ vendor: 'minimax', auth: 'bearer', urls: [`${origin}/v1/token_plan/remains`] }];
  }
  if (host === 'opencode.ai') {
    return [{ vendor: 'opencode', auth: 'bearer', urls: [v1(base, 'usage')] }];
  }
  if (host.includes('siliconflow')) {
    return [{ vendor: 'siliconflow', auth: 'bearer', urls: [`${base}/user/info`] }];
  }
  if (host === 'openrouter.ai') {
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
export function authHeaders(auth, apiKey) {
  return { Authorization: auth === 'raw' ? String(apiKey || '') : `Bearer ${apiKey || ''}` };
}

const item = (o) => {
  const it = { label: o.label, direction: o.direction };
  if (typeof o.percent === 'number') it.percent = Math.round(o.percent * 10) / 10;
  if (typeof o.value === 'number') it.value = o.value;
  if (typeof o.max === 'number') it.max = o.max;
  it.resetAt = o.resetAt ?? null;
  it.unlimited = !!o.unlimited;
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

// OpenRouter:limit 与 limit_remaining 同为 null = 没有上限 → 标"无限",**不显示百分比**
// (没有分母)。limit_reset 为 null 时是**终身累计**上限,绝不能标"本月"。
function parseOpenrouter(j, currency) {
  const d = j?.data;
  if (!d || typeof d !== 'object') return null;
  // 「两者为 null = 无上限」的判据是**两个键都在且都为 null**。用 `== null` 会把"响应里
  // 压根没这两个键"(字段改名/换了个上游)也判成无限 —— 那是拿"读不到"冒充"没上限"。
  const has = (k) => Object.prototype.hasOwnProperty.call(d, k);
  if (has('limit') && has('limit_remaining') && d.limit === null && d.limit_remaining === null) {
    return { kind: 'amount', currency, items: [item({ label: '额度', direction: 'left', unlimited: true })] };
  }
  // 读不到剩余量就整条降级成"查不到"。只有 max 没有 value 会渲染出一行光秃秃的周期词
  // (没数字、没方向词、没进度条),比明写"查不到"更像是坏了。
  const left = num(d.limit_remaining);
  if (left === null) return null;
  const max = num(d.limit);
  const label = d.limit_reset == null ? '累计（终身）' : windowLabel(d.limit_reset, '额度');
  return {
    kind: 'amount', currency,
    items: [item({ label, direction: 'left', value: left, max: max ?? undefined })],
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
    case 'minimax': return parseMinimax(b[0]);
    case 'opencode': return parseOpencode(b[0]);
    case 'siliconflow': return parseSiliconflow(b[0]);
    case 'openrouter': return parseOpenrouter(b[0], candidate.currency || 'USD');
    case 'oneapi': return parseOneAPI(b);
    default: return null;
  }
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
    if (parsed) return { ok: true, endpoint: c.vendor, ...parsed };
  }
  return { ok: false, reason };
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

// ok:false 时给人话原因(留空白用户会以为查询坏了)。
export function reasonNote(reason) {
  if (reason === 'auth') return '额度接口拒绝了当前密钥（可能未开通该接口或权限不足）';
  if (reason === 'network') return '额度接口请求失败（网络不可达或超时）';
  if (reason === 'blocked') return '该 provider 的地址指向内网，已拒绝查询额度（SSRF 防护）';
  return '该 provider 不提供额度接口';
}
