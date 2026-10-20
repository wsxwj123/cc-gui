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

/**
 * r151l 判官修正:每 tab 单调递增的**历史请求代号**。fetchMessages / loadOlderMessages
 * 发请求前各取一个新号;响应落地时号变了(期间有更新的一次请求 / 切走再切回)整条丢弃。
 * 只按 sessionId 守卫不够:同会话切走再回来时 sessionId 又相等,旧响应会把新列表覆盖掉。
 * 返回 { seqs, seq };seqs 是新数组(不原地改 state 里的旧数组)。
 */
export function nextHistoryRequestSeq(seqs, tab) {
  const idx = Number.isInteger(tab) && tab >= 0 && tab <= 5 ? tab : 0;
  const arr = Array.isArray(seqs) ? [...seqs] : [];
  const seq = (Number.isFinite(arr[idx]) ? arr[idx] : 0) + 1;
  arr[idx] = seq;
  return { seqs: arr, seq };
}

/** 这个响应对应的请求代号是否仍是最新一次(不是 → 丢弃,不写列表/分页账)。 */
export function isHistoryRequestCurrent(seqs, tab, seq) {
  const idx = Number.isInteger(tab) && tab >= 0 && tab <= 5 ? tab : 0;
  return Array.isArray(seqs) && seqs[idx] === seq;
}
