// r118:回合进行中切走会话再切回,刚发出的那条用户消息消失十几秒(用户实报)。
//
// 根因:用户气泡只是本地乐观副本,CLI 要等会话进程起来【开始处理】才把它写进 jsonl
// (用户机器挂了很多 MCP,这个窗口十几秒)。切会话的 effect 为了防串会话必须清本地副本
// (见 App.jsx 切会话那段),清掉之后历史里还没有 → 两个来源同时缺席,消息凭空消失。
//
// 修法:切走时把「尚未落盘的用户乐观气泡」按会话键暂存(不渲染、不跨会话),切回后
// 对账历史:还没有 → 补回;已经有了 → 丢掉本地副本(同一句话不画两遍)。
// 对账复用 App.jsx 既有的 makePersistedIndex 身份口径(用户消息走全文+落盘时间强口径),
// 不另立一套 —— 弱口径会拿同前缀的旧消息误判"已落盘",反而把气泡整条清掉。
//
// 为什么是模块级 Map 而不是组件 state:切会话的 effect 清的正是组件 state;分屏两个
// 窗格是 SessionDetail 的两个实例。与 r68 直播快照(utils/reattach.js)同构。
//
// 键严格等于 queueKeyFor(session):真会话是 sessionId,草稿期是 draft-<hash>-<draftId>;
// draft 拿到真 sid 时由 migrateUserStash 改键(与 chatMessages.ownerKey 迁移同批)。
// 渲染层不需要额外过滤:补回时把 ownerKey 钉成当前会话键,visibleChat 的既有门控
// (localEntryVisible)保证它永不出现在别的会话。
import { localEntryVisible } from './sessionFlowIdentity.js';

// 只留最近 N 个会话键:每条是几条小消息,但仍不该长期无限涨(Map 保插入序 = 天然 LRU)。
const STASH_CAP = 8;
// r189:每个会话键下最多留这么多条。暂存不清账,同一会话反复切走会一直攒;超出时只丢最旧的
// 【已结清】条目 —— 没结清的可能正等着补回,丢了就是 r118 的「消息凭空消失」。
const ENTRY_CAP = 40;
const stash = new Map();
// r189:结清账(会话键 → 已结清的 uuid 集合)。单独记、不往气泡对象上打标:暂存里的气泡和页面
// 状态里的是同一个对象,改它等于改页面状态。账跟着条目走:删条目同删账,改键同改账。
const settled = new Map();

function dropSettledKey(key) { settled.delete(key); }

/** 删掉超出上限的最旧已结清条目(没结清的一条不丢,哪怕因此仍超上限)。 */
function capEntries(key, entries) {
  const done = settled.get(key);
  let excess = entries.length - ENTRY_CAP;
  if (excess <= 0 || !done?.size) return entries;
  const kept = [];
  for (const m of entries) {
    if (excess > 0 && done.has(m?.uuid)) { excess -= 1; done.delete(m.uuid); continue; }
    kept.push(m);
  }
  return kept;
}

/**
 * 切走时挑出可暂存的本地消息:只挑用户自己发出的乐观气泡(type==='user'),
 * 且必须【严格属于刚切走的那个会话】—— 无 ownerKey 的条目只在 streamOwnerKey 等于该
 * 会话键时才算它的(A 的迟到条目不许被当成 B 的暂存走)。
 */
export function pickStashableUserBubbles(chatMessages, { ownerKey = null, streamOwnerKey = null } = {}) {
  return (chatMessages || []).filter((m) => m?.type === 'user'
    && localEntryVisible({ ownerKey: m?.ownerKey, streamOwnerKey, sessionQueueKey: ownerKey }));
}

/** 合并进 key 名下(按 uuid 去重:同一会话反复切走只留一份;同 uuid 以新到的为准)。 */
export function stashUserBubbles(key, entries) {
  if (!key || !entries?.length) return;
  const byUuid = new Map((stash.get(key) || []).map((m) => [m.uuid, m]));
  // 同 uuid 再合并只换对象、不动结清账:已结清的保持已结清(账按 uuid 记)。
  for (const m of entries) byUuid.set(m.uuid, m);
  stash.delete(key);            // 重新插入,刷新它在 Map 里的 LRU 位置
  stash.set(key, capEntries(key, [...byUuid.values()]));
  while (stash.size > STASH_CAP) {
    const oldest = stash.keys().next().value;
    stash.delete(oldest);
    dropSettledKey(oldest);
  }
}

/** 草稿拿到真 sid:draft 键下的暂存改挂到真 sid(幂等,旧键空则不动)。 */
export function migrateUserStash(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const entries = stash.get(fromKey);
  if (!entries?.length) return;
  const done = settled.get(fromKey);
  stash.delete(fromKey);
  dropSettledKey(fromKey);
  // 账先并到新键再合并条目,上限裁剪才认得出哪些已结清。
  if (done?.size) {
    const into = settled.get(toKey) || new Set();
    for (const uuid of done) into.add(uuid);
    settled.set(toKey, into);
  }
  stashUserBubbles(toKey, entries);
}

/** 撤掉某会话暂存里的一条(按 uuid;r151q:发送被 409 退回队列的那条乐观气泡,不能在切回时被补回来)。 */
export function dropStashedUserBubble(key, uuid) {
  const entries = key && uuid ? stash.get(key) : null;
  if (!entries?.length) return;
  const rest = entries.filter((m) => m?.uuid !== uuid);
  settled.get(key)?.delete(uuid);
  if (rest.length) stash.set(key, rest); else { stash.delete(key); dropSettledKey(key); }
}

/** 丢弃某会话的暂存(回滚把尾部从 jsonl 裁掉后,暂存副本已不代表现实)。 */
export function dropUserStash(key) {
  if (!key) return;
  stash.delete(key);
  dropSettledKey(key);
}

const parseTs = (value) => {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
};

/**
 * r189:汇总已加载的历史窗口(App.jsx 的 messages 只是最后一页,首屏最多 120 条、单页最多 8 MB),
 * 供结清判据 S2–S4 用。时间缺失或解析不出的条目不能当「晚于某时刻」的证据,所以单独记一笔
 * allTimed,S3 遇到它就不成立。
 *   latestUserTs     最晚一条用户亲手发的消息(type==='user';任务通知在历史里是 task-notice,
 *                    别的会话发来的是 peer-message,都不算 —— 它们会先于还在排队的 M 存盘)
 *   latestCompactTs  最晚一条压缩条目
 *   earliestTs       最早一条的时间(配合 allTimed 回答「是否每条都晚于 T」)
 *   hasNonReply      有没有不是回复的条目
 */
export function summarizeHistoryWindow(messages, { hasMore = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let latestUserTs = null;
  let latestCompactTs = null;
  let earliestTs = null;
  let allTimed = true;
  let hasNonReply = false;
  for (const m of list) {
    const ts = parseTs(m?.timestamp);
    if (ts === null) allTimed = false;
    else if (earliestTs === null || ts < earliestTs) earliestTs = ts;
    if (m?.type !== 'turn') hasNonReply = true;
    if (ts === null) continue;
    if (m?.type === 'user' && (latestUserTs === null || ts > latestUserTs)) latestUserTs = ts;
    if (m?.type === 'compact' && (latestCompactTs === null || ts > latestCompactTs)) latestCompactTs = ts;
  }
  return { count: list.length, hasMore: !!hasMore, latestUserTs, latestCompactTs, earliestTs, allTimed, hasNonReply };
}

/** 窗口里每一条的时间都晚于 t(空窗口、有取不到时间的条目都不算)。 */
export function windowAllLaterThan(summary, t) {
  return !!summary && summary.count > 0 && summary.allTimed && summary.earliestTs !== null && summary.earliestTs > t;
}

const COMPACT_RE = /^\/compact\b/;   // 与 App.jsx 发送处 isCompact 同一条正则

/**
 * r189:按窗口证据判 M 是否已结清(S1 由调用方的 known.has 判,不在这里另写一份)。
 * 不许用「窗口里有晚于 T 的回复」:回复条目的时间是它最后一条记录的时间,一轮在 T 之前开始、
 * 还在跑的回复也晚于 T;也不许用「晚于 T 的任务通知 / 别的会话发来的消息」:M 发出途中来的通知
 * 会先被处理、先存盘,M 还在等。所以 S2 只认 type==='user',S3 必须左边还有更早的页、整页都晚于 T、
 * 且至少一条不是回复。
 */
export function settledByWindow(m, summary) {
  const t = parseTs(m?.timestamp);
  if (t === null || !summary) return false;   // 自己的时间取不到 → 只按 S1
  // S2:用户输入按发送顺序存盘,更晚的一条已存盘,更早的这条要么也存了,要么永远不会以原文存盘。
  if (summary.latestUserTs !== null && summary.latestUserTs > t) return true;
  // S3:M 发出后已经存进了整整一页,而且其中有 T 之后才接收的输入。
  if (summary.hasMore && summary.hasNonReply && windowAllLaterThan(summary, t)) return true;
  // S4:/compact 在历史里不是同文字的用户条目,而是一条压缩条目。
  if (COMPACT_RE.test(String(m?.text || '').trim())
    && summary.latestCompactTs !== null && summary.latestCompactTs >= t) return true;
  return false;
}

/**
 * 取回:已结清的 = 本地副本该撤(历史接棒,或它根本不会以原样出现在历史里),其余 = 还没落盘的(该补回)。
 * `known` 传 App.jsx 的 makePersistedIndex(...) 实例 —— 孪生口径(S1)只有一套。
 * `windowInfo` = { messages, hasMore }:已加载的历史窗口与它左边还有没有更早的页,不传时只按 S1。
 * 为什么要 S2–S4 并且记账:窗口只是最后一页,存盘已久的消息孪生在窗口外,只按 S1 会把它们
 * 一律当成没存盘、补回到对话末尾(r189 用户实报);一旦结清就记下,之后窗口怎么变都不再补回。
 * 不清掉条目(留在暂存里):分屏两个窗格看同一会话时,两边各自都要能拿到同样的 persisted;
 * 反复调用的结果幂等(补回按 uuid 去重、撤除按 uuid 过滤)。
 */
export function takePendingUserBubbles(key, known, windowInfo = null) {
  const entries = stash.get(key) || [];
  const pending = [];
  const persisted = [];
  if (!entries.length) return { pending, persisted };
  const summary = windowInfo ? summarizeHistoryWindow(windowInfo.messages, { hasMore: windowInfo.hasMore }) : null;
  let done = settled.get(key);
  for (const m of entries) {
    const isSettled = done?.has(m?.uuid) || known?.has?.(m) || settledByWindow(m, summary);
    if (isSettled) {
      if (!done) { done = new Set(); settled.set(key, done); }
      done.add(m?.uuid);
      persisted.push(m);
    } else pending.push(m);
  }
  return { pending, persisted };
}
