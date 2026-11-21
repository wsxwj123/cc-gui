// r196:后台排空(下称 BD)。页面里全应用一份,只管「当前没有任何挂载窗格在排空它」的会话:这一轮真正结束后(共用轮询里
// 这个会话没有在跑的进程),把排队栏队首那条直接 POST /api/chat 发出(带 queuedDrain:true),不接流;用户回到会话时由窗格
// 现有的接流 / 读历史接上。窗格显示着的会话仍由窗格现有三处排空负责。方案见 .devflow 任务文件「方案 v2」第 1、2 节。
// 依赖全部经 createBackgroundDrainer(deps) 注入(写法照 agentsActivePoller.js),不读任何窗格状态:会话编号恒为队列键,
// 工作区路径取入队快照 owner.cwd,模型 / 权限 / 强度按会话从状态库取(见 buildBgChatRequest)。
import { createQueueId, firstDrainableIndex, isDraftQueueKey, withoutBgSendFields } from './steerQueue.js';
import { AUTO_DOWNGRADE_NOTICE, buildChatRequestBody } from './chatRequest.js';
import { gateHistModel } from './routing.js';

// ── 共享登记:窗格 / 流收尾 / 回退写,BD 读。登记一律返回幂等的注销函数(放 finally / 副作用清理)。─────────────
const paneDrains = new Map();  // 会话键 → 挂载着的窗格排空者个数
const paneEpochs = new Map();  // 会话键 → 登记代数;每次登记 +1,BD 记在退避上,代数变了退避作废(窗格接管)
export function registerPaneDrain(key) {
  if (!key) return () => {};
  paneDrains.set(key, (paneDrains.get(key) || 0) + 1);
  paneEpochs.set(key, (paneEpochs.get(key) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (paneDrains.get(key) || 0) - 1;
    if (n > 0) paneDrains.set(key, n); else paneDrains.delete(key);
  };
}
export const paneDrainRegistered = (key) => paneDrains.has(key);
const paneEpochOf = (key) => paneEpochs.get(key) || 0;

const finalizing = new Map(); // 会话键 → 进行中的流收尾个数
/** 流收尾开始。返回注销函数;注销函数上的 add(key) 把 init 拿到的正式编号追加进同一登记(一并注销)。 */
export function beginFinalizing(keys) {
  const held = new Set();
  let done = false;
  const add = (key) => {
    if (done || !key || held.has(key)) return;
    held.add(key);
    finalizing.set(key, (finalizing.get(key) || 0) + 1);
  };
  for (const k of (Array.isArray(keys) ? keys : [keys])) add(k);
  const end = () => {
    if (done) return;
    done = true;
    for (const k of held) {
      const n = (finalizing.get(k) || 0) - 1;
      if (n > 0) finalizing.set(k, n); else finalizing.delete(k);
    }
  };
  end.add = add;
  return end;
}
export const isFinalizing = (key) => finalizing.has(key);

// 回退令牌:回退流程各出口清;卸载后回退仍在后台继续,所以不随窗格卸载清,靠 2 分钟过期兜底。
export const ROLLBACK_TOKEN_TTL_MS = 120_000;
const rollbackTokens = new Map(); // 会话键 → 登记时刻
export function setRollbackBusy(key, now = Date.now()) { if (key) rollbackTokens.set(key, now); }
export function clearRollbackBusy(key) { rollbackTokens.delete(key); }
export function isRollbackBusy(key, now = Date.now()) {
  const at = rollbackTokens.get(key);
  if (at === undefined) return false;
  if (now - at >= ROLLBACK_TOKEN_TTL_MS) { rollbackTokens.delete(key); return false; }
  return true;
}

/** BD 受理过的进程号(会话键 → Set<pid>)。窗格回到会话时据此补拉一次历史,拉过即删。 */
export const bgAcceptedPids = new Map();
export function noteBgAcceptedPid(key, pid) {
  if (!key || pid == null || pid === '') return;
  if (!bgAcceptedPids.has(key)) bgAcceptedPids.set(key, new Set());
  bgAcceptedPids.get(key).add(String(pid));
}

// ── 纯函数 ───────────────────────────────────────────────────────────────────────────
const isChatProc = (p) => p?.kind === 'chat-process';
const agentsOf = (data) => (Array.isArray(data?.agents) ? data.agents : []);

/** 共用轮询结果里,会话 key 有没有在跑的进程。初始化中、续跑复活、输入预测收尾窗、被停那一段都算在跑;已退出、空闲不算。 */
export function isSessionBusy(items, key) {
  return (Array.isArray(items) ? items : []).some((p) => isChatProc(p) && p.sessionId === key && p.stoppable === true && p.status !== 'idle');
}

/**
 * 会话本身此刻不许后台发的三种情形(发出前复核与 POST 之前各判一次,同一判据):正在删除、交给手机远程控制、
 * Provider 与这个会话上次发送时不同(要先剥思考块,交给窗格)。能发 → null。
 */
export function bgSessionBlockReason(key, input = {}) {
  if (input.pendingDelete?.has?.(key)) return 'deleting';
  if (input.remoteControlled?.[key]) return 'remote';
  const lastProv = input.lastProviderBySession?.[key];
  if (lastProv && lastProv !== (input.currentProviderHint || 'anthropic')) return 'provider-changed';
  return null;
}

/**
 * 会话 key 此刻能不能由 BD 发出队首;能 → null,不能 → 原因码。input:
 * { queues, items, runId, now, inFlight(Map), nextTryAt(Map key→{at,epoch}), pendingDelete(Set), remoteControlled,
 *   lastProviderBySession, currentProviderHint, largeAsk(Map key→{epoch}:拍快照时目录太大、要先问用户的会话) }
 */
export function bgDrainBlockReason(key, input = {}) {
  if (isDraftQueueKey(key)) return 'draft';
  const list = input.queues?.[key];
  const i = firstDrainableIndex(list, input.now);
  if (i < 0) return 'no-head';
  const head = list[i];
  if (head.runId !== input.runId) return 'other-run';      // 刷新 / 重启之前遗留的:不在后台发
  if (head.hidden) return 'hidden';                        // 计划续跑 / 跨会话卡片「处理」:等用户回到会话
  if (!head.owner?.cwd) return 'no-owner';                 // 没有入队快照(取不到工作区路径)
  if (paneDrainRegistered(key)) return 'pane';
  if (isFinalizing(key)) return 'finalizing';
  if (isRollbackBusy(key, input.now)) return 'rollback';
  const sessionBlock = bgSessionBlockReason(key, input);
  if (sessionBlock) return sessionBlock;
  const la = input.largeAsk?.get?.(key);
  if (la && la.epoch === paneEpochOf(key)) return 'large-snapshot'; // 目录太大、要先问用户:交给窗格(窗格接管时作废)
  if (input.inFlight?.has?.(key)) return 'in-flight';
  const nt = input.nextTryAt?.get?.(key);
  if (nt && nt.epoch === paneEpochOf(key) && nt.at > input.now) return 'backoff';
  if (isSessionBusy(input.items, key)) return 'busy';
  return null;
}

/** 这一拍可以发的会话:[{ key, index, item }](同一会话最多一条)。 */
export function pickBgDrainTargets(input = {}) {
  const out = [];
  for (const key of Object.keys(input.queues || {})) {
    if (bgDrainBlockReason(key, input) !== null) continue;
    const index = firstDrainableIndex(input.queues[key], input.now);
    out.push({ key, index, item: input.queues[key][index] });
  }
  return out;
}

/**
 * 应答分类(方案 2.5)。phase:'first' 首发 / 'resend' 结果不明后同号重发(含 504 后的查询)。返回:
 * accepted / start-timeout / busy / gone / failed / retryable / server-changed / ambiguous(结果不明)/ unknown(重发阶段的
 * TURN_*:可能说明首个请求已被收下,直接复核)。
 */
export function classifyBgSendResponse(phase, status, body, networkError = false) {
  const resend = phase === 'resend';
  if (networkError || !body || typeof body !== 'object' || Array.isArray(body)) return 'ambiguous';
  const code = typeof body.code === 'string' ? body.code : '';
  const hasPid = body.pid != null && body.pid !== '';
  if (status === 200) return hasPid ? 'accepted' : 'ambiguous';
  if (status === 504 && code === 'CHAT_START_TIMEOUT') return hasPid ? 'start-timeout' : 'ambiguous';
  if (status === 409 && code === 'CHAT_SESSION_BUSY') return 'busy';
  if (status === 404 && code === 'CHAT_SESSION_GONE') return 'gone';
  if (status === 409 && code === 'TURN_SERVER_CHANGED') return resend ? 'unknown' : 'server-changed';
  if (status === 409 && (code === 'TURN_CONFLICT' || code === 'TURN_EXPIRED')) return resend ? 'unknown' : 'failed';
  if ((status === 500 && code === 'CHAT_START_FAILED') || (status === 503 && code === 'TURN_CAPACITY')) return 'retryable';
  if (status >= 400 && status < 500) return 'failed';
  return 'ambiguous'; // 5xx 没有 code、认不出的状态
}

// 退避(只在 BD 内存,条目上不写):会话忙 2/4/8/16/30 秒;可重试 5/15/45 秒(第 4 次转复核);结果不明 3/10 秒(再不明转复核)。
const BACKOFF = { busy: [2000, 4000, 8000, 16000, 30000], retryable: [5000, 15000, 45000], ambiguous: [3000, 10000] };
export const BG_RETRYABLE_MAX = BACKOFF.retryable.length;
export const BG_AMBIGUOUS_RESENDS = BACKOFF.ambiguous.length;
export function backoffMs(category, attempt) {
  const steps = BACKOFF[category] || BACKOFF.busy;
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  return steps[Math.min(n, steps.length) - 1];
}

export const BG_INTERRUPTED_TEXT = '这条在自动发出时被打断（网络中断、页面刷新或服务重启），不能确定是否已经发出；请先查看会话记录，再决定重发或删除。';
/** 复核原因(holdReason.code / detail)→ 排队栏文案。认不出的原因码按「结果不明」说。 */
export function holdReasonText(code, detail) {
  const d = typeof detail === 'string' ? detail : '';
  switch (code) {
    case 'failed': return `自动发送没有成功：${d}`;
    case 'retries-exhausted': return `自动发送没有成功（已重试 3 次）：${d}`;
    case 'turn-incomplete': return '自动发出的这一轮没有完成；请先查看会话记录，再决定重发或删除。';
    case 'session-mismatch': return '自动发出后会话编号对不上；请先查看会话记录。';
    default: return BG_INTERRUPTED_TEXT;
  }
}

/** 后台发出时的权限档:这个会话单独设过就用它;没设过按「逐步确认」(不回落全局默认,无人在场时不放大宽档)。 */
export function resolveBgPermissionMode(permissionModeBySession, key) {
  const m = permissionModeBySession?.[key];
  return typeof m === 'string' && m ? m : 'default';
}

/** 历史模型:入队快照里那条消息按当时的 providerEpoch 门控;快照为空(会话第一轮)时用轮询结果里该会话进程的 model(进程早于 epoch 不用)。 */
export function resolveBgHistModel({ histMsg, items, key, providerEpoch = 0, officialAnthropic = false } = {}) {
  if (histMsg) return gateHistModel(histMsg, providerEpoch, officialAnthropic);
  const proc = (Array.isArray(items) ? items : []).find((p) => isChatProc(p) && p.sessionId === key && p.model);
  if (!proc) return null;
  if (providerEpoch && !(Number(proc.startedAt) >= providerEpoch)) return null;
  return proc.model;
}

/** 组后台发送的请求体:与窗格同一个 buildChatRequestBody,只多 queuedDrain:true。state = 状态库此刻的状态。 */
export function buildBgChatRequest({ key, item, state, items, serverEpoch, clientTurnId } = {}) {
  const st = state || {};
  const official = (st.currentProvider?.providerHint || 'anthropic') === 'anthropic';
  const text = String(item?.text ?? '');
  const built = buildChatRequestBody({
    prompt: text, clientTurnId, serverEpoch, sessionId: key, cwd: item?.owner?.cwd,
    isCompact: /^\/compact\b/.test(text.trim()), appendSystemPrompt: item?.opts?.appendSystemPrompt, agent: '',
    permissionMode: resolveBgPermissionMode(st.permissionModeBySession, key),
    autoAuditStatus: st.autoAuditStatus, providerHint: st.currentProvider?.providerHint,
    modelPin: st.modelBySession?.[key],
    histModel: resolveBgHistModel({ histMsg: item?.owner?.histMsg, items, key, providerEpoch: st.providerEpoch || 0, officialAnthropic: official }),
    globalModel: st.currentModel, availableModels: st.availableModels, customModels: st.customModels, officialAnthropic: official,
    context1m: st.context1mBySession?.[key],
    effort: typeof st.getEffortFor === 'function' ? st.getEffortFor(key) : undefined,
    modelEffortMeta: st.modelEffortMeta,
    addDirs: st.addDirs, globalRead: st.globalRead, keepAlive: st.persistentChat, maxBudgetUsd: st.maxBudgetUsd,
    promptSuggestions: st.promptSuggestions, genui: st.genuiRender,
  });
  return { body: { ...built.body, queuedDrain: true }, autoDowngraded: built.autoDowngraded, model: built.model };
}

export { AUTO_DOWNGRADE_NOTICE }; // 降档提示与窗格共用 chatRequest.js 里那一份
const DRAFT_ID_RE = /-(d\d+-\d+)$/;

// ── 控制器 ───────────────────────────────────────────────────────────────────────────
/**
 * deps:subscribe(cb)→退订函数(共用轮询)、fetchFresh()→Promise<data>、store(getState)、runId、
 * postChat(body, {signal})→Promise<{status, body}>(网络错误时 reject;body 不是 JSON 给 null)、
 * getServerEpoch()、clearServerEpoch()、now、setTimer / clearTimer、newTurnId、
 * preflightSnapshot(payload)→{send, sha}(largeSnapshot.bgPreflightLargeSnapshot)、persistAttachmentSidecar(args)、leaveNotice(key, text)、onTurnStarted(key, info)、
 * onTurnAccepted(key, 应答, notify)、promoteDraftArtifacts(草稿键, sid);requestTimeoutMs、fallbackTimeoutMs、queryGapMs。
 */
export function createBackgroundDrainer(deps = {}) {
  const {
    subscribe, fetchFresh, store, runId, postChat,
    getServerEpoch = async () => null, clearServerEpoch = () => {},
    now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
    newTurnId = () => `bg-${createQueueId('t')}`,
    preflightSnapshot = null, persistAttachmentSidecar = null,
    leaveNotice = () => {}, onTurnStarted = null, onTurnAccepted = null, promoteDraftArtifacts = null,
    requestTimeoutMs = 45_000, fallbackTimeoutMs = 120_000, queryGapMs = 5_000,
  } = deps;
  const st = () => store.getState();
  const inFlight = new Map();    // 会话键 → { queueId, abort }:同一会话同一时刻最多一条
  const nextTryAt = new Map();   // 会话键 → { at, epoch }
  const attempts = new Map();    // `键\0queueId\0类别` → { n, epoch }
  const bodies = new Map();      // queueId → 请求体(同号同体重发、504 后的查询)
  const lastQueryAt = new Map(); // queueId → 上次 504 查询时刻
  const largeAsk = new Map();    // 会话键 → { epoch }:拍快照时目录太大、这个会话还没就大目录做过选择(等窗格接管后弹窗)
  const timers = new Set();
  const sleepers = new Set();
  const pending = new Set();
  let unsubscribe = null;
  let stopped = true;
  let gen = 0; // 每次 start 加一:stop 之后还没走完的旧异步链据此作废,不再动条目
  const live = (g) => !stopped && g === gen;

  // 占位要在异步链开始之前登记(同一拍、下一拍都不会再选中这个会话);用 token 认自己的占位,stop 清掉后旧链收尾不误删新的。
  const track = (key, queueId, start) => {
    const token = {};
    inFlight.set(key, { queueId, abort: null, token });
    const p = Promise.resolve().then(() => start(gen)).catch(() => {}).finally(() => {
      pending.delete(p);
      if (inFlight.get(key)?.token === token) inFlight.delete(key);
    });
    pending.add(p);
  };
  const sleep = (ms) => new Promise((resolve) => {
    const done = () => { sleepers.delete(done); timers.delete(t); resolve(); };
    sleepers.add(done);
    const t = setTimer(done, ms);
    timers.add(t);
  });
  const countKey = (key, queueId, cat) => `${key}\0${queueId}\0${cat}`;
  const peek = (key, queueId, cat) => {
    const e = attempts.get(countKey(key, queueId, cat));
    return e && e.epoch === paneEpochOf(key) ? e.n : 0;
  };
  const bump = (key, queueId, cat) => {
    const n = peek(key, queueId, cat) + 1;
    attempts.set(countKey(key, queueId, cat), { n, epoch: paneEpochOf(key) });
    return n;
  };
  const forget = (key, queueId) => {
    for (const k of [...attempts.keys()]) if (k.startsWith(`${key}\0${queueId}\0`)) attempts.delete(k);
    bodies.delete(queueId);
    lastQueryAt.delete(queueId);
  };
  const reasonOf = (res) => (typeof res?.body?.error === 'string' && res.body.error) || `HTTP ${res?.status || 0}`;
  const inputFor = (items, t) => {
    const s = st();
    return {
      queues: s.messageQueue || {}, items, runId, now: t, inFlight, nextTryAt,
      pendingDelete: s.pendingDeleteSessions, remoteControlled: s.remoteControlled,
      lastProviderBySession: s.lastProviderBySession, currentProviderHint: s.currentProvider?.providerHint, largeAsk,
    };
  };

  function review(key, queueId, code, detail) {
    st().settleBgSend(key, queueId, { kind: 'review', code, detail });
    forget(key, queueId);
  }
  function release(key, queueId, cat) {
    st().settleBgSend(key, queueId, { kind: 'release' });
    bodies.delete(queueId);
    const n = bump(key, queueId, cat);
    nextTryAt.set(key, { at: now() + backoffMs(cat, n), epoch: paneEpochOf(key) });
  }
  function removeAccepted(key, queueId, pid) {
    st().removeFromQueueById(key, queueId, { expectBgSending: true });
    forget(key, queueId);
    nextTryAt.delete(key);
    noteBgAcceptedPid(key, pid);
  }
  // 会话文件不在(404)或草稿第一条失败:这个键的排队(隐藏项除外)移进首页「未发出的消息」;存不进就把已移的取回、原样留着。
  function moveQueueToOrphans(key) {
    const s = st();
    const list = Array.isArray(s.messageQueue?.[key]) ? s.messageQueue[key] : [];
    const moved = [];
    for (const it of list) {
      if (!it || it.hidden) continue;
      const { steerState, holdReason, attemptWasAmbiguous, ...clean } = withoutBgSendFields(it);
      void steerState; void holdReason; void attemptWasAmbiguous;
      if (!s.addOrphanDraftMessage(key, it.owner?.projectHash || null, clean)) {
        for (const qid of moved) s.takeOrphanDraftMessage(key, qid);
        return false;
      }
      moved.push(clean.queueId);
    }
    s.clearQueue(key);
    for (const it of list) if (it?.queueId) forget(key, it.queueId);
    return true;
  }

  async function post(key, body) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const rec = inFlight.get(key);
    if (rec) rec.abort = ctl;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => { try { ctl?.abort(); } catch {} resolve({ networkError: true }); }, requestTimeoutMs);
      timers.add(timer);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => postChat(body, { signal: ctl?.signal })).then(
          (r) => ({ status: Number(r?.status) || 0, body: r?.body && typeof r.body === 'object' ? r.body : null }),
          () => ({ networkError: true }),
        ),
        timeout,
      ]);
    } finally { clearTimer(timer); timers.delete(timer); }
  }

  async function accept(key, queueId, json, g) {
    const pid = String(json.pid);
    st().settleBgSend(key, queueId, { kind: 'accepted', pid });
    try { onTurnAccepted?.(key, json, (text) => leaveNotice(key, text)); } catch {}
    let fresh = null;
    try { fresh = await fetchFresh(); } catch { return; } // 确认不了:保持在途(带 bgAcceptedPid),兜底超时移除
    if (!live(g)) return;
    const proc = agentsOf(fresh).find((p) => isChatProc(p) && String(p.pid) === pid);
    if (proc?.sessionId && proc.sessionId !== key) { review(key, queueId, 'session-mismatch'); return; }
    removeAccepted(key, queueId, pid);
  }

  async function deliver(key, queueId, body, phase, resends, g) {
    const res = await post(key, body);
    if (!live(g)) return;
    switch (classifyBgSendResponse(phase, res.status, res.body, res.networkError)) {
      case 'accepted': return accept(key, queueId, res.body, g);
      case 'start-timeout': st().settleBgSend(key, queueId, { kind: 'accepted', pid: res.body.pid, startTimedOut: true }); return;
      case 'busy': release(key, queueId, 'busy'); return;
      case 'gone': if (!moveQueueToOrphans(key)) review(key, queueId, 'failed', reasonOf(res)); return;
      case 'failed': review(key, queueId, 'failed', reasonOf(res)); return;
      case 'retryable':
        if (peek(key, queueId, 'retryable') + 1 > BG_RETRYABLE_MAX) review(key, queueId, 'retries-exhausted', reasonOf(res));
        else release(key, queueId, 'retryable');
        return;
      case 'server-changed': {
        try { clearServerEpoch(); } catch {}
        let epoch = null;
        try { epoch = await getServerEpoch(); } catch {}
        if (!live(g)) return;
        const next = { ...body, serverEpoch: epoch || undefined };
        bodies.set(queueId, next);
        return deliver(key, queueId, next, 'resend', resends, g);
      }
      case 'unknown': review(key, queueId, 'interrupted'); return;
      default: {
        if (resends >= BG_AMBIGUOUS_RESENDS) { review(key, queueId, 'interrupted'); return; }
        await sleep(backoffMs('ambiguous', resends + 1));
        if (!live(g)) return;
        return deliver(key, queueId, body, 'resend', resends + 1, g);
      }
    }
  }

  async function sendOne(key, queueId, g) {
    let fresh;
    try { fresh = await fetchFresh(); } catch { return; }
    if (!live(g)) return;
    const items = agentsOf(fresh);
    const t = now();
    // 复核:用「调用之后才发出」的那份结果再判一次(自己的占位不算在途)
    if (bgDrainBlockReason(key, { ...inputFor(items, t), inFlight: null }) !== null) return;
    const list = st().messageQueue?.[key] || [];
    if (list[firstDrainableIndex(list, t)]?.queueId !== queueId) return;
    const bgTurnId = newTurnId();
    const marked = st().markBgSending(key, queueId, { bgTurnId, bgStartedAt: t });
    if (!marked) return; // 写不进 / 已不是可发的队首:这一拍放弃
    // 文件快照(与窗格同一个 POST /api/checkpoints,不弹窗):目录太大、这个会话还没做过选择 → 先不在后台发,条目退回原位
    // (不记退避),记下原因;用户回到会话时由窗格按现有流程弹窗。拍到与否都不挡发送(请求失败静默)。
    if (preflightSnapshot) {
      let snap = null;
      try {
        snap = await preflightSnapshot({
          sessionId: key, cwd: marked.owner?.cwd, label: `before: ${String(marked.text).slice(0, 60)}`,
          clientMessageId: bgTurnId, messageTimestamp: new Date(t).toISOString(), promptPreview: marked.text,
        });
      } catch { snap = null; }
      if (!live(g)) return;
      if (snap && snap.send === false) {
        st().settleBgSend(key, queueId, { kind: 'release' });
        largeAsk.set(key, { epoch: paneEpochOf(key) });
        return;
      }
    }
    try { onTurnStarted?.(key, { sessionId: key }); } catch {}
    const meta = marked.opts?.meta;
    // 附件旁注:后台发出的这条没有本地气泡,卡片只能从旁注读回 —— 先写旁注(最多等 5 秒)再发,这条一出现在会话记录里
    // 就带着卡片;写不成不挡发送(发件箱自己会重试)。
    if (persistAttachmentSidecar && Array.isArray(meta?.attachments) && meta.attachments.length) {
      let written = null;
      try {
        written = Promise.resolve(persistAttachmentSidecar({
          ownerKey: null, sessionId: key,
          payload: { messageId: bgTurnId, text: marked.text, attachments: meta.attachments, displayText: meta.displayText || '' },
        })).catch(() => {});
      } catch {}
      if (written) await Promise.race([written, sleep(5000)]);
      if (!live(g)) return;
    }
    let serverEpoch = null;
    try { serverEpoch = await getServerEpoch(); } catch {}
    if (!live(g)) return;
    // F2:拍快照、写附件旁注、取实例号这几段等待之后,POST 之前再判一次远程控制 / 正在删除 / Provider(同一判据);
    // 不通过就退回普通排队(不算失败、不写原因),与发出前复核不通过时一样。
    if (bgSessionBlockReason(key, inputFor(items, now())) !== null) {
      st().settleBgSend(key, queueId, { kind: 'release' });
      return;
    }
    const req = buildBgChatRequest({ key, item: marked, state: st(), items, serverEpoch, clientTurnId: bgTurnId });
    if (req.autoDowngraded) {
      try { st().setPermissionMode('default', key); } catch {}
      leaveNotice(key, AUTO_DOWNGRADE_NOTICE);
    }
    bodies.set(queueId, req.body);
    await deliver(key, queueId, req.body, 'first', 0, g);
  }

  // 504 之后:那个进程不在跑了才用同号同体再发一次当查询(命中记录 → 回同一 pid 与回合终态)。
  async function queryStartTimedOut(key, queueId, body, g) {
    const res = await post(key, body);
    if (!live(g)) return;
    if (res.status === 200 && res.body?.duplicated === true && res.body.pid != null) {
      const status = res.body.status;
      if (status === 'completed') removeAccepted(key, queueId, String(res.body.pid));
      else if (status === 'failed' || status === 'stopped') review(key, queueId, 'turn-incomplete');
      return; // 还在跑 / 停止中:下一拍再看
    }
    const kind = classifyBgSendResponse('resend', res.status, res.body, res.networkError);
    if (kind === 'accepted') return accept(key, queueId, res.body, g); // 服务端已无记录、当新请求收下:上次没送达,只这一次
    if (kind === 'start-timeout') { st().settleBgSend(key, queueId, { kind: 'accepted', pid: res.body.pid, startTimedOut: true }); return; }
    if (kind === 'ambiguous' && bump(key, queueId, 'query') <= BG_AMBIGUOUS_RESENDS) return; // 查询没回音:隔一会儿再查
    review(key, queueId, 'interrupted');
  }

  function followUp(key, item, items, t) {
    if (item.bgStartTimedOut && item.bgAcceptedPid) {
      const pid = String(item.bgAcceptedPid);
      if (items.some((p) => isChatProc(p) && String(p.pid) === pid && p.stoppable === true && p.status !== 'idle')) return;
      if (t - (lastQueryAt.get(item.queueId) || 0) < queryGapMs) return;
      const body = bodies.get(item.queueId);
      if (!body) { review(key, item.queueId, 'interrupted'); return; } // 本页内存里没有原请求体(排空者重建过),没法同号查询
      lastQueryAt.set(item.queueId, t);
      track(key, item.queueId, (g) => queryStartTimedOut(key, item.queueId, body, g));
      return;
    }
    // 兜底超时:BD 内存里没有对应在途、且标记已超过 fallbackTimeoutMs
    if (t - Number(item.bgStartedAt || 0) < fallbackTimeoutMs) return;
    if (item.bgAcceptedPid) removeAccepted(key, item.queueId, String(item.bgAcceptedPid));
    else review(key, item.queueId, 'interrupted');
  }

  function handleDraft(key, items) {
    if (paneDrainRegistered(key) || inFlight.has(key)) return;
    const list = st().messageQueue?.[key];
    const draftId = DRAFT_ID_RE.exec(key)?.[1];
    if (!Array.isArray(list) || !list.length || !draftId) return;
    const procs = items.filter((p) => isChatProc(p) && p.draftId === draftId);
    const bound = procs.find((p) => p.sessionId);
    if (bound) { try { promoteDraftArtifacts?.(key, bound.sessionId); } catch {} return; }
    if (procs.length && procs.every((p) => p.stoppable === false)) moveQueueToOrphans(key); // 第一条失败、没拿到正式编号
  }

  function onPoll(data) {
    if (stopped) return;
    const items = agentsOf(data);
    const t = now();
    const queues = st().messageQueue || {};
    for (const [key, list] of Object.entries(queues)) {
      if (!Array.isArray(list) || inFlight.has(key)) continue;
      const mine = list.find((it) => it?.steerState === 'bg-sending');
      if (mine) followUp(key, mine, items, t);
      else if (isDraftQueueKey(key)) handleDraft(key, items);
    }
    for (const { key, item } of pickBgDrainTargets(inputFor(items, t))) track(key, item.queueId, (g) => sendOne(key, item.queueId, g));
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      gen += 1;
      unsubscribe = subscribe ? subscribe((data) => onPoll(data)) : null;
    },
    /** 中止在途请求、清定时器,不改条目(在途条目由兜底超时 / 刷新恢复规则收尾)。 */
    stop() {
      stopped = true;
      try { unsubscribe?.(); } catch {}
      unsubscribe = null;
      for (const r of inFlight.values()) { try { r.abort?.abort(); } catch {} }
      inFlight.clear();
      pending.clear();
      for (const t of timers) clearTimer(t);
      timers.clear();
      for (const done of [...sleepers]) done();
    },
    onPoll,
    /** 等手上的异步发送都告一段落(不含被退避推迟的下一拍)。 */
    async whenIdle() { while (pending.size) await Promise.allSettled([...pending]); },
  };
}

export function startBackgroundDrainer(deps) {
  const drainer = createBackgroundDrainer(deps);
  drainer.start();
  return drainer;
}
