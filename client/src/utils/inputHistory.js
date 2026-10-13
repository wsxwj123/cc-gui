// 输入历史(在输入框里按上键翻出以前发过的输入)的存取 —— 纯机制,零 React / store 依赖,可单测。
// 本地存储对象一律由调用方传进来(浏览器里是 localStorage,单测里是带配额的假实现)。
//
// 两种键:
//   cgui-input-history:<会话键>   每个会话自己的输入历史(最多 INPUT_HISTORY_MAX_ENTRIES 条,新的在前)
//   cgui-input-history            按会话隔离之前的旧全局键(存量最多 100 条)。只读、不删:
//                                 升级前的历史还要能翻出来,而且多个会话 / 标签页都可能在读它。
//
// r149(用户实报:首页发消息被拦,「本地存储空间不足」):
// 原来"读"在本会话键为空时回落到旧全局键,而"写"拿这份回落结果加上新条目整份写进本会话键 —— 每个新会话
// 第一次发消息,就把旧全局的 100 条抄一份(约 23 KB)。约 220 个会话把 5 MB 的本地存储占满,之后连一条
// 待发消息都存不进去。实测 211 个会话键占了 92%,其中 88% 的条目是旧全局键的原样副本。
// S1:写入只基于本会话键自己的列表;上键翻历史时再把旧全局的接在后面(去重)。

export const LEGACY_INPUT_HISTORY_KEY = 'cgui-input-history';
export const INPUT_HISTORY_PREFIX = 'cgui-input-history:';
export const INPUT_HISTORY_MAX_ENTRIES = 100;

/** 会话键 → 它的输入历史键。没有会话键时沿用原来的 global。 */
export const inputHistoryKey = (sessionKey) => `${INPUT_HISTORY_PREFIX}${sessionKey || 'global'}`;

/** 存储里的原始值 → 条目数组(只留非空字符串;解析不了 = 空)。 */
export function parseInputHistory(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}
const readList = (storage, key) => {
  try { return parseInputHistory(storage.getItem(key)); } catch { return []; }
};

/**
 * 上键翻历史用的列表:本会话自己的在前,旧全局的在后,去重。
 * 本会话还没发过消息时,翻出来的就是旧全局那份 —— 升级后旧历史仍然翻得出来。
 */
export function readInputHistory(storage, sessionKey) {
  const own = readList(storage, inputHistoryKey(sessionKey));
  const legacy = readList(storage, LEGACY_INPUT_HISTORY_KEY);
  if (!legacy.length) return own;
  const seen = new Set(own);
  return [...own, ...legacy.filter((x) => !seen.has(x))];
}

/**
 * 把一条输入记进本会话的输入历史(提到最前、去重、最多留 INPUT_HISTORY_MAX_ENTRIES 条)。
 * **只基于本会话键自己的列表**,不把旧全局的条目带进来。返回是否写入。
 */
export function saveInputHistoryEntry(storage, sessionKey, value) {
  const entry = String(value || '').trim();
  if (!entry) return false;
  const key = inputHistoryKey(sessionKey);
  const list = readList(storage, key).filter((x) => x !== entry);
  list.unshift(entry);
  try {
    storage.setItem(key, JSON.stringify(list.slice(0, INPUT_HISTORY_MAX_ENTRIES)));
    return true;
  } catch {
    return false;
  }
}
