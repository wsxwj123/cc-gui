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
 *
 * r26-G4:image 块的 base64 data 不按字符计(一张图几十万物料,chars/4 会虚高到
 * 几十万),按固定当量 ESTIMATED_TOKENS_PER_IMAGE 计(Anthropic 官方经验值约
 * (w×h)/750,无尺寸信息时取中位常量);文本块照旧 chars/4。无图片输入时序列化
 * 内容与旧口径逐字节一致(纯文本回归哨兵靠这点成立)。
 */
export const ESTIMATED_TOKENS_PER_IMAGE = 1500;

export function estimateInputTokens(body) {
  let size = 0;
  let images = 0;
  try {
    const messages = (body?.messages ?? []).map((m) => {
      if (!m || !Array.isArray(m.content)) return m;
      const kept = m.content.filter((b) => {
        if (b && typeof b === 'object' && b.type === 'image') { images++; return false; }
        return true;
      });
      return kept.length === m.content.length ? m : { ...m, content: kept };
    });
    size = JSON.stringify({
      messages,
      system: body?.system ?? '',
      tools: body?.tools ?? [],
    }).length;
  } catch { size = 0; images = 0; }
  return { input_tokens: Math.max(0, Math.ceil(size / 4) + images * ESTIMATED_TOKENS_PER_IMAGE) };
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

// ── r31:共享最近 count_tokens 结果表 ─────────────────────────────────────────
// 背景:第三方 provider 的 /context 快路经 SDK slot.query.getContextUsage() 拿数据,
// SDK 不透传自定义字段,代理层在 count_tokens 响应顶层打标的 estimated:true 到不了前端
// (被误标成「精确·SDK 实测」)。两个本地 proxy 与 chat.js 同在一个 server 进程,用这张
// 内存档桥接:proxy 在返回响应前 record,快路拿到 usage 后按 model 在时间窗内回查,
// 命中且 estimated 就把标记补进 usage 再进 mapSdkContextUsage。官方 provider 不走 proxy,
// 永不写入,快路自然查不到、绝无误标(宁可不标也不错标)。
const MAX_COUNT_TOKENS_OUTCOMES = 20;
const COUNT_TOKENS_OUTCOME_TTL_MS = 10_000; // 保留窗:比快路 3s 回查窗宽松,命中率高
const countTokensOutcomes = [];             // [{ at, model, estimated, inputTokens }],按时间升序

/**
 * 记录一次 count_tokens 结果(代理层返回响应前调用)。
 * model:请求体里的模型名;estimated:该响应是否估算回落;inputTokens:响应的 input_tokens。
 */
export function recordCountTokensOutcome({ model, estimated, inputTokens }) {
  const now = Date.now();
  countTokensOutcomes.push({
    at: now,
    model: typeof model === 'string' ? model : '',
    estimated: estimated === true,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
  });
  // 只留最近 MAX 条或 TTL 内,闲置进程内存不涨。
  while (countTokensOutcomes.length > MAX_COUNT_TOKENS_OUTCOMES) countTokensOutcomes.shift();
  const cutoff = now - COUNT_TOKENS_OUTCOME_TTL_MS;
  while (countTokensOutcomes.length && countTokensOutcomes[0].at < cutoff) countTokensOutcomes.shift();
}

/**
 * 回查最近一次 count_tokens 结果(按 model)。默认只在 withinMs(3s)时间窗内查,
 * 时间倒序找最新一条;该 model 的最新记录已超窗 → 返 null(过期不命中)。
 * now 仅供测试注入"未来时刻"模拟过期;正常调用缺省 Date.now()。
 */
export function latestCountTokensOutcome(model, { withinMs = 3000, now = Date.now() } = {}) {
  const m = typeof model === 'string' ? model : '';
  const cutoff = now - withinMs;
  for (let i = countTokensOutcomes.length - 1; i >= 0; i--) {
    const r = countTokensOutcomes[i];
    if (r.model !== m) continue;
    if (r.at < cutoff) return null; // 该 model 最新一条都已超窗,更早的必不在窗内
    return r;
  }
  return null;
}
