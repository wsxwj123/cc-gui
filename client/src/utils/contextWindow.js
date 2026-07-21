// 模型的"原生上下文窗口"判定(纯函数,从 App.jsx 抽出供单测):上下文徽章分母的
// 本地兜底表。完整优先级见 App.jsx SessionDetail:显式 [1m] > 后端 resolvedWindow >
// /context 实测 > 本函数。
// 策略(用户要求):**默认按 1M 估算**,已知小于 1M 的模型显式回落到真实窗口。
// 优先级:① [1m] 后缀 / 名字里的 -Nm 标注 → N×1M;② -Nk 标注(moonshot-v1-128k)→ N×1K;
// ③ 已知更小的具体系列(含 U3 实测:deepseek/mimo/GLM=200K、Kimi=256K)→ 其真实窗口;
// ④ 其余(gemini/gpt-5.x/minimax/grok-4 及未知第三方)→ 默认 1M。默认 1M 只是初始估算,
// /context 实测(优先级更高)或显式 [1m] 会进一步校正,不会因估大而误判(有超窗提示与 sane-ceiling)。
export function nativeContextWindow(model) {
  const id = (model || '').toLowerCase();
  if (/\[1m\]/i.test(id)) return 1_000_000;
  const byM = id.match(/(\d+)m(?![a-z0-9])/);        // 如 -2m / -1m 显式标注,最权威
  if (byM) return parseInt(byM[1], 10) * 1_000_000;
  const byName = id.match(/(\d+)k(?![a-z0-9])/);     // 如 moonshot-v1-128k
  if (byName) return parseInt(byName[1], 10) * 1000;
  // 已知【小于 1M】的模型 → 回落真实窗口(默认改 1M 后必须显式挡下,否则超窗误判/不触发压缩)。
  // Claude 系分代(2026-07 官方文档核实):fable-5/mythos-5/sonnet-5/opus-4.6+/sonnet-4.6
  // 原生 1M(默认即 1M,无需 [1m] beta;CLI /context 对 sonnet-5 实测报 ~967k 印证);
  // haiku 全系 200K;更老代(opus≤4.5、sonnet≤4.5、claude-3-x)200K(1M 需 [1m],走上方分支)。
  // 旧表把全部 claude 系按 200K 算 → fable-5/Desktop opus 1M 会话首开徽章爆红 389k/200k(194%) 根因。
  // (?![\d-]) 两支对称:挡数字续接(sonnet-52)与带日期新代(sonnet-5-20260101)——后者按
  // 保守 200K 现状,由 1M 运行时推断(App.jsx 单次 ctxUsage 超窗证据,6bfc207)自愈。
  if (/claude|anthropic|opus|sonnet|haiku/.test(id)) {
    if (/fable|mythos/.test(id)) return 1_000_000;
    if (/opus-?4-?[6-9]|opus-?[5-9](?![\d-])/.test(id)) return 1_000_000;
    if (/sonnet-?4-?[6-9]|sonnet-?[5-9](?![\d-])/.test(id)) return 1_000_000;
    if (/^(opus|sonnet)$/.test(id)) return 1_000_000;   // CLI 别名 = 当前 tier 最新 → 1M
    return 200_000;                                     // haiku 全系 / opus≤4.5 / sonnet≤4.5 / claude-3-x
  }
  if (/deepseek|mimo/.test(id)) return 200_000;                               // U3 实测 /context 200K
  if (/kimi|moonshot/.test(id)) return 262_144;                              // Kimi K2.x 原生 256K
  if (/glm|zhipu|chatglm/.test(id)) return 200_000;                          // GLM 实测 200K
  if (/grok-?3|grok-?2/.test(id)) return 131_072;                            // Grok-3 128K(Grok-4 走下方默认 1M)
  if (/gpt-4o|gpt-4-turbo|llama|mistral|mixtral|command-r/.test(id)) return 131_072; // 主流 128K 档
  if (/gpt-5.*(mini|nano)/.test(id)) return 400_000;                          // GPT-5 mini/nano 400K
  // 其余(gemini / gpt-5(.x) / gpt-4.1 全系〔mini/nano 也是 1M〕/ minimax / grok-4 / 未知第三方)→ 默认 1M。
  return 1_000_000;
}
