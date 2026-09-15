// R20 官方价目 HTTP 入口。
//
// GET  /api/pricing                —— 当前价目 + 逐家状态(schemaVersion:2 + 兼容旧四字段)
// GET  /api/pricing?refreshId=…    —— 同一份价目 + 该次刷新的状态(未知 404 / 过期 410)
// GET  /api/pricing/current        —— 当前 provider 的价目身份(前端据此渲染刷新范围/禁用理由)
// POST /api/pricing/refresh        —— 触发刷新(省略 presetIds = 全预设;scope:'current' = 只刷当前
//                                      provider),202 {refreshId,status:'running'}
//
// 错误信封统一 {ok:false,code,error}(公共规则节)。请求体里带 url/header/key 一律忽略:
// 来源地址只能来自本模块登记的官方源,不接受调用方改写。
import { Router } from 'express';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { buildCatalog, startRefresh, getRefresh, warmupIfStale, bootPricingCatalog } from '../services/pricing-catalog.js';
import { registryPresetIds } from '../services/pricing-sources.js';
import { matchPresetByBaseURL } from '../utils/builtin-providers.js';
import { readActiveProviderId, readCustomProviders } from './settings.js';

const router = Router();

const REFRESH_KEEP_MS = 24 * 60 * 60 * 1000;
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const ANTHROPIC_ACTIVE_PATH = join(homedir(), '.claude-gui', 'anthropic-active.json');
const LOOPBACK_RE = /^https?:\/\/(127(\.\d+){3}|localhost|\[::1\])(:|\/|$)/i;

async function readJsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
}

function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return String(url || ''); }
}

/** baseURL → 该家官方价目的预设 id 数组;不在预设表里返回 null(纯函数,单测直接喂)。 */
export function presetIdsForBaseURL(baseURL) {
  const hit = matchPresetByBaseURL(baseURL);
  // 同 host 的多条预设共用一条采集器(deepseek-official / deepseek-anthropic 同一次抓取):
  // 一起传,只刷当前 provider 时也把它两个协议入口都算上。host 不在 43 家预设里 → 无从判身份。
  return hit.matched ? hit.candidates.map((p) => p.id) : null;
}

/**
 * 「当前 provider」的价目身份 —— 前端「刷新价格」默认只刷这一家,范围由这里定。
 * 身份只取现成的三处来源(与 /provider-quota、restore*Provider 同一口径,不新造来源):
 *   1. active-provider.json 的 id → custom-providers.json 的 baseURL(GUI 自建 provider)
 *   2. anthropic-active.json 的 baseURL(走回环代理时的真实上游;**只在 settings 仍指向回环
 *      代理时可信** —— 用户改用终端 cc switch 切走后,旧 marker 不能再代表当前 provider)
 *   3. settings.json 的 env.ANTHROPIC_BASE_URL(直连第三方时就是真地址;回环代理地址匹配不上预设)
 * 三处都没有 BASE_URL = 官方 Anthropic(切官方会把 BASE_URL 删掉,settings.js 的 official 分支)。
 * @returns {{presetIds:string[], label:string, resolved:boolean, reason:string|null}}
 */
export async function resolveCurrentPriceScope() {
  const activeId = await readActiveProviderId();
  let baseURL = '';
  let label = '';
  if (activeId) {
    const provider = (await readCustomProviders()).find((p) => p.id === activeId);
    if (provider?.baseURL) { baseURL = String(provider.baseURL); label = provider.name || activeId; }
  }
  const settings = await readJsonFile(SETTINGS_PATH);
  const envBase = String(settings?.env?.ANTHROPIC_BASE_URL || '');
  if (!baseURL && LOOPBACK_RE.test(envBase)) {
    const marker = await readJsonFile(ANTHROPIC_ACTIVE_PATH);
    if (marker?.baseURL) { baseURL = String(marker.baseURL); label = marker.name || marker.providerId || ''; }
  }
  if (!baseURL) baseURL = envBase;
  if (!baseURL) return { presetIds: ['anthropic-official'], label: label || 'Anthropic 官方', resolved: true, reason: null };
  const presetIds = presetIdsForBaseURL(baseURL);
  if (!presetIds) {
    return {
      presetIds: [], label: label || hostOf(baseURL), resolved: false,
      reason: `当前 provider（${hostOf(baseURL)}）不在官方价目来源的 ${registryPresetIds().length} 家预设里，无法按家刷新`,
    };
  }
  return { presetIds, label: label || presetIds[0], resolved: true, reason: null };
}

function fail(res, status, code, error) {
  return res.status(status).json({ ok: false, code, error });
}

// 当前 provider 的价目身份(前端渲染「范围」行 + 判disable 用;刷新接口本身不接受前端指定的范围)。
// 单开一个端点而不是塞进 GET /api/pricing:那个响应的顶层键集合是合同锁定的 7 个键
// (PA-401 逐字断言),加字段会红。
router.get('/pricing/current', async (_req, res) => {
  res.json({ ok: true, ...(await resolveCurrentPriceScope()) });
});

router.get('/pricing', (req, res) => {
  // 24h 内用缓存:过期/首次访问在后台自动刷新,GET 不等网络(先回当前价目)。
  warmupIfStale();
  const refreshId = typeof req.query.refreshId === 'string' ? req.query.refreshId : null;
  if (refreshId) {
    const { run } = getRefresh(refreshId);
    if (!run) return fail(res, 404, 'PRICING_REFRESH_NOT_FOUND', '未找到该刷新记录(进程重启后旧 id 不再保留)');
    if (Date.now() - Date.parse(run.startedAt) > REFRESH_KEEP_MS) {
      return fail(res, 410, 'PRICING_REFRESH_EXPIRED', '该刷新记录已超过 24 小时保留窗口');
    }
    const catalog = buildCatalog({ refreshId });
    catalog.refresh = {
      refreshId: run.refreshId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      providers: run.providers.map((entry) => ({ ...entry })),
    };
    return res.json(catalog);
  }
  return res.json(buildCatalog());
});

router.post('/pricing/refresh', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // 只有 presetIds / scope 参与语义;url/header/key 等一律不读(不接受调用方指定来源)。
  const raw = body.presetIds;
  if (raw !== undefined && !Array.isArray(raw)) {
    return fail(res, 400, 'PRICING_INVALID_PROVIDER', 'presetIds 必须是预设 id 数组');
  }
  if (body.scope !== undefined && body.scope !== 'current') {
    return fail(res, 400, 'PRICING_INVALID_PROVIDER', "scope 只支持 'current'");
  }
  const known = new Set(registryPresetIds());
  if (Array.isArray(raw)) {
    if (!raw.length) return fail(res, 400, 'PRICING_INVALID_PROVIDER', 'presetIds 不能是空数组');
    const bad = raw.find((id) => typeof id !== 'string' || !known.has(id));
    if (bad !== undefined) {
      // 混入一个非法项整个请求 400,且不抓任何源。
      return fail(res, 400, 'PRICING_INVALID_PROVIDER', '包含未知的预设 id');
    }
  }
  // scope:'current' = 只刷当前 provider;显式 presetIds 优先(不把两套范围混着算)。
  // 身份判不出来(自建/中转地址不在 43 家预设里)时明确回 400,而不是悄悄回落全预设 ——
  // 回落就等于违背「只刷当前」这件事本身,用户拿到的会是 43 家的请求面。
  let ids = Array.isArray(raw) ? raw : null;
  if (!ids && body.scope === 'current') {
    const current = await resolveCurrentPriceScope();
    if (!current.resolved) return fail(res, 400, 'PRICING_CURRENT_UNRESOLVED', current.reason);
    ids = current.presetIds;
  }
  const { refreshId } = startRefresh(ids);
  // 202 的语义是「已受理这次刷新」:合同原文固定返回 status:'running'。同一批重复请求
  // 会拿回同一个 refreshId(那轮可能已经结束),真实进度一律以 GET ?refreshId= 的
  // refresh.status 为准,这里不把「那轮已结束」当成一次新刷新的应答。
  return res.status(202).json({ ok: true, refreshId, status: 'running' });
});

export { bootPricingCatalog };

export default router;
