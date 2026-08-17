const BARRIER_STATES = new Set(['unknown', 'accepted', 'needs-review', 'claiming']);

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

// 页面恢复后没有原 slot receipt；任何 unresolved 都先成为人工复核 barrier。
export function stripSteerState(queueMap) {
  if (!queueMap || typeof queueMap !== 'object') return {};
  const out = {};
  for (const [sessionKey, list] of Object.entries(queueMap)) {
    if (!Array.isArray(list)) continue;
    out[sessionKey] = list.map((item) => {
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
