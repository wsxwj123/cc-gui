const BARRIER_STATES = new Set(['unknown', 'accepted', 'needs-review', 'claiming']);

// r26-B5:队列/pin/owner 键的单一构造点。draft 键必须带 draftId——旧形态
// `draft-<projectHash>` 让同项目两个 draft 窗格共用一个队列(A 排队、B 的 drain 发出),
// 且 draft→真 sid 迁移会把共享队列整个并进先 init 的一方。新形态:
//   真会话 → sessionId;draft → `draft-<projectHash>-<draftId>`。
// draftId 缺失(理论上的旧版残留 draft)落到 '-none' 尾段:宁可键相异失败安全,
// 也绝不回到共享键。所有裸模板串一律改调本函数,杜绝口径再裂。
export function queueKeyFor(sel) {
  if (sel && sel.sessionId) return sel.sessionId;
  return `draft-${sel?.projectHash || 'none'}-${sel?.draftId || 'none'}`;
}

// draft 队列键判定与 projectHash 段解析(孤儿回收按项目过滤用)。
// draftId 形态恒为 `d<ts>-<seq>`(App.jsx newDraftId),据此从新形态键里剥出 hash;
// 剥不掉的按旧形态 `draft-<hash>` 整段当 hash(旧键只会进孤儿表,归属不再猜测)。
export function isDraftQueueKey(key) {
  return typeof key === 'string' && key.startsWith('draft-');
}
export function draftQueueProjectHash(key) {
  if (!isDraftQueueKey(key)) return null;
  const rest = key.slice('draft-'.length);
  const m = rest.match(/^(.*)-d\d+-\d+$/);
  return (m ? m[1] : rest) || 'none';
}

export function createQueueId(prefix = 'queue') {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function isSteerBarrier(item) {
  return !!(item && (BARRIER_STATES.has(item.steerState) || item.attemptWasAmbiguous));
}

// 只有已被 server 明确接纳、仍等待 JSONL UUID 对账的条目才画实时并入气泡。
export function isSteered(item) {
  return !!(item?.steerId && item.steerState === 'accepted');
}

// ①'kept' = 用户显式决定"保留不发"：已 resolved，非 barrier；drain/steer 都跳过它
// （不自动发送），也不拦它后面的条目（不拦队列）。
const firstNonKeptIndex = (list) => {
  if (!Array.isArray(list)) return -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.steerState !== 'kept') return i;
  }
  return -1;
};

// FIFO 只看（跳过 kept 后的）队首。任何 unresolved 条目都是 barrier，绝不能越过它发送后项。
export function firstDrainableIndex(list) {
  const i = firstNonKeptIndex(list);
  if (i < 0) return -1;
  const head = list[i];
  return head?.text && !isSteerBarrier(head) ? i : -1;
}

export function firstSteerableIndex(list) {
  const i = firstNonKeptIndex(list);
  if (i < 0) return -1;
  const head = list[i];
  return head?.text && !head.hidden && !isSteerBarrier(head) ? i : -1;
}

// 两种已验证落盘形态：真 user.uuid，或 reader 合成 queued_command.source_uuid 后的 steerUuid。
export function persistedSteerKeys(persisted) {
  const out = new Set();
  for (const message of (Array.isArray(persisted) ? persisted : [])) {
    if (message?.type !== 'user') continue;
    if (typeof message.uuid === 'string' && message.uuid) out.add(message.uuid.toLowerCase());
    if (typeof message.steerUuid === 'string' && message.steerUuid) out.add(message.steerUuid.toLowerCase());
  }
  return out;
}

export function steerLanded(item, _unusedSigs, steerKeys) {
  if (!item?.steerId || !steerKeys?.has) return false;
  return steerKeys.has(String(item.steerId).toLowerCase());
}

// 收尾只接受 UUID 正向证明。未命中不等于“未消费”，因此转 needs-review 而非 queued。
export function reconcileSteered(list, _unusedSigs, steerKeys) {
  if (!Array.isArray(list) || !list.length) return list;
  if (!list.some((item) => isSteerBarrier(item) || item?.steerId)) return list;
  let changed = false;
  const out = [];
  for (const item of list) {
    if (!isSteerBarrier(item) && !item?.steerId) { out.push(item); continue; }
    if (steerLanded(item, null, steerKeys)) { changed = true; continue; }
    // ①用户已决定"保留不发"：除 UUID 正向命中（上一行，说明其实已送达，条目清掉）外，
    // 对账不得把它翻回 needs-review barrier——那会复活刚被用户解开的死锁。
    if (item.steerState === 'kept') { out.push(item); continue; }
    if (item.steerState === 'needs-review') { out.push(item); continue; }
    changed = true;
    const { claimId, targetPaneId, claimDraft, ...rest } = item;
    void claimId; void targetPaneId; void claimDraft;
    out.push({ ...rest, steerState: 'needs-review', attemptWasAmbiguous: true });
  }
  return changed ? out : list;
}

// ②claim 残留（claiming 中间态 / hidden sendable 槽）复位为可见 needs-review 原条目。
// hidden 槽在 finalize 时丢了原文本与附件（收进 claimDraft），这里按 claimDraft 还原；
// steerId 一并还原，让后续对账的 UUID 正向命中仍能自动清掉"其实已送达"的条目。
export function reclaimClaimItem(item) {
  if (!item || (!item.claimDraft && item.steerState !== 'claiming')) return item;
  const draft = item.claimDraft || null;
  const { claimId, targetPaneId, claimDraft, hidden, ...rest } = item;
  void claimId; void targetPaneId; void claimDraft; void hidden;
  const restored = { ...rest, steerState: 'needs-review', attemptWasAmbiguous: true };
  if (draft) {
    if (typeof draft.queueText === 'string' && draft.queueText) restored.text = draft.queueText;
    else if (!restored.text && typeof draft.text === 'string') restored.text = draft.text;
    if (typeof draft.sourceQueueId === 'string' && draft.sourceQueueId) restored.queueId = draft.sourceQueueId;
    if (typeof draft.steerId === 'string' && draft.steerId) restored.steerId = draft.steerId;
    if (Array.isArray(draft.attachments) && draft.attachments.length) {
      restored.opts = {
        ...(restored.opts || {}),
        meta: { ...(restored.opts?.meta || {}), attachments: draft.attachments, displayText: draft.text || '' },
      };
    }
  }
  return restored;
}

// 页面恢复后没有原 slot receipt；任何 unresolved 都先成为人工复核 barrier。
// ②claim 残留（不论目标 pane 是否还在——pane id 计数器重启后重置，跨重启一律悬空）
// 全部复位为可见 needs-review，绝不留 hidden 阻塞槽。
export function stripSteerState(queueMap) {
  if (!queueMap || typeof queueMap !== 'object') return {};
  const out = {};
  for (const [sessionKey, list] of Object.entries(queueMap)) {
    if (!Array.isArray(list)) continue;
    out[sessionKey] = list.map((item) => {
      if (item?.claimDraft || item?.steerState === 'claiming') return reclaimClaimItem(item);
      if (!isSteerBarrier(item) && !item?.steerId) return item;
      // ①"保留不发"是用户决定，跨重启保持，不翻回 needs-review。
      if (item?.steerState === 'kept') return item;
      const { claimId, targetPaneId, claimDraft, ...rest } = item;
      void claimId; void targetPaneId; void claimDraft;
      return { ...rest, steerState: 'needs-review', attemptWasAmbiguous: true };
    });
  }
  return out;
}

// 旧测试/调用点只需要一个不可用于自动删除的签名容器；保留导出避免扩大改动面。
export function persistedUserSigs() { return new Map(); }
export function steerSig(text) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
export function sigLanded() { return false; }
export const STEER_LAND_TOLERANCE_MS = 1000;
