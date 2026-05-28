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

  // DeepSeek — CNY/MTok (off-peak tier removed in current pricing)
  'deepseek-chat':               cny(1, 2, 0.02),       // v4-flash non-thinking
  'deepseek-reasoner':           cny(1, 2, 0.02),       // v4-flash thinking
  'deepseek-v4-flash':           cny(1, 2, 0.02),
  'deepseek-v4-pro':             cny(3, 6, 0.025),      // promo until 2026-05-31
  'deepseek-v3.1':               cny(1, 2, 0.02),
  'deepseek-v3.2-exp':           cny(1, 2, 0.02),

  // MiMo — no official API for 7B/VL (open-source). V2.5 from OpenRouter as reference.
  'mimo-v2.5':                   usd(0.14, 0.28),
  'mimo-v2':                     usd(0.14, 0.28),
};

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
    const target = (provider.model && PRICES[provider.model])
      ? provider.model
      : (PRICES['deepseek-' + (provider.model || '')] ? 'deepseek-' + provider.model : 'deepseek-chat');
    return PRICES[target] || PRICES['deepseek-chat'];
  }
  if (hint === 'mimo') {
    return PRICES['mimo-v2.5'] || null;
  }
  // anthropic / bedrock / vertex / unknown → use claude name as displayed
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

/** Format a USD cost. Uses more precision for cheap calls. */
export function formatCost(usd) {
  if (usd == null || isNaN(usd)) return '';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01)   return `$${usd.toFixed(4)}`;
  if (usd < 1)      return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
