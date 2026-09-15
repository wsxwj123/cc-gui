// R20 官方价目目录:状态机 + 缓存 + 刷新。
//
// 数据流:registry(产品唯一预设全集) → 每家官方源的采集器(pricing-sources.js) →
// 按来源快照(snapshot) → GET /api/pricing 的 providers/quotes/prices 视图。
//
// 硬规矩(逐字来自 .devflow/INTERFACE.md + PRICING-RULINGS.md):
// - 一源失败不得清空他源或最后有效价;每源只留当前/上一有效快照,不无限留版本。
// - 24 小时内用缓存;没有有效数据时 prices/quotes 可空,不伪造 0 价。
// - 刷新最多并行 3 源、单源 15 秒超时;同一批仍在跑/已全部成功且在 24h 内 → 重复请求返回同一 refreshId;
//   已结束的 failed/partial 批次再请求开新一轮;重合源共享 inflight(不重复发请求)。
// - refresh 逐家结果在 refresh.providers[] 逐条可观察(终态 status/errorCode/attemptedAt/fetchedAt)。
// - 0 仅代表来源明确免费;「不支持/暂免/议价/未提供」一律 null。

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { COLLECTORS, PARSER_VERSION, collectorFor, metaFor, registryPresetIds, sourceUrlFor } from './pricing-sources.js';
import { BUILTIN_PROVIDERS } from '../utils/builtin-providers.js';

const CACHE_DIR = join(homedir(), '.claude-gui');
const CACHE_PATH = join(CACHE_DIR, 'pricing-catalog.json');
const TTL_MS = 24 * 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 15_000;
const MAX_PARALLEL = 3;
const AUTO_RETRY_MIN_MS = 10 * 60 * 1000; // 自动刷新失败源的最短重试间隔
const USER_AGENT = 'cc-gui-pricing/1.0 (+official price pages)';

const UNIT = 'per 1M tokens';

// ── 状态 ────────────────────────────────────────────────────────────────
// snapshots: collectorId → { collectorId, presetIds, status, errorCode, attemptedAt, fetchedAt,
//                           quotes, modelCount, unresolvedModels }
let snapshots = new Map();
let refreshRuns = new Map();      // refreshId → run
let refreshByKey = new Map();     // presetIds 集合 key → refreshId(同批重复请求同 id)
let inflightSources = new Map();  // collectorId → Promise
let lastWarmupId = null;          // 最近一次自动刷新(warmupIfStale 发起)的 refreshId
let runSeq = 0;                   // 同批同毫秒也能开出不同 refreshId(失败批次允许立即重开后才可能撞)
let bootDone = false;

function now() { return new Date().toISOString(); }

function loadDisk() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    for (const snap of parsed?.snapshots || []) {
      // 解析器版本不同的旧快照不再可信(维度/形状可能已变)→ 当作没有,下次刷新重建。
      if (snap && typeof snap.collectorId === 'string' && snap.parserVersion === PARSER_VERSION) snapshots.set(snap.collectorId, snap);
    }
  } catch { /* 首次运行无缓存文件:空目录起点 */ }
}

function saveDisk() {
  // 原子替换(写法同 usage-stats.js saveCache):直写会先把文件截到 0,写一半被杀 → 下次 loadDisk
  // 解析失败当空 = 全部来源的最后有效价一次清空。写临时文件再 rename,任何时刻只见完整旧值或完整新值。
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: 1, snapshots: [...snapshots.values()] }));
    renameSync(tmp, CACHE_PATH);
  } catch {
    // 落盘失败不影响内存态;删掉本次临时文件,免得每次失败都留一份半成品。
    try { unlinkSync(tmp); } catch { /* 本来就没写出来 / 删不掉 */ }
  }
}

// ── 报价归一 ────────────────────────────────────────────────────────────

function quoteIdOf(parts) {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function protocolOfPreset(presetId) {
  // registry 里的 type 就是协议名(openai/claude…);多条预设共用一条报价时协议不唯一 → null。
  const builtin = BUILTIN_PROVIDERS.find((p) => p.id === presetId);
  return builtin?.type || null;
}

function buildQuotesFor(collector, snapshot) {
  const primary = collector.presetIds[0];
  const meta = metaFor(primary);
  const single = collector.presetIds.length === 1;
  const fetchedAt = snapshot.fetchedAt;
  return (snapshot.rawQuotes || []).map((raw) => {
    const key = raw.modelId || raw.displayName;
    const conditions = raw.conditions || null;
    const quoteId = quoteIdOf([primary, key, raw.currency, conditions, collector.id]);
    const priced = ['input', 'output'].some((dim) => typeof raw.prices?.[dim] === 'number');
    return {
      quoteId,
      provider: primary,
      presetIds: [...collector.presetIds],
      modelId: raw.modelId || null,
      displayName: raw.displayName || null,
      protocol: single ? protocolOfPreset(primary) : null,
      market: meta.market || null,
      currency: raw.currency || null,
      unit: UNIT,
      prices: {
        input: raw.prices?.input ?? null,
        output: raw.prices?.output ?? null,
        cacheRead: raw.prices?.cacheRead ?? null,
        cacheWrite5m: raw.prices?.cacheWrite5m ?? null,
        cacheWrite1h: raw.prices?.cacheWrite1h ?? null,
      },
      conditions,
      validFrom: raw.validFrom ?? null,
      validTo: raw.validTo ?? null,
      sourceUrl: meta.sourceUrl,
      sourceKind: 'official',
      fetchedAt,
      parserVersion: PARSER_VERSION,
      status: priced ? 'fresh' : 'unresolved',
    };
  });
}

/** 同一条报价(同模型+同币种+同条件)在来源里重复出现时只留一条,避免明细与计数互相矛盾。 */
function dedupeRawQuotes(list) {
  const seen = new Set();
  const out = [];
  for (const quote of list) {
    const key = JSON.stringify([quote.modelId || quote.displayName, quote.currency, quote.conditions ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(quote);
  }
  return out;
}

function summarizeQuotes(quotes) {
  const models = new Set();
  const unresolved = new Set();
  for (const quote of quotes) {
    const key = quote.modelId || quote.displayName || quote.quoteId;
    models.add(key);
    if (!quote.modelId) unresolved.add(quote.displayName || key);
  }
  return { modelCount: models.size, unresolvedModels: [...unresolved] };
}

// ── 抓取 ────────────────────────────────────────────────────────────────

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!response.ok) return { errorCode: 'SOURCE_UNAVAILABLE', detail: `HTTP ${response.status}` };
  const text = await response.text();
  return { text };
}

async function runCollector(collector) {
  const attemptedAt = now();
  const presetIds = collector.presetIds;
  if (!collector.request) {
    return { collectorId: collector.id, presetIds, status: 'source-unavailable', errorCode: 'SOURCE_UNAVAILABLE', attemptedAt, fetchedAt: null, rawQuotes: [], modelCount: 0, unresolvedModels: [] };
  }
  try {
    const fetched = await fetchText(collector.request.url);
    if (fetched.errorCode) {
      return { collectorId: collector.id, presetIds, status: 'source-unavailable', errorCode: fetched.errorCode, attemptedAt, fetchedAt: null, rawQuotes: [], modelCount: 0, unresolvedModels: [] };
    }
    let parsed;
    try {
      parsed = collector.parse(fetched.text);
    } catch {
      parsed = { quotes: [] };
    }
    const rawQuotes = dedupeRawQuotes((parsed?.quotes || []).filter((q) => q && (q.modelId || q.displayName) && q.currency));
    if (!rawQuotes.length) {
      // 200 却首页/空表/币种或单位不明 → 错误内容,不冒充成功。
      const errorCode = parsed?.partialReason === 'PRICE_DIMENSION_UNKNOWN' ? 'PRICE_DIMENSION_UNKNOWN' : 'SOURCE_INVALID_CONTENT';
      return {
        collectorId: collector.id, presetIds,
        status: parsed?.modelCount > 0 ? 'partial' : 'source-unavailable',
        errorCode,
        attemptedAt, fetchedAt: null,
        rawQuotes: [], modelCount: parsed?.modelCount || 0, unresolvedModels: [],
      };
    }
    const snapshot = {
      collectorId: collector.id,
      presetIds,
      parserVersion: PARSER_VERSION,
      status: parsed?.partial ? 'partial' : 'fresh',
      errorCode: null,
      attemptedAt,
      fetchedAt: attemptedAt,
      rawQuotes,
      ...summarizeQuotes(buildQuotesFor(collector, { rawQuotes, fetchedAt: attemptedAt })),
    };
    return snapshot;
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const previous = snapshots.get(collector.id);
    return {
      collectorId: collector.id,
      presetIds,
      status: previous?.fetchedAt ? 'stale' : 'source-unavailable',
      errorCode: timedOut ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE',
      // 有上一份数据时 attemptedAt 仍是那份数据对应的时间(fetchedAt 不得早于它)。
      attemptedAt: previous?.fetchedAt ? previous.attemptedAt : attemptedAt,
      fetchedAt: previous?.fetchedAt || null,
      rawQuotes: previous?.rawQuotes || [],
      modelCount: previous?.modelCount || 0,
      unresolvedModels: previous?.unresolvedModels || [],
    };
  }
}

/** 单源 inflight 合并:同一来源在一次刷新里只发一次网络请求。 */
function collectSource(collector) {
  const existing = inflightSources.get(collector.id);
  if (existing) return existing;
  const promise = runCollector(collector)
    .then((snapshot) => {
      if (!snapshot.rawQuotes?.length && snapshot.status === 'source-unavailable') {
        // 失败:保留上一份有效快照的价格,状态如实标失败(不清空他源/最后有效价)。
        const previous = snapshots.get(collector.id);
        if (previous?.rawQuotes?.length) {
          // 保留上一份有效价:attemptedAt 也保留成【这份数据对应的那次尝试】——
          // fetchedAt 是上次成功时间,不能比 attemptedAt 还早(合同口径:快照的时间自洽)。
          const merged = { ...previous, status: previous.status === 'fresh' ? 'stale' : previous.status, errorCode: snapshot.errorCode };
          snapshots.set(collector.id, merged);
          return merged;
        }
      }
      snapshots.set(collector.id, snapshot);
      saveDisk();
      return snapshot;
    })
    .finally(() => { inflightSources.delete(collector.id); });
  inflightSources.set(collector.id, promise);
  return promise;
}

// ── 刷新运行 ────────────────────────────────────────────────────────────

function presetKey(ids) { return [...ids].sort().join(','); }

function deriveTopStatus(entries) {
  const successStates = ['fresh', 'partial', 'not-token-priced'];
  const states = entries.map((entry) => entry.status);
  const successes = states.filter((state) => successStates.includes(state)).length;
  if (!states.length) return 'completed';
  if (successes === states.length) return 'completed';
  if (successes === 0) return 'failed';
  return 'partial';
}

function entryForPreset(presetId, snapshot, attemptedAt) {
  const meta = metaFor(presetId);
  if (meta.planOnly) {
    return { presetId, status: 'not-token-priced', errorCode: null, attemptedAt, fetchedAt: null };
  }
  const collector = collectorFor(presetId);
  if (!collector) {
    return { presetId, status: 'unmapped', errorCode: null, attemptedAt, fetchedAt: null };
  }
  if (!snapshot || snapshot.status === undefined) {
    return { presetId, status: 'source-unavailable', errorCode: 'SOURCE_UNAVAILABLE', attemptedAt, fetchedAt: null };
  }
  return { presetId, status: snapshot.status, errorCode: snapshot.errorCode || null, attemptedAt: snapshot.attemptedAt || null, fetchedAt: snapshot.fetchedAt || null };
}

function finishRun(run) {
  run.status = deriveTopStatus(run.providers);
  run.finishedAt = now();
  saveDisk();
}

/**
 * 启动一次刷新。presetIds 省略 = 全预设。返回 { refreshId, status }。
 * 同一批(去重后集合相同)仍在跑、或已全部成功且在 24h 内 → 返回同一 refreshId;
 * 已结束的 failed/partial 批次 → 开新一轮(否则开机没网失败一次,24h 内手动/自动都无法重试)。
 */
export function startRefresh(presetIds) {
  const all = registryPresetIds();
  const ids = presetIds ? [...new Set(presetIds)] : all;
  const key = presetKey(ids);
  const existingId = refreshByKey.get(key);
  const existing = existingId ? refreshRuns.get(existingId) : null;
  const reusable = existing && Date.now() - Date.parse(existing.startedAt) < TTL_MS
    && (existing.status === 'running' || existing.status === 'completed');
  if (reusable) return { refreshId: existing.refreshId, status: existing.status };

  runSeq += 1;
  const refreshId = `pr_${createHash('sha1').update(`${key}|${Date.now()}|${runSeq}`).digest('hex').slice(0, 16)}`;
  const run = {
    refreshId, key, presetIds: [...ids], status: 'running', startedAt: now(), finishedAt: null,
    providers: [], pending: new Set(), order: [], settled: 0,
  };
  refreshRuns.set(refreshId, run);
  refreshByKey.set(key, refreshId);
  run.providers = ids.map((presetId) => {
    const collector = collectorFor(presetId);
    if (collector) run.order.push({ presetId, collector }); // 无采集器(套餐/未映射)当场定终态,不进 pending
    return entryForPreset(presetId, collector ? snapshots.get(collector.id) : null, now());
  });
  if (!run.order.length) { finishRun(run); return { refreshId, status: run.status }; }

  // 最多并行 3 源:有上份快照的源先做(刷新期间旧价仍可读),其余随后。
  const queue = [...run.order].sort((a, b) => (snapshots.get(b.collector.id)?.fetchedAt ? 1 : 0) - (snapshots.get(a.collector.id)?.fetchedAt ? 1 : 0));
  let cursor = 0;
  let busy = 0;
  const pump = () => {
    while (busy < MAX_PARALLEL && cursor < queue.length) {
      const item = queue[cursor];
      cursor += 1;
      busy += 1;
      run.pending.add(item.presetId);
      collectSource(item.collector)
        .catch(() => null)
        .then((snapshot) => {
          const entry = run.providers.find((p) => p.presetId === item.presetId);
          if (entry) Object.assign(entry, entryForPreset(item.presetId, snapshot, now()));
          run.pending.delete(item.presetId);
          run.settled += 1;
          busy -= 1;
          if (run.settled === queue.length) finishRun(run);
          else pump();
        });
    }
  };
  pump();
  return { refreshId, status: run.status };
}

export function getRefresh(refreshId) {
  const run = refreshRuns.get(refreshId);
  if (run) return { run };
  return { run: null };
}

/** 最近一次(含进行中)刷新的可观察视图。 */
function currentRefreshView() {
  let latest = null;
  for (const run of refreshRuns.values()) {
    if (!latest || Date.parse(run.startedAt) > Date.parse(latest.startedAt)) latest = run;
  }
  if (!latest) return { status: 'completed', refreshId: null, providers: [], startedAt: null, finishedAt: null };
  return {
    refreshId: latest.refreshId,
    status: latest.status,
    startedAt: latest.startedAt,
    finishedAt: latest.finishedAt,
    providers: latest.providers.map((p) => ({ ...p })),
  };
}

// ── 目录视图 ────────────────────────────────────────────────────────────

function quoteList() {
  const all = [];
  for (const snapshot of snapshots.values()) {
    const collector = COLLECTORS[snapshot.collectorId];
    if (!collector) continue;
    const built = buildQuotesFor(collector, snapshot);
    const seen = new Set();
    for (const quote of built) {
      if (seen.has(quote.quoteId)) continue;
      seen.add(quote.quoteId);
      all.push(quote);
    }
  }
  return all;
}

/** 兼容旧四字段:只在该模型存在唯一一条「明确适用」报价且四维齐全时写入(宁缺勿猜)。 */
export function legacyPrices(quotes) {
  const byModel = new Map();
  for (const quote of quotes) {
    if (!quote.modelId || quote.status !== 'fresh') continue;
    if (quote.currency !== 'USD') continue; // 旧视图是 USD/1M,别把 CNY 数字混进去
    const { input, output, cacheRead, cacheWrite5m, cacheWrite1h } = quote.prices;
    if ([input, output, cacheRead].some((v) => typeof v !== 'number')) continue;
    const cacheWrite = typeof cacheWrite5m === 'number' ? cacheWrite5m : cacheWrite1h;
    if (typeof cacheWrite !== 'number') continue;
    const list = byModel.get(quote.modelId) || [];
    list.push({ input, output, cacheRead, cacheWrite });
    byModel.set(quote.modelId, list);
  }
  const out = {};
  for (const [model, list] of byModel) {
    if (list.length !== 1) continue;
    out[model] = list[0];
  }
  return out;
}

export function buildCatalog({ refreshId = null } = {}) {
  const quotes = quoteList();
  const ids = registryPresetIds();
  const providers = ids.map((presetId) => {
    const meta = metaFor(presetId);
    const collector = collectorFor(presetId);
    const snapshot = collector ? snapshots.get(collector.id) : null;
    const runningRun = [...refreshRuns.values()].find((run) => run.status === 'running' && run.pending.has(presetId));
    let status;
    let errorCode = null;
    let attemptedAt = null;
    let fetchedAt = null;
    let modelCount = 0;
    let unresolvedModels = [];
    if (snapshot) {
      status = snapshot.status;
      errorCode = snapshot.errorCode || null;
      attemptedAt = snapshot.attemptedAt || null;
      fetchedAt = snapshot.fetchedAt || null;
      // 时间自洽兜底:fetchedAt 是上次成功,永远不能晚于 attemptedAt(旧版写坏的磁盘快照
      // 也在这里被纠正,不用等下一次刷新)。
      if (fetchedAt && attemptedAt && Date.parse(fetchedAt) < Date.parse(attemptedAt)) attemptedAt = fetchedAt;
      modelCount = snapshot.modelCount || 0;
      unresolvedModels = snapshot.unresolvedModels || [];
    } else if (meta.planOnly) {
      status = 'not-token-priced';
    } else if (!collector) {
      status = 'unmapped';
    } else {
      status = 'source-unavailable';
      errorCode = 'SOURCE_UNAVAILABLE';
    }
    if (runningRun) {
      // 刷新进行中:已有上份结果的源标 stale(旧价仍在),尚未取到的保持原状态。
      if (fetchedAt) status = 'stale';
      else if (status === 'fresh') status = 'stale';
    }
    return {
      presetId,
      billingProvider: meta.billingProvider,
      market: meta.market,
      billingMode: meta.billingMode,
      sourceUrl: sourceUrlFor(presetId),
      status,
      attemptedAt,
      fetchedAt,
      errorCode,
      modelCount,
      unresolvedModels,
    };
  });

  const prices = legacyPrices(quotes);
  let newest = null;
  for (const snapshot of snapshots.values()) {
    if (snapshot.fetchedAt && (!newest || Date.parse(snapshot.fetchedAt) > Date.parse(newest))) newest = snapshot.fetchedAt;
  }
  return {
    source: 'official-sources',
    fetchedAt: newest,
    prices,
    schemaVersion: 2,
    providers,
    quotes,
    refresh: currentRefreshView(),
  };
}

/** 24h 内用缓存:首次访问/过期时后台刷新,GET 不阻塞在网络上。 */
export function warmupIfStale() {
  const ids = registryPresetIds();
  const stale = ids.filter((presetId) => {
    const collector = collectorFor(presetId);
    if (!collector) return false;
    const snapshot = snapshots.get(collector.id);
    if (snapshot?.fetchedAt && Date.now() - Date.parse(snapshot.fetchedAt) <= TTL_MS) return false;
    // 取不到数据的源不每次 GET 都重试(它的旧 attemptedAt 会一直「过期」)。
    const lastAttempt = snapshot?.attemptedAt ? Date.parse(snapshot.attemptedAt) : 0;
    return Date.now() - lastAttempt > AUTO_RETRY_MIN_MS;
  });
  if (!stale.length) return null;
  // 按「上一轮自动刷新」限频,而不是按批次 key 缓存 24h:有旧价的源失败后 attemptedAt 保留旧值(见 collectSource),
  // 上面的逐源过滤挡不住它,且 stale 集合一变 key 就变 —— 只能在这里统一挡:
  // 上一轮还在跑 → 不叠加;上一轮 failed/partial → 结束后至少隔 AUTO_RETRY_MIN_MS 再自动重试(合同:至少间隔 10 分钟)。
  const last = lastWarmupId ? refreshRuns.get(lastWarmupId) : null;
  if (last?.status === 'running') return null;
  if (last && last.status !== 'completed' && Date.now() - Date.parse(last.finishedAt || last.startedAt) < AUTO_RETRY_MIN_MS) return null;
  const started = startRefresh(stale);
  lastWarmupId = started.refreshId;
  return started;
}

export function __resetForTests() {
  snapshots = new Map();
  refreshRuns = new Map();
  refreshByKey = new Map();
  inflightSources = new Map();
  lastWarmupId = null;
  bootDone = false;
}

export function bootPricingCatalog() {
  if (bootDone) return;
  bootDone = true;
  loadDisk();
  // 应用启动即预热:应用关闭时不承诺定时更新,开机后有一次即算「首次访问自动刷新」。
  warmupIfStale();
}
