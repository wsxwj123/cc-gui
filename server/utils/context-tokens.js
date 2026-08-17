// r11-⑨:第三方精确上下文通路的纯函数层。
// 取证(2026-08-17,装机 CLI 二进制字符串层,只读):
//  · CLI 的 getContextUsage 对每个分类打 POST `/v1/messages/count_tokens?beta=true`
//    (SDK client.beta.messages.countTokens),消费响应的 `.input_tokens` 数字;
//  · 两个本地代理(anthropic-proxy 8789 / openai-proxy 8788)此前都没实现该端点:
//    anthropic-proxy 盲透传(第三方上游多为 404),openai-proxy 更糟 —— URL 含
//    /v1/messages 就当成生成请求转 chat/completions(真实计费调用)。
//    → 第三方链路 count_tokens 永不成功,快路 8s 后 504,精确计算必超时。

/** count_tokens 请求判定(路径可带 ?beta=true 等查询串)。 */
export function isCountTokensRequest(method, url) {
  return method === 'POST' && /^\/v1\/messages\/count_tokens(?:\?|$)/.test(String(url || ''));
}

/** 上游透传的短超时:2s 内没结果就本地估算(比 CLI 自己的失败链路快一个量级)。 */
export const COUNT_TOKENS_UPSTREAM_TIMEOUT_MS = 2000;

/**
 * 本地估算回退:与 CLI 第三方本地估算同口径的字符启发式 ——
 * JSON.stringify(messages+system+tools).length / 4 量级。
 * 响应形态凑官方 count_tokens:{ input_tokens }(CLI 只读这个字段,二进制实证)。
 */
export function estimateInputTokens(body) {
  let size = 0;
  try {
    size = JSON.stringify({
      messages: body?.messages ?? [],
      system: body?.system ?? '',
      tools: body?.tools ?? [],
    }).length;
  } catch { size = 0; }
  return { input_tokens: Math.max(0, Math.ceil(size / 4)) };
}

/** 上游 200 响应体校验:必须带数字 input_tokens 才透传,否则回退估算(垃圾 200 不喂 CLI)。 */
export function parseUpstreamCountTokens(text) {
  try {
    const j = JSON.parse(text);
    if (j && Number.isFinite(j.input_tokens)) return j;
  } catch {}
  return null;
}

/**
 * /context 快路超时预算(自适应):基础 8s,每 100k 已知 tokens +2s,上限 30s。
 * knownTokens 缺失/非法按 0(维持旧 8s 行为)。
 */
export function contextTimeoutBudget(knownTokens) {
  const n = Number.isFinite(knownTokens) && knownTokens > 0 ? knownTokens : 0;
  return Math.min(30000, 8000 + 2000 * Math.floor(n / 100000));
}
