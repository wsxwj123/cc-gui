// Model pricing table — USD per 1M tokens.
// CNY-priced models are converted at a fixed rate (CNY_TO_USD) for display.
// 这是**离线兜底表**;运行时优先用 /api/pricing 下发的 LiteLLM 远端表(REMOTE),
// 覆盖更广更新更勤。手抄表只在 REMOTE 无该 model 时兜底。
// 全量核对日期 2026-07-16(Anthropic/DeepSeek 官方页直核;国产厂官方页 JS 渲染抓不到,
// 走搜索聚合近似,已逐条标注来源与置信度)。2026-08-04 按"历史里真实出现过的 model id"
// 抽查重核 Anthropic / OpenAI / DeepSeek / Kimi / MiMo 官方页(GLM 本机零调用未重核),
// 补齐有调用记录却缺条目的 id,详见各段注释。四价含义:input / output / cacheRead(缓存读)
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
  // 官方页直核 2026-08-04(上次 2026-07-16,数字未变): platform.claude.com/docs/en/about-claude/pricing
  // cacheWrite 列取 5min TTL 变体(=1.25×input);1h write=2×input 不建模。
  // Fable 5 / Mythos 5(限量): $10/$50,cw $12.50,cr $1(用新 tokenizer,token 量 ~+30%)。
  'claude-fable-5':              usd(10, 50, 1, 12.5),
  'claude-mythos-5':             usd(10, 50, 1, 12.5),
  // Sonnet 5: 引导价 $2/$10(至 2026-08-31),之后 $3/$15。此处按引导价(cw $2.50/cr $0.20)。
  'claude-sonnet-5':             usd(2, 10, 0.2, 2.5),
  // Opus 5: 官方页 $5/$25、5m 写 $6.25、命中 $0.50(= usd() 默认倍率)。历史里 4.2 万条
  // 调用却一直缺条目,只靠 LiteLLM 远端表兜着 —— 远端拉不到时整批消息无价可显。
  'claude-opus-5':               usd(5, 25),
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

  // DeepSeek — USD/MTok, 官方页直核 2026-08-04(与 2026-07-16 一致未变)
  // api-docs.deepseek.com/quick_start/pricing。cacheWrite=input:DeepSeek 不收 cache 写入费,
  // cache miss 即标准 input 价(实测 400 条 deepseek 记录 cache_creation 恒为 0,该列不参与计算)。
  // 【峰谷计价——已核实但刻意不实现】官方页公告原文:"DeepSeek API 服务即将采用峰谷定价
  // 策略,高峰时段价格为平时价格 2 倍,适用所有计费项,具体时间以正式通知为准。【高峰时段
  // 定义:北京时间每日 9:00~12:00 和 14:00~18:00】"。关键词是"即将采用"+"以正式通知为准":
  // 政策尚未生效、也没有生效日期。下表就是现行实际计费的"平时价格"。现在加 2× 时段维度,
  // 等于把今天所有历史消息按一个还没生效的规则算错一倍;等正式通知后再按消息 timestamp
  // 补 peak/offPeak 两组价(jsonl timestamp 是 UTC ISO8601,北京时间恒 UTC+8 无夏令时,
  // 换算本身可靠,唯一缺的就是生效日期)。
  // deepseek-chat/reasoner 是 v4-flash 的 non-thinking/thinking 别名(2026-07-24 弃用);
  // 官方现行价目页已不再列出这两个 id,保留作兜底(运行时 LiteLLM 远端表优先,那边仍给
  // 旧价 $0.28/$0.42)。本机历史零调用,不动。
  'deepseek-chat':               usd(0.14, 0.28, 0.0028, 0.14),    // v4-flash non-thinking
  'deepseek-reasoner':           usd(0.14, 0.28, 0.0028, 0.14),    // v4-flash thinking
  'deepseek-v4-flash':           usd(0.14, 0.28, 0.0028, 0.14),
  'deepseek-v4-pro':             usd(0.435, 0.87, 0.003625, 0.435),
  'deepseek-v3.1':               usd(0.14, 0.28, 0.0028, 0.14),    // 旧版,官方现表无单列→按 v4-flash 兜底
  'deepseek-v3.2-exp':           usd(0.14, 0.28, 0.0028, 0.14),    // 同上

  // MiMo 小米 — 2026-08-04 官方页直核 mimo.mi.com/pricing(CNY,与 2026-07-13 一致未变);
  // cache 命中价极低单列。无时段/长度阶梯,单组固定价。
  'mimo-v2.5':                   cny(1, 2, 0.02),
  'mimo-v2.5-pro':               cny(3, 6, 0.025),  // 项目实际部署此档
  // UltraSpeed 是独立档(¥9/¥18,命中 ¥0.075),没有这个键时前缀兜底会落到 pro 档 = 少算 3×。
  'mimo-v2.5-pro-ultraspeed':    cny(9, 18, 0.075),
  // mimo-v2 系(mimo-v2-flash 等)2026-06-30 已下线,官方价目页无条目 → 按"拿不到不编"留空。

  // OpenAI — 2026-08-04 官方页直核 developers.openai.com/api/docs/pricing(补 5.6 系;
  // 5.4/5.5 的 input/output/cacheRead 沿用 2026-06-05 录入值,与 LiteLLM 表一致;
  // cacheWrite 列本轮统一成 input,与 LiteLLM(按 1.25×input 生成)不同,见下)。
  // OpenAI 只有"缓存命中"折扣、不收缓存写入费 → cacheWrite=input(实测 3313 条 gpt 记录
  // cache_creation 恒为 0,这一列不参与计算,改的是口径不是数字)。
  'gpt-5.6-sol':                 usd(5, 30, 0.50, 5),
  'gpt-5.6-terra':               usd(2, 12, 0.20, 2),
  'gpt-5.6-luna':                usd(0.20, 1.20, 0.02, 0.20),
  'gpt-5.5':                     usd(5, 30, 0.50, 5),
  'gpt-5.5-pro':                 usd(30, 180, 30, 30),  // pro 无 cache 优惠,cacheRead = input
  'gpt-5.4':                     usd(2.50, 15, 0.25, 2.50),
  'gpt-5.4-mini':                usd(0.75, 4.50, 0.075, 0.75),
  'gpt-5.4-nano':                usd(0.20, 1.25, 0.02, 0.20),
  'gpt-5.4-pro':                 usd(30, 180, 30, 30),

  // Google Gemini — 2026-06-05 拉取 ai.google.dev,paid tier
  'gemini-2.5-pro':              usd(1.25, 10, 0.125),
  'gemini-2.5-flash':            usd(0.30, 2.50, 0.03),
  'gemini-2.5-flash-lite':       usd(0.10, 0.40, 0.01),
  'gemini-3-flash-preview':      usd(0.50, 3.00, 0.05),
  'gemini-3.1-flash-lite':       usd(0.25, 1.50, 0.025),
  'gemini-3.1-pro-preview':      usd(2.00, 12.00, 0.20),
  'gemini-3.5-flash':            usd(1.50, 9.00, 0.15),

  // Moonshot Kimi — 2026-07-17 官方页直核 platform.kimi.com/docs/pricing/chat-k3|k27-code|k26(CNY)
  // 2026-08-04 重核 chat-k3:命中 ¥2 / 未命中 ¥20 / 输出 ¥100,与下表一致;官方页无时段折扣、
  // 无按上下文长度的阶梯,单组固定价。
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
  'sonar-pro':                   usd(3, 15, 3, 3),
  'sonar-reasoning-pro':         usd(2, 8, 2, 2),
  'sonar-deep-research':         usd(2, 8, 2, 2),

  // Mistral — mistral.ai/pricing 直核 2026-07-17。缓存:cached input -90%
  // (cacheRead=0.1×input=默认),不收写入费(cacheWrite=input)。用 base 前缀键
  // 兜底带版本后缀 id(mistral-large-2512 等)。codestral 未拿到明确 chat 单价→不编。
  'mistral-large':               usd(2, 6, 0.2, 2),
  'mistral-medium':              usd(0.4, 2, 0.04, 0.4),
  'mistral-small':               usd(0.1, 0.3, 0.01, 0.1),

  // Cerebras — cerebras.ai/pricing 直核 2026-07-17(页面表格原文 "GPT OSS 120B |
  // $0.35/M | $0.75/M")。仅 gpt-oss-120b 拿到明确 input/output 拆分;llama/qwen 官方页
  // 只给笼统值、未拆 in/out→不编。无 prompt caching(cacheRead/cacheWrite=input)。
  // 注意与 Groq 的 'openai/gpt-oss-120b' 是不同 id(Cerebras 裸名),不冲突。
  'gpt-oss-120b':                usd(0.35, 0.75, 0.35, 0.35),

  // 智谱 GLM-5 系/4.7 — 国内 bigmodel.cn/pricing 浏览器渲染直核 2026-07-17(CNY)。
  // 国内外双价同 id,一键一价,本地表取**国内人民币价**(主受众国内);国际站用户
  // 以 LiteLLM 远端表为准。国际站 Z.ai(docs.z.ai 定价页,2026-07-17,USD)参考:
  // glm-5.2/5.1 $1.4/$4.4、glm-5-turbo $1.2/$4.0、glm-5 $1/$3.2、glm-4.7 $0.6/$2.2。
  // 国内为按输入长度阶梯计价,取 [32K+) 高档(本 GUI 会话上下文普遍超 32K);
  // 缓存:缓存命中单列,缓存存储"限时免费"→cacheWrite=input。
  'glm-5.2':                     cny(8, 28, 2, 8),      // 单档(1M ctx)
  'glm-5.1':                     cny(8, 28, 2, 8),      // 低档 [0,32K) 为 ¥6/¥24,命中 ¥1.3
  'glm-5-turbo':                 cny(7, 26, 1.8, 7),    // 低档 [0,32K) 为 ¥5/¥22,命中 ¥1.2
  'glm-5':                       cny(6, 22, 1.5, 6),    // 低档 [0,32K) 为 ¥4/¥18,命中 ¥1
  'glm-4.7':                     cny(4, 16, 0.8, 4),    // 取 [32K,200K) 档;[0,32K) 按输出长度 ¥2/¥8 或 ¥3/¥14
  // Flash/FlashX/视觉档(2026-07-17 直核):bigmodel.cn/pricing 是 SPA 抓不到数字,
  // 免费口径取 docs.bigmodel.cn 模型总览(GLM-4.7-Flash 标注"免费模型");FlashX/5V-Turbo
  // 用国际站 docs.z.ai 价目页 USD 数字(缓存存储限时免费→cacheWrite=input)。
  // 不加这些键时前缀兜底会落到 'glm-4.7'/'glm-5' 高价档,免费/轻量模型被计成旗舰价。
  'glm-4.7-flash':               cny(0, 0, 0, 0),           // 官方免费模型
  'glm-4.7-flashx':              usd(0.07, 0.4, 0.01, 0.07),
  'glm-5v-turbo':                usd(1.2, 4, 0.24, 1.2),
  // 'glm-5v'(无 Turbo 后缀):bigmodel/z.ai 现行价目与模型总览均无此 id(视觉现役
  // 仅 GLM-5V-Turbo/4.6V/4.5V)→ 按"拿不到留空不加"口径不编。

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

// ── R3: 用户自填单价(最高优先级,赢过 REMOTE / PRICES / ALIASES)──────────
// 内置价表永远算不准两类情况,而只有用户自己知道实付多少:
//   ① 中转站:同一个 gpt-5.6-sol,走中转站是服务商自定价(通常低于官网),走本地代理是
//      订阅额度。jsonl 顶层字段只有 uuid/timestamp/cwd/sessionId/version/gitBranch,
//      没有 baseURL/provider,事后无法反推 → 只能由用户在 provider 表单里填。
//   ② 套餐包月:付的是月费不是 token 费,按单价算出的金额没有意义 → 只显示用量。
// 数据来自 provider 条目的 modelPrices:
//   { [modelId]: { in, out, cacheRead, cacheWrite } | { plan: true } }
// 单位【人民币元 / 每百万 token】(内部按 CNY_TO_USD 折 USD,与其余价表同口径)。
// 缺省语义(与 UI 说明逐字一致):
//   · in / out 留空 → 该项回落内置表同项(内置表也没有该模型时按 0),不是把整条按 0 算;
//   · 缓存两项留空 → 按 cacheRead=0.1×in、cacheWrite=1.25×in(与 cny()/usd() 同默认倍率);
//   · in 与 out 都没填 → 整条当没填,完全回落内置表。
// 匹配【按 model id 精确匹配,与当前 provider 无关】—— 和 lookupPrice 的"计价第一依据永远
// 是这条消息实际用的模型"是同一条原则(jsonl 只有 model)。
// ponytail: 精确匹配就够 —— id 是用户从自己的模型列表里选或手输的。不做去日期后缀/最长前缀
// 兜底,免得"填了 gpt-5.6 把 gpt-5.6-luna 也一起计价"这种意外;要覆盖多个 id 就多填几行。
const UP_KEY = 'cgui-user-prices';
let USER_ACTIVE = new Map();  // 当前激活 provider 填的价
let USER_ANY = new Map();     // 全部 provider 填的价(同 id 取列表里第一个)

function sanitizeUserPrice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.plan === true) return { plan: true };
  const n = (v) => {
    const x = typeof v === 'string' ? Number(v.trim() || NaN) : v;
    return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
  };
  const e = { in: n(raw.in), out: n(raw.out), cacheRead: n(raw.cacheRead), cacheWrite: n(raw.cacheWrite) };
  return (e.in != null || e.out != null) ? e : null;  // 一项价都没有 = 当没填
}

/**
 * 把 provider 列表里的 modelPrices 装进查价层。入参 = GET /api/providers 的
 * customProviders(含 isCurrent),不含也永远不该含 apiKey。
 * 【同 id 冲突】两个 provider 给同一个 model id 填了不同价时:优先当前激活 provider 的,
 * 否则取列表里第一个匹配。这是 jsonl 不记 provider 造成的固有天花板 —— 一条历史消息
 * 只留下 model id,分不出它当年走的是哪个 provider,任何规则都是猜,取"当前激活的"至少
 * 让用户看到的数字和他此刻的账单口径一致。
 */
export function setUserPrices(providers, persist = true) {
  const active = new Map();
  const any = new Map();
  const slim = [];
  for (const p of Array.isArray(providers) ? providers : []) {
    const mp = p && p.modelPrices;
    if (!mp || typeof mp !== 'object') continue;
    let kept = false;
    for (const [id, raw] of Object.entries(mp)) {
      const e = sanitizeUserPrice(raw);
      if (!e || !id) continue;
      kept = true;
      if (p.isCurrent && !active.has(id)) active.set(id, e);
      if (!any.has(id)) any.set(id, e);
    }
    if (kept) slim.push({ isCurrent: !!p.isCurrent, modelPrices: mp });
  }
  USER_ACTIVE = active;
  USER_ANY = any;
  // 缓存使下次加载首帧就有用户价(与 REMOTE 同一套路);hydrate 成功后覆盖。
  if (persist) { try { localStorage.setItem(UP_KEY, JSON.stringify(slim)); } catch { /* 隐私模式/配额 */ } }
}

/** 该 model id 的用户配置条目({in,out,...} 或 {plan:true}),没有则 null。 */
export function userModelPrice(model) {
  if (!model) return null;
  return USER_ACTIVE.get(model) || USER_ANY.get(model) || null;
}

// 用户条目 → 与 PRICES 同形状的四价条目(USD/1M)。plan 档不产生价格(走 isPlanBilling)。
function userPriceEntry(model) {
  const u = userModelPrice(model);
  if (!u || u.plan) return null;
  const base = lookupByModel(model);  // 未填项的回落源,可能为 null
  const input  = u.in  != null ? u.in  * CNY_TO_USD : (base ? base.input : 0);
  const output = u.out != null ? u.out * CNY_TO_USD : (base ? base.output : 0);
  const fallbackRead  = u.in != null ? input * 0.1  : (base ? base.cacheRead : 0);
  const fallbackWrite = u.in != null ? input * 1.25 : (base ? base.cacheWrite : 0);
  return {
    input,
    output,
    cacheRead:  u.cacheRead  != null ? u.cacheRead  * CNY_TO_USD : fallbackRead,
    cacheWrite: u.cacheWrite != null ? u.cacheWrite * CNY_TO_USD : fallbackWrite,
    currency: 'CNY',
    source: 'user',
  };
}

async function hydrateUserPrices() {
  try {
    const r = await fetch('/api/providers');
    const j = await r.json();
    if (j && Array.isArray(j.customProviders)) setUserPrices(j.customProviders);
  } catch { /* 拉不到 → 沿用 localStorage 缓存 */ }
}
if (typeof window !== 'undefined') {
  try { setUserPrices(JSON.parse(localStorage.getItem(UP_KEY) || '[]'), false); } catch { /* 缓存损坏 */ }
  // 自 hydrate 兜底:不依赖任何组件的挂载顺序。provider 增删改/切换后 App 会广播
  // cgui:provider-change,顺带重拉一次,改完价格立即生效不用刷新。
  hydrateUserPrices();
  window.addEventListener('cgui:provider-change', hydrateUserPrices);
}

// Common aliases the CLI may emit.
// 裸别名对应哪一代是有歧义的(会话当年跑的可能是别的代),只能取"该别名当前指向的
// 主力型号";已存在的三条不动(改了也只是把一个猜测换成另一个猜测)。
const ALIASES = {
  'sonnet': 'claude-sonnet-4-6',
  'opus':   'claude-opus-4-7',
  'haiku':  'claude-haiku-4-5',
  // 与上面三条同理:CLI 发裸 'fable' 时原先四路查价全落空 = 无价可显。
  // (本机 3749 个 jsonl 的 assistant 消息里实际出现 0 次 —— 上一版注释写的"717 条"
  //  是拿 rg 抓 "model":" 时把 Agent 工具入参 model:"fable" 也算进去了,不是真调用。)
  'fable':  'claude-fable-5',
};

// 按 model id 查价(与 provider 无关的纯解析):LiteLLM 远端表优先(覆盖广、随上游
// 更新),内置手抄表兜底;再依次试别名、去日期后缀、最长前缀、去命名空间前缀。
function lookupByModel(model) {
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
  if (key) return PRICES[key];
  // 聚合平台/网关下发带命名空间的 id(moonshotai/kimi-k3、openai/gpt-5.6-sol):它们按
  // 上游模型计价,去掉命名空间再查一次,总好过整条消息无价可显。精确键在前面已匹配,
  // 故 Groq 的 'openai/gpt-oss-120b'(与 Cerebras 裸名不同价)仍走自己的键,不受影响。
  return model && model.includes('/') ? lookupByModel(model.slice(model.lastIndexOf('/') + 1)) : null;
}

// 按 model + provider 查一条单价。
//   任何 hint  → 用户自填单价永远最优先(R3)
//   anthropic / bedrock / vertex / unknown → 直接按这条消息的 model 查
//   deepseek / mimo → 同样先按这条消息的 model 查,**查不到才**回落 env 档位
// 【R4-c2 纠正旧注释】原注释写着"cc switch 路由时 stream-json 的 model 字段仍是
// claude-sonnet-X-X,真实上游在 ANTHROPIC_MODEL env"——已被实测推翻:本机历史里的 24 个
// model id 全是真实上游名(deepseek-v4-flash 14,239 条、k3 14,229 条、mimo-v2.5-pro
// 3,121 条),没有伪装成 claude-* 的。所以 env 档位(provider.model)只是**消息没带
// model 时**的兜底,不是主依据。别照着旧注释把这两个分支"修回"按 env 计价。
function lookupPrice(model, provider) {
  if (!model && !(provider && provider.model)) return null;
  // R3:用户自填单价最高优先级 —— 赢过 REMOTE / 内置表,也赢过下面 deepseek/mimo 的
  // env 档位回落(用户填的是他这条消息实付的钱,任何推断都不该盖过它)。
  const user = userPriceEntry(model);
  if (user) return user;
  const hint = (provider && provider.providerHint) || 'anthropic';

  // Q-a:计价的第一依据永远是【这条消息实际用的模型】,不是 provider.model(= 当前
  // env 档位)。这两个分支原先完全忽略传入的 model,后果:①换档后回看旧会话全按新档
  // 计价(deepseek v4-flash↔v4-pro 差 3×);②当前切到 deepseek/mimo 时打开任何历史
  // Claude/Kimi 会话,整条会话按 deepseek/mimo 单价算(差一个数量级)。
  // 回落路径原样保留:消息无 model(老 jsonl / 流式首帧)时仍按 env 档位。
  if (hint === 'deepseek') {
    const byMsg = lookupByModel(model) || (model && PRICES['deepseek-' + model]);
    if (byMsg) return byMsg;
    // Prefer env-set upstream model name; fall back to deepseek-chat default.
    const remote = remoteLookup(provider.model);
    if (remote) return remote;
    const target = (provider.model && PRICES[provider.model])
      ? provider.model
      : (PRICES['deepseek-' + (provider.model || '')] ? 'deepseek-' + provider.model : 'deepseek-chat');
    return PRICES[target] || PRICES['deepseek-chat'];
  }
  if (hint === 'mimo') {
    // 项目实际部署 mimo-v2.5-pro;provider.model 精确匹配次之,兜底 pro(原硬返回非-pro 偏低 3×)
    return lookupByModel(model)
      || (provider && provider.model && PRICES[provider.model])
      || PRICES['mimo-v2.5-pro'] || PRICES['mimo-v2.5'] || null;
  }
  // anthropic / bedrock / vertex / unknown → use claude name as displayed
  return lookupByModel(model);
}

/**
 * 官方订阅(Pro/Max 包月)计费判据 —— 判的是【这条消息】,不是整个界面。
 * 订阅包月覆盖的只有 Claude 那部分:把单价表算出的金额显示给订阅用户是误导
 * (那是"如果走 API 会花多少",不是他的账单)。但同一个人切到 deepseek/kimi/gpt
 * 跑过的消息是**另外真金白银付的**,恰恰是订阅用户唯一需要看的费用 —— 所以判据
 * 必须带上 model:只看当前 provider 会把第三方花费一起藏了(判官实测:本机第三方
 * 消息 3.6 万条、真实花费约 ¥1.27 万,全被藏成 0)。这和 lookupPrice 里"计价第一
 * 依据永远是这条消息实际用的模型"是同一条原则,与 UsagePanel 的分档口径一致
 * (R4-a 起面板与气泡共用 computeCost / aggregateCost,不再各判各的)。
 * 两个条件:
 *   model 是 Claude 家族(含裸别名 opus/sonnet/haiku/fable)
 *   + 【当时】走的是官方 OAuth(切官方时 AUTH_TOKEN/API_KEY 被显式删掉,只能走 OAuth)
 * model 缺失、鉴权方式不明,一律判非订阅:失败方向是"照常显示价格",不是"多藏一个数字"。
 */
export function isSubscriptionBilling(provider, model) {
  if (!provider) return false;
  // 本机 29.9 万条 assistant 记录里的 24 个 model id 实测:命中的恰是 10 个 claude-*,
  // 第三方(k3 / kimi-for-coding / gpt-5.5 / deepseek-* / mimo-* / moonshotai/*)无一误伤。
  if (!/claude|opus|sonnet|haiku|fable|mythos/i.test(model || '')) return false;
  if ((provider.providerHint || 'anthropic') === 'anthropic') return provider.hasAuthKey === false;
  // R4-b:当前是第三方 provider —— 这条 Claude 消息显然不是现在发的,判据要用【当时】的
  // 鉴权方式,而 jsonl 里没有。原实现在这里直接 return false(= 拿此刻的第三方身份顶替),
  // 于是切一次 provider 历史金额就翻转:判官实测订阅态合计 ¥4,690,切到第三方立刻变
  // ¥498,876,多出的 49 万全是订阅期 Claude 消息按 API 单价算出的虚构钱。
  // 改用最后一次观察到的官方计费方式;从没观察到过则维持原行为(照常显示)。
  return lastOfficialBilling === 'oauth';
}

// ── R4-b:最后一次观察到的【官方计费方式】────────────────────────────
// 'oauth' = 订阅包月(官方 provider 且无 AUTH_TOKEN/API_KEY)| 'apikey' = 按量付费。
// ponytail: localStorage 一行就够 —— 与 cgui-user-prices / cgui-litellm-prices 同层,纯展示
// 口径。丢了只会回落成"照常显示价格"(多显示,不多藏),不值得为它引入服务端持久化。
// 已知天花板:同一台机器换了账号(订阅号 → API key 号)时,换之前的历史会按换之后的口径判。
// 要根治得按消息记当时的鉴权方式,而 jsonl 存不下 —— 与"同一 model id 在不同 provider
// 不同价"是同一个天花板。
const OFFICIAL_BILLING_KEY = 'cgui-official-billing';
let lastOfficialBilling = null;
try { lastOfficialBilling = localStorage.getItem(OFFICIAL_BILLING_KEY) || null; } catch { /* 隐私模式 */ }

/**
 * 记下"官方 provider 当前是怎么计费的"。只在 provider 确实是官方时记录 —— 第三方的
 * hasAuthKey 说的是第三方的 token,不是官方计费方式,不许污染记录。
 * 调用点:App 根组件对 currentProvider 的 effect(全局唯一,跟随 store 的刷新节奏)。
 */
export function observeOfficialBilling(provider) {
  if (!provider || (provider.providerHint || 'anthropic') !== 'anthropic') return;
  if (typeof provider.hasAuthKey !== 'boolean') return;  // 不知道就别记(旧数据/未返回)
  const mode = provider.hasAuthKey ? 'apikey' : 'oauth';
  if (mode === lastOfficialBilling) return;
  lastOfficialBilling = mode;
  try { localStorage.setItem(OFFICIAL_BILLING_KEY, mode); } catch { /* 隐私模式/配额 */ }
}

/**
 * 套餐包月档:按 token 单价算出来的金额没有意义(用户付的是月费,不是 token 费)→ 不显示。
 * 两类:
 *   1. Claude 官方订阅(见 isSubscriptionBilling);
 *   2. Kimi Code 会员套餐(baseURL api.kimi.com/coding)。它的模型 id 是套餐专属的
 *      k3 / kimi-for-coding / kimi-for-coding-highspeed,与开放平台按量付费的
 *      kimi-k3 / kimi-k2.7-code 不同名 → 单看 model id 就能可靠区分,不依赖当前 env。
 *      (下面价表里那三个键按开放平台同型号价近似,套餐档不显示金额,它们只作兜底。)
 * 其余(DeepSeek / MiMo / 官方 API key / 中转站)一律按量档,照常显示金额。
 * 【已知天花板】jsonl 不记接入方式 —— 实测顶层字段只有 uuid / timestamp / cwd /
 * sessionId / version / gitBranch 等,没有 baseURL / provider;同一个 gpt-5.6-sol
 * 既可能走中转站(自定价、通常低于官网)也可能走本地 codex 代理(ChatGPT 订阅额度),
 * 单价基准分不出来。按"宁可看到标注了不确定的数字,也不要什么都看不到"的口径:
 * 这类一律【显示 + 在 title 标注按官网价估算】,不静默隐藏。
 */
export function isPlanBilling(provider, model) {
  // R3:用户为这个 model id 显式配置过 → 以他的配置为准,优先级最高。勾了「套餐包月」
  // 就是套餐(不显示金额);填了单价就是按量(哪怕 id 命中下面的 Kimi 白名单、哪怕当前
  // 是 Claude 订阅态 —— 中转站转售 claude-* 是真花钱的,不能跟着订阅一起藏)。
  const u = userModelPrice(model);
  if (u) return !!u.plan;
  // ponytail: 整串白名单够用 —— 套餐 id 与开放平台 id 不同名。将来 Kimi 改名在这里补键,
  // 不必引入"按消息记 provider"的新体系(jsonl 也存不下)。
  // R4-c1:锚定整串,不是前缀。原 /^(k3|kimi-for-coding)/ 会把 k30 / k3-turbo / k3.5 一起
  // 当套餐静默藏掉金额(今天无碰撞,Kimi 开放平台出裸 k3.x 就中招)。[1m] 是 CLI 通用的
  // 1M 上下文后缀,同一个模型,要保留。
  if (/^(k3|kimi-for-coding(-highspeed)?)(\[1m\])?$/.test(model || '')) return true;
  return isSubscriptionBilling(provider, model);
}

/**
 * Compute USD cost for a single message's usage object.
 * Returns { totalUsd, breakdown: {input, output, cacheRead, cacheWrite} } or null.
 * 套餐档的消息返回 null —— 这是所有费用展示的唯一出口,各处 `cost && (...)`
 * 条件渲染因此自动只剩用量,不用在每个显示点各加一遍判断。判据带 model,
 * 所以订阅态下同一条会话里按量付费模型的花费照常显示、Claude 的不显示。
 */
export function computeCost(model, usage, provider) {
  if (!usage) return null;
  if (isPlanBilling(provider, model)) return null;
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
  // source='user' = 这条按用户自填单价算的 → 显示口径改成"按你填写的单价计算",
  // 不再说"按官网价估算"(TurnBubble / MessageBubble / UsagePanel 三处同一判据)。
  return { totalUsd, breakdown, currency: p.currency, source: p.source || 'table' };
}

/**
 * R4-a:用量面板的费用口径 —— 服务端按 model 聚合后的 { input, output, cacheRead,
 * cacheWrite } 走同一个 computeCost,与逐条消息的气泡逐位一致(单价×token 是线性的,
 * 先加后乘与先乘后加结果相同)。返回三态,对应面板的三种显示:
 *   { usd }            → 金额
 *   { subscription }   → 订阅内 / 套餐内(付的是月费,按 token 算出来的数没有意义)
 *   { unknown }        → 「—」(查不到这个 model 的单价,无从计算)
 * 【为什么要有这个函数】原先 UsagePanel 自带一套分档:/claude|opus|sonnet|haiku/ 一律当
 * 订阅藏掉(连官方 API key 付费用户的钱也藏)、只有 deepseek/mimo 算钱、其余一律「—」。
 * 判官实测同一份真实历史:面板 ¥211.70 vs 气泡 ¥4,689.56,差 22 倍。口径必须只有一个出口。
 */
export function aggregateCost(model, tokens, provider) {
  const c = computeCost(model, {
    input_tokens: tokens.input, output_tokens: tokens.output,
    cache_read_input_tokens: tokens.cacheRead, cache_creation_input_tokens: tokens.cacheWrite || 0,
  }, provider);
  if (c) return { usd: c.totalUsd };
  // computeCost 返回 null 有两种原因,面板要分开显示:套餐/订阅档 vs 查无单价。
  return isPlanBilling(provider, model) ? { subscription: true } : { unknown: true };
}

/**
 * 费用数字的悬浮说明 —— TurnBubble / MessageBubble / UsagePanel 三处共用,口径靠共用
 * 保证一致,不靠各自维护同一段话。用了用户自填单价的消息如实说明来源,不再说"按官网价估算"。
 */
export function costTitle(cost) {
  if (!cost) return '';
  const head = cost.source === 'user'
    ? '本条按你为该模型填写的单价计算（人民币 / 每百万 token）。\n单价在 provider 编辑表单的「计价」中设置，留空的项按内置官网价回落。\n'
    : '本条估算（人民币；美元计价模型按 1 USD ≈ 7.2 CNY 换算，人民币计价模型为原生定价）\n'
      + '单价取各模型官网价目。若该模型经中转站接入或按套餐计费，则在 provider 编辑表单的「计价」中填写实付单价。\n';
  return head
    + `input ${formatCost(cost.breakdown.input)}\n`
    + `output ${formatCost(cost.breakdown.output)}\n`
    + `cache read ${formatCost(cost.breakdown.cacheRead)}\n`
    + `cache write ${formatCost(cost.breakdown.cacheWrite)}`;
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
