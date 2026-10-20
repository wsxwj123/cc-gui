// r151l:历史分页的前端纯逻辑 —— 请求窗口大小、静默刷新合并、前插去重、2000 条上限。
// 窗口/游标语义在服务端(server/utils/history-pagination.js);这里只做客户端侧的账。
// 单测:tests/unit/check-r151l-history-page.mjs。

/** 首屏与每次「加载更早」取多少条(接口文件 §2)。 */
export const HISTORY_PAGE_SIZE = 120;
/** 客户端最多保留多少条已加载历史;超过只留最近 N 条并提示。 */
export const HISTORY_LOADED_MAX = 2000;

/**
 * 本次 /messages 请求的 limit:
 * - 首屏/短会话 → 120;
 * - 静默刷新不得把已加载旧消息刷掉 → 至少等于当前已加载条数;
 * - 上限 2000(再大只会把响应体重新拉回去)。
 */
export function historyFetchLimit(loaded) {
  const n = Number.isFinite(loaded) ? Math.floor(loaded) : 0;
  return Math.min(HISTORY_LOADED_MAX, Math.max(HISTORY_PAGE_SIZE, n));
}

/** 消息身份键:uuid 优先;没有 uuid 的合成条目(旧形态)退回 type+时间戳+正文。 */
export function historyMessageKey(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.uuid === 'string' && message.uuid) return `u:${message.uuid}`;
  const ts = typeof message.timestamp === 'string' ? message.timestamp : '';
  const text = typeof message.text === 'string'
    ? message.text
    : (Array.isArray(message.text) ? message.text.join('\n') : '');
  return `${message.type || '?'}|${ts}|${text}`;
}

/**
 * 静默刷新落地:服务端返回的是"最近 N 条"的后缀窗口,文件追加会让窗口右移、
 * 把已加载的最旧几条挤出去。先找 incoming[0] 在当前列表里的位置,把更早的前缀原样保留。
 * 返回 { messages, preservedPrefix }:preservedPrefix = 保留了几条旧前缀(0 = 以服务端为准)。
 * 找不到交集(会话/文件被重写)→ 整份以服务端为准,不复活旧内容。
 */
export function mergeRefreshedMessages(existing, incoming) {
  const base = Array.isArray(existing) ? existing : [];
  const next = Array.isArray(incoming) ? incoming : [];
  if (!next.length) return { messages: [], preservedPrefix: 0 };
  if (!base.length) return { messages: next, preservedPrefix: 0 };
  const firstKey = historyMessageKey(next[0]);
  const idx = firstKey ? base.findIndex((m) => historyMessageKey(m) === firstKey) : -1;
  if (idx > 0) return { messages: [...base.slice(0, idx), ...next], preservedPrefix: idx };
  return { messages: next, preservedPrefix: 0 };
}

/**
 * 「加载更早」落地:把这一页前插到当前列表,按身份键去重(防与流式/静默刷新重复)。
 * 返回 { messages, addedCount }。
 */
export function prependOlderMessages(existing, older) {
  const base = Array.isArray(existing) ? existing : [];
  const page = Array.isArray(older) ? older : [];
  if (!page.length) return { messages: base, addedCount: 0 };
  const seen = new Set();
  for (const m of base) {
    const k = historyMessageKey(m);
    if (k) seen.add(k);
  }
  const fresh = [];
  for (const m of page) {
    const k = historyMessageKey(m);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    fresh.push(m);
  }
  if (!fresh.length) return { messages: base, addedCount: 0 };
  return { messages: [...fresh, ...base], addedCount: fresh.length };
}

/** 2000 条上限:超出只保留最近 max 条。返回 { messages, dropped }。 */
export function trimRecentMessages(messages, max = HISTORY_LOADED_MAX) {
  const list = Array.isArray(messages) ? messages : [];
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : HISTORY_LOADED_MAX;
  if (list.length <= cap) return { messages: list, dropped: 0 };
  return { messages: list.slice(list.length - cap), dropped: list.length - cap };
}

const historyTabIndex = (tab) => (Number.isInteger(tab) && tab >= 0 && tab <= 5 ? tab : 0);

/**
 * r151l 判官修正(窄复审①):历史请求代号按 **(sessionId, tab, lane)** 分账。
 *   · lane='refresh'(fetchMessages)/ 'older'(loadOlderMessages)各一条独立递增线 ——
 *     静默刷新不再把在飞的「加载更早」判过期,反之亦然(原来共用一个号会互相作废);
 *   · 记录里带 sessionId:换会话后旧会话的号自然失效;
 *   · 计数器**只增不减**(reset 也 +1,不归零):切走再切回同一会话、关窗再开时,新号必然
 *     大于旧号 —— 若按键归零,切回后第一次请求会和当年在飞的旧号撞上。
 * 返回 { seqs, seq };seqs 是新数组(不原地改 state 里的旧数组)。
 */
export function nextHistoryRequestSeq(seqs, tab, sessionId, lane = 'refresh') {
  const idx = historyTabIndex(tab);
  const arr = Array.isArray(seqs) ? [...seqs] : [];
  const prev = arr[idx] && typeof arr[idx] === 'object' ? arr[idx] : null;
  const key = lane === 'older' ? 'older' : 'refresh';
  const seq = (Number.isFinite(prev?.[key]) ? prev[key] : 0) + 1;
  arr[idx] = {
    sessionId: sessionId || null,
    refresh: Number.isFinite(prev?.refresh) ? prev.refresh : 0,
    older: Number.isFinite(prev?.older) ? prev.older : 0,
    [key]: seq,
  };
  return { seqs: arr, seq };
}

/**
 * 切会话 / 换 pane 会话 / 清空窗格:作废该 tab 的**两条**代号线。
 * sessionId 置 null(在飞响应立即判过期),计数器**递增**而不是原样保留:
 *   · refresh 线:切回同一会话时 fetchMessages 才领新号,递增保证新号大于在飞的旧号;
 *   · older 线:切回时可能**没有新的**「加载更早」请求 —— 若旧号仍等于存储值,
 *     只清 sessionId 的 reset 会被切回后的 refresh 写回(重新写回旧 sessionId)而"复活",
 *     迟到的旧页被当成最新拼回列表(可能造成分页空洞)。递增后旧号必然对不上。
 * 见 tests/unit/check-r151l-history-page.mjs 的 t9。
 */
export function resetHistoryRequestSeq(seqs, tab) {
  const idx = historyTabIndex(tab);
  const arr = Array.isArray(seqs) ? [...seqs] : [];
  const prev = arr[idx] && typeof arr[idx] === 'object' ? arr[idx] : null;
  arr[idx] = {
    sessionId: null,
    refresh: (Number.isFinite(prev?.refresh) ? prev.refresh : 0) + 1,
    older: (Number.isFinite(prev?.older) ? prev.older : 0) + 1,
  };
  return arr;
}

/**
 * 分页账落盘时要继承的 loading / capped:
 * 只有账属于**本次响应的会话**才沿用旧账的在飞标记;账属于别的会话时一律用新值。
 * 侧栏切会话(setSelectedSession)不清理 historyPagingByTab,若不加会话限定,会把 A 的
 * loading:true 抄进 B 的新账,B 的「加载更早」就会永久禁用(loadOlderMessages 见
 * paging.loading 早退,后续刷新也只是把 loading 再抄一遍);capped 同理会把 A 的
 * 2000 条上限漏给 B。
 */
export function resolveHistoryPagingFlags(pagingNow, sessionId, opts = {}) {
  const sameSession = !!pagingNow && typeof pagingNow === 'object'
    && pagingNow.sessionId === sessionId;
  return {
    loading: !!(sameSession && pagingNow.loading),
    capped: !!opts.capped || !!(sameSession && pagingNow.capped),
  };
}

/** 这个响应对应的请求代号是否仍是该 (tab, session, lane) 最新一次(不是 → 丢弃)。 */
export function isHistoryRequestCurrent(seqs, tab, sessionId, lane, seq) {
  const idx = historyTabIndex(tab);
  const rec = Array.isArray(seqs) ? seqs[idx] : null;
  if (!rec || typeof rec !== 'object' || rec.sessionId !== (sessionId || null)) return false;
  const key = lane === 'older' ? 'older' : 'refresh';
  return rec[key] === seq;
}
