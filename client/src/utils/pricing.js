// Model pricing table — USD per 1M tokens.
// CNY-priced models are converted at a fixed rate (CNY_TO_USD) for display.
// Sources fetched 2026-05-27 from each provider's official pricing page.

const CNY_TO_USD = 1 / 7.2;

// Helper: build a CNY model entry, auto-convert to USD.
const cny = (input, output, cacheRead = input * 0.1, cacheWrite = input * 1.25) => ({
  input: input * CNY_TO_USD,
  output: output * CNY_TO_USD,
  cacheRead: cacheRead * CNY_TO_USD,
  cacheWrite: cacheWrite * CNY_TO_USD,
  currency: 'CNY',  // displayed prices are USD-converted; original was CNY
});

const usd = (input, output, cacheRead = input * 0.1, cacheWrite = input * 1.25) => ({
  input, output, cacheRead, cacheWrite, currency: 'USD',
});

// Anthropic (https://docs.anthropic.com/en/docs/about-claude/models) — USD/MTok
// cache_write here is the 5-min TTL variant (1.25× input). 1-hr write is 2× input.
const PRICES = {
  // Claude — Anthropic official
  'claude-opus-4-7':             usd(5, 25),
  'claude-opus-4-6':             usd(5, 25),
  'claude-opus-4-1':             usd(15, 75),
  'claude-opus-4-0':             usd(15, 75),
  'claude-sonnet-4-6':           usd(3, 15),
  'claude-sonnet-4-5':           usd(3, 15),
  'claude-sonnet-4-5-20250929':  usd(3, 15),
  'claude-sonnet-4-0':           usd(3, 15),
  'claude-haiku-4-5':            usd(1, 5),
  'claude-haiku-4-5-20251001':   usd(1, 5),
  'claude-3-5-haiku-20241022':   usd(0.80, 4),

  // DeepSeek — USD/MTok, 2026-06-19 拉取 api-docs.deepseek.com/quick_start/pricing
  // (官方页以 USD 计价)。cacheWrite=input:DeepSeek 不收 cache 写入费,cache miss 即标准 input 价。
  // deepseek-chat/reasoner 是 v4-flash 的 non-thinking/thinking 别名(2026-07-24 弃用,价格同)。
  'deepseek-chat':               usd(0.14, 0.28, 0.0028, 0.14),    // v4-flash non-thinking
  'deepseek-reasoner':           usd(0.14, 0.28, 0.0028, 0.14),    // v4-flash thinking
  'deepseek-v4-flash':           usd(0.14, 0.28, 0.0028, 0.14),
  'deepseek-v4-pro':             usd(0.435, 0.87, 0.003625, 0.435),
  'deepseek-v3.1':               usd(0.14, 0.28, 0.0028, 0.14),    // 旧版,官方现表无单列→按 v4-flash 兜底
  'deepseek-v3.2-exp':           usd(0.14, 0.28, 0.0028, 0.14),    // 同上

  // MiMo 小米 — 2026-07-13 核实 mimo.mi.com 官方(CNY);cache 命中价极低单列
  'mimo-v2.5':                   cny(1, 2, 0.02),
  'mimo-v2.5-pro':               cny(3, 6, 0.025),  // 项目实际部署此档

  // Anthropic Claude — 2026-06-05 拉取 platform.claude.com 官方表
  'claude-opus-4-8':             usd(5, 25),       // 4.8 用新 tokenizer,可能多消耗 ~35% token
  'claude-haiku-4-5':            usd(1, 5),

  // OpenAI — 2026-06-05 拉取 developers.openai.com
  'gpt-5.5':                     usd(5, 30, 0.50),
  'gpt-5.5-pro':                 usd(30, 180, 30),  // pro 无 cache 优惠,cacheRead = input
  'gpt-5.4':                     usd(2.50, 15, 0.25),
  'gpt-5.4-mini':                usd(0.75, 4.50, 0.075),
  'gpt-5.4-nano':                usd(0.20, 1.25, 0.02),
  'gpt-5.4-pro':                 usd(30, 180, 30),

  // Google Gemini — 2026-06-05 拉取 ai.google.dev,paid tier
  'gemini-2.5-pro':              usd(1.25, 10, 0.125),
  'gemini-2.5-flash':            usd(0.30, 2.50, 0.03),
  'gemini-2.5-flash-lite':       usd(0.10, 0.40, 0.01),
  'gemini-3-flash-preview':      usd(0.50, 3.00, 0.05),
  'gemini-3.1-flash-lite':       usd(0.25, 1.50, 0.025),
  'gemini-3.1-pro-preview':      usd(2.00, 12.00, 0.20),
  'gemini-3.5-flash':            usd(1.50, 9.00, 0.15),

  // Moonshot Kimi — 2026-07-13 核实,微调贴合官方(CNY)
  'kimi-k2.6':                   cny(6.8, 28.8, 1.15),
  'moonshot-v1-8k':              cny(2, 10),
  'moonshot-v1-32k':             cny(5, 20),
  'moonshot-v1-128k':            cny(10, 30),

  // xAI Grok — 2026-06-05 拉取 docs.x.ai (无 cache 优惠披露)
  'grok-4.3':                    usd(1.25, 2.50, 1.25),
  'grok-4.20-0309-reasoning':    usd(1.25, 2.50, 1.25),
  'grok-4.20-0309-non-reasoning': usd(1.25, 2.50, 1.25),
  'grok-4.20-multi-agent-0309':  usd(1.25, 2.50, 1.25),
  'grok-build-0.1':              usd(1.00, 2.00, 1.00),

  // 智谱 GLM — 2026-07-13 核实 bigmodel.cn 官方(4.6/4.5/air);plus/z1-flash 官方现役页无独立条目,保留估值
  'glm-4.6':                     cny(4.3, 15.8),    // 官方 ≈$0.60/$2.20
  'glm-4.5':                     cny(4.3, 15.8),    // 官方 ≈$0.60/$2.20
  'glm-4.5-air':                 cny(1.4, 7.9),     // 官方 ≈$0.20/$1.10
  'glm-4-plus':                  cny(50, 50),       // 估值(未抓到)
  'glm-z1-flash':                cny(1, 4),         // 估值(未抓到)

  // MiniMax — 2026-07-13 核实 platform.minimax.io 官方(M2/M1);Text-01/abab7 legacy 页已下,保留估值
  'MiniMax-M2':                  cny(2.1, 8.4),     // 官方 ¥2.1/¥8.4,cache ¥0.21
  'MiniMax-M1':                  cny(2.88, 15.8),   // 官方 ≈$0.40/$2.20
  'MiniMax-Text-01':             cny(1, 8),         // 估值(legacy)
  'abab7-chat-preview':          cny(10, 30),       // 估值(legacy)
};

// ── Z2: LiteLLM 远端单价表 ──────────────────────────────────────
// server /api/pricing 下发(USD/1M,已含 cacheRead/cacheWrite),比上面的手抄表
// 新且权威,查价时优先。localStorage 缓存使后续加载同步可用;启动后异步刷新。
let REMOTE = {};
try { REMOTE = JSON.parse(localStorage.getItem('cgui-litellm-prices') || 'null') || {}; } catch {}

async function hydrateRemotePrices() {
  try {
    const r = await fetch('/api/pricing');
    const j = await r.json();
    if (j && j.prices && Object.keys(j.prices).length) {
      REMOTE = j.prices;
      try { localStorage.setItem('cgui-litellm-prices', JSON.stringify(j.prices)); } catch {}
    }
  } catch { /* 离线/失败 → 沿用缓存或内置表 */ }
}
if (typeof window !== 'undefined') setTimeout(hydrateRemotePrices, 3000);

function remoteLookup(model) {
  if (!model || !REMOTE) return null;
  let e = REMOTE[model];
  if (!e) e = REMOTE[model.replace(/-\d{8}$/, '')];
  if (!e) {
    const k = Object.keys(REMOTE).find((k) => model.startsWith(k));
    e = k ? REMOTE[k] : null;
  }
  return e ? { ...e, currency: 'USD' } : null;
}

// Common aliases the CLI may emit.
const ALIASES = {
  'sonnet': 'claude-sonnet-4-6',
  'opus':   'claude-opus-4-7',
  'haiku':  'claude-haiku-4-5',
};

// When provider routing is in effect (cc switch), the stream-json's model
// field still says "claude-sonnet-X-X" because the CLI is Claude-shaped. The
// real upstream is in ANTHROPIC_MODEL env. We choose a price by provider hint
// + model resolution rules:
//   anthropic / bedrock / vertex → Claude prices for the (displayed) model
//   deepseek                     → DeepSeek prices for resolvedModel or default
//   mimo / openrouter / silicon  → unsupported, return null (don't lie)
function lookupPrice(model, provider) {
  if (!model && !(provider && provider.model)) return null;
  const hint = (provider && provider.providerHint) || 'anthropic';

  if (hint === 'deepseek') {
    // Prefer env-set upstream model name; fall back to deepseek-chat default.
    const remote = remoteLookup(provider.model);
    if (remote) return remote;
    const target = (provider.model && PRICES[provider.model])
      ? provider.model
      : (PRICES['deepseek-' + (provider.model || '')] ? 'deepseek-' + provider.model : 'deepseek-chat');
    return PRICES[target] || PRICES['deepseek-chat'];
  }
  if (hint === 'mimo') {
    // 项目实际部署 mimo-v2.5-pro;provider.model 精确匹配优先,兜底 pro(原硬返回非-pro 偏低 3×)
    return (provider && provider.model && PRICES[provider.model]) || PRICES['mimo-v2.5-pro'] || PRICES['mimo-v2.5'] || null;
  }
  // anthropic / bedrock / vertex / unknown → use claude name as displayed
  // LiteLLM 表优先(覆盖广、随上游更新),内置手抄表兜底。
  const remote = remoteLookup(model) || (ALIASES[model] && remoteLookup(ALIASES[model]));
  if (remote) return remote;
  if (PRICES[model]) return PRICES[model];
  if (ALIASES[model] && PRICES[ALIASES[model]]) return PRICES[ALIASES[model]];
  const stripped = model && model.replace(/-\d{8}$/, '');
  if (stripped && PRICES[stripped]) return PRICES[stripped];
  const key = model && Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key] : null;
}

/**
 * Compute USD cost for a single message's usage object.
 * Returns { totalUsd, breakdown: {input, output, cacheRead, cacheWrite} } or null.
 */
export function computeCost(model, usage, provider) {
  if (!usage) return null;
  const p = lookupPrice(model, provider);
  if (!p) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const M = 1_000_000;
  const breakdown = {
    input:      (input * p.input) / M,
    output:     (output * p.output) / M,
    cacheRead:  (cacheRead * p.cacheRead) / M,
    cacheWrite: (cacheWrite * p.cacheWrite) / M,
  };
  const totalUsd = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
  return { totalUsd, breakdown, currency: p.currency };
}

/**
 * Format a USD cost for display in CNY (×7.2, the same fixed rate as CNY_TO_USD).
 * Tiers are re-cut for CNY magnitudes (values ~7× the USD ones).
 */
export function formatCost(usd) {
  if (usd == null || isNaN(usd)) return '';
  const cny = usd / CNY_TO_USD;
  if (cny < 0.001) return '<¥0.001';
  if (cny < 0.01)  return `¥${cny.toFixed(4)}`;
  if (cny < 1)     return `¥${cny.toFixed(3)}`;
  return `¥${cny.toFixed(2)}`;
}
