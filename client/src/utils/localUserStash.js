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
const stash = new Map();

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
  for (const m of entries) byUuid.set(m.uuid, m);
  stash.delete(key);            // 重新插入,刷新它在 Map 里的 LRU 位置
  stash.set(key, [...byUuid.values()]);
  while (stash.size > STASH_CAP) stash.delete(stash.keys().next().value);
}

/** 草稿拿到真 sid:draft 键下的暂存改挂到真 sid(幂等,旧键空则不动)。 */
export function migrateUserStash(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const entries = stash.get(fromKey);
  if (!entries?.length) return;
  stash.delete(fromKey);
  stashUserBubbles(toKey, entries);
}

/** 丢弃某会话的暂存(回滚把尾部从 jsonl 裁掉后,暂存副本已不代表现实)。 */
export function dropUserStash(key) {
  if (key) stash.delete(key);
}

/**
 * 取回:历史里出现的 = 已落盘(本地副本该撤),其余 = 还没落盘的(该补回)。
 * `known` 传 App.jsx 的 makePersistedIndex(...) 实例 —— 身份口径只有一套。
 * 不清账(条目留在暂存里):分屏两个窗格看同一会话时,两边各自都要能拿到自己那份;
 * 反复调用的结果幂等(补回按 uuid 去重、撤除按 uuid 过滤)。
 */
export function takePendingUserBubbles(key, known) {
  const entries = stash.get(key) || [];
  const pending = [];
  const persisted = [];
  for (const m of entries) (known?.has?.(m) ? persisted : pending).push(m);
  return { pending, persisted };
}
