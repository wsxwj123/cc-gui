// r151l 历史接口薄封装:只走 HTTP,不 import 产品代码。
// 消息正文在响应里可能是字符串(user)或数组(turn.text 是 text 片段数组),统一摊平成字符串再比。

export const pad3 = (n) => String(n).padStart(3, '0');

export function messageText(m) {
  const raw = m && (m.text !== undefined ? m.text : m.displayText);
  if (Array.isArray(raw)) return raw.join('');
  return raw === undefined || raw === null ? '' : String(raw);
}

export function messageTexts(body) {
  return Array.isArray(body?.messages) ? body.messages.map(messageText) : [];
}

/** 全量 usageTotals 的精确预期:每条 assistant 100 in / 20 out,共 count/2 次 API 调用。 */
export function usageFor(count) {
  const assistants = Math.floor(count / 2);
  return {
    input: assistants * 100,
    output: assistants * 20,
    cacheRead: 0,
    cacheCreation: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    apiCalls: assistants,
    codes: [],
    issues: [],
  };
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined) u.set(k, String(v));
  }
  return u.toString();
}

/** GET /api/sessions/:sid/messages。params 里 limit/before 原样落 query(非法值也照发)。 */
export async function getHistory(base, sid, projectHash, params = {}) {
  const query = qs({ projectHash, ...params });
  const url = `${base}/api/sessions/${encodeURIComponent(sid)}/messages?${query}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, text, url };
}

/** 轮询直到 fn 返回真值,返回它;超时返回 null。 */
export async function waitFor(fn, ms = 20_000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** 只摘接口应答里本轮关心的字段,失败信息里一并打印,方便定位红在哪条断言。 */
export function historyFacts(res) {
  const texts = messageTexts(res.body);
  return {
    status: res.status,
    count: texts.length,
    first: texts[0] ?? null,
    last: texts[texts.length - 1] ?? null,
    hasMore: res.body?.hasMore,
    beforeCursor: res.body?.beforeCursor,
    total: res.body?.total,
  };
}
