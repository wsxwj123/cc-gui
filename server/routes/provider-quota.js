import { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { readCustomProviders, readActiveProviderId, assertPublicBaseURL } from './settings.js';
import { readCapped } from '../utils/read-capped.js';
import {
  pickCandidates, authHeaders, probeQuota, computeLow, normalizeThresholds, reasonNote,
} from '../services/provider-quota.js';

// r16-2:第三方 provider 的余额/额度。官方订阅走 /api/subscription-usage(那张卡在
// 非官方 provider 上整卡不渲染),本路由补上互斥的另一半。纯逻辑(候选端点/解析/阈值)
// 全在 services/provider-quota.js,这里只做 IO:读配置 → 探测 → 缓存。
//
// apiKey 只在内存里流转:不落日志、不进响应体、不进错误信息、不拼进命令行(用 node fetch,
// 不 spawn curl —— 那会把 key 暴露在进程表里)。r16-4 的 quotaKey 同一套约束。
const router = Router();

const TIMEOUT_MS = 8000;
const CACHE_MS = 60_000; // 与 subscription-usage.js 同款:60s 结果缓存 + 失败冷却

// 最后一次成功的数据(按 provider id),失败时回放并标 degraded —— 不把陈旧数据伪装成新鲜。
let cache = null; // { at, providerId, keyTag, data }

// r16-4b(判官建议1):缓存与冷却原先只按 providerId 判 —— 用户刚补上额度密钥保存,
// 立即查却不打上游、仍回放旧的"查不到",而卡片轮询是 120s。这恰好是本功能最该生效的
// 时刻,会被当成"填了没用"。这里把【密钥指纹】也纳入键:换了任一把 key 立即失效。
// 存的是 sha256 前 8 位而非明文 —— 指纹只在内存、不可逆,也不进任何响应或日志。
function keyTagOf(provider) {
  const k = String(provider?.quotaKey || provider?.apiKey || '');
  if (!k) return 'none';
  return (provider?.quotaKey ? 'q:' : 'a:') + createHash('sha256').update(k).digest('hex').slice(0, 8);
}
// 失败冷却**必须带 provider id**:切了 provider 就是另一把 key、另一套端点,拿 A 的
// 失败去冷却 B 会让刚切过去的 provider 一分钟查不出东西(还会挂上 A 的错误文案)。
let cooldown = { providerId: null, until: 0, note: '' };
// 探测命中的端点(按 provider id),避免每次都从头试候选。
const endpointMemo = new Map();
// 在飞的探测。订阅者有三处(用量面板的卡 + 顶栏红点 + provider 切换列表),chat-done 是
// 同一刻广播的 —— 不合并就是同一秒对第三方发三份完全一样的请求。
let inflight = null; // { providerId, promise }

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
  const cacheHit = cache && cache.providerId === provider.id && cache.keyTag === keyTag;
  if (cacheHit && now - cache.at < CACHE_MS) return res.json(cache.data);
  // 失败冷却:全失败后 CACHE_MS 内不再打真接口("标记无额度接口,本次不再重试")。
  // 有旧数据回放 + degraded,没有就回上次原因。
  if (cooldown.providerId === provider.id && cooldown.keyTag === keyTag && now < cooldown.until) {
    if (cacheHit) return res.json({ ...cache.data, degraded: true, note: cooldown.note });
    return res.json({ ...head, ok: false, reason: cooldown.reason || 'no-endpoint', note: cooldown.note });
  }

  // SSRF 守卫。这里是全仓唯一"带存储 apiKey 打存储 baseURL"的新调用点 —— 写入端
  // (probeUpstreamModels)早有同一道门,但存量条目与 DNS rebinding 会绕过它,故探测前
  // 再解析一次主机名(环回放行:本机中转是合法场景;私网/链路本地一律拒)。
  try {
    await assertPublicBaseURL(provider.baseURL);
  } catch {
    cooldown = { providerId: provider.id, keyTag, until: Date.now() + CACHE_MS, reason: 'blocked', note: reasonNote('blocked') };
    return res.json({ ...head, ok: false, reason: 'blocked', note: cooldown.note });
  }

  const all = pickCandidates(provider);
  // 命中过的端点提前:省掉每次重试前面的候选。
  const hit = endpointMemo.get(provider.id);
  const candidates = hit ? [...all.filter((c) => c.vendor === hit), ...all.filter((c) => c.vendor !== hit)] : all;
  if (!candidates.length) {
    cooldown = { providerId: provider.id, keyTag, until: Date.now() + CACHE_MS, reason: 'no-endpoint', note: reasonNote('no-endpoint') };
    return res.json({ ...head, ok: false, reason: 'no-endpoint', note: cooldown.note });
  }

  // 合并的是**整段"探测→建响应→写缓存"**,不只是那次 fetch:并发的几份必须拿到同一个
  // data 对象,否则各写各的缓存(fetchedAt 差几毫秒),缓存回放跟首份对不上。
  if (!inflight || inflight.providerId !== provider.id) {
    const promise = (async () => {
      // r16-4:额度查询用 quotaKey,没配才回落 apiKey。有几家的额度接口认的不是推理 key
      // (OpenRouter 账户余额要 management key、MiniMax 套餐额度可能要订阅密钥),
      // 拿推理 key 打过去只会 401 或读到空数据。
      const result = await probeQuota(candidates, makeFetcher(provider.quotaKey || provider.apiKey));
      if (!result.ok) {
        endpointMemo.delete(provider.id);
        cooldown = { providerId: provider.id, keyTag, until: Date.now() + CACHE_MS, reason: result.reason, note: reasonNote(result.reason) };
        return { reason: result.reason }; // 直接带回失败原因:全局 cooldown 可能已被另一个 provider 的探测清空
      }
      endpointMemo.set(provider.id, result.endpoint);
      const data = {
        ...head, ok: true, kind: result.kind, currency: result.currency, items: result.items,
        low: computeLow(result, await readThresholds()), fetchedAt: Date.now(),
      };
      cache = { at: Date.now(), providerId: provider.id, keyTag, data };
      cooldown = { providerId: null, until: 0, note: '' }; // 成功即解冷却
      return { data };
    })();
    inflight = { providerId: provider.id, promise };
    promise.catch(() => {}).finally(() => { if (inflight?.promise === promise) inflight = null; });
  }
  const out = await inflight.promise;
  if (out.data) return res.json(out.data);
  // 探测失败:有旧数据就回放并标 degraded(不把陈旧数据伪装成新鲜),没有就回人话原因。
  const note = reasonNote(out.reason);
  if (cacheHit) return res.json({ ...cache.data, degraded: true, note });
  res.json({ ...head, ok: false, reason: out.reason, note });
});

export default router;
