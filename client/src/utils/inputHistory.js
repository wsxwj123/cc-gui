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
// S3:单条超过这么多字符的输入不记进输入历史(发送、草稿不受影响)。输入历史是给"上键翻回一条再改改"
// 用的,整段粘贴的长文没有这个用途,却最吃空间(实测存量里有 20 条超过 4000 字符,最长约 14000)。
// 只管新写入;存量里已有的超长条目不动。
export const INPUT_HISTORY_MAX_ENTRY_CHARS = 4000;

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
 * **只基于本会话键自己的列表**,不把旧全局的条目带进来。空白、超长(S3)的不记。返回是否写入。
 * 写不进(本地存储满)时腾空间重试一次(S4,见 freeInputHistoryAndRetry);openSessionKeys = 当前各窗格
 * 正在显示的会话键,腾空间时它们的输入历史不删(正在写的这个会话自己也不删)。
 */
export function saveInputHistoryEntry(storage, sessionKey, value, { openSessionKeys = [] } = {}) {
  const entry = String(value || '').trim();
  if (!entry) return false;
  if (entry.length > INPUT_HISTORY_MAX_ENTRY_CHARS) return false;   // S3
  const key = inputHistoryKey(sessionKey);
  const list = readList(storage, key).filter((x) => x !== entry);
  list.unshift(entry);
  const serialized = JSON.stringify(list.slice(0, INPUT_HISTORY_MAX_ENTRIES));
  const attempt = () => {
    try { storage.setItem(key, serialized); return true; } catch { return false; }
  };
  if (attempt()) return true;
  return freeInputHistoryAndRetry(storage, attempt, [sessionKey || 'global', ...openSessionKeys]);
}

// ── S2:瘦身 ────────────────────────────────────────────────
// 存量:S1 之前每个会话键里都躺着旧全局键的副本。把会话键里"与旧全局键相同的条目"剔掉(它们仍能经
// readInputHistory 从旧全局键翻出来,一条都不丢),剔空的键整个删除。幂等:跑第二遍什么都不改。

/** 存储里所有会话级输入历史键的名字(不含旧全局键)。 */
function inputHistoryKeysOf(storage) {
  const keys = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (typeof key === 'string' && key.startsWith(INPUT_HISTORY_PREFIX)) keys.push(key);
  }
  return keys;
}

/**
 * 瘦身的纯计算。entries = { 会话级输入历史键: 条目数组 },legacyList = 旧全局键里的条目。
 * 返回 { rewrite: { 键: 剔除副本后的数组 }, remove: [剔空了的键] };与旧全局没有重叠的键不出现在结果里。
 */
export function slimInputHistoryEntries(entries, legacyList) {
  const legacy = new Set(legacyList);
  const rewrite = {};
  const remove = [];
  if (!legacy.size) return { rewrite, remove };
  for (const [key, list] of Object.entries(entries)) {
    const kept = list.filter((x) => !legacy.has(x));
    if (kept.length === list.length) continue;
    if (kept.length) rewrite[key] = kept;
    else remove.push(key);
  }
  return { rewrite, remove };
}

/**
 * 对一份本地存储做瘦身。只碰 cgui-input-history:<会话键>;旧全局键、别的键、解析不了或形态不认识的
 * 输入历史键一律不动。返回 { removedKeys, rewrittenKeys, freedChars }。不抛。
 */
export function slimInputHistory(storage) {
  const result = { removedKeys: 0, rewrittenKeys: 0, freedChars: 0 };
  try {
    const legacy = parseInputHistory(storage.getItem(LEGACY_INPUT_HISTORY_KEY));
    if (!legacy.length) return result;
    const entries = {};
    const sizes = {};
    for (const key of inputHistoryKeysOf(storage)) {
      const raw = storage.getItem(key);
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) continue;
      entries[key] = parsed;
      sizes[key] = raw.length;
    }
    const { rewrite, remove } = slimInputHistoryEntries(entries, legacy);
    // 先删剔空的(立刻腾出空间),再把变小了的写回去
    for (const key of remove) {
      storage.removeItem(key);
      result.removedKeys += 1;
      result.freedChars += key.length + sizes[key];
    }
    for (const [key, list] of Object.entries(rewrite)) {
      const next = JSON.stringify(list);
      try {
        storage.setItem(key, next);
        result.rewrittenKeys += 1;
        result.freedChars += sizes[key] - next.length;
      } catch { /* 连更小的值都写不回去:原样留着 */ }
    }
  } catch { /* 存储不可用:什么都不做 */ }
  return result;
}

// ── S4:写不进时腾空间 ───────────────────────────────────────
/**
 * 本地存储写不进时调用:腾出输入历史占的空间,然后重试。attempt() 做那次写入并返回成没成。
 * 顺序:
 *   ① 先瘦身一次(S2:只剔旧全局的副本,不丢任何历史),再试;
 *   ② 还不够,按占用从大到小删"没有显示在任何窗格里的会话"的输入历史键,每删一个试一次,成功即停;
 *   ③ 没有可删的了仍失败 → 把第②步删掉的原样写回去,再返回 false(调用方这时才报错)。
 *      r150 J1:原来不写回 —— 占满存储的不是输入历史时,别的会话的输入历史全被删光,要写的东西还是没写进,白删。
 * **只动会话级的输入历史键**(cgui-input-history:<会话键>):它是锦上添花的东西,丢了只是少翻几条。
 * 草稿、待发队列、标题、权限模式等一律不碰;旧全局键、没有会话键的输入框用的 global 键也不删。
 * openSessionKeys:当前各窗格正在显示的会话键 —— 用户眼前的会话,它的输入历史不删。
 */
export function freeInputHistoryAndRetry(storage, attempt, openSessionKeys = []) {
  try {
    slimInputHistory(storage);
    if (attempt()) return true;
    const keep = new Set([inputHistoryKey(null), ...(openSessionKeys || []).filter(Boolean).map((k) => inputHistoryKey(k))]);
    const candidates = inputHistoryKeysOf(storage)
      .filter((key) => !keep.has(key))
      .map((key) => { const value = storage.getItem(key); return { key, value, size: key.length + String(value ?? '').length }; })
      .sort((a, b) => b.size - a.size);
    const removed = [];   // J1:删掉的键值留在内存里,全部删完仍写不进就写回去
    for (const { key, value } of candidates) {
      storage.removeItem(key);
      removed.push([key, value]);
      if (attempt()) return true;
    }
    for (const [key, value] of removed) {
      if (value == null) continue;
      try { storage.setItem(key, value); } catch { /* 这一个写不回去:只丢它,继续写回其余的 */ }
    }
  } catch { /* 存储不可用 */ }
  return false;
}

// ── S5:删会话 ───────────────────────────────────────────────
/** 会话被删除时调用:删掉它的输入历史键(原来删了会话这个键还留着,只增不减)。没有会话键则什么都不做。 */
export function removeInputHistory(storage, sessionKey) {
  if (!sessionKey) return;
  try { storage.removeItem(inputHistoryKey(sessionKey)); } catch { /* 存储不可用 */ }
}
