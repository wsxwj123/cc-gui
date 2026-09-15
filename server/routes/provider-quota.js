import { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { readCustomProviders, readActiveProviderId, assertPublicBaseURL, assertQuotaPublicURL } from './settings.js';
import { readCapped } from '../utils/read-capped.js';
import {
  pickCandidates, authHeaders, probeQuota, computeAlert, normalizeThresholds, reasonNote,
  probeCodexQuota, noEndpointNote, customCandidateOf, customNote, parseQuota, checkQuotaConfig, pathHintsFor,
  sameQuotaURL, sameHostURL,
} from '../services/provider-quota.js';
import { readCodexRateLimits, findCodexBin } from '../services/codex-quota.js';

// r16-2:第三方 provider 的余额/额度。官方订阅走 /api/subscription-usage(那张卡在
// 非官方 provider 上整卡不渲染),本路由补上互斥的另一半。纯逻辑(候选端点/解析/阈值)
// 全在 services/provider-quota.js,这里只做 IO:读配置 → 探测 → 缓存。
//
// apiKey 只在内存里流转:不落日志、不进响应体、不进错误信息、不拼进命令行(用 node fetch,
// 不 spawn curl —— 那会把 key 暴露在进程表里)。r16-4 的 quotaKey 同一套约束。
const router = Router();

const TIMEOUT_MS = 8000;
const CACHE_MS = 60_000; // 与 subscription-usage.js 同款:60s 结果缓存 + 失败冷却

// 最后一次成功的数据(按槽位身份 = providerId+baseURL 指纹,J8),失败时回放并标
// degraded —— 不把陈旧数据伪装成新鲜。多槽:改去 B 端点再改回 A,A 的缓存还在。
const cacheBySlot = new Map(); // slotKey → { at, keyTag, data }

// r16-4b(判官建议1):缓存与冷却原先只按 providerId 判 —— 用户刚补上额度密钥保存,
// 立即查却不打上游、仍回放旧的"查不到",而卡片轮询是 120s。这恰好是本功能最该生效的
// 时刻,会被当成"填了没用"。这里把【密钥指纹】也纳入键:换了任一把 key 立即失效。
// 存的是 sha256 前 8 位而非明文 —— 指纹只在内存、不可逆,也不进任何响应或日志。
function keyTagOf(provider) {
  const k = String(provider?.quotaKey || provider?.apiKey || '');
  if (!k) return 'none';
  return (provider?.quotaKey ? 'q:' : 'a:') + createHash('sha256').update(k).digest('hex').slice(0, 8);
}
// r26-J8:缓存/冷却/memo 的身份键必须含 baseURL 指纹 —— 用户编辑端点后(同 providerId、
// 同 key)原先仍吃旧端点的缓存/冷却。指纹只用于内存分键,不做安全判定,截断碰撞的代价
// 只是多打一次额度请求。
function urlTagOf(provider) {
  return createHash('sha1').update(String(provider?.baseURL || '')).digest('hex').slice(0, 8);
}
// 自定义额度端点的配置指纹(§5.4):用户改了额度地址但没动 baseURL 时,槽位键不变 →
// 一分钟内仍吃旧端点的缓存/冷却,用户会当成"填了没用"(r16-4b 在密钥上踩过同一个坑)。
// 一次覆盖五张按 slotKey 分键的表(cache / cooldown / endpointMemo / alertBySlot /
// inflightBySlot)。未配置的自定义端点时**不加这一段** —— 存量槽位键一字不动。
function quotaTagOf(provider) {
  const url = String(provider?.quotaURL || '');
  if (!url) return '';
  return createHash('sha1')
    .update(`${url}|${provider?.quotaPath || ''}|${provider?.quotaAuth || ''}`)
    .digest('hex').slice(0, 8);
}
function slotKeyOf(provider) {
  const q = quotaTagOf(provider);
  return q ? `${provider?.id}|${urlTagOf(provider)}|${q}` : `${provider?.id}|${urlTagOf(provider)}`;
}
// 失败冷却**必须带槽位身份**(providerId+baseURL 指纹):切了 provider 或改了端点就是另一把
// key、另一套端点,拿 A 的失败去冷却 B 会让刚切过去的 provider 一分钟查不出东西(还会挂上 A 的错误文案)。
const cooldownBySlot = new Map(); // slotKey → { keyTag, until, reason, note }
// 探测命中的端点(按槽位身份),避免每次都从头试候选。
const endpointMemo = new Map();
// r26-J10:红点滞回状态(亮/灭),按槽位身份分键 —— 切 provider/换端点后上家的
// 亮灭状态不串到下家。
const alertBySlot = new Map(); // slotKey → boolean
// 在飞的探测。订阅者有三处(用量面板的卡 + 顶栏红点 + provider 切换列表),chat-done 是
// 同一刻广播的 —— 不合并就是同一秒对第三方发三份完全一样的请求。
// r26-J11:按槽位分槽(Map<slotKey, Promise>)—— 单槽时快速切换 provider 会把别家的
// 在飞探测顶掉,切回来又重探一遍(互踩),分槽后各家等各家的。
const inflightBySlot = new Map();

// 当前 provider 是否官方:与 subscription-usage.js 同判据(settings.json 的
// ANTHROPIC_BASE_URL 为空或指向 api.anthropic.com)。官方时本卡整卡不渲染。
async function isOfficial() {
  try {
    const s = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf-8'));
    const base = String(s?.env?.ANTHROPIC_BASE_URL || '');
    return !base || /api\.anthropic\.com/.test(base);
  } catch { return true; }
}

async function readThresholds() {
  try {
    const p = JSON.parse(await readFile(join(homedir(), '.claude-gui', 'prefs.json'), 'utf-8'));
    return normalizeThresholds(p?.quotaThresholds);
  } catch { return normalizeThresholds(null); }
}

// 响应体上限。这条路的 host 是**用户自填的**,不设上限就能在 8s 窗口里往内存灌任意大小。
// 额度响应正常都在几 KB。
// r26-J2:限量读实现抽到 server/utils/read-capped.js 共用(生图路由同款);本处限值不变。
const MAX_BODY = 1_000_000;
// ponytail:只做截断不做流式解析 —— 超限直接当失败,没必要为它写增量 JSON 解析器。
const readBody = (res) => readCapped(res, MAX_BODY);

// fetcher:8s 超时,返回 { status, body }。body 是解析后的 JSON(非 JSON / 超限时给 null,
// 交由解析层判失败)。**错误信息里不带任何 header/key**。
// export 仅为单测:要钉住"路由把 candidate.auth 原样传下去"(智谱的裸 token 写错就是 401,
// 而这一位在纯函数层测不到)。
export function makeFetcher(apiKey) {
  return async (url, candidate) => {
    const r = await fetch(url, {
      headers: { ...authHeaders(candidate.auth, apiKey), Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // 不跟随重定向:上面那道 SSRF 守卫只解析了 baseURL 的主机名,跟随 302 等于把内网
      // 探测面又还回去(上游把我们重定向到 169.254.169.254 之类)。3xx 直接当非 200 失败。
      redirect: 'manual',
    });
    let body = null;
    try { body = JSON.parse(await readBody(r)); } catch { body = null; }
    return { status: r.status, body };
  };
}

// 失败文案分流(§D.5):手填通道命中 → 自定义文案(点名"自定义额度接口");否则既有原因表。
function noteFor(reason, custom) {
  return custom ? customNote(reason, custom) : reasonNote(reason);
}

// 探测用哪把 key:quotaKey 优先(它是用户为额度接口单独配的);没配才回落 apiKey —— 但
// **只在同源时回落**。apiKey 是推理密钥,归属是 provider 的 baseURL;自定义额度端点配成
// 别的 host 时把它带过去,等于把推理密钥交给那个 host(手改文件 / 经本地口的 PUT 都能把
// quotaURL 指到别处,一次污染 → 之后每次探测静默外发)。跨 host 只有 quotaKey 能跟过去,
// 没有就不发认证头(上游回 401,卡片文案引导用户填额度查询密钥)。
function quotaKeyFor(provider, custom) {
  if (provider.quotaKey) return provider.quotaKey;
  if (custom && !sameHostURL(provider.baseURL, provider.quotaURL)) return '';
  return provider.apiKey || '';
}

// GET /api/provider-quota
//  官方 → { official:true }(前端整卡隐藏,由订阅额度卡接管)
//  成功 → { ok:true, providerId, providerName, kind, currency, items[], low }
//  失败 → { ok:false, reason:'no-endpoint'|'network'|'auth', note:'人话原因' }
router.get('/provider-quota', async (_req, res) => {
  const activeId = await readActiveProviderId();
  const provider = activeId ? (await readCustomProviders()).find((p) => p.id === activeId) : null;
  if (!provider) {
    // 没在 GUI 管理的 provider 列表里:官方就交给订阅额度卡,否则明写原因(留空白
    // 用户会以为查询坏了)。
    if (await isOfficial()) return res.json({ official: true });
    return res.json({
      ok: false, official: false, reason: 'no-endpoint',
      note: '未找到当前 provider 的配置（额度查询只支持在 GUI 里管理的 provider）',
    });
  }
  const head = { official: false, providerId: provider.id, providerName: provider.name || provider.id };
  const now = Date.now();
  const keyTag = keyTagOf(provider);
  const slotKey = slotKeyOf(provider); // r26-J8:身份 = providerId + baseURL 指纹
  const cached = cacheBySlot.get(slotKey);
  const cacheHit = cached && cached.keyTag === keyTag ? cached : null;
  if (cacheHit && now - cacheHit.at < CACHE_MS) return res.json(cacheHit.data);
  // 失败冷却:全失败后 CACHE_MS 内不再打真接口("标记无额度接口,本次不再重试")。
  // 有旧数据回放 + degraded,没有就回上次原因。
  const cd = cooldownBySlot.get(slotKey);
  if (cd && cd.keyTag === keyTag && now < cd.until) {
    if (cacheHit) return res.json({ ...cacheHit.data, degraded: true, note: cd.note });
    // 没有旧数据可回放时也要自曝 degraded:这一份同样**不是刚刚探测出来的**结果,而是
    // 上一次失败的复述。不标的话,调用方无法区分"刚打的、确实查不到"与"一分钟前失败过、
    // 这次根本没打上游"(客户端两者渲染相同,但语义与排查都不同)。
    return res.json({ ...head, ok: false, degraded: true, reason: cd.reason || 'no-endpoint', note: cd.note });
  }

  // SSRF 守卫。这里是全仓唯一"带存储 apiKey 打存储 baseURL"的新调用点 —— 写入端
  // (probeUpstreamModels)早有同一道门,但存量条目与 DNS rebinding 会绕过它,故探测前
  // 再解析一次主机名(环回放行:本机中转是合法场景;私网/链路本地一律拒)。
  try {
    await assertPublicBaseURL(provider.baseURL);
  } catch {
    cooldownBySlot.set(slotKey, { keyTag, until: Date.now() + CACHE_MS, reason: 'blocked', note: reasonNote('blocked') });
    return res.json({ ...head, ok: false, reason: 'blocked', note: reasonNote('blocked') });
  }
  // 自定义额度端点是**另一个 host**(跨 host 是合法场景:API 站与面板站分离,§4.1),
  // 所以对它的 host 也得再解析一次 —— 存量条目/手改文件/DNS rebinding 一样能绕过写入端。
  // 同一道守卫,同一口径(环回放行、私网拒、https 解析失败放行)。
  const custom = customCandidateOf(provider);
  if (custom) {
    try {
      await assertQuotaPublicURL(custom.urls[0]);
    } catch {
      const note = customNote('blocked', custom);
      cooldownBySlot.set(slotKey, { keyTag, until: Date.now() + CACHE_MS, reason: 'blocked', note });
      return res.json({ ...head, ok: false, reason: 'blocked', note });
    }
  }

  const all = pickCandidates(provider);
  // 命中过的端点提前:省掉每次重试前面的候选。
  const hit = endpointMemo.get(slotKey);
  const candidates = hit ? [...all.filter((c) => c.vendor === hit), ...all.filter((c) => c.vendor !== hit)] : all;
  if (!candidates.length) {
    // 候选为空分两档:识别名单内(第②类"本期未接入")vs 其余(第③类"未登记")。
    const note = noEndpointNote(provider);
    cooldownBySlot.set(slotKey, { keyTag, until: Date.now() + CACHE_MS, reason: 'no-endpoint', note });
    return res.json({ ...head, ok: false, reason: 'no-endpoint', note });
  }

  // 合并的是**整段"探测→建响应→写缓存"**,不只是那次 fetch:并发的几份必须拿到同一个
  // data 对象,否则各写各的缓存(fetchedAt 差几毫秒),缓存回放跟首份对不上。
  if (!inflightBySlot.has(slotKey)) {
    const promise = (async () => {
      // r16-4:额度查询用 quotaKey,没配才回落 apiKey(且只同源回落,见 quotaKeyFor)。
      // 有几家的额度接口认的不是推理 key(OpenRouter 账户余额要 management key、MiniMax
      // 套餐额度可能要订阅密钥),拿推理 key 打过去只会 401 或读到空数据。
      // OpenAI 官方预设走本机 codex 的只读 RPC(不带任何 key、不发 HTTP);其余走候选探测。
      // 两条路的返回值同形,后面的缓存/冷却/在飞合并**共用同一段**。
      const result = candidates.some((c) => c.vendor === 'codex')
        ? await probeCodexQuota(readCodexRateLimits, findCodexBin)
        : await probeQuota(candidates, makeFetcher(quotaKeyFor(provider, custom)));
      if (!result.ok) {
        endpointMemo.delete(slotKey);
        // ④ 类自带逐字文案(codex 通道);手填通道命中时用"自定义额度接口"那套(落进
        // 「该 provider 未登记额度接口」会让用户以为配置没生效,他明明登记了);其余走原因表。
        const note = result.note || noteFor(result.reason, custom);
        cooldownBySlot.set(slotKey, { keyTag, until: Date.now() + CACHE_MS, reason: result.reason, note });
        return { reason: result.reason, note }; // 直接带回失败原因:冷却可能已被另一个槽位的探测清掉
      }
      endpointMemo.set(slotKey, result.endpoint);
      // r26-J10:红点带滞回 —— 占比 ≥90% 才亮、降到 <85% 才灭,边界抖动不闪。
      const thresholds = await readThresholds();
      const low = computeAlert(result, thresholds, alertBySlot.get(slotKey) || false);
      alertBySlot.set(slotKey, low);
      const data = {
        ...head, ok: true, kind: result.kind, currency: result.currency, items: result.items,
        low, fetchedAt: Date.now(),
        // codex 通道成功时带上卡片标注(本机账户额度与 API key 无绑定);其余候选没有这一项。
        ...(result.annotation ? { note: result.annotation } : {}),
      };
      cacheBySlot.set(slotKey, { at: Date.now(), keyTag, data });
      cooldownBySlot.delete(slotKey); // 成功即解冷却
      return { data };
    })();
    inflightBySlot.set(slotKey, promise);
    promise.catch(() => {}).finally(() => { if (inflightBySlot.get(slotKey) === promise) inflightBySlot.delete(slotKey); });
  }
  const out = await inflightBySlot.get(slotKey);
  if (out.data) return res.json(out.data);
  // 探测失败:有旧数据就回放并标 degraded(不把陈旧数据伪装成新鲜),没有就回人话原因。
  const note = out.note || noteFor(out.reason, custom);
  if (cacheHit) return res.json({ ...cacheHit.data, degraded: true, note });
  res.json({ ...head, ok: false, reason: out.reason, note });
});

// §E.4「测试失败 · SSRF」逐字文案(测试口专用:用户点的是"测试",看到的该是测试结果,
// 不是一条写入期的校验错误)。
const CUSTOM_TEST_BLOCKED = '该地址指向内网，已拒绝（SSRF 防护）。仅允许公网地址与本机回环地址。';
// 同源闸拦下时的文案:必须说清"为什么没测"与"下一步做什么" —— 只说"失败"用户会以为
// 是端点坏了,然后反复点(见 §C.3:这是唯一接受调用方指定 URL 的口子)。
const CUSTOM_TEST_KEY_ORIGIN = '地址与已保存的额度地址不同：已保存的密钥只用于已保存的地址，不会发往新地址。请填写额度查询密钥后测试。';

// POST /api/custom-providers/quota-test —— 让用户验证**任意** provider(含非激活的)的
// 额度端点配置。GET /api/provider-quota 只查 active-provider.json 那一个,没有这个口子
// 就只能靠切过去验证。
//
// 这是 V1 契约放宽(接受调用方指定的 URL)的唯一新入口,守卫一条不砍:
//   ①§B.3 形态/长度校验(400,同一张错误表)
//   ②SSRF 守卫:同一道 assertPublicBaseURL(环回放行 / 私网与链路本地拒 / 公网 http 拒 /
//     https 解析失败放行 —— 口径一个字不改)
//   ③makeFetcher:8s 超时 / **不跟随重定向** / 1MB 上限
//   ④与生产**同一个** readByPath + num 解析(不另写一套)
// 密钥边界:**只进请求头**(makeFetcher → authHeaders),响应体 / error / pathHints 三层
// 都不含它。地址回显一律只回 host 与键名,不回完整 URL。
// 不写缓存、不写冷却、不动 endpointMemo:测试是显式动作,连续两次必须真打上游两次。
router.post('/custom-providers/quota-test', async (req, res) => {
  const cfg = checkQuotaConfig(req.body);
  if (cfg.error) return res.status(400).json({ ok: false, error: cfg.error });
  try {
    await assertQuotaPublicURL(cfg.url);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.kind === 'blocked' ? CUSTOM_TEST_BLOCKED : e.message });
  }
  const candidate = { vendor: 'custom', auth: cfg.auth, urls: [cfg.url], path: cfg.path, currency: cfg.currency };
  // 密钥来源:本次输入优先;否则编辑态按 id 读存储值(quotaKey → apiKey,与
  // POST /api/custom-providers/test 的既有做法一致)。新增态且一个都没有 → 不拦:
  // 让上游回 401,用户看到真实原因。
  let apiKey = typeof req.body?.quotaKey === 'string' ? req.body.quotaKey.trim() : '';
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  if (!apiKey && id) {
    const p = (await readCustomProviders()).find((x) => x.id === id);
    const stored = p?.quotaKey || p?.apiKey || '';
    // 同源闸(与 POST /api/custom-providers/test 同语义:用存储 key 时地址必须取存储值):
    // 存储密钥只发往**存储的**额度地址;调用方指定别的地址又不自带 quotaKey 时一律扣下,
    // 一个请求都不发 —— 否则 {id, quotaURL:攻击者地址} 就能把该 provider 的密钥送出去。
    // 业务失败与其它测试失败同形(HTTP 200 + ok:false,前端读 body.ok 渲染成结果横幅)。
    if (stored && !sameQuotaURL(cfg.url, p.quotaURL)) {
      return res.json({ ok: false, error: CUSTOM_TEST_KEY_ORIGIN });
    }
    apiKey = stored;
  }
  let r;
  try { r = await makeFetcher(apiKey)(cfg.url, candidate); }
  catch { return res.json({ ok: false, error: '请求失败（网络不可达或超时）。' }); }
  if (r.status === 401 || r.status === 403) {
    return res.json({ ok: false, error: `接口拒绝了当前密钥（HTTP ${r.status}）。可在上方填写额度查询密钥。`, httpStatus: r.status });
  }
  if (r.status !== 200) {
    return res.json({ ok: false, error: `请求失败（HTTP ${r.status}）。请检查地址与取值路径。`, httpStatus: r.status });
  }
  const parsed = parseQuota(candidate, [r.body]);
  if (!parsed) {
    // 路径写对是唯一的上手门槛 → 200 但取不到时附一张**只有键名**的响应骨架(V4)。
    const hints = cfg.path ? pathHintsFor(r.body) : [];
    return res.json({
      ok: false,
      error: cfg.path ? `响应里没有「${cfg.path}」这个路径。` : '响应不是可读的数字。',
      ...(hints.length ? { pathHints: hints } : {}),
    });
  }
  return res.json({ ok: true, value: parsed.items[0].value, currency: parsed.currency, path: cfg.path });
});

export default router;
