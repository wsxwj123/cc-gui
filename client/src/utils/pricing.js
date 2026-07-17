// Model pricing table — USD per 1M tokens.
// CNY-priced models are converted at a fixed rate (CNY_TO_USD) for display.
// 这是**离线兜底表**;运行时优先用 /api/pricing 下发的 LiteLLM 远端表(REMOTE),
// 覆盖更广更新更勤。手抄表只在 REMOTE 无该 model 时兜底。
// 全量核对日期 2026-07-16(Anthropic/DeepSeek 官方页直核;国产厂官方页 JS 渲染抓不到,
// 走搜索聚合近似,已逐条标注来源与置信度)。四价含义:input / output / cacheRead(缓存读)
// / cacheWrite(缓存写)。usd()/cny() 未显式给缓存价时按 Anthropic 通用规则默认
// cacheRead=0.1×input、cacheWrite=1.25×input(5min TTL)。

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
  // 官方页直核 2026-07-16: platform.claude.com/docs/en/about-claude/pricing
  // cacheWrite 列取 5min TTL 变体(=1.25×input);1h write=2×input 不建模。
  // Fable 5 / Mythos 5(限量): $10/$50,cw $12.50,cr $1(用新 tokenizer,token 量 ~+30%)。
  'claude-fable-5':              usd(10, 50, 1, 12.5),
  'claude-mythos-5':             usd(10, 50, 1, 12.5),
  // Sonnet 5: 引导价 $2/$10(至 2026-08-31),之后 $3/$15。此处按引导价(cw $2.50/cr $0.20)。
  'claude-sonnet-5':             usd(2, 10, 0.2, 2.5),
  'claude-opus-4-8':             usd(5, 25),       // 4.8 用新 tokenizer,可能多消耗 ~35% token
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

  // DeepSeek — USD/MTok, 官方页直核 2026-07-16 api-docs.deepseek.com/quick_start/pricing
  // (与上次一致未变;官方页以 USD 计价)。cacheWrite=input:DeepSeek 不收 cache 写入费,cache miss 即标准 input 价。
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

  // Moonshot Kimi — 2026-07-17 官方页直核 platform.kimi.com/docs/pricing/chat-k3|k27-code|k26(CNY)
  // cacheWrite=input:Kimi 只有缓存命中/未命中两档、不收 cache 写入费,cache miss 即标准 input 价(同 DeepSeek)。
  'kimi-k3':                     cny(20, 100, 2, 20),
  'kimi-k2.7-code-highspeed':    cny(13, 54, 2.6, 13),
  'kimi-k2.7-code':              cny(6.5, 27, 1.3, 6.5),
  'kimi-k2.6':                   cny(6.5, 27, 1.1, 6.5),
  // Kimi Code 会员套餐(api.kimi.com/coding)模型 id 别名——套餐制无按量单价,
  // 按同模型开放平台价近似(k3→kimi-k3,kimi-for-coding→kimi-k2.7-code)。
  'k3':                          cny(20, 100, 2, 20),
  'kimi-for-coding-highspeed':   cny(13, 54, 2.6, 13),
  'kimi-for-coding':             cny(6.5, 27, 1.3, 6.5),
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

  // ── 内置 provider 补全(2026-07-16)──────────────────────────────
  // 以下国产厂官方定价页均为 JS 渲染,WebFetch/r.jina.ai 抓不到实价;下列为**搜索聚合
  // 近似值**(非官方页直核),仅作离线兜底。运行时 /api/pricing 的 LiteLLM 表已覆盖
  // dashscope/volcengine/hunyuan/stepfun/baidu,优先生效,这里只在离线且 REMOTE 无该 id 时兜底。
  // 币种 CNY(cny() 自动按 CNY_TO_USD 折 USD 存储)。model id 用「获取模型」实时拉取,
  // 故用宽前缀键(lookupPrice 的 startsWith 兜底可匹配带版本后缀的 id)。

  // 通义千问 Qwen(dashscope)— 搜索聚合,阿里云长期公开档位
  'qwen3-max':                   cny(2.5, 10),      // 旗舰,阶梯计费起步价
  'qwen-max':                    cny(2.5, 10),
  'qwen-plus':                   cny(0.8, 2),       // 促销输入价¥0.8(原¥4)
  'qwen-turbo':                  cny(0.3, 0.6),

  // 豆包 Doubao(volcengine 火山方舟)— 搜索聚合(新浪/火山文档),分段计费取旗舰档
  'doubao-seed':                 cny(6, 30, 1.2),   // Seed 2.1 Pro:输入¥6/输出¥30/缓存命中¥1.2

  // 腾讯混元 Hunyuan — 搜索聚合(腾讯云文档/知乎)
  'hunyuan-turbos':              cny(0.8, 2),
  'hunyuan-t1':                  cny(1, 4),

  // 阶跃 StepFun — 搜索聚合(IT之家/阿里云百炼代理页);step-3 为限时折扣价,易变
  'step-3':                      cny(1.5, 4),
  'step-3.7-flash':              cny(1.35, 8.1),

  // 百度文心 ERNIE(qianfan): 未核实(官方页JS渲染+搜索无可靠聚合)→无离线兜底,
  // 运行时依赖 LiteLLM(litellm_provider=baidu)。切勿编造。

  // ── 海外推理平台补全(2026-07-17 官方页直核)────────────────────────
  // 这批 provider 官方定价页多为 SSR/文档站,已逐条上官方页核对 input/output/cache。
  // 币种均 USD(usd())。缓存口径按各家官方计费模型逐条注释。

  // Groq — groq.com/pricing 直核 2026-07-17。缓存:cached input 打 5 折(cacheRead=0.5×input),
  // 不收 cache 写入费(cacheWrite=input)。gpt-oss 官方 id 带 openai/ 前缀。
  'llama-3.3-70b-versatile':     usd(0.59, 0.79, 0.295, 0.59),
  'llama-3.1-8b-instant':        usd(0.05, 0.08, 0.025, 0.05),
  'openai/gpt-oss-120b':         usd(0.15, 0.60, 0.075, 0.15),
  'openai/gpt-oss-20b':          usd(0.075, 0.30, 0.0375, 0.075),

  // Perplexity — docs.perplexity.ai 定价章节直核 2026-07-17。sonar 系无 prompt caching
  // (cacheRead/cacheWrite=input,无缓存计费);另有按请求的搜索上下文费(low/med/high,
  // $5~$14/1K 请求)未建模,此处仅 token 单价。'sonar' 短键兜底同族其它 id(longest-prefix
  // 使 sonar-pro/-reasoning-pro/-deep-research 命中各自档)。
  'sonar':                       usd(1, 1, 1, 1),
  'sonar-pro':                   usd(3, 15, 3, 15),
  'sonar-reasoning-pro':         usd(2, 8, 2, 8),
  'sonar-deep-research':         usd(2, 8, 2, 8),

  // Mistral — mistral.ai/pricing 直核 2026-07-17。缓存:cached input -90%
  // (cacheRead=0.1×input=默认),不收写入费(cacheWrite=input)。用 base 前缀键
  // 兜底带版本后缀 id(mistral-large-2512 等)。codestral 未拿到明确 chat 单价→不编。
  'mistral-large':               usd(2, 6, 0.2, 2),
  'mistral-medium':              usd(0.4, 2, 0.04, 0.4),
  'mistral-small':               usd(0.1, 0.3, 0.01, 0.1),

  // Cerebras — cerebras.ai/pricing + inference-docs 直核 2026-07-17。
  // 仅 gpt-oss-120b 拿到明确 input/output 拆分($0.25/$0.69);llama/qwen 官方页只给
  // "10c/60c" 笼统值、未拆 in/out→不编。无 prompt caching(cacheRead/cacheWrite=input)。
  // 注意与 Groq 的 'openai/gpt-oss-120b' 是不同 id(Cerebras 裸名),不冲突。
  'gpt-oss-120b':                usd(0.25, 0.69, 0.25, 0.69),

  // Z.ai 智谱国际站 — docs.z.ai/guides/overview/pricing 直核 2026-07-17(USD)。
  // glm-4.6/4.5/4.5-air 与国内 bigmodel 同 id,现值(≈$0.60/$2.20、$0.20/$1.10)一致→不重复加。
  // 下列 glm-5/5.2/4.7 为国际站新 id。缓存:cached input 单列命中价,写入"限时免费"→cacheWrite=input。
  'glm-5.2':                     usd(1.4, 4.4, 0.26, 1.4),
  'glm-5':                       usd(1.0, 3.2, 0.2, 1.0),
  'glm-4.7':                     usd(0.6, 2.2, 0.11, 0.6),

  // 未加(拿不到官方 per-model 数字,按口径留空不编):
  //   Together / Fireworks:定价页 JS 渲染取不到干净 per-id 单价,且 id 带 org/账户前缀
  //     (meta-llama/…、accounts/fireworks/models/…)、按参数尺寸分档;其托管的开源模型
  //     已在 LiteLLM 远端表(together_ai/*、fireworks_ai/*)覆盖,运行时优先生效。
  //   Hyperbolic:无独立官方价目页,取不到→留空。
  //   MiniMax M3/M2.7:platform.minimaxi.com 文本模型价 JS 渲染核不到→保留现有 M2/M1 键。
  //   Poe:订阅积分制,无按量单价→不入表。
  //   302.AI / AiHubMix / OpenRouter:聚合平台按上游模型计价,LiteLLM 已覆盖上游 id→不加本地键。
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
    // 前缀兜底取**最长**匹配(与下方内置表 lookupPrice 同口径):键序不确定时
    // 短键(claude-3-5)不许抢走长键(claude-3-5-haiku)。
    const k = Object.keys(REMOTE)
      .filter((k) => model.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
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
  // 前缀兜底取**最长**匹配:'step-3.7-flash-xxx' 该命中 'step-3.7-flash' 而非先遇到的 'step-3'
  const key = model && Object.keys(PRICES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
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
