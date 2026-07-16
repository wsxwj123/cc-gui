// Minimal runnable check for computeCost (pricing.js).
// Run: node client/src/utils/pricing.test.mjs
// Verifies the four usage paths (input/output/cacheRead/cacheWrite) all参与计价,
// using the hardcoded fallback table (REMOTE is empty under node — no window/fetch).
import assert from 'node:assert';
import { computeCost, formatCost } from './pricing.js';

// Opus 4.8 fallback price = usd(5, 25) → input 5, output 25, cacheRead 0.5, cacheWrite 6.25.
const usage = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 10000,
  cache_creation_input_tokens: 5000,
};
const r = computeCost('claude-opus-4-8', usage);
assert.ok(r, 'expected a cost result for claude-opus-4-8');

// Expected (USD): 1000*5 + 2000*25 + 10000*0.5 + 5000*6.25, all /1e6
const expected = (1000 * 5 + 2000 * 25 + 10000 * 0.5 + 5000 * 6.25) / 1e6; // = 0.09125
assert.ok(Math.abs(r.totalUsd - expected) < 1e-9, `totalUsd ${r.totalUsd} != ${expected}`);
assert.ok(Math.abs(r.breakdown.cacheRead - 0.005) < 1e-9, 'cacheRead path wrong');
assert.ok(Math.abs(r.breakdown.cacheWrite - 0.03125) < 1e-9, 'cacheWrite path wrong');

// New entry sanity: Fable 5 = usd(10,50,1,12.5). 1M cacheWrite tokens → $12.50.
const fable = computeCost('claude-fable-5', { cache_creation_input_tokens: 1_000_000 });
assert.ok(Math.abs(fable.totalUsd - 12.5) < 1e-9, `fable cacheWrite ${fable?.totalUsd} != 12.5`);

// CNY model stored as USD: qwen-turbo input ¥0.3 → 0.3/7.2 USD per 1M input tokens.
const qwen = computeCost('qwen-turbo', { input_tokens: 1_000_000 }, { providerHint: 'anthropic', model: 'qwen-turbo' });
assert.ok(Math.abs(qwen.totalUsd - 0.3 / 7.2) < 1e-9, `qwen input ${qwen?.totalUsd} != ${0.3 / 7.2}`);

// formatCost renders CNY (×7.2). 0.09125 USD → ¥0.657 (<¥1 → 3 decimals).
assert.strictEqual(formatCost(expected), '¥0.657');

console.log('pricing.test.mjs OK — totalUsd(opus4.8) =', r.totalUsd, '→', formatCost(r.totalUsd));
