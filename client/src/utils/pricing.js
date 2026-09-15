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

import {
  getPricingCatalogCached, officialQuotesByModelId, officialQuotesByDisplayKey, officialNameKey,
} from './pricingCatalog.js';
import {
  periodFor, LONG_CONTEXT_THRESHOLDS, OFFICIAL_MODEL_ALIASES, AGGREGATE_PERIOD_AT,
} from '../../../server/utils/pricing-rules.js';

const CNY_TO_USD = 1 / 7.2;

// Helper: build a CNY model entry, auto-convert to USD.
// 【currency 的语义】这个字段说的是**这几个数字的单位**,不是「原价来自哪个币种」——
// 本表的 CNY 行已经按 7.2 折算成 USD,所以标 'USD'(展示层才不会再折一次)。
// 官方报价层(quotes)不折算、原样保留来源币种(那里 currency:'CNY' 表示数字就是人民币),
// 展示层按 currency 决定要不要 ×7.2 —— 两种来源因此各自显示成官方原值。
const cny = (input, output, cacheRead = input * 0.1, cacheWrite = input * 1.25, extra) => ({
  input: input * CNY_TO_USD,
  output: output * CNY_TO_USD,
  cacheRead: cacheRead * CNY_TO_USD,
  cacheWrite: cacheWrite * CNY_TO_USD,
  currency: 'USD',
  ...extra,
});

const usd = (input, output, cacheRead = input * 0.1, cacheWrite = input * 1.25, extra) => ({
  input, output, cacheRead, cacheWrite, currency: 'USD',
  ...extra,
});

// O-2 拍板:官方已下架的旧模型保留历史价 + 标注「已下架」。不上调成未定价 ——
// 那会让回看旧会话成片空白;标注与 tooltip 说明由 resolvePrice 透出(retired/note)。
const RETIRED_V4 = { retired: true, note: '官方已下架(2026-08-27),此为历史价' };

// Anthropic (https://docs.anthropic.com/en/docs/about-claude/models) — USD/MTok
// cache_write here is the 5-min TTL variant (1.25× input). 1-hr write is 2× input.
const PRICES = {
  // Claude — Anthropic official
  // 官方页直核 2026-08-04(上次 2026-07-16,数字未变): platform.claude.com/docs/en/about-claude/pricing
  // cacheWrite 列取 5min TTL 变体(=1.25×input);1h write=2×input 不建模。
  // Fable 5 / Mythos 5(限量): $10/$50,cw $12.50,cr $1(用新 tokenizer,token 量 ~+30%)。
  'claude-fable-5':              usd(10, 50, 1, 12.5),
  'claude-mythos-5':             usd(10, 50, 1, 12.5),
  // Fable 5.1 / Mythos 5.1:官方页 $10/$50、**命中价 $0.25**(0.025×,与 5 代的 0.1× 不同)。
  // 不补这两行时,'claude-fable-5-1' 靠最长前缀命中 'claude-fable-5' → 命中价被算成 $1(4× 高估)。
  'claude-fable-5-1':            usd(10, 50, 0.25, 12.5),
  'claude-mythos-5-1':           usd(10, 50, 0.25, 12.5),
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
  // 【峰谷计价——2026-09-11 起已实现】官方公告:高峰时段价格为平时价格 2 倍,高峰 = 北京时间
  // 周一至周五 9:00–12:00、14:00–18:00,自 2026-08-17 00:00(+08:00) 起生效。现行实现走
  // **官方报价层**(/api/pricing 的 quotes,CNY 原值,按时段两条)按每条消息自身时间戳判档;
  // 下表是离线兜底,只保留已下架的 v4 旧价(见各行的 retired 标注)。
  // 未在表里给 deepseek-flash / deepseek-v4-pro 现价:它们的官方价是分时段的,离线表存不下
  // 「哪个时刻用哪条」,存一个均价反而把用户看得到的数字算错 —— 宁可「未定价」并说明原因。
  // deepseek-chat/reasoner 是 v4-flash 的 non-thinking/thinking 别名(2026-07-24 弃用);
  // 官方现行价目页已不再列出这两个 id,保留作兜底。本机历史零调用,不动。
  'deepseek-chat':               usd(0.14, 0.28, 0.0028, 0.14),    // v4-flash non-thinking
  'deepseek-reasoner':           usd(0.14, 0.28, 0.0028, 0.14),    // v4-flash thinking
  'deepseek-v4-flash':           usd(0.14, 0.28, 0.0028, 0.14, RETIRED_V4),
  // vision-exp 与 v4-flash 同价:补一行让它**精确**命中(原先靠最长前缀命中 v4-flash),
  // 于是「已下架」标注也能落到它身上,而不是静默借用别的行。
  'deepseek-v4-flash-vision-exp': usd(0.14, 0.28, 0.0028, 0.14, RETIRED_V4),
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
  // 2026-09-11 按官方页重核:5.6 系三档已调价(sol $4/$20、terra $2/$12、luna 不变),
  // 长上下文档(>272K 输入)由报价层携带,本表只有短档;写价 = input(不收写入费)。
  'gpt-5.6-sol':                 usd(4, 20, 0.40, 4),
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
  // GLM-5.3-Flash:官方国内站 ¥0.8/¥2.8/命中 ¥0.23(1M 单档,2026-09-11 直核 docs.bigmodel.cn)。
  // 不补这行时 'glm-5.3-flash' 靠最长前缀命中 'glm-5' → 被按 ¥6/¥22/¥1.5 计(输入高 7.5×)。
  'glm-5.3-flash':               cny(0.8, 2.8, 0.23, 0.8),
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

// Claude 家族的缓存写有两档 TTL:5m = 1.25×input(usd() 的默认倍率),1h = **2×input**
// (官方页逐模型一致)。补齐 1h 档后,带 TTL 分配的写量才能按档精算;缺 TTL 分配而两档价
// 不同时按「写费未知」处理(不拿任一档价猜)—— 与官方报价层的规则完全同一条。
for (const [id, entry] of Object.entries(PRICES)) {
  if (/^claude-/.test(id) && typeof entry.input === 'number' && entry.cacheWrite1h === undefined) {
    entry.cacheWrite1h = entry.input * 2;
  }
}

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

// 兼容视图 prices 的来源 = GET /api/pricing 的 `prices`(现行三键视图)。运行时有两条路把
// 它装进来:①客户端 catalog 缓存(setPricingCatalog/loadPricingCatalog,与 quotes 同一份响应);
// ②模块顶部的 localStorage 兜底(下次加载首帧就能用)。前者更新,优先用它。
function compatPrices() {
  const cached = getPricingCatalogCached?.();
  const prices = cached && typeof cached.prices === 'object' ? cached.prices : null;
  return prices && Object.keys(prices).length ? prices : REMOTE;
}

function remoteLookup(model) {
  const table = compatPrices();
  if (!model || !table) return null;
  let e = table[model];
  if (!e) e = table[model.replace(/-\d{8}$/, '')];
  if (!e) {
    // 前缀兜底取**最长**匹配(与下方内置表 lookupByModel 同口径):键序不确定时
    // 短键(claude-3-5)不许抢走长键(claude-3-5-haiku)。
    const k = Object.keys(table)
      .filter((k) => model.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    e = k ? table[k] : null;
  }
  return e ? { ...e, currency: 'USD' } : null;
}

/** 同上,但带上「是不是逐字命中」—— 去日期后缀与最长前缀都是靠规则猜的(matchedExactly=false)。 */
function remoteLookupDetailed(model) {
  const table = compatPrices();
  if (!model || !table) return null;
  if (table[model]) return { entry: { ...table[model], currency: 'USD' }, matchedExactly: true };
  const stripped = model.replace(/-\d{8}$/, '');
  if (stripped !== model && table[stripped]) return { entry: { ...table[stripped], currency: 'USD' }, matchedExactly: false };
  const k = Object.keys(table)
    .filter((key) => model.startsWith(key))
    .sort((a, b) => b.length - a.length)[0];
  return k ? { entry: { ...table[k], currency: 'USD' }, matchedExactly: false } : null;
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
// 匹配【按归一化后的 model id 匹配,与当前 provider 无关】—— 和 lookupPrice 的"计价第一
// 依据永远是这条消息实际用的模型"是同一条原则(jsonl 只有 model)。
const UP_KEY = 'cgui-user-prices';
let USER_ACTIVE = new Map();  // 当前激活 provider 填的价(精确键 + 归一键两层)
let USER_ANY = new Map();     // 全部 provider 填的价(同键取列表里第一个)

/**
 * R5-c:用户价查找的两层键。存入与查询都走这两个函数,故两侧写法不一致也能对上。
 *   exactKey — trim + 小写。用户输入的空白与大小写不该导致落空,但 id 本身一字不改。
 *   normModelKey — 在 exactKey 基础上再剥 [1m] 后缀与命名空间前缀。
 * 为什么要归一层:同一个模型在历史里两种形态并存 —— 'gpt-5.6-sol' 与 'openai/gpt-5.6-sol'、
 * 'kimi-k3' 与 'moonshotai/kimi-k3';[1m] 是 CLI 通用的 1M 上下文后缀(同一个模型)。
 * 原先纯精确匹配,带前缀/带 [1m] 的那部分消息会**静默**回落官网价,用户看不出来。
 * 【为什么归一层不能单独用】命名空间不是纯噪声:内置表里 'openai/gpt-oss-120b'(Groq,
 * $0.15/$0.60)与 'gpt-oss-120b'(Cerebras,$0.35/$0.75)本来就是两个价不同的模型(见
 * PRICES 里那两行的注释)。无条件剥前缀会把它们合成一个键,用户填的 Cerebras 价被 Groq
 * 的顶掉、差 23 倍且完全静默 —— 比"少算成官网价"更隐蔽(口径标签还写着"按你填写的单价")。
 * 所以:装填两遍(精确键全部落位后,归一键只补空位),查询也按 精确 → 归一 的顺序。
 * 【仍然不做】去日期后缀 / 最长前缀兜底:填 'gpt-5.6' 不许把 'gpt-5.6-luna' 一起计价 ——
 * 那是当初拒绝前缀兜底的理由,至今成立。要覆盖多个 id 就多填几行。
 * 【已知天花板】'k3' 与 'k3[1m]' 归一后同键,分不出 1M 变体的差价(用户也没有别的地方
 * 能表达这个差价);两个都填时精确键各自成立,只有没精确命中时才落到归一层。
 */
const exactKey = (id) => String(id || '').trim().toLowerCase();
function normModelKey(id) {
  const s = exactKey(id).replace(/\[1m\]$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}

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
  const flat = [];  // [{ isCurrent, id, e }],保持 provider 列表顺序
  for (const p of Array.isArray(providers) ? providers : []) {
    const mp = p && p.modelPrices;
    if (!mp || typeof mp !== 'object') continue;
    let kept = false;
    for (const [id, raw] of Object.entries(mp)) {
      const e = sanitizeUserPrice(raw);
      if (!e || !exactKey(id)) continue;
      kept = true;
      flat.push({ isCurrent: !!p.isCurrent, id, e });
    }
    if (kept) slim.push({ isCurrent: !!p.isCurrent, modelPrices: mp });
  }
  // 两遍装填,键按种类打 'e:'/'n:' 前缀分开命名空间。前缀不能省:两种键混在同一个 Map 里
  // 时,'gpt-oss-120b' 既可能是 Cerebras 的**精确**键、也可能是 Groq 的 'openai/…' 归一
  // 出来的键,查询方分不出命中的是哪一种 —— 于是"精确优先"退化成"谁先写进去谁赢"。
  for (const [tag, keyOf] of [['e:', exactKey], ['n:', normModelKey]]) {
    for (const { isCurrent, id, e } of flat) {
      const raw = keyOf(id);
      if (!raw) continue;
      const k = tag + raw;
      if (isCurrent && !active.has(k)) active.set(k, e);
      if (!any.has(k)) any.set(k, e);
    }
  }
  USER_ACTIVE = active;
  USER_ANY = any;
  // 缓存使下次加载首帧就有用户价(与 REMOTE 同一套路);hydrate 成功后覆盖。
  if (persist) { try { localStorage.setItem(UP_KEY, JSON.stringify(slim)); } catch { /* 隐私模式/配额 */ } }
}

/**
 * 该 model id 的用户配置条目({in,out,...} 或 {plan:true}),没有则 null。
 * 顺序:精确键(激活 → 任意)→ 归一键(激活 → 任意)。
 * 精确整体优先于"当前激活" —— 精确匹配讲的是**模型身份**(Groq 的 openai/gpt-oss-120b
 * 与 Cerebras 的 gpt-oss-120b 是两个模型),isCurrent 只是同一身份撞车时的裁决规则。
 */
export function userModelPrice(model) {
  const exact = exactKey(model);
  if (!exact) return null;
  const norm = 'n:' + normModelKey(model);
  return USER_ACTIVE.get('e:' + exact) || USER_ANY.get('e:' + exact)
    || USER_ACTIVE.get(norm) || USER_ANY.get(norm) || null;
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

// 按 model id 查内置离线表(纯解析,不碰 provider):精确 → 别名 → 去日期后缀 → 最长前缀
// → 去命名空间前缀。返回 { entry, matchedExactly }:后三种都是「靠规则猜到」的命中
// (matchedExactly=false),展示层据此加「·疑似」后缀,不再静默顶替。
function lookupByModel(model) {
  const table = (entry) => ({ entry, matchedExactly: true });
  if (model && PRICES[model]) return table(PRICES[model]);
  if (ALIASES[model] && PRICES[ALIASES[model]]) return table(PRICES[ALIASES[model]]);
  const guessed = (entry) => ({ entry, matchedExactly: false });
  const stripped = model && model.replace(/-\d{8}$/, '');
  if (stripped && stripped !== model && PRICES[stripped]) return guessed(PRICES[stripped]);
  // 前缀兜底取**最长**匹配:'step-3.7-flash-xxx' 该命中 'step-3.7-flash' 而非先遇到的 'step-3'
  const key = model && Object.keys(PRICES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (key) return guessed(PRICES[key]);
  // 聚合平台/网关下发带命名空间的 id(moonshotai/kimi-k3、openai/gpt-5.6-sol):它们按
  // 上游模型计价,去掉命名空间再查一次,总好过整条消息无价可显。精确键在前面已匹配,
  // 故 Groq 的 'openai/gpt-oss-120b'(与 Cerebras 裸名不同价)仍走自己的键,不受影响。
  if (!model || !model.includes('/')) return null;
  const inner = lookupByModel(model.slice(model.lastIndexOf('/') + 1));
  // 剥命名空间本身也是「靠规则猜」(§10.11③):命中记 matchedExactly=false,与内层怎么命中的无关。
  return inner ? { entry: inner.entry, matchedExactly: false } : null;
}

// 内置离线表的入口(含 deepseek/mimo 的 env 档位回落,口径与旧 lookupPrice 逐字一致)。
//   anthropic / bedrock / vertex / unknown → 直接按这条消息的 model 查
//   deepseek / mimo → 同样先按这条消息的 model 查,**查不到才**回落 env 档位
// 【R4-c2 纠正旧注释】原注释写着"cc switch 路由时 stream-json 的 model 字段仍是
// claude-sonnet-X-X,真实上游在 ANTHROPIC_MODEL env"——已被实测推翻:本机历史里的 24 个
// model id 全是真实上游名(deepseek-v4-flash 14,239 条、k3 14,229 条、mimo-v2.5-pro
// 3,121 条),没有伪装成 claude-* 的。所以 env 档位(provider.model)只是**消息没带
// model 时**的兜底,不是主依据。别照着旧注释把这两个分支"修回"按 env 计价。
function offlineLookup(model, provider) {
  if (!model && !(provider && provider.model)) return null;
  const hint = (provider && provider.providerHint) || 'anthropic';
  // Q-a:计价的第一依据永远是【这条消息实际用的模型】,不是 provider.model(= 当前
  // env 档位)。这两个分支原先完全忽略传入的 model,后果:①换档后回看旧会话全按新档
  // 计价(deepseek v4-flash↔v4-pro 差 3×);②当前切到 deepseek/mimo 时打开任何历史
  // Claude/Kimi 会话,整条会话按 deepseek/mimo 单价算(差一个数量级)。
  // 回落路径原样保留:消息无 model(老 jsonl / 流式首帧)时仍按 env 档位。
  if (hint === 'deepseek') {
    const byMsg = lookupByModel(model) || (model && PRICES['deepseek-' + model] && { entry: PRICES['deepseek-' + model], matchedExactly: false });
    if (byMsg) return byMsg;
    // Prefer env-set upstream model name; fall back to deepseek-chat default.
    const remote = remoteLookup(provider.model);
    if (remote) return { entry: remote, matchedExactly: false };   // env 档位 = 猜的
    const target = (provider.model && PRICES[provider.model])
      ? provider.model
      : (PRICES['deepseek-' + (provider.model || '')] ? 'deepseek-' + provider.model : 'deepseek-chat');
    return { entry: PRICES[target] || PRICES['deepseek-chat'], matchedExactly: false };
  }
  if (hint === 'mimo') {
    // 项目实际部署 mimo-v2.5-pro;provider.model 精确匹配次之,兜底 pro(原硬返回非-pro 偏低 3×)
    return lookupByModel(model)
      || (provider && provider.model && PRICES[provider.model] && { entry: PRICES[provider.model], matchedExactly: false })
      || (PRICES['mimo-v2.5-pro'] && { entry: PRICES['mimo-v2.5-pro'], matchedExactly: false })
      || (PRICES['mimo-v2.5'] && { entry: PRICES['mimo-v2.5'], matchedExactly: false })
      || null;
  }
  // anthropic / bedrock / vertex / unknown → use claude name as displayed
  return lookupByModel(model);
}

// ── 统一取价出口 resolvePrice(2026-09-11 计价修正)────────────────────────
// 优先级:手填单价 → 官方 quotes → 官方 compat prices → community(当前无来源)→ 内置表。
// 每一层都给出**来源原币种**的数字(官方 CNY 报价就是人民币数,不折算),展示层按 currency
// 决定要不要按 7.2 换算 —— 两种来源才能各自显示成官方原值。

const UNIT = 'per 1M tokens';

/** 失败原因闭集(契约 §0.1,8 值;resolvePrice 只产其中 6 个价格类)。 */
export const COST_UNAVAILABLE_REASONS = [
  'PLAN_BILLING', 'USAGE_EMPTY', 'USAGE_INVALID', 'NO_PRICE',
  'PERIOD_UNRESOLVED', 'PERIOD_NOT_EFFECTIVE', 'CONDITIONS_AMBIGUOUS', 'THRESHOLD_UNKNOWN',
];

/** 逐字表(契约 §10.11⑦):detail 不是自由文本,测试按这张表断言。 */
const REASON_DETAIL = {
  PLAN_BILLING: '当前是按套餐计费，不显示金额',
  USAGE_EMPTY: '这条记录没有用量数据',
  USAGE_INVALID: '用量字段无法解析',
  NO_PRICE: '没有该模型的可用价格',
  PERIOD_UNRESOLVED: '该模型按时段计价，但这条记录的时间未知或无法解析',
  PERIOD_NOT_EFFECTIVE: '该模型的时段价在本次调用时间尚未生效',
  CONDITIONS_AMBIGUOUS: '该模型有多条适用条件不同的报价，无法确定用哪一条',
  THRESHOLD_UNKNOWN: '该模型的上下文阈值未登记，无法判断走哪一档',
};

// 条件词表的闭集(契约 §5.1.1):表外的条件一律「不解释 → 该 quote 不适用」。
// periodLabel / timezone 是**标注**不是判定条件(采集器给时段报价附的中文原文与时区),
// 不认识它们就会把每一条分时段报价都判掉;真正的判定键只有 period/schedule/context/
// minPromptTokens/tier 五个。
const KNOWN_CONDITION_KEYS = new Set(['period', 'periodLabel', 'timezone', 'schedule', 'context', 'minPromptTokens', 'tier']);
const DECORATIVE_CONDITION_KEYS = new Set(['periodLabel', 'timezone']);
const DEFAULT_SCHEDULE_KEY = 'deepseek-cn-peak';

const strip1m = (model) => String(model || '').replace(/\[1m\]$/, '');

/** 时间戳(ISO 串 / epoch 毫秒)→ 毫秒数;不可解析一律 null(不读「现在」)。 */
function parseTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 一条报价的条件是否适用。返回:
 *   { ok:true, applied:[...] }        条件成立(无条件时 applied 为空数组)
 *   { ok:false, needsTime:true }      时段条件成立与否取决于时刻,而时刻未知 → 不能落下一层
 *   { ok:false }                      不适用(不认识的条件 / 档位不对 / 长度档不匹配)
 */
function evaluateConditions(conditions, ctx) {
  if (conditions == null) return { ok: true, applied: [] };
  if (typeof conditions !== 'object') return { ok: false };
  const keys = Object.keys(conditions);
  if (!keys.length) return { ok: true, applied: [] };
  for (const key of keys) if (!KNOWN_CONDITION_KEYS.has(key)) return { ok: false };
  // schedule 只接受唯一那份时段表;别的值 → 宁缺勿猜。
  if (conditions.schedule != null && conditions.schedule !== DEFAULT_SCHEDULE_KEY) return { ok: false };
  if (conditions.tier != null && conditions.tier !== 'standard') return { ok: false };
  const applied = [];
  if (conditions.period != null) {
    // 只认规范化后的 'peak'/'off-peak';中文旧标签等不认识的值 → 不适用(不会退化成"无条件")。
    if (conditions.period !== 'peak' && conditions.period !== 'off-peak') return { ok: false };
    if (ctx.ts == null) return { ok: false, needsTime: true };
    const period = periodFor(ctx.ts);
    if (period.key !== conditions.period) return { ok: false };
    applied.push({ period: conditions.period, localISO: period.localISO });
  }
  if (conditions.context != null) {
    const threshold = LONG_CONTEXT_THRESHOLDS[ctx.model];
    if (conditions.context === 'long context') {
      // 阈值未登记 → 判不出是不是长档:**不套长档**(宁缺勿猜),只存在长档报价时由上层给
      // THRESHOLD_UNKNOWN 说明原因。
      if (typeof threshold !== 'number') return { ok: false, thresholdMissing: true };
      if (ctx.promptTokens == null || !(ctx.promptTokens > threshold)) return { ok: false };
      applied.push({ context: 'long context', promptTokens: ctx.promptTokens, threshold });
    } else if (conditions.context === 'short context') {
      // 阈值未登记时短档仍是**安全档**(它不额外加价,也是今天看得见的数字):照常适用。
      if (typeof threshold !== 'number') return { ok: true, applied: [] };
      if (ctx.promptTokens == null || ctx.promptTokens > threshold) return { ok: false };
    } else return { ok: false };
  }
  if (conditions.minPromptTokens != null) {
    if (ctx.promptTokens == null || !(ctx.promptTokens > conditions.minPromptTokens)) return { ok: false };
    applied.push({ minPromptTokens: conditions.minPromptTokens });
  }
  return { ok: true, applied };
}

/** 官方的「同一份价」比较键:币种 + 四维(1h 写价不参与 —— 不同来源给不给 1h 列不该算成两份价)。 */
function priceSignature(quote) {
  const p = quote.prices || {};
  return JSON.stringify([quote.currency ?? null, p.input ?? null, p.output ?? null, p.cacheRead ?? null, p.cacheWrite5m ?? null]);
}

function quoteIdentity(quote) {
  return quote.quoteId || JSON.stringify([
    quote.provider, quote.modelId, quote.displayName, quote.conditions ?? null, quote.currency,
    quote.prices?.input, quote.prices?.output, quote.prices?.cacheRead, quote.prices?.cacheWrite5m, quote.prices?.cacheWrite1h,
  ]);
}

/**
 * 官方报价层的候选(契约 §10.11③ 三条并列):
 *   ① modelId 与剥掉 [1m] 的 model 逐字相等(大小写敏感);
 *   ② officialKey(displayName) 相等(大小写不敏感);
 *   ③ OFFICIAL_MODEL_ALIASES 给出的目标键,再按 ①② 匹配。
 * **不剥 vendor/ 命名空间**(那是靠规则猜,属下一层的事)。
 */
function officialCandidates(model) {
  const stripped = strip1m(model);
  const out = [];
  const seen = new Set();
  const collect = (list) => {
    for (const quote of list) {
      const id = quoteIdentity(quote);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(quote);
    }
  };
  collect(officialQuotesByModelId(stripped));
  collect(officialQuotesByDisplayKey(officialNameKey(stripped)));
  const alias = OFFICIAL_MODEL_ALIASES[stripped];
  if (alias) {
    collect(officialQuotesByModelId(alias));
    collect(officialQuotesByDisplayKey(officialNameKey(alias)));
  }
  return out;
}

const fail = (reason, extra = {}) => ({ ok: false, reason, detail: REASON_DETAIL[reason], ...extra });

/**
 * 取价(纯函数,无副作用,不发网络请求 —— 只读已缓存的 catalog)。
 * 返回 {ok:true, tier, matchedExactly, currency, unit, prices:{input,output,cacheRead,cacheWrite5m,cacheWrite1h},
 *      quoteId, sourceUrl, fetchedAt, appliedConditions, skipped, note, retired}
 * 或 {ok:false, reason, detail, skipped}。
 */
export function resolvePrice(model, opts = {}) {
  const provider = opts.provider || null;
  const promptTokens = typeof opts.promptTokens === 'number' && Number.isFinite(opts.promptTokens) ? opts.promptTokens : null;
  const ts = parseTimestamp(opts.at);
  const skipped = [];

  // ① 手填单价(最高优先,命中即返回):逐维度照抄用户填的值,未填的维度 = null(未知)——
  // 不回落内置表、也不用默认倍率补(§10.12③;跨层拼维度会让金额变成两个来源拼出来的数)。
  const user = userModelPrice(model);
  if (user?.plan) return fail('PLAN_BILLING');
  if (user) {
    return {
      ok: true, tier: 'manual', matchedExactly: true, currency: 'CNY', unit: UNIT,
      prices: {
        input: user.in ?? null, output: user.out ?? null,
        cacheRead: user.cacheRead ?? null, cacheWrite5m: user.cacheWrite ?? null, cacheWrite1h: null,
      },
      quoteId: null, sourceUrl: null, fetchedAt: null,
      appliedConditions: [], skipped: [], note: null, retired: false,
    };
  }

  // ② 官方报价层
  const candidates = officialCandidates(model);
  if (candidates.length) {
    const ctx = { ts, promptTokens, model: strip1m(model) };
    const applicable = [];
    let needsTime = 0;
    let unsupported = 0;
    let excludedByValidity = 0;
    let thresholdMissing = 0;
    for (const quote of candidates) {
      if (typeof quote?.currency !== 'string' || quote.status !== 'fresh') continue;   // 币种未补证/非 fresh 不得计价
      const prices = quote.prices || {};
      if (typeof prices.input !== 'number' || typeof prices.output !== 'number') continue;
      const from = parseTimestamp(quote.validFrom);
      const to = parseTimestamp(quote.validTo);
      if (ts != null && ((from != null && from > ts) || (to != null && to <= ts))) { excludedByValidity += 1; continue; }
      const verdict = evaluateConditions(quote.conditions, ctx);
      if (verdict.needsTime) { needsTime += 1; continue; }
      if (!verdict.ok) {
        if (verdict.thresholdMissing) thresholdMissing += 1; else unsupported += 1;
        skipped.push({ tier: 'official-quote', reason: 'CONDITIONS_UNSUPPORTED' });
        continue;
      }
      applicable.push({ quote, applied: verdict.applied });
    }
    if (!applicable.length) {
      // 候选全带时段条件而时刻未知 → **不落下一层**(下层的价必然是错的时段价)。
      if (needsTime > 0 && unsupported === 0 && thresholdMissing === 0 && excludedByValidity === 0) return fail('PERIOD_UNRESOLVED', { skipped });
      // 只存在长上下文档而阈值未登记 → 说明为什么给不出一档(比 NO_PRICE 具体)。
      if (thresholdMissing > 0 && needsTime === 0 && unsupported === 0 && excludedByValidity === 0) return fail('THRESHOLD_UNKNOWN', { skipped });
      if (needsTime === 0 && excludedByValidity > 0) {
        // 有报价因 validFrom/validTo 被排除:该层跳过,落到下一层取「当时价」;
        // 若五层都没命中,最终用 PERIOD_NOT_EFFECTIVE 解释(比 NO_PRICE 更具体)。
        skipped.push({ tier: 'official-quote', reason: 'PERIOD_NOT_EFFECTIVE' });
      }
    } else {
      // 多命中:取值与币种全一致 → 取 quoteId 字典序最小;不一致 → 见下。
      let group = applicable;
      const groups = new Map();
      for (const item of group) {
        const sig = priceSignature(item.quote);
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(item);
      }
      if (groups.size > 1) {
        // 同一模型国内外双价(GLM-5.3-Flash:国内站 CNY 0.8 vs 国际站 USD 0.15)会让
        // "取值不一致"永远成立。本 GUI 的主受众是国内(内置表同样取国内人民币价),
        // 故先按市场收敛到 cn 组;cn 组内部还不一致才算歧义。
        const all = [...groups.values()];
        const cn = all.filter((list) => list.every((item) => item.quote.market === 'cn'));
        if (cn.length === 1) group = cn[0];
      }
      const signatures = new Set(group.map((item) => priceSignature(item.quote)));
      if (signatures.size > 1) {
        skipped.push({ tier: 'official-quote', reason: 'CONDITIONS_AMBIGUOUS' });
        return fail('CONDITIONS_AMBIGUOUS', { skipped });
      }
      const chosen = [...group].sort((a, b) => String(a.quote.quoteId).localeCompare(String(b.quote.quoteId)))[0];
      const q = chosen.quote;
      const p = q.prices || {};
      return {
        ok: true, tier: 'official-quote', matchedExactly: true,
        currency: q.currency, unit: UNIT,
        prices: {
          input: p.input ?? null, output: p.output ?? null, cacheRead: p.cacheRead ?? null,
          cacheWrite5m: p.cacheWrite5m ?? null, cacheWrite1h: p.cacheWrite1h ?? null,
        },
        quoteId: q.quoteId ?? null, sourceUrl: q.sourceUrl ?? null, fetchedAt: q.fetchedAt ?? null,
        appliedConditions: group.flatMap((item) => item.applied), skipped: [], note: null, retired: false,
      };
    }
  }

  // ③ 官方兼容视图 prices(现行精确 → 去日期后缀 → 最长前缀,本次不改回退链)
  const compat = remoteLookupDetailed(model);
  if (compat) {
    const e = compat.entry;
    return {
      ok: true, tier: 'official-compat', matchedExactly: compat.matchedExactly, currency: 'USD', unit: UNIT,
      prices: { input: e.input ?? null, output: e.output ?? null, cacheRead: e.cacheRead ?? null, cacheWrite5m: e.cacheWrite ?? null, cacheWrite1h: e.cacheWrite1h ?? null },
      quoteId: null, sourceUrl: null, fetchedAt: null, appliedConditions: [], skipped, note: null, retired: false,
    };
  }

  // ④ community 兜底层:当前无来源(实现延后),恒跳过 —— 命中不了就不是错误。

  // ⑤ 内置离线表(现行回退链,不改)
  const offline = offlineLookup(model, provider);
  if (offline) {
    const e = offline.entry;
    return {
      ok: true, tier: 'offline', matchedExactly: offline.matchedExactly, currency: e.currency || 'USD', unit: UNIT,
      prices: { input: e.input ?? null, output: e.output ?? null, cacheRead: e.cacheRead ?? null, cacheWrite5m: e.cacheWrite ?? null, cacheWrite1h: e.cacheWrite1h ?? null },
      quoteId: null, sourceUrl: null, fetchedAt: null, appliedConditions: [], skipped,
      note: e.note || null, retired: !!e.retired,
    };
  }

  if (skipped.some((item) => item.reason === 'PERIOD_NOT_EFFECTIVE')) return fail('PERIOD_NOT_EFFECTIVE', { skipped });
  return fail('NO_PRICE', { skipped });
}

/** 用量本身的问题(与价格无关的那两类原因):'USAGE_EMPTY' | 'USAGE_INVALID' | null。 */
function usageProblem(usage) {
  if (!usage || typeof usage !== 'object') return 'USAGE_EMPTY';
  const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
  let seen = false;
  for (const field of fields) {
    const value = usage[field];
    if (value == null) continue;
    if (typeof value !== 'number') continue;      // 非数字(老数据里的怪异值)按今天的口径当 0
    seen = true;
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return 'USAGE_INVALID';
  }
  return seen ? null : 'USAGE_EMPTY';
}

/**
 * `computeCost` 返回 null 时,UI 用它把「未定价 · 费用未知」换成具体原因(契约 §5.5 文案表)。
 * 返回 { reason, detail } 或 null(表示"有金额",调用方不该走到这里)。
 */
export function costUnavailableReason(model, usage, provider, opts) {
  const problem = usageProblem(usage);
  if (problem) return { reason: problem, detail: REASON_DETAIL[problem] };
  if (isPlanBilling(provider, model)) return { reason: 'PLAN_BILLING', detail: REASON_DETAIL.PLAN_BILLING };
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const price = resolvePrice(model, { at: opts?.at, provider, promptTokens: input });
  if (price.ok) return null;
  return { reason: price.reason, detail: price.detail };
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
  const hint = provider.providerHint || 'anthropic';
  if (hint === 'anthropic') return provider.hasAuthKey === false;
  // R5-a:Bedrock / Vertex 上的 claude-* 是**按 token 真实计费**的(走 AWS / GCP 账单,
  // 与 Claude 订阅是两笔钱),持久化的 oauth 判据对它们不适用 —— 套用等于把真实账单
  // 藏成"订阅内"。
  // 【覆盖面,别写成"Bedrock/Vertex 都修好了"】providerHint 的产地(server/routes/
  // settings.js 的 GET /provider)**只从 ANTHROPIC_BASE_URL 猜**,所以这里只覆盖"把
  // base URL 指向 bedrock/amazonaws/vertex/googleapis 网关"这一种接法。Claude Code 官方
  // 的标准姿势是 CLAUDE_CODE_USE_BEDROCK=1 / CLAUDE_CODE_USE_VERTEX=1 且**不设 base
  // URL**(本仓一处都没处理这两个环境变量),那种配置下 hint 落 'anthropic'、AWS_* 凭证
  // 又使 hasAuthKey 为 false → 在上面那行就被判成订阅,根本走不到这里。
  // 补这个缺口要动 providerHint 的语义,而它流向 lookupPrice 等多处;本机无此接法,
  // 不为一个用不到的场景改公共判据。留作已知限制。
  if (hint === 'bedrock' || hint === 'vertex') return false;
  // R4-b:当前是别的第三方 provider —— 这条 Claude 消息显然不是现在发的,判据要用【当时】的
  // 鉴权方式,而 jsonl 里没有。原实现在这里直接 return false(= 拿此刻的第三方身份顶替),
  // 于是切一次 provider 历史金额就翻转:判官实测订阅态合计 ¥4,690,切到第三方立刻变
  // ¥498,876,多出的 49 万全是订阅期 Claude 消息按 API 单价算出的虚构钱。
  // 改用最后一次观察到的官方计费方式;从没观察到过则维持原行为(照常显示)。
  // 【代价说明,勿再写成"中转站不受影响"】中转站的 hint 是 'unknown',与"订阅期跑的
  // Claude 历史"在 jsonl 里长得一模一样(顶层只有 uuid/timestamp/cwd/sessionId/version/
  // gitBranch,没有 baseURL),分不出来 → 观察到 oauth 后,中转站转售的 claude-* 会跟着
  // 一起藏。逃生口是用户在 provider 表单里为该 model id 填单价(优先级最高,见 isPlanBilling)。
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
 * R5-b:没有本地记录时的一次性引导探测。
 * observeOfficialBilling 只在【当前 provider 恰好是官方】时才写记录,所以新装机 / 清了
 * localStorage 且当前挂着第三方 provider 的用户根本不会有记录 —— 订阅期跑的 Claude 历史
 * 于是全按 API 单价算:判官在真实历史上实测合计 ¥166,204.71(有记录时 ¥665.75),要用户
 * 手动切一次官方 provider 才自愈。
 * 探测走 GET /api/subscription-usage?probe=1(Anthropic OAuth 用量端点,GUI 本来就在用):
 * 它能返回用量 = 这台机器存在官方订阅 → 记 'oauth'。客户端只看结果,不接触任何凭证。
 * 失败方向:超时 / 未登录 / 解析不出 / 任何异常一律**不写记录**,回落现有行为(照常显示
 * 价格)—— 与 observeOfficialBilling 的"不知道就别记"同一条口径。
 * 只探一次:有记录就不探(记录是更强的证据);并发调用共用同一个 in-flight promise。
 * 【已知天花板】探测是异步的,结果落地后已渲染的金额要等下一次渲染才更新。
 */
let probing = null;
export function probeOfficialBilling() {
  if (lastOfficialBilling) return Promise.resolve(lastOfficialBilling);
  if (probing) return probing;
  probing = (async () => {
    try {
      const r = await fetch('/api/subscription-usage?probe=1');
      const j = await r.json();
      // official:true + 至少一档用量解析成功 = 这台机器确有官方订阅。
      // official:false(当前 provider 不是官方)与带 error 的降级响应都不算证据。
      // 再查一次 lastOfficialBilling:请求在飞的这段时间里 observeOfficialBilling 可能已经
      // 直接观察到了当前官方 provider 的计费方式 —— 那是更强的证据(读的是实际配置),
      // 探测(机器级)不许覆盖它。
      if (!lastOfficialBilling && j && j.official === true && (j.session || j.weekAll || j.weekScoped)) {
        lastOfficialBilling = 'oauth';
        try { localStorage.setItem(OFFICIAL_BILLING_KEY, 'oauth'); } catch { /* 隐私模式/配额 */ }
      }
    } catch { /* 网络/解析失败 → 不写记录 */ }
    return lastOfficialBilling;
    // 清空放 .finally 而不是函数体末尾:body 若全程同步跑完(fetch 同步抛),体内的
    // probing = null 会先于外层赋值执行 → probing 永远非空 = 再也不重试。
  })().finally(() => { probing = null; });
  return probing;
}
if (typeof window !== 'undefined') probeOfficialBilling();

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
  // 是 Claude 订阅态)。这条同时是中转站转售 claude-* 的**唯一逃生口**:那笔钱是真花的,
  // 但 jsonl 分不出中转站与官方订阅(见 isSubscriptionBilling 末尾),只能由用户填单价
  // 把它从订阅口径里捞回来。
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
export function computeCost(model, usage, provider, opts) {
  if (usageProblem(usage)) return null;
  if (isPlanBilling(provider, model)) return null;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  // 长上下文判据 = **单次调用 API 字段 input_tokens 的原值**(它已含缓存读写的总量),
  // 不得再加 cache_read/cache_creation —— 见 server/utils/pricing-rules.js 的阈值表注释。
  const price = resolvePrice(model, { at: opts?.at, provider, promptTokens: input });
  if (!price.ok) return null;
  const p = price.prices;
  const M = 1_000_000;
  const unknown = [];
  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null };
  if (p.input != null) breakdown.input = (input * p.input) / M; else if (input > 0) unknown.push('input');
  if (p.output != null) breakdown.output = (output * p.output) / M; else if (output > 0) unknown.push('output');
  if (cacheRead > 0) {
    if (p.cacheRead != null) breakdown.cacheRead = (cacheRead * p.cacheRead) / M;
    else unknown.push('cacheRead');   // 该维度未知:不计费、点名(不拿别的维度/倍率凑一个数)
  }
  // 缓存写(RULINGS #6 硬约定:**顶层量与分项不得相加**):
  //   w5/w1 = 两档 TTL 分项,wt = 顶层写量。
  //   有分配且 w5+w1 === wt → 按档精算;分配之和 ≠ 顶层 → 数据自相矛盾,写费未知;
  //   无分配(两档都是 0)而 wt>0 → 两档价相同可按该单一价计,不同/缺档 → 写费未知。
  const w5 = num(usage.cache_creation?.ephemeral_5m_input_tokens);
  const w1 = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  const hasSplit = w5 + w1 > 0;
  if (hasSplit && w5 + w1 === cacheWrite) {
    breakdown.cacheWrite5m = w5 > 0 ? (p.cacheWrite5m != null ? (w5 * p.cacheWrite5m) / M : null) : 0;
    breakdown.cacheWrite1h = w1 > 0 ? (p.cacheWrite1h != null ? (w1 * p.cacheWrite1h) / M : null) : 0;
    if (breakdown.cacheWrite5m == null) unknown.push('cacheWrite', 'cacheWrite5m');
    if (breakdown.cacheWrite1h == null) unknown.push('cacheWrite', 'cacheWrite1h');
    breakdown.cacheWrite = (breakdown.cacheWrite5m || 0) + (breakdown.cacheWrite1h || 0);
  } else if (hasSplit) {
    unknown.push('cacheWrite');      // 自相矛盾:不猜
  } else if (cacheWrite > 0) {
    if (p.cacheWrite5m != null && (p.cacheWrite1h == null || p.cacheWrite1h === p.cacheWrite5m)) {
      // 单档价:只有 5m 价(OpenAI/内置表口径),或两档恰好同价 —— 都不需要 TTL 分配。
      breakdown.cacheWrite = (cacheWrite * p.cacheWrite5m) / M;
    } else {
      unknown.push('cacheWrite');    // 只有 1h 价 / 两档不同价 / 两档都缺 → 写费未知(不猜)
    }
  }
  const totalUsd = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
  const writeUnknown = unknown.includes('cacheWrite');
  // source='user' = 这条按用户自填单价算的 → 显示口径改成"按你填写的单价计算",
  // 不再说"按官网价估算"(TurnBubble / MessageBubble / UsagePanel 三处同一判据)。
  return {
    totalUsd, breakdown, currency: price.currency, source: price.tier === 'manual' ? 'user' : 'table',
    tier: price.tier, matchedExactly: price.matchedExactly,
    quoteId: price.quoteId, appliedConditions: price.appliedConditions, skipped: price.skipped,
    note: price.note, retired: price.retired,
    ...(unknown.length ? { unknownDimensions: unknown, partial: true } : {}),
    ...(writeUnknown ? { writeUnknown: true } : {}),
  };
}

/**
 * UI 的**唯一**计费入口(§5.3):决策"这一轮要不要逐调用算"。
 *   usageCalls 存在且至少一项 at 可解析、且该模型的官方报价含时段条件 → 逐调用各算一次
 *   (每次用该项自己的 at),金额与 breakdown 相加;部分项不可解析 → 该项按「时段未知」
 *   处理(不计入金额 + partial + unknownDimensions 含 'period')。
 *   否则 → 单次 computeCost(时间取 message.timestamp)。
 * 为什么不无条件逐调用:非分时段模型的金额与调用次数无关(单价×token 是线性的),
 * 逐调用只会把一个 at 缺失的项算成"未知"。
 */
export function computeCostForMessage(message, provider) {
  if (!message || typeof message !== 'object') return null;
  const model = message.model;
  const calls = Array.isArray(message.usageCalls) ? message.usageCalls : null;
  if (calls && calls.length && hasPeriodQuote(model)) {
    const parts = [];
    let partial = false;
    let missingTime = 0;
    for (const call of calls) {
      const at = call?.at;
      if (parseTimestamp(at) == null) { missingTime += 1; continue; }
      const cost = computeCost(model, call?.usage, provider, { at });
      if (!cost) { missingTime += 1; continue; }
      parts.push(cost);
    }
    if (!parts.length) return computeCost(model, message.usage, provider, { at: message.timestamp });
    const total = { totalUsd: 0, breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 } };
    const unknown = [];
    const applied = [];
    let sawSplit = false;
    for (const cost of parts) {
      total.totalUsd += cost.totalUsd;
      total.breakdown.input += cost.breakdown.input;
      total.breakdown.output += cost.breakdown.output;
      total.breakdown.cacheRead += cost.breakdown.cacheRead;
      total.breakdown.cacheWrite += cost.breakdown.cacheWrite;
      if (cost.breakdown.cacheWrite5m != null || cost.breakdown.cacheWrite1h != null) sawSplit = true;
      total.breakdown.cacheWrite5m = (total.breakdown.cacheWrite5m || 0) + (cost.breakdown.cacheWrite5m || 0);
      total.breakdown.cacheWrite1h = (total.breakdown.cacheWrite1h || 0) + (cost.breakdown.cacheWrite1h || 0);
      for (const dim of cost.unknownDimensions || []) if (!unknown.includes(dim)) unknown.push(dim);
      applied.push(...(cost.appliedConditions || []));
      if (cost.partial) partial = true;
    }
    if (!sawSplit) { total.breakdown.cacheWrite5m = null; total.breakdown.cacheWrite1h = null; }
    if (missingTime > 0) {
      partial = true;
      if (!unknown.includes('period')) unknown.push('period');
      applied.push({ period: 'unknown' });
    }
    const head = parts[0];
    return {
      totalUsd: total.totalUsd, breakdown: total.breakdown, currency: head.currency, source: head.source,
      tier: head.tier, matchedExactly: head.matchedExactly, quoteId: head.quoteId, skipped: head.skipped,
      note: head.note, retired: head.retired, appliedConditions: applied,
      ...(partial ? { partial: true } : {}),
      ...(unknown.length ? { unknownDimensions: unknown } : {}),
      ...(unknown.includes('cacheWrite') ? { writeUnknown: true } : {}),
    };
  }
  return computeCost(model, message.usage, provider, { at: message.timestamp });
}

/**
 * A 项:子代理逐条计价(契约 §10.3)。每个 agent 用【自身】model + 自身 usage/usageCalls +
 * 自身 timestamp 走 computeCostForMessage —— 子代理常是 sonnet 而主回合是 opus,沿用主回合
 * 模型会整条算错;走同一个入口的收益是分时段 / TTL 两档 / 长上下文档 / ·疑似 / ·已下架
 * 自动生效,不新开计价路径。
 *   代价 = costUsd 是【原币种】金额(与 turn 的 cost 同口径),故每条 agent 带 currency,
 *   展示层按 displayUsd 折算 —— 与 turn 全相同款做法,不是第二套口径。
 *   失败(算不出来)记 costUsd: null(不是 0)、partial: true、reason 进 unknownDimensions,
 *   绝不按 0 相加;单个 agent 的畸形输入不外溢成整体异常。
 * 纯函数、无网络、无副作用:不改传入数组,同输入同输出。
 */
export function computeCostForAgents(agents, provider) {
  const empty = { totalUsd: 0, count: 0, agents: [], partial: false };
  if (!Array.isArray(agents) || agents.length === 0) return empty;
  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const unknownDimensions = [];
  const currencies = new Set();
  const priced = [];
  let totalUsd = 0;
  let partial = false;
  for (const item of agents) {
    const agent = item && typeof item === 'object' ? item : {};
    const model = typeof agent.model === 'string' && agent.model ? agent.model : null;
    const metadata = {
      agentSessionId: typeof agent.agentSessionId === 'string' ? agent.agentSessionId : null,
      toolUseId: typeof agent.toolUseId === 'string' ? agent.toolUseId : null,
      agentType: typeof agent.agentType === 'string' ? agent.agentType : null,
      model: agent.model ?? null,
    };
    const cost = computeCostForMessage(
      { model, usage: agent.usage, timestamp: agent.timestamp, usageCalls: agent.usageCalls }, provider,
    );
    if (!cost) {
      partial = true;
      const reason = costUnavailableReason(model, agent.usage, provider, { at: agent.timestamp })?.reason;
      if (reason && !unknownDimensions.includes(reason)) unknownDimensions.push(reason);
      priced.push({ ...metadata, costUsd: null, tier: null, matchedExactly: null, retired: false, currency: null });
      continue;
    }
    totalUsd += cost.totalUsd;
    breakdown.input += cost.breakdown.input;
    breakdown.output += cost.breakdown.output;
    breakdown.cacheRead += cost.breakdown.cacheRead;
    breakdown.cacheWrite += cost.breakdown.cacheWrite;
    for (const dim of cost.unknownDimensions || []) if (!unknownDimensions.includes(dim)) unknownDimensions.push(dim);
    if (cost.currency) currencies.add(cost.currency);
    priced.push({
      ...metadata, costUsd: cost.totalUsd, tier: cost.tier ?? null,
      matchedExactly: cost.matchedExactly ?? null, retired: cost.retired === true,
      currency: cost.currency ?? null,
    });
  }
  return {
    totalUsd, breakdown, count: agents.length, agents: priced, partial, unknownDimensions,
    // 展示层要按币种折算(displayUsd);多币种混在一张卡上时给不出一个数,故缺席即按 USD 处理。
    ...(currencies.size === 1 ? { currency: [...currencies][0] } : {}),
  };
}

/**
 * 该 model 的官方报价里有没有分时段条件(决定要不要逐调用各算一次)。
 * 用量面板也用这个判据决定「要不要显示当前时段那一行」—— 计价与展示共用一处,
 * 否则会出现"面板认了某个模型有峰谷价、计价却不认"这类两套口径。
 */
export function hasPeriodQuote(model) {
  for (const quote of officialCandidates(model)) {
    if (quote?.conditions && typeof quote.conditions === 'object' && quote.conditions.period != null) return true;
  }
  return false;
}

/** usage 字段 → 数字(非数字/缺失一律 0,与今天的口径逐字一致)。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
  const asUsage = (bucket) => ({
    input_tokens: bucket.input, output_tokens: bucket.output,
    cache_read_input_tokens: bucket.cacheRead, cache_creation_input_tokens: bucket.cacheWrite || 0,
  });
  // 分时段模型:面板拿到的是按模型汇总的 token(没有时间)。按桶各算一次,时点用规则模块里
  // 写死的代表时刻(不读「现在」,否则同一份数据每次打开金额都变)。
  const byPeriod = tokens.byPeriod;
  if (byPeriod && hasPeriodQuote(model)) {
    const buckets = ['peak', 'offPeak'];
    let usd = 0;
    const unknown = [];
    let partial = false;
    let any = false;
    for (const bucket of buckets) {
      const row = byPeriod[bucket];
      if (!row) continue;
      const c = computeCost(model, asUsage(row), provider, { at: AGGREGATE_PERIOD_AT[bucket] });
      if (!c) continue;
      any = true;
      usd += c.totalUsd;
      for (const dim of c.unknownDimensions || []) if (!unknown.includes(dim)) unknown.push(dim);
      if (c.partial) partial = true;
    }
    const unknownRow = byPeriod.unknown;
    if (unknownRow && (unknownRow.calls || 0) > 0) { partial = true; if (!unknown.includes('period')) unknown.push('period'); }
    if (any) return { usd, currency: firstCurrency(model, provider), ...(partial ? { partial: true, unknownDimensions: unknown } : {}) };
    return isPlanBilling(provider, model) ? { subscription: true } : { unknown: true };
  }
  const c = computeCost(model, asUsage(tokens), provider);
  if (c) return { usd: c.totalUsd, currency: c.currency, ...(c.partial ? { partial: true, unknownDimensions: c.unknownDimensions } : {}) };
  // computeCost 返回 null 有两种原因,面板要分开显示:套餐/订阅档 vs 查无单价。
  return isPlanBilling(provider, model) ? { subscription: true } : { unknown: true };
}

/** 分时段行的展示币种:取其一时段解析出来的 currency(同一条报价,两个时段必然同币种)。 */
function firstCurrency(model, provider) {
  const price = resolvePrice(model, { at: AGGREGATE_PERIOD_AT.peak, provider, promptTokens: null });
  return price.ok ? price.currency : null;
}

/**
 * 费用数字的悬浮说明 —— TurnBubble / MessageBubble / UsagePanel 三处共用,口径靠共用
 * 保证一致,不靠各自维护同一段话。用了用户自填单价的消息如实说明来源,不再说"按官网价估算"。
 */
export function costTitle(cost) {
  if (!cost) return '';
  const head = cost.source === 'user'
    ? '本条按你为该模型填写的单价计算（人民币 / 每百万 token）。\n单价在 provider 编辑表单的「计价」中设置；未填的维度按未知处理，不计入金额。\n'
    : '本条估算（人民币；美元计价模型按 1 USD ≈ 7.2 CNY 换算，人民币计价模型为原生定价）\n'
      + '单价取各模型官网价目。若该模型经中转站接入或按套餐计费，则在 provider 编辑表单的「计价」中填写实付单价。\n';
  const lines = [
    `input ${formatCost(cost.breakdown.input)}`,
    `output ${formatCost(cost.breakdown.output)}`,
    `cache read ${formatCost(cost.breakdown.cacheRead)}`,
    `cache write ${formatCost(cost.breakdown.cacheWrite)}`,
  ];
  if (cost.breakdown.cacheWrite5m != null || cost.breakdown.cacheWrite1h != null) {
    lines.push(`cache write 5m ${formatCost(cost.breakdown.cacheWrite5m || 0)}`);
    lines.push(`cache write 1h ${formatCost(cost.breakdown.cacheWrite1h || 0)}`);
  }
  if (cost.sourceUrl) {
    lines.push(`来源 ${cost.sourceUrl}${cost.fetchedAt ? `（抓取于 ${cost.fetchedAt}）` : ''}`);
  }
  const conditions = (cost.appliedConditions || []).map(conditionText).filter(Boolean);
  if (conditions.length) lines.push(`适用条件 ${conditions.join('、')}`);
  for (const item of cost.skipped || []) {
    if (item?.tier) lines.push(`未采用 ${item.tier}${item.reason ? `：${item.reason}` : ''}`);
  }
  if (cost.note) lines.push(cost.note);
  return head + lines.join('\n');
}

/** 适用条件的可读串(进 tooltip)。 */
function conditionText(condition) {
  if (!condition || typeof condition !== 'object') return '';
  if (condition.context === 'long context') {
    return `长上下文（输入 ${condition.promptTokens} > ${condition.threshold}）`;
  }
  if (condition.period === 'peak') return `高峰时段${condition.localISO ? `（${condition.localISO}）` : ''}`;
  if (condition.period === 'off-peak') return `空闲时段${condition.localISO ? `（${condition.localISO}）` : ''}`;
  if (condition.period === 'unknown') return '部分调用时段未知';
  if (condition.minPromptTokens != null) return `输入量 > ${condition.minPromptTokens}`;
  return '';
}

/** 费用徽章左侧的来源标注(契约 §5.5 的六个词 + 「·疑似」/「·已下架」两个后缀)。 */
export function costSourceLabel(cost) {
  if (!cost) return '';
  let word;
  if (cost.tier === 'manual' || cost.source === 'user') word = '手填单价';
  else if (cost.tier === 'community') word = '社区表（估算）';
  else if (cost.tier === 'offline') word = '离线旧价（估算）';
  else if ((cost.appliedConditions || []).some((item) => item?.context === 'long context')) word = '官方价·长上下文';
  else if ((cost.appliedConditions || []).some((item) => item?.period)) word = '官方价·分时段';
  else word = '按官网价估算';
  if (cost.matchedExactly === false) word += '·疑似';
  if (cost.retired) word += '·已下架';
  return word;
}

/** 「费用未知」时三处费用位显示的词(契约 §5.5,逐字;NO_PRICE 沿用现行文案)。 */
export const COST_REASON_TEXT = {
  NO_PRICE: '未定价 · 费用未知',
  USAGE_INVALID: '用量异常 · 费用未知',
  PERIOD_UNRESOLVED: '时段未知 · 费用未知',
  PERIOD_NOT_EFFECTIVE: '时段价未生效 · 费用未知',
  CONDITIONS_AMBIGUOUS: '条件歧义 · 费用未知',
  THRESHOLD_UNKNOWN: '阈值未知 · 费用未知',
};

/** 「有金额但有未知维度」时的补充说明(契约 §5.5 的三句)。 */
export function costUnknownNote(cost) {
  const dims = cost?.unknownDimensions || [];
  if (dims.includes('period')) return '部分调用时段未知 · 费用为已知小计';
  if (dims.includes('cacheWrite5m') || dims.includes('cacheWrite1h')) return '写费未知（该档无价）';
  if (dims.includes('cacheWrite')) return '写费未知（缺 TTL 分配）';
  return '';
}

/**
 * 金额 → 展示用美元口径:官方 CNY 报价是**原币种数字**(人民币/百万),内置/远端表是美元数字。
 * 展示层按 7.2 回算人民币,所以只有美元数字能直接喂 formatCost —— 人民币数字要先折过去,
 * 否则会被再乘一次 7.2(用户看到的钱多 6.2 倍)。
 */
export function displayUsd(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return amount;
  return currency === 'CNY' ? amount * CNY_TO_USD : amount;
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
