// R13「会话流」客户端的纯身份判定层(无 DOM、无 store 依赖,单测直调)。
// 接线:App.jsx(流式缓冲归属门控 / clientTurnId / 停止身份)、sessionStore.js(窗格代际)。
// 合同见 .devflow/INTERFACE.md「会话流与子代理(R11–R13)」:
//   · 窗格发布 paneId(稳定)/ownerKey(draft 或母 sessionId)/generation(该 owner 本轮);
//   · 新草稿绑定真实 sid 后,原 clientTurnId/generation 仍属于同轮;
//   · 不论 A 迟到的是 POST/init/delta/工具/模型/done/error 还是 finally,B 的正文与
//     运行状态都不能被写入 —— 本地条目一律按"发起时的 owner"判定可见性。

// 服务端合同:clientTurnId 为 1–64 位 [A-Za-z0-9_-](chat.js 的 CLIENT_TURN_RE 同口径)。
export const CLIENT_TURN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 一条本地产物(用户气泡 / 半截回复 / 错误气泡 / 旁问)在当前窗格是否可见。
 * - 带 ownerKey 的条目(btw、停止半截、error turn):只属于它发起时那个 owner;
 * - 不带 ownerKey 的条目(流式 turn / 用户回显):只属于"本窗格当前正在消费的那条流"。
 * A 的迟到事件写进来的条目在 B 上两条都不成立 ⇒ 永不渲染进 B。
 */
export function localEntryVisible({ ownerKey = null, streamOwnerKey = null, sessionQueueKey = null } = {}) {
  if (ownerKey) return ownerKey === sessionQueueKey;
  return !!sessionQueueKey && streamOwnerKey === sessionQueueKey;
}

/**
 * 生成一个 clientTurnId。每条用户发送一个;重试 / 响应丢失必须沿用同一个
 * (调用方持有 —— 见 resolveClientTurnId),绝不换新 id 再发。
 */
export function makeClientTurnId(nowMs, seq) {
  return `ct${Number(nowMs).toString(36)}${Number(seq).toString(36)}`;
}

/** 已有 id 就沿用(重试/重发同一条),否则新生成一个。 */
export function resolveClientTurnId(existing, nowMs, seq) {
  if (typeof existing === 'string' && CLIENT_TURN_ID_RE.test(existing)) return existing;
  return makeClientTurnId(nowMs, seq);
}

/** 该窗格的两个 owner 绑定是否算"同一轮"(决定 generation 是否轮换)。 */
export function sameOwnerRound(prev, next) {
  if (!prev && !next) return true;
  // 空窗格 → 草稿:Home(新建会话形态)发出的第一条消息就是本窗格这一轮的开端,
  // 从"还没有会话"到"draft-key"再到"真 sid"是同一轮。
  if (!prev) return !next.sessionId;
  if (!next) return false;                       // 会话 → 空(关窗格 / 新建会话)= 新一轮
  if (prev.sessionId && next.sessionId) return prev.sessionId === next.sessionId;
  // draft → 真 sid 升级:同项目、旧侧无 sid、新侧拿到 sid。
  if (!prev.sessionId && next.sessionId) return prev.projectHash === next.projectHash;
  return false;                                  // 两个不同 draft(换了 draftId)= 新一轮
}

/**
 * 需要轮换时返回新的代际数组(只改 idx 一格),同一轮返回 null(调用方不动 state)。
 * `fresh` 是取新代际 token 的函数(store 里是单调计数器)。
 */
export function rotatedPaneGenerations({ generations, idx, prev, next, fresh } = {}) {
  if (sameOwnerRound(prev, next)) return null;
  const gens = [...(generations || [])];
  gens[idx] = fresh();
  return gens;
}

/**
 * 停止请求要带的期望 owner(服务端不一致回 409 RUN_STALE,即"停失败")。只发**能证明
 * 属于这个 pid** 的身份,拿不准就返回 null,让调用方走不带字段的老路径:
 *   · 本端起流时记下的 pid+owner(activeProc/activeOwner)且 pid 仍一致 → 用记下的 owner;
 *   · 后台 pid 那条路径(poll 按 sessionId 匹配出来的)→ 用该会话 sid。
 * 绝不能拿"当前窗格的键"顶替:客户端 draft 键与服务端 slot.draftId 不同口径。
 */
export function resolveStopOwner({ pid = null, recordedPid = null, recordedOwner = null, backgroundPid = null, currentSessionId = null } = {}) {
  const target = String(pid ?? '');
  if (target && recordedPid && String(recordedPid) === target && recordedOwner) return recordedOwner;
  if (target && backgroundPid && String(backgroundPid) === target && currentSessionId) return currentSessionId;
  return null;
}
