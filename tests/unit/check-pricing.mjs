// Minimal runnable check for computeCost (pricing.js).
// Run: node tests/unit/check-pricing.mjs
// Verifies the four usage paths (input/output/cacheRead/cacheWrite) all参与计价,
// using the hardcoded fallback table。REMOTE 表经 localStorage stub 注入(pricing.js
// 模块加载时读 'cgui-litellm-prices'),只放 claude-3-5* 两键,不影响下方走内置表的断言。
import assert from 'node:assert';

// 短键在前、长键在后:旧 find() 按键序先中短键 'claude-3-5',最长前缀匹配须中长键。
const REMOTE_STUB = {
  'claude-3-5':       { input: 100, output: 100, cacheRead: 10,   cacheWrite: 125 },
  'claude-3-5-haiku': { input: 0.8, output: 4,   cacheRead: 0.08, cacheWrite: 1 },
};
globalThis.localStorage = {
  getItem: (k) => (k === 'cgui-litellm-prices' ? JSON.stringify(REMOTE_STUB) : null),
  setItem: () => {},
};
const { computeCost, formatCost } = await import('../../client/src/utils/pricing.js');

// REMOTE 前缀兜底取最长:claude-3-5-haiku-latest(无精确键、无 -YYYYMMDD 后缀)
// 同时命中 'claude-3-5' 与 'claude-3-5-haiku',必须取长键的 $0.8 而非短键的 $100。
const rlong = computeCost('claude-3-5-haiku-latest', { input_tokens: 1_000_000 });
assert.ok(Math.abs(rlong.totalUsd - 0.8) < 1e-9, `remote longest-prefix ${rlong?.totalUsd} != 0.8`);
// 只中短键的 id 仍正常兜底到 'claude-3-5'。
const rshort = computeCost('claude-3-5-sonnet-x', { input_tokens: 1_000_000 });
assert.ok(Math.abs(rshort.totalUsd - 100) < 1e-9, `remote short-prefix ${rshort?.totalUsd} != 100`);

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

// 前缀兜底取最长匹配:step-3.7-flash 命中自己的 ¥1.35/¥8.1 档,不被 'step-3' 抢跑。
const CNY = 7.2;
const step37 = computeCost('step-3.7-flash', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(step37.totalUsd - (1.35 + 8.1) / CNY) < 1e-9, `step-3.7-flash ${step37?.totalUsd} != ${(1.35 + 8.1) / CNY}`);
// 带后缀 id 走前缀兜底,同样须命中最长前缀 step-3.7-flash(旧 find() 按插入序会先中 step-3)
const step37sfx = computeCost('step-3.7-flash-preview', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(step37sfx.totalUsd - (1.35 + 8.1) / CNY) < 1e-9, `step-3.7-flash-preview ${step37sfx?.totalUsd} != ${(1.35 + 8.1) / CNY}`);
// 无独立条目的 step-3.5-flash 前缀兜底命中 step-3 档(¥1.5/¥4)
const step35 = computeCost('step-3.5-flash', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(step35.totalUsd - (1.5 + 4) / CNY) < 1e-9, `step-3.5-flash ${step35?.totalUsd} != ${(1.5 + 4) / CNY}`);

// Kimi:开放平台官方价;highspeed 有独立表键,走精确键命中(不进前缀兜底分支),须取自己的档
const k27hs = computeCost('kimi-k2.7-code-highspeed', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(k27hs.totalUsd - (13 + 54) / CNY) < 1e-9, `kimi-k2.7-code-highspeed ${k27hs?.totalUsd} != ${(13 + 54) / CNY}`);
// Kimi Code 套餐 id:k3[1m] 走 'k3' 前缀兜底,kimi-for-coding 精确命中
const k3m = computeCost('k3[1m]', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(k3m.totalUsd - (20 + 100) / CNY) < 1e-9, `k3[1m] ${k3m?.totalUsd} != ${(20 + 100) / CNY}`);
const kfc = computeCost('kimi-for-coding', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(kfc.totalUsd - (6.5 + 27) / CNY) < 1e-9, `kimi-for-coding ${kfc?.totalUsd} != ${(6.5 + 27) / CNY}`);

// Groq(2026-07-17):gpt-oss-120b 官方 id 带 openai/ 前缀,精确命中 $0.15/$0.60,cacheRead 半价 $0.075。
const groq = computeCost('openai/gpt-oss-120b', { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 });
assert.ok(Math.abs(groq.totalUsd - (0.15 + 0.075)) < 1e-9, `groq gpt-oss-120b ${groq?.totalUsd} != 0.225`);
// Cerebras 裸 id 'gpt-oss-120b' 是不同键($0.35/$0.75),不被 Groq 前缀抢。
const cere = computeCost('gpt-oss-120b', { output_tokens: 1_000_000 });
assert.ok(Math.abs(cere.totalUsd - 0.75) < 1e-9, `cerebras gpt-oss-120b ${cere?.totalUsd} != 0.75`);

// Perplexity:'sonar' 短键不许抢走 'sonar-pro'(longest-prefix)。sonar-pro = $3/$15。
const spro = computeCost('sonar-pro', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(spro.totalUsd - (3 + 15)) < 1e-9, `sonar-pro ${spro?.totalUsd} != 18`);

// Mistral:base 前缀键兜底带版本后缀 id。mistral-large-2512 → 'mistral-large' = $2/$6。
const mlarge = computeCost('mistral-large-2512', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(mlarge.totalUsd - (2 + 6)) < 1e-9, `mistral-large-2512 ${mlarge?.totalUsd} != 8`);

// GLM-5 系国内 CNY 价(bigmodel.cn,[32K+) 档):'glm-5' 不许抢走 'glm-5.2'(longest-prefix);
// glm-5.2 input ¥8。glm-5.1 须精确命中自己的 ¥8,不落 'glm-5' 前缀档(¥6)。
const glm52 = computeCost('glm-5.2', { input_tokens: 1_000_000 });
assert.ok(Math.abs(glm52.totalUsd - 8 / CNY) < 1e-9, `glm-5.2 ${glm52?.totalUsd} != ${8 / CNY}`);
const glm51 = computeCost('glm-5.1', { input_tokens: 1_000_000 });
assert.ok(Math.abs(glm51.totalUsd - 8 / CNY) < 1e-9, `glm-5.1 ${glm51?.totalUsd} != ${8 / CNY}`);
// GLM Flash/视觉档不许前缀兜底落到高价档:
// glm-4.7-flash 官方免费 → 计价存在且恒 0,不落 'glm-4.7'(¥4/¥16)。
const gflash = computeCost('glm-4.7-flash', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 });
assert.ok(gflash, 'glm-4.7-flash 应有价目条目(免费≠无条目)');
assert.ok(Math.abs(gflash.totalUsd) < 1e-12, `glm-4.7-flash ${gflash?.totalUsd} != 0(前缀兜底漏到 glm-4.7 档?)`);
// glm-4.7-flashx(z.ai $0.07/$0.4)精确命中,不落 'glm-4.7-flash'(免费)也不落 'glm-4.7'。
const gflashx = computeCost('glm-4.7-flashx', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(gflashx.totalUsd - (0.07 + 0.4)) < 1e-9, `glm-4.7-flashx ${gflashx?.totalUsd} != 0.47`);
// glm-5v-turbo(z.ai $1.2/$4)精确命中,不落 'glm-5'(¥6/¥22)前缀档。
const g5vt = computeCost('glm-5v-turbo', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(g5vt.totalUsd - (1.2 + 4)) < 1e-9, `glm-5v-turbo ${g5vt?.totalUsd} != 5.2`);

// ── Q-c(2026-08-04 官方页重核):历史里真实出现过、原先无价或落错档的 id ──
// Opus 5(历史 4.2 万条):官方 $5/$25。原先内置表无条目,只靠 LiteLLM 远端表兜。
const opus5 = computeCost('claude-opus-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(opus5.totalUsd - (5 + 25)) < 1e-9, `claude-opus-5 ${opus5?.totalUsd} != 30`);
// GPT-5.6 系(官方 developers.openai.com):sol $5/$30、terra $2/$12、luna $0.2/$1.2。
const sol = computeCost('gpt-5.6-sol', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 });
assert.ok(Math.abs(sol.totalUsd - (5 + 30 + 0.5)) < 1e-9, `gpt-5.6-sol ${sol?.totalUsd} != 35.5`);
const terra = computeCost('gpt-5.6-terra', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(terra.totalUsd - (2 + 12)) < 1e-9, `gpt-5.6-terra ${terra?.totalUsd} != 14`);
const luna = computeCost('gpt-5.6-luna', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(luna.totalUsd - (0.2 + 1.2)) < 1e-9, `gpt-5.6-luna ${luna?.totalUsd} != 1.4`);
// MiMo UltraSpeed 独立档 ¥9/¥18:不许被 'mimo-v2.5-pro'(¥3/¥6)前缀兜底吃掉(少算 3×)。
const ultra = computeCost('mimo-v2.5-pro-ultraspeed', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(ultra.totalUsd - (9 + 18) / CNY) < 1e-9, `mimo ultraspeed ${ultra?.totalUsd} != ${(9 + 18) / CNY}`);
// 裸别名 'fable'(历史 717 条)原先四路查价全落空 → 现走 ALIASES 到 claude-fable-5($10/$50)。
const fableAlias = computeCost('fable', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(fableAlias.totalUsd - (10 + 50)) < 1e-9, `fable 别名 ${fableAlias?.totalUsd} != 60`);
// 带命名空间的聚合平台 id:去掉命名空间按上游模型计价。
const nsKimi = computeCost('moonshotai/kimi-k3', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(nsKimi.totalUsd - (20 + 100) / CNY) < 1e-9, `moonshotai/kimi-k3 ${nsKimi?.totalUsd} != ${(20 + 100) / CNY}`);
const nsGpt = computeCost('openai/gpt-5.6-sol', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(nsGpt.totalUsd - (5 + 30)) < 1e-9, `openai/gpt-5.6-sol ${nsGpt?.totalUsd} != 35`);
// 回归守卫:Groq 的 'openai/gpt-oss-120b' 有自己的精确键($0.15/$0.60),不许被去命名空间
// 后的 Cerebras 裸键($0.35/$0.75)顶掉 —— 精确匹配必须先于去命名空间兜底。
const groqNs = computeCost('openai/gpt-oss-120b', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
assert.ok(Math.abs(groqNs.totalUsd - (0.15 + 0.60)) < 1e-9, `groq 精确键被命名空间兜底顶掉 ${groqNs?.totalUsd} != 0.75`);

// formatCost renders CNY (×7.2). 0.09125 USD → ¥0.657 (<¥1 → 3 decimals).
assert.strictEqual(formatCost(expected), '¥0.657');

console.log('check-pricing OK — totalUsd(opus4.8) =', r.totalUsd, '→', formatCost(r.totalUsd));
