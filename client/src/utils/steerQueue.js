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

// r80(A1):Home(未选任何会话)时顶栏模型选择器的落点键 —— 「还没建出来的那条草稿」。
// 原来这里是 null,setModelFor(null, m) 走"只改内存 currentModel"分支、零落盘,于是
// 每次启动(RESTORE_LAST_ON_BOOT 默认 false ⇒ 必落 Home)选的模型刷新即回全局默认。
//
// 为什么不是 `draft-<hash>-<draftId>`:Home 的 draftId 要到用户点发送(App.jsx submit)
// 那一刻才由 newDraftId() 领,项目也可能在选模型之后再改 —— 选模型时这两段都还不存在。
// 用一个固定的「待发」键接住,再由 submit 把它交接到真 draft 键(migrateSessionKey,
// 搬完即删源键),交接后的链路与既有 draft 完全一致:
//     HOME_DRAFT_KEY --submit--> draft-<hash>-<draftId> --init--> 真 sessionId
// 删源键这一步顺带满足"新会话不继承上一次 Home 的选择":每次 Home 选择恰好被消费一次。
// 形态保持 `draft-` 前缀:syncableKey 据此不把它推给服务端(与既有 draft 键同语义);
// 它永远不进 messageQueue,故不参与孤儿队列回收。
export const HOME_DRAFT_KEY = 'draft-home-pending';

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

// r116:「⚡ 并入」为灰的原因码 —— 判据与 firstSteerableIndex 同源(能并入即返回 null,
// 不能并入时队首卡在哪一态就报哪一态),只给 UI 说人话用,不改任何状态。
// 为什么要有它:accepted(已送进回合、等 CLI 落盘)的条目原来在队列条里不显示,队首被它
// 挡住时用户只看到"按钮是灰的",hover 却还写着"把队列里的下一条消息并入当前回合"——
// 按钮与文案互相打脸(用户实报"并入按钮有时候点不了")。
export function steerBlockReason(list) {
  if (firstSteerableIndex(list) >= 0) return null;
  const i = firstNonKeptIndex(list);
  const head = i >= 0 ? list[i] : null;
  if (head?.steerState === 'accepted') return 'accepted';
  if (head?.steerState === 'claiming') return 'claiming';
  if (head?.steerState === 'unknown') return 'unknown';
  if (head?.steerState === 'needs-review' || head?.attemptWasAmbiguous) return 'review';
  if (head?.hidden) return 'hidden';
  return 'none';
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
// r26-B3 落盘宽限:reattach/转后台中途的历史刷新会触发对账,而 CLI 落盘有 1-3s+
// 延迟(实测 p90=17.4s)—— accepted 条目的 uuid 还没来得及进 jsonl 就被翻
// needs-review(误报,且 needs-review 是 barrier 会卡死后续队列)。宽限期内保留
// accepted 原样(记 missCount 供观测),超出宽限仍缺席才翻。锚点取
// acceptedAt ?? queuedAt:旧数据无 acceptedAt,而其 queuedAt 必然老旧 → 立即翻,
// 向后兼容;reattach 期间被 stripSteerState 之外路径重建的条目也有新鲜 queuedAt 兜底。
export const RECONCILE_GRACE_MS = 20000;

// R46:「还在途」的唯一判据 —— 已被 server 接纳、UUID 还没进 jsonl、且没超出兜底宽限。
// 横幅(App.jsx finalize)与对账翻案共用它:横幅原来只看「有没有 steerId、UUID 在不在」,
// 于是 accepted(还在等落盘)的条目也被算成"无法确认"→ 成功的并入照样弹失败横幅。
export function steerStillInFlight(item, now = Date.now()) {
  if (item?.steerState !== 'accepted') return false;
  const anchor = item.acceptedAt ?? item.queuedAt;
  return Number.isFinite(anchor) && now - anchor < RECONCILE_GRACE_MS;
}

// R46 治本:turnActive = 「这个回合还活着吗」。
//   落盘的时点由 CLI 的下一个 tool_result 边界决定,不是"我点了多久"—— 隔离实例实测
//   3.3 / 6.0 / 9.6 / 11.5 / **148** 秒。所以回合没结束就没有"终局缺席"这回事:
//     true  → 一律先保留 accepted(不管多久,记 missCount 供观测);
//     false → 这是一次终局对账(回合已结束),缺席即翻 → 真失败不漏判;
//     未传  → 客户端状态不明,吃 RECONCILE_GRACE_MS 兜底宽限(旧调用点口径不变)。
export function reconcileSteered(list, _unusedSigs, steerKeys, { turnActive } = {}) {
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
    // r26-B3:accepted 且仍在落盘宽限期内 → 本轮未命中不翻(下一次刷新仍缺席才翻)。
    // R46:回合还活着(turnActive === true)→ 一直等,与宽限无关;回合已结束
    // (=== false)→ 终局对账,连宽限也不等(再挂 20s 只会让它卡在不可见的 accepted 态,
    // isSteered 的条目在队列栏里是不显示的,用户既看不到也拿不回)。
    if (item.steerState === 'accepted') {
      if (turnActive === true || (turnActive !== false && steerStillInFlight(item))) {
        changed = true;
        out.push({ ...item, missCount: (item.missCount || 0) + 1 });
        continue;
      }
    }
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
// r26-B2 文本优先级:
//   · 无附件 → draft.text(用户在取回窗格里的最新编辑,非空时)优先于 draft.queueText
//     (原始出站文本)——孤儿回收/复位不得丢用户编辑;
//   · 有 attachments → 发送文本恒取 queueText:该形态下 draft.text 是 displayText
//     展示文本,当发送文本还原会把展示文本发进会话;draft.text 只回填 displayText;
//   · opts.discardEdits(releaseClaimDraft「用户显式清空输入框=放弃这次编辑」)→
//     恒还原 queueText 原文,编辑文本随清空动作一并放弃。
export function reclaimClaimItem(item, opts = {}) {
  if (!item || (!item.claimDraft && item.steerState !== 'claiming')) return item;
  const draft = item.claimDraft || null;
  const { claimId, targetPaneId, claimDraft, hidden, ...rest } = item;
  void claimId; void targetPaneId; void claimDraft; void hidden;
  const restored = { ...rest, steerState: 'needs-review', attemptWasAmbiguous: true };
  if (draft) {
    const hasAttachments = Array.isArray(draft.attachments) && draft.attachments.length > 0;
    const queueText = typeof draft.queueText === 'string' && draft.queueText ? draft.queueText : null;
    const editedText = typeof draft.text === 'string' && draft.text ? draft.text : null;
    if (opts.discardEdits || hasAttachments) {
      if (queueText) restored.text = queueText;
      else if (!restored.text && editedText) restored.text = editedText;
    } else if (editedText) {
      restored.text = editedText;
    } else if (queueText) {
      restored.text = queueText;
    }
    if (typeof draft.sourceQueueId === 'string' && draft.sourceQueueId) restored.queueId = draft.sourceQueueId;
    if (typeof draft.steerId === 'string' && draft.steerId) restored.steerId = draft.steerId;
    if (hasAttachments) {
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
      // R46 ③:accepted 是「已送达、只等 UUID 落盘」的在途态，不是未决残留 —— 页面重载
      // 不改变它。原来无条件翻 needs-review 等于每次重载都把在途并入判死（落盘要等下一个
      // tool_result 边界，重载几乎必然落在窗口内 = 用户命中的入口 1）。原样保留
      // steerId/acceptedAt，交给宽限/回合存活判据；真失败仍会被终局对账翻掉。
      if (item?.steerState === 'accepted') return item;
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
