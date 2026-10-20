// r151l:历史消息分页的纯逻辑 —— query 校验 + 窗口切割。
// 契约:.devflow/r151l-history-pagination-接口.md §1。
// 路由只负责解析 HTTP、服务只负责构建全量 messages;窗口/游标语义集中在这里,单测直接 import。
// 兼容底线:不传 limit = 全量(逐字旧行为);不传 before = 右端 total。

export const HISTORY_LIMIT_MAX = 2000;

/** query 值 → 非负整数;小数/负数/科学计数法/空串/数组一律 null。 */
function toInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 解析并校验 `limit` / `before` query。
 * 返回 { ok:true, limit?, before? }(缺省字段为 undefined)或 { ok:false, error }。
 * 超界 before(> total)在 sliceMessagesForPage 里按 total 处理,这里只校验整数形态。
 */
export function parseHistoryPaging(query = {}) {
  const q = query && typeof query === 'object' ? query : {};
  const result = { ok: true, limit: undefined, before: undefined };
  // Express 的 req.query 里"没传"是 undefined;`?limit`(空值)是 '',按非法处理。
  if (q.limit !== undefined) {
    const n = toInteger(q.limit);
    if (n === null || n < 1 || n > HISTORY_LIMIT_MAX) {
      return { ok: false, error: `limit 必须是 1..${HISTORY_LIMIT_MAX} 的整数` };
    }
    result.limit = n;
  }
  if (q.before !== undefined) {
    const n = toInteger(q.before);
    if (n === null) return { ok: false, error: 'before 必须是非负整数' };
    result.before = n;
  }
  return result;
}

/**
 * 从全量 messages 里切出一页。
 * - limit 缺省 → 原样返回全量,hasMore=false,beforeCursor=0(旧调用语义)。
 * - limit 给了 → 窗口 [max(0,before-limit), min(before,total));before 缺省/超界按 total。
 * - beforeCursor = 窗口第一条在**全量数组**里的下标(空窗口 null),可直接当下次的 before。
 * - hasMore = 窗口左侧还有更早消息。
 * 纯函数:不修改入参。
 */
export function sliceMessagesForPage(messages, { limit, before } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  if (limit === undefined || limit === null) {
    return { messages: list, hasMore: false, beforeCursor: 0, total };
  }
  const size = toInteger(limit);
  // 非法 limit 由路由拒绝;这里按全量兜底,保证直接调用纯函数也不会切出畸形窗口。
  if (size === null || size < 1) {
    return { messages: list, hasMore: false, beforeCursor: 0, total };
  }
  const rawEnd = before === undefined || before === null ? total : toInteger(before);
  const end = Math.max(0, Math.min(rawEnd === null ? total : rawEnd, total));
  const start = Math.max(0, end - size);
  const window = start === 0 && end === total ? list : list.slice(start, end);
  return {
    messages: window,
    hasMore: start > 0,
    beforeCursor: window.length ? start : null,
    total,
  };
}
