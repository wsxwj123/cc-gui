// 官方价目目录的客户端缓存(R20/R24)。
//
// 用量面板里的「价格与来源」区要用 GET /api/pricing;这份数据不像用量统计那样每次
// 都要重扫,应用起来先取一次、面板打开即用(标为 stale 也只是把上次的拿来看)。
// 刷新价格走 POST /api/pricing/refresh,结果用 setPricingCatalog 写回同一份缓存。
//
// 索引(2026-09-11):quotes 是逐条消息、逐次调用查的(历史列表能到 2 万条),线性遍历
// 数百条 quotes 是硬性性能问题 → set/hydrate 时按 modelId 与 officialKey(displayName)
// 各建一个 Map,查表 O(1),catalog 一变就重建。
import { normalizeOfficialName } from '../../../server/utils/pricing-rules.js';

let cache = null;
let inflight = null;
let byModelId = new Map();
let byName = new Map();
let allQuotes = [];

/** 官方显示名的比较键:归一(丢尾括号/trim/折叠空白)+ 小写(见契约 §10.11③)。 */
export function officialNameKey(displayName) {
  return normalizeOfficialName(displayName).toLowerCase();
}

// 外部内容(官方采集/community 表的模型名)当 Map 键前先拒绝原型污染用的保留字 ——
// 拒绝而不是改名:改出来的名字会变成另一个"能命中"的键,反而制造错配。
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const safeKey = (value) => (typeof value === 'string' && value && !UNSAFE_KEYS.has(value) ? value : '');

function push(map, key, quote) {
  const list = map.get(key);
  if (list) list.push(quote);
  else map.set(key, [quote]);
}

function rebuild(data) {
  const nextModel = new Map();
  const nextName = new Map();
  const quotes = [];
  const seen = new Set();
  for (const quote of Array.isArray(data?.quotes) ? data.quotes : []) {
    if (!quote || typeof quote !== 'object') continue;
    // §10.12⑥:候选按 quoteId 去重;缺失时按稳定序列化去重(同一条报价不该算两次)。
    const id = quote.quoteId || JSON.stringify([
      quote.provider, quote.modelId, quote.displayName, quote.conditions ?? null,
      quote.currency, quote.prices?.input, quote.prices?.output, quote.prices?.cacheRead,
      quote.prices?.cacheWrite5m, quote.prices?.cacheWrite1h,
    ]);
    if (seen.has(id)) continue;
    seen.add(id);
    quotes.push(quote);
    const modelId = safeKey(quote.modelId);
    if (modelId) push(nextModel, modelId, quote);
    const name = safeKey(officialNameKey(quote.displayName));
    if (name) push(nextName, name, quote);
  }
  byModelId = nextModel;
  byName = nextName;
  allQuotes = quotes;
}

export function getPricingCatalogCached() {
  return cache;
}

export function setPricingCatalog(data) {
  if (data && typeof data === 'object') cache = data;
  rebuild(cache);
  return cache;
}

export function loadPricingCatalog() {
  if (inflight) return inflight;
  inflight = fetch('/api/pricing')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((data) => { cache = data; rebuild(data); return data; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** modelId 逐字相等的官方报价(大小写敏感:模型 id 是机器标识)。 */
export function officialQuotesByModelId(modelId) {
  return byModelId.get(modelId) || [];
}

/** officialKey(displayName) 相等的官方报价。 */
export function officialQuotesByDisplayKey(key) {
  return byName.get(key) || [];
}

/** 目录里有没有任何报价(供「官方层能不能用」这类判断,不必自己遍历)。 */
export function hasOfficialQuotes() {
  return allQuotes.length > 0;
}
