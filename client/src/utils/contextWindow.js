// 模型的"原生上下文窗口"判定(纯函数,从 App.jsx 抽出供单测):上下文徽章分母的
// 本地兜底表。完整优先级见 App.jsx SessionDetail:显式 [1m] > 后端 resolvedWindow >
// /context 实测 > 本函数。
// ⚠️ 本表只是兜底:第三方 provider 下由服务端 chat.js 的 MODEL_WINDOW_RULES 说了算
// (resolveDisplayWindow 走那张表,官方 OAuth 时才返回 null 落到本函数)。两表口径【不完全
// 一致】且不必强求一致:本表对未知模型默认 1M、服务端未命中返 null,策略本就不同(差分过
// 64 个模型名,minimax-k3、deepseek-v3.2、k3-256k 等仍有差)。真正要求是:改动某个模型族的
// 窗口时两边一起看,别只改一处 —— 历史上就是各自漂移出的事故(服务端 k3=262144 /
// 客户端 deepseek=200000,均已被实测证伪)。
// 策略(用户要求):**默认按 1M 估算**,已知小于 1M 的模型显式回落到真实窗口。
// 优先级:① [1m] 后缀 / 名字里的 -Nm 标注 → N×1M;② -Nk 标注(moonshot-v1-128k)→ N×1K;
// ③ 已知具体系列(GLM=200K、Kimi K2.x=256K、DeepSeek 旧系=128K、GPT-5/mini/nano=400K 等)
//    → 其真实窗口,按代际拆分(旧表把 deepseek/mimo 一律记 200K,已被历史实测打穿);
// ④ 其余(gemini/minimax/grok-4 及未知第三方)→ 默认 1M。默认 1M 只是初始估算,
// /context 实测(优先级更高)或显式 [1m] 会进一步校正,不会因估大而误判(有超窗提示与 sane-ceiling)。
// 低危#3:第三方裸别名判定。第三方 provider 下发 `sonnet`/`opus`/`haiku`(或
// `claude-` 前缀)这类无版本号、无窗口标注的裸别名时,nativeContextWindow 只能落
// 默认分母(opus/sonnet=1M),但真实窗口由中转服务商映射的后端模型决定、本地无从
// 得知。徽章据此追加一句"实际窗口以服务商为准"(不新造手填窗口机制,提示为主;
// 用户可在弹层点 /context 让上游实测校正)。仅裸别名命中 —— 带版本号(sonnet-5)、
// 带窗口标注(-128k/[1m])的都有确定分母,不提示。
export function isBareClaudeAlias(model) {
  return /^(claude-)?(opus|sonnet|haiku)$/.test((model || '').toLowerCase().trim());
}

// R8-6:从 result.modelUsage 提取 CLI 自报的上下文窗口(徽章分母 B 方案)。
// 语义依据(spike-a 实测,CLI 2.1.227):result.modelUsage = { "<完整模型id>":
// { inputTokens, ..., contextWindow, maxOutputTokens, canonicalModel, provider } },
// contextWindow 是 CLI 自认口径(压缩执行按它算)= 分母最权威来源。
// 匹配策略保守(风险清单:别名/多模型 entry 匹配错分母):
//   exact 命中 modelId → 取;exact 未命中且仅一个 entry → 用之(单模型回合的常态);
//   多 entry 且无 exact(如子代理用了不同模型)→ 不取,保持现状。
// contextWindow 非有限正数 → 丢弃。返回 { window, matchedModel } | null。
// ⚠️ 红线(memory context-badge-usage-source):本函数只读 contextWindow 静态字段,
// modelUsage 里的 *Tokens 是整轮累积口径,绝不能拿去当"当前占用"。
export function pickCliContextWindow(modelUsage, modelId) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null;
  const valid = (e) => !!e && Number.isFinite(e.contextWindow) && e.contextWindow > 0;
  if (modelId && valid(modelUsage[modelId])) {
    return { window: modelUsage[modelId].contextWindow, matchedModel: modelId };
  }
  const keys = Object.keys(modelUsage);
  if (keys.length === 1 && valid(modelUsage[keys[0]])) {
    return { window: modelUsage[keys[0]].contextWindow, matchedModel: keys[0] };
  }
  return null;
}

// r103:徽章分母的来源优先级(纯函数,单测 check-r103-dev-badge-window.mjs)。
// 事故(用户实报):第三方 provider 表单手填 1M,第一轮结束后徽章分母变回 200K ——
// R8-6 拿 result.modelUsage[*].contextWindow 无条件覆盖了手填值,而 CLI 对它不认识的
// 第三方模型名【恒报 200,000】。同一时刻 GUI 已经用 CLAUDE_CODE_MAX_CONTEXT_TOKENS 把
// CLI 的真实窗口认知/压缩线抬到 1M(server chat.js resolveCompactWindowSettings),
// 所以旧口径下【显示的分母与 CLI 实际压缩行为相反】。
// 正确方向:GUI 侧有窗口来源(压缩联动下发值 / provider 手填 / 实抓 / 规则表)时以它为准,
// CLI 自报只在 GUI 完全没有来源时(官方模型、或第三方无手填无规则)才当分母 —— 官方模型
// 上 GUI 恒无来源,行为与改前一致,无回归。
// 返回 { window, source },source ∈ '1m' | 'linked' | 'provider' | 'cli' | null。
// null = 无任何来源,调用方自行落 /context 实测缓存 / nativeContextWindow 兜底。
// 入参非对象(null/undefined/数字/字符串)按"全缺"处理返回 { window: null, source: null },
// 不抛错 —— 调用点在流事件回调里,抛一次就吞掉整条 result 处理。
export function resolveBadgeWindow(opts) {
  const { cliWindow, linkedWindow, providerWindow, model } = (opts && typeof opts === 'object') ? opts : {};
  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  if (/\[1m\]/i.test(model || '')) return { window: 1_000_000, source: '1m' };
  const linked = pos(linkedWindow);
  if (linked) return { window: linked, source: 'linked' };
  const provider = pos(providerWindow);
  if (provider) return { window: provider, source: 'provider' };
  const cli = pos(cliWindow);
  if (cli) return { window: cli, source: 'cli' };
  return { window: null, source: null };
}

export function nativeContextWindow(model) {
  const id = (model || '').toLowerCase().trim();
  if (/\[1m\]/i.test(id)) return 1_000_000;
  const byM = id.match(/(\d+)m(?![a-z0-9])/);        // 如 -2m / -1m 显式标注,最权威
  if (byM) return parseInt(byM[1], 10) * 1_000_000;
  const byName = id.match(/(\d+)k(?![a-z0-9])/);     // 如 moonshot-v1-128k
  if (byName) return parseInt(byName[1], 10) * 1000;
  // 已知【小于 1M】的模型 → 回落真实窗口(默认改 1M 后必须显式挡下,否则超窗误判/不触发压缩)。
  // Claude 系分代(证据:CLI 2.1.226 二进制模型注册表 + headless 实测):原生 1M(注册表
  // native_1m:true)从 4.7 起 —— fable-5/mythos-5/opus-5/sonnet-5/opus-4.7/opus-4.8;
  // 【4.6 一代(opus-4-6、sonnet-4-6)注册表写的是 window:200000】,只有 supports_1m_beta,
  // 1M 必须靠 [1m] 后缀开(走本函数最上方分支);haiku 全系与更老代(opus≤4.5、sonnet≤4.5、
  // claude-3-x)同为 200K。旧表把 4.6 一代记成 1M 是错的:/context 实测对裸 claude-opus-4-6
  // 报 31k/200k,而本表在实测缺席时(新会话/探测超时)当分母 → 60% 的会话显示 12%,不预警
  // 不压缩,一路撞 CLI 硬阻断线。反向的旧事故(全 claude 系一律 200K → fable-5 爆红
  // 389k/200k)由下面 1M 那两支挡住,两边都不能再漂。
  // (?![\d-]) 两支对称:挡数字续接(sonnet-52)与带日期新代(sonnet-5-20260101)——后者按
  // 保守 200K 现状,由 1M 运行时推断(App.jsx 单次 ctxUsage 超窗证据,6bfc207)自愈。
  if (/claude|anthropic|opus|sonnet|haiku/.test(id)) {
    if (/fable|mythos/.test(id)) return 1_000_000;
    if (/opus-?4-?[7-9]|opus-?[5-9](?![\d-])/.test(id)) return 1_000_000;
    if (/sonnet-?4-?[7-9]|sonnet-?[5-9](?![\d-])/.test(id)) return 1_000_000;
    if (/^(opus|sonnet)$/.test(id)) return 1_000_000;   // CLI 别名 = 当前 tier 最新 → 1M
    return 200_000;                                     // haiku 全系 / opus≤4.5 / sonnet≤4.5 / claude-3-x
  }
  // DeepSeek 按代际拆分(与服务端表同口径)。旧的"deepseek|mimo 一律 200K"被实测证伪:
  // deepseek-v4-flash 历史最大 prompt 680,100 早已打穿 200K。
  if (/deepseek/.test(id)) return /deepseek-?v4|deepseek.*-(flash|pro)\b/.test(id) ? 1_048_576 : 131_072;
  if (/mimo/.test(id)) return /mimo-?v?2\.5|mimo-?v?([3-9]|[1-9]\d(?!\d))/.test(id) ? 1_000_000 : 200_000; // MiMo v2.5+ 官方 1M(两位分支兜住 mimo-v10;(?!\d) 挡住 mimo-20260115 这类裸日期后缀被当版本号);更老代无官方规格,保守 200K
  // 'k3' 打头是 Kimi Code 套餐别名(不含 kimi/moonshot 字样所以上面正则漏网)。
  // 前缀判据:必须 ^k3 后接 . 或 - 或结束,minimax-k3(非开头)、k30(数字续接)都不误伤。
  // k3[1m] / k3-1m 走上方 [1m]、-Nm 分支返回 1M;k3-256k 走上方 -Nk 分支返回 256,000。
  if (/kimi-?k3|^k3([.-]|$)/.test(id)) return 1_048_576;                     // Kimi K3 全系官方 1M(旧值 262,144 被 319,687 实测证伪)
  if (/kimi|moonshot/.test(id)) return 262_144;                              // Kimi K2.x / for-coding 原生 256K
  if (/glm|zhipu|chatglm/.test(id)) return 200_000;                          // GLM 实测 200K
  if (/grok-?3|grok-?2/.test(id)) return 131_072;                            // Grok-3 128K(Grok-4 走下方默认 1M)
  if (/gpt-4o|gpt-4-turbo|llama|mistral|mixtral|command-r/.test(id)) return 131_072; // 主流 128K 档
  if (/gpt-?5\.([4-9]|[1-9]\d(?!\d))/.test(id)) return 1_050_000;             // GPT-5.4 起全系 1.05M(sol/terra/luna 同窗口;两位分支兜住 gpt-5.10,首位排除 0 免得 gpt-5.05 误进本档)
  if (/gpt-?5/.test(id)) return 400_000;                                      // GPT-5 / mini / nano 400K
  // 其余(gemini / gpt-4.1 全系〔mini/nano 也是 1M〕/ minimax / grok-4 / 未知第三方)→ 默认 1M。
  return 1_000_000;
}
