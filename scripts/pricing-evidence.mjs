#!/usr/bin/env node
// T0/T11 修前-修后证据:对固定的 5 组输入打印 {model, usage, at, totalUsd, 命中的价键}。
// 同一份脚本跑两次(改动前 before.txt / 改动后 after.txt),逐行对照即为「修前失败、修后通过」的证据。
// 用法:node scripts/pricing-evidence.mjs > .devflow/pricing-accuracy-evidence/before.txt
// 不联网、不碰任何实例:localStorage 用空实现顶掉,只走内置表/离线层。
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const m = await import('../client/src/utils/pricing.js');

const CASES = [
  ['glm-5.3-flash(1M in/out/read)', 'glm-5.3-flash', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 }, undefined],
  ['glm-5(1M in/out/read)', 'glm-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 }, undefined],
  ['claude-fable-5-1(1M read)', 'claude-fable-5-1', { cache_read_input_tokens: 1e6 }, undefined],
  ['claude-fable-5(1M read)', 'claude-fable-5', { cache_read_input_tokens: 1e6 }, undefined],
  ['deepseek-flash(1M in)', 'deepseek-flash', { input_tokens: 1e6 }, undefined],
  ['deepseek-flash(1M in,@peak)', 'deepseek-flash', { input_tokens: 1e6 }, '2026-09-11T01:30:00.000Z'],
  ['gpt-5.6-sol(1M in)', 'gpt-5.6-sol', { input_tokens: 1e6 }, undefined],
  ['gpt-5.6-sol(100k in+200k cr)', 'gpt-5.6-sol', { input_tokens: 100000, cache_read_input_tokens: 200000 }, undefined],
  ['gpt-5.6-sol(300k in,long?)', 'gpt-5.6-sol', { input_tokens: 300000 }, '2026-09-11T01:30:00.000Z'],
  ['opus-5 5m1k+1h1k', 'claude-opus-5', { cache_creation_input_tokens: 2000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 } }, '2026-09-11T01:30:00.000Z'],
  ['opus-5 顶层写 2000 无分配', 'claude-opus-5', { cache_creation_input_tokens: 2000 }, '2026-09-11T01:30:00.000Z'],
  ['deepseek-v4-flash(1M in)', 'deepseek-v4-flash', { input_tokens: 1e6 }, undefined],
  ['deepseek-v4-flash-vision-exp(1M in)', 'deepseek-v4-flash-vision-exp', { input_tokens: 1e6 }, undefined],
];

const round = (v) => (typeof v === 'number' ? +v.toFixed(8) : v);
for (const [label, model, usage, at] of CASES) {
  const opts = at ? { at } : {};
  const cost = m.computeCost(model, usage, null, opts);
  const price = typeof m.resolvePrice === 'function' ? m.resolvePrice(model, opts) : null;
  const key = price && price.ok
    ? `${price.tier}${price.quoteId ? ':' + price.quoteId : ''}${price.matchedExactly === false ? '(疑似)' : ''}${price.retired ? '(已下架)' : ''}`
    : (price ? `无价:${price.reason}` : '(resolvePrice 未实现)');
  const known = cost ? {
    total: round(cost.totalUsd),
    breakdown: Object.fromEntries(Object.entries(cost.breakdown).map(([k, v]) => [k, round(v)])),
    unknownDimensions: cost.unknownDimensions || null,
    partial: cost.partial || false,
  } : null;
  console.log(`${label.padEnd(36)} | ${key.padEnd(34)} | ${cost ? JSON.stringify(known) : 'null'}`);
}
