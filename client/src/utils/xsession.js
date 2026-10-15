// r151b 跨会话消息(一期:人转发、人点处理)—— 前端的状态收敛与接口调用。
// App.jsx 与各组件只调这里,不在 App 里堆逻辑(PLAN-r151 X.2)。
//
// 状态口径(接口文件 X.3.3 / X.3.4):
//   · enabled:总开关(GET /api/xsession/config + WS xs:config)。关着时本模块给界面的都是"没有":
//     卡片区、侧栏条数、Dock 角标都不出现。唯一例外是消息气泡(历史与直播,见下方 peer* 函数),
//     它描述已经发生过的事,不看开关(X.3.7)。
//   · inbox[sid]:该会话收到、还没结束的消息(pending / queued / claimed / processing,带正文),按到达升序。
//     只有被卡片区关注(watchXsInbox)的会话才去拉;WS xs:message 一律按 message.to.sessionId 分发,
//     绝不读"当前选中会话"(异步回调读当前选中 = 分屏 / 切会话时串到别的会话,线上出过)。
//   · pending*:GET /api/xsession/pending 的计数(只数 status 为 pending 的),侧栏会话行、项目行与 Dock 共用。
// xs:message 不带正文:已知的消息只就地合并状态(保留已有正文);没见过的消息要正文时才重拉该会话的列表。
// 不做"收到事件就整表重拉"—— 那会让卡片在用户眼前按别的消息的事件跳变,也掩盖接口 409 的刷新路径。
import { create } from 'zustand';
import { useStore } from '../stores/sessionStore.js';
import { setXsDockExtra } from './attention.js';

const SID_RE = /^[0-9a-fA-F-]{36}$/; // 既有判据:36 位、只含十六进制字符与连字符(消息 id 同形)
export const isXsId = (v) => typeof v === 'string' && SID_RE.test(v);

const ACTIVE_STATUSES = new Set(['pending', 'queued', 'claimed', 'processing']);
const EMPTY_LIST = Object.freeze([]);
const EMPTY_MAP = Object.freeze({});

// 点【处理】时走既有发送流程的那条请求的 prompt:服务端兑换凭据后整条换成信封,这段文字不会交给模型;
// 只因 /api/chat 要求 prompt 是非空字符串。不能以 "/" 开头(会被当成斜杠命令)。
export const XS_PROMPT_PLACEHOLDER = '（跨会话消息）';
export const PEER_BODY_MISSING = '（内容未能解析）';

export const useXsStore = create(() => ({
  enabled: false,
  // GET config 的 nativeGuard.lastFailureAt(ISO 字符串或 null):设置块的引导失效提示用,不随总开关清空
  guardFailureAt: null,
  pendingTotal: 0,
  pendingBySession: EMPTY_MAP, // { [sessionId]: 待处理条数 }
  pendingByProject: EMPTY_MAP, // { [项目目录(去尾部分隔符)]: 待处理条数 }
  inbox: EMPTY_MAP, // { [sessionId]: 消息对象[] }
  busy: EMPTY_MAP, // { [messageId]: true } 卡片按钮的请求在路上
}));

// ── 接口调用(不抛错;网络失败 status 为 0) ─────────────────────────────────────
// payload 给了才带 JSON 请求体;不给时请求与原来逐字相同(只有 method)。
async function xsRequest(method, url, payload) {
  try {
    const init = { method };
    if (payload !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(payload);
    }
    const res = await fetch(url, init);
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}
const isDisabledReply = (r) => r.status === 409 && r.body && r.body.code === 'XS_DISABLED';
const replyError = (r, fallback) => (r.body && typeof r.body.error === 'string' && r.body.error ? r.body.error : fallback);

// ── 总开关 ───────────────────────────────────────────────────────────────────────
function applyEnabled(on) {
  const next = on === true;
  if (useXsStore.getState().enabled === next) return;
  if (!next) {
    useXsStore.setState({ enabled: false, pendingTotal: 0, pendingBySession: EMPTY_MAP, pendingByProject: EMPTY_MAP, inbox: EMPTY_MAP, busy: EMPTY_MAP });
    return;
  }
  useXsStore.setState({ enabled: true });
  void refreshPending();
  for (const sid of watched.keys()) void refreshInbox(sid);
}

/** 读一次总开关(与引导失效时刻);开着且原本就开着(如 WS 重连后)时顺带对账计数与已关注的收件箱。 */
export async function loadXsConfig() {
  const r = await xsRequest('GET', '/api/xsession/config');
  if (!r.ok || !r.body || typeof r.body.enabled !== 'boolean') return;
  const guard = r.body.nativeGuard;
  const failureAt = guard && typeof guard.lastFailureAt === 'string' && guard.lastFailureAt ? guard.lastFailureAt : null;
  if (useXsStore.getState().guardFailureAt !== failureAt) useXsStore.setState({ guardFailureAt: failureAt });
  const was = useXsStore.getState().enabled;
  applyEnabled(r.body.enabled);
  if (r.body.enabled && was) {
    void refreshPending();
    for (const sid of watched.keys()) void refreshInbox(sid);
  }
}

/** 设置块的总开关:PUT /api/xsession/config { enabled }。成功后按应答收敛(随后到达的 WS xs:config 同值,幂等)。 */
export async function setXsEnabled(on) {
  const r = await xsRequest('PUT', '/api/xsession/config', { enabled: on === true });
  if (r.ok && r.body && typeof r.body.enabled === 'boolean') {
    applyEnabled(r.body.enabled);
    return { ok: true };
  }
  return { ok: false, error: replyError(r, r.status === 0 ? '网络错误，未能保存' : '保存失败，请重试') };
}

// ── 待处理计数 ───────────────────────────────────────────────────────────────────
export const normProjectPath = (p) => (typeof p === 'string' ? p.replace(/[\\/]+$/, '') : '');
const sameCounts = (a, b) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
};

let pendingSeq = 0;
async function refreshPending() {
  if (!useXsStore.getState().enabled) return;
  const seq = ++pendingSeq;
  const r = await xsRequest('GET', '/api/xsession/pending');
  if (seq !== pendingSeq) return; // 后发的请求还在路上,以它为准
  if (isDisabledReply(r)) { applyEnabled(false); return; }
  if (!r.ok || !r.body || !Array.isArray(r.body.sessions) || !useXsStore.getState().enabled) return;
  const bySession = {};
  const byProject = {};
  let sum = 0;
  for (const it of r.body.sessions) {
    const n = Number(it && it.pending);
    if (!it || !isXsId(it.sessionId) || !Number.isInteger(n) || n <= 0) continue;
    bySession[it.sessionId] = (bySession[it.sessionId] || 0) + n;
    const p = normProjectPath(it.projectPath);
    if (p) byProject[p] = (byProject[p] || 0) + n;
    sum += n;
  }
  const total = Number.isInteger(r.body.total) && r.body.total >= 0 ? r.body.total : sum;
  const cur = useXsStore.getState();
  useXsStore.setState({
    pendingTotal: total,
    // 值没变就保留旧引用:订阅整张表的侧栏不因每次对账白重渲
    pendingBySession: sameCounts(cur.pendingBySession, bySession) ? cur.pendingBySession : bySession,
    pendingByProject: sameCounts(cur.pendingByProject, byProject) ? cur.pendingByProject : byProject,
  });
}
let pendingTimer = null;
function schedulePendingRefresh() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => { pendingTimer = null; void refreshPending(); }, 150);
}

// ── 收件箱(卡片区的数据) ─────────────────────────────────────────────────────────
const watched = new Map(); // sessionId → 关注计数(分屏里同一会话可能开在两个窗格)
const inboxEpoch = new Map(); // sessionId → 本地改动序号:拉取途中有改动则拉完再拉一次
const inboxInflight = new Map();
const inboxAgain = new Set();
const bumpEpoch = (sid) => inboxEpoch.set(sid, (inboxEpoch.get(sid) || 0) + 1);

function setInboxList(sid, list) {
  const cur = useXsStore.getState().inbox;
  const next = { ...cur };
  if (list && list.length) next[sid] = list; else delete next[sid];
  useXsStore.setState({ inbox: Object.keys(next).length ? next : EMPTY_MAP });
}
function patchInboxMessage(sid, id, fn) {
  const list = useXsStore.getState().inbox[sid];
  if (!Array.isArray(list)) return;
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const updated = fn(list[idx]);
  if (!updated) { setInboxList(sid, list.filter((m) => m.id !== id)); return; }
  const copy = list.slice();
  copy[idx] = updated;
  setInboxList(sid, copy);
}
const removeInboxMessage = (sid, id) => patchInboxMessage(sid, id, () => null);

/** 合并一条去掉了正文的消息对象(WS 广播 / 本地乐观更新)。离开 pending 时记下原因,撤回成功后先用它显示。 */
function mergeMessageFields(old, m) {
  const next = { ...old, ...m, body: old.body === undefined ? null : old.body };
  if (old.status === 'pending' && m.status !== 'pending') next.heldBefore = { heldReason: old.heldReason ?? null, heldText: old.heldText ?? null };
  else if (m.status === 'pending') next.heldBefore = null;
  else next.heldBefore = old.heldBefore || null;
  return next;
}

async function refreshInbox(sid) {
  if (!isXsId(sid) || !useXsStore.getState().enabled) return;
  if (inboxInflight.has(sid)) { inboxAgain.add(sid); return inboxInflight.get(sid); }
  const run = (async () => {
    const epoch0 = inboxEpoch.get(sid) || 0;
    const r = await xsRequest('GET', `/api/xsession/messages?sessionId=${encodeURIComponent(sid)}`);
    if (isDisabledReply(r)) { applyEnabled(false); return; }
    if (!r.ok || !r.body || !Array.isArray(r.body.messages) || !useXsStore.getState().enabled) return;
    const list = r.body.messages.filter((m) => m && isXsId(m.id) && ACTIVE_STATUSES.has(m.status) && m.to && m.to.sessionId === sid);
    const prev = useXsStore.getState().inbox[sid] || EMPTY_LIST;
    // 撤回后恢复原因要用到的"离开 pending 前的原因"只在本地有,接口里没有:按 id 带过去
    setInboxList(sid, list.map((m) => {
      const old = prev.find((x) => x.id === m.id);
      return old && old.heldBefore && m.status !== 'pending' ? { ...m, heldBefore: old.heldBefore } : m;
    }));
    if ((inboxEpoch.get(sid) || 0) !== epoch0) inboxAgain.add(sid);
  })().finally(() => {
    inboxInflight.delete(sid);
    if (inboxAgain.delete(sid)) void refreshInbox(sid);
  });
  inboxInflight.set(sid, run);
  return run;
}

/** 卡片区挂载时调用:关注该会话的收件箱并拉一次;返回取消关注函数。 */
export function watchXsInbox(sid) {
  if (!isXsId(sid)) return () => {};
  watched.set(sid, (watched.get(sid) || 0) + 1);
  void refreshInbox(sid);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (watched.get(sid) || 1) - 1;
    if (n <= 0) watched.delete(sid); else watched.set(sid, n);
  };
}

function mergeXsMessage(m) {
  if (!m || typeof m !== 'object' || !isXsId(m.id)) return;
  const sid = m.to && m.to.sessionId;
  if (!isXsId(sid) || !useXsStore.getState().enabled) return;
  schedulePendingRefresh();
  bumpEpoch(sid);
  const list = useXsStore.getState().inbox[sid];
  const known = Array.isArray(list) && list.some((x) => x.id === m.id);
  if (known) {
    if (ACTIVE_STATUSES.has(m.status)) patchInboxMessage(sid, m.id, (old) => mergeMessageFields(old, m));
    else removeInboxMessage(sid, m.id);
    return;
  }
  if (ACTIVE_STATUSES.has(m.status) && watched.has(sid)) void refreshInbox(sid);
}

/** useWebSocket 的分发入口:只认 xs:config / xs:message。 */
export function handleXsWsEvent(data) {
  if (!data || typeof data !== 'object') return;
  if (data.type === 'xs:config') {
    if (typeof data.enabled === 'boolean') applyEnabled(data.enabled);
    return;
  }
  if (data.type === 'xs:message') mergeXsMessage(data.message);
}

/**
 * App 挂载时调用一次:读总开关;WS 重连后再读一次并对账(断线期间的广播可能丢了);
 * Dock 角标跟着待处理总数走(总开关关着时为 0 = 与改动前相同)。
 */
export function startXsession() {
  void loadXsConfig();
  const syncDock = (s) => setXsDockExtra(s.enabled ? s.pendingTotal : 0);
  syncDock(useXsStore.getState());
  const unsubscribe = useXsStore.subscribe(syncDock);
  const onReconnect = () => { void loadXsConfig(); };
  window.addEventListener('cgui:ws-reconnected', onReconnect);
  return () => {
    unsubscribe();
    window.removeEventListener('cgui:ws-reconnected', onReconnect);
  };
}

// ── 卡片按钮 ─────────────────────────────────────────────────────────────────────
function markBusy(id) {
  const b = useXsStore.getState().busy;
  if (b[id]) return false;
  useXsStore.setState({ busy: { ...b, [id]: true } });
  return true;
}
function clearBusy(id) {
  const b = useXsStore.getState().busy;
  if (!b[id]) return;
  const rest = { ...b };
  delete rest[id];
  useXsStore.setState({ busy: Object.keys(rest).length ? rest : EMPTY_MAP });
}

// 前端排队(sessionStore.messageQueue,会落 localStorage)里"处理这条消息"的条目:opts.xsProcess 只带
// { messageId, sessionId },绝不带凭据(审计 F1)。凭据到真正发出前才由 claimXsForSend 认领拿到。
const isProcessEntryOf = (messageId) => (q) => !!(q && q.opts && q.opts.xsProcess && q.opts.xsProcess.messageId === messageId);
function queueHasXsProcess(queues, messageId) {
  if (!queues || !isXsId(messageId)) return false;
  const hit = isProcessEntryOf(messageId);
  for (const list of Object.values(queues)) if (Array.isArray(list) && list.some(hit)) return true;
  return false;
}

/** 撤回 / 忽略之后,前端排队里还没发出的同一条一并撤掉(忽略时排队里的这一条一并取消)。 */
function dropQueuedProcess(messageId) {
  const st = useStore.getState();
  for (const [key, list] of Object.entries(st.messageQueue || {})) {
    if (!Array.isArray(list)) continue;
    const idx = list.findIndex(isProcessEntryOf(messageId));
    if (idx >= 0) st.removeFromQueue(key, idx);
  }
}

/**
 * 【处理】:交给既有发送流程(send = 本窗格的 handleSend)发一条隐藏的消息,只带消息 id(opts.xsProcess),不带凭据。
 * 会话正忙时既有发送流程把它原样排进队列(队列会落 localStorage),消息在服务端保持 pending,卡片显示"已排队";
 * 轮到它真正发出时 handleSend 才调 claimXsForSend 认领拿一次性凭据(审计 F1)。已在排队里的同一条不重复排;
 * isStillOn():本窗格已换了会话就不交出去。返回 { ok } / { ok:false, error }(error 为空 = 无需另行提示)。
 */
export async function processXsMessage({ sessionId, messageId, send, isStillOn }) {
  if (!useXsStore.getState().enabled || !isXsId(sessionId) || !isXsId(messageId) || typeof send !== 'function') return { ok: false, error: '' };
  if (useXsStore.getState().busy[messageId] || queueHasXsProcess(useStore.getState().messageQueue, messageId)) return { ok: false, error: '' };
  if (typeof isStillOn === 'function' && !isStillOn()) return { ok: false, error: '' };
  Promise.resolve().then(() => send(XS_PROMPT_PLACEHOLDER, { hiddenUserMessage: true, xsProcess: { messageId, sessionId } })).catch(() => { void refreshInbox(sessionId); });
  return { ok: true };
}

/**
 * handleSend 真正发出点卡片的这条之前调用(直接发送,或排队轮到它时):这时才认领拿一次性凭据。
 * 返回 { ok:true, fields:{ xsMessageId, xsToken } } —— fields 只放进这一次 POST /api/chat 的请求体,
 * 不进 opts / 排队 / 任何持久存储;或 { ok:false, notice } —— 不发送,卡片已按最新状态刷新(notice 为空 = 不用另行提示)。
 * sendSessionId:这次请求要发往的会话;与消息的目标会话不同就不认领(不把凭据发到别的会话去)。
 */
export async function claimXsForSend(xsProcess, sendSessionId) {
  const p = xsProcess && typeof xsProcess === 'object' ? xsProcess : {};
  const sid = isXsId(p.sessionId) ? p.sessionId : null;
  const refresh = () => { if (sid) { bumpEpoch(sid); void refreshInbox(sid); } };
  if (!sid || !isXsId(p.messageId) || sid !== sendSessionId || !useXsStore.getState().enabled) { refresh(); return { ok: false, notice: '' }; }
  const messageId = p.messageId;
  if (!markBusy(messageId)) { refresh(); return { ok: false, notice: '' }; } // 撤回 / 忽略正在路上
  try {
    const r = await xsRequest('POST', `/api/xsession/messages/${messageId}/claim`);
    if (!r.ok || !r.body || typeof r.body.token !== 'string') {
      if (isDisabledReply(r)) { applyEnabled(false); return { ok: false, notice: '' }; }
      bumpEpoch(sid);
      await refreshInbox(sid);
      return { ok: false, notice: r.status === 409 || r.status === 404 ? '' : `跨会话消息没有发出：${replyError(r, '未能开始处理')}。卡片已按最新状态刷新。` };
    }
    bumpEpoch(sid);
    if (!isXsId(r.body.token)) {
      // 审计 S4:凭据字段不全 / 形状不对 → 不发送(否则请求不带凭据、占位文字被当成普通消息发给模型),按最新状态刷新卡片
      await refreshInbox(sid);
      return { ok: false, notice: '跨会话消息没有发出：认领凭据无效。卡片已按最新状态刷新。' };
    }
    patchInboxMessage(sid, messageId, (old) => mergeMessageFields(old, { status: 'claimed', heldReason: null, heldText: null }));
    return { ok: true, fields: { xsMessageId: messageId, xsToken: r.body.token } };
  } finally {
    clearBusy(messageId);
  }
}

/** 【撤回】:claimed → pending,旧凭据作废。 */
export async function releaseXsMessage({ sessionId, messageId }) {
  if (!isXsId(sessionId) || !isXsId(messageId) || !markBusy(messageId)) return { ok: false, error: '' };
  try {
    const r = await xsRequest('POST', `/api/xsession/messages/${messageId}/release`);
    if (r.ok) {
      dropQueuedProcess(messageId);
      bumpEpoch(sessionId);
      patchInboxMessage(sessionId, messageId, (old) => mergeMessageFields(old, {
        status: 'pending',
        heldReason: (old.heldBefore && old.heldBefore.heldReason) || null,
        heldText: (old.heldBefore && old.heldBefore.heldText) || null,
      }));
      return { ok: true };
    }
    if (isDisabledReply(r)) { applyEnabled(false); return { ok: false, error: '' }; }
    await refreshInbox(sessionId);
    return { ok: false, error: r.status === 409 || r.status === 404 ? '' : `未能撤回：${replyError(r, '请求失败')}` };
  } finally {
    clearBusy(messageId);
  }
}

/** 【忽略】:→ dismissed,卡片消失,正文随即删除。 */
export async function dismissXsMessage({ sessionId, messageId }) {
  if (!isXsId(sessionId) || !isXsId(messageId) || !markBusy(messageId)) return { ok: false, error: '' };
  try {
    const r = await xsRequest('POST', `/api/xsession/messages/${messageId}/dismiss`);
    if (r.ok) {
      dropQueuedProcess(messageId);
      bumpEpoch(sessionId);
      removeInboxMessage(sessionId, messageId);
      return { ok: true };
    }
    if (isDisabledReply(r)) { applyEnabled(false); return { ok: false, error: '' }; }
    await refreshInbox(sessionId);
    return { ok: false, error: r.status === 409 || r.status === 404 ? '' : `未能忽略：${replyError(r, '请求失败')}` };
  } finally {
    clearBusy(messageId);
  }
}

// ── 与既有发送流程的接缝(App.jsx handleSend) ─────────────────────────────────────
/**
 * 自动标题(App.jsx handleSend 里每一处 POST /api/chat/title)拿来当"首条用户消息"的文字:触发条件与请求体都只读它。
 * 点卡片发出的那条(opts.xsProcess)的 prompt 只是占位 XS_PROMPT_PLACEHOLDER,不是用户写的话 —— 拿去起标题,
 * 没有标题的会话(第三方 provider 常见)就被写成占位文字:返回 '',触发条件不成立。
 * 其余发送原样返回 prompt(包括别的隐藏消息),自动标题行为与改动前相同。
 */
export function xsAutoTitlePrompt(prompt, opts) {
  return opts && opts.xsProcess ? '' : prompt;
}
/** /api/chat 拒了这条点卡片的请求(400 / 409 XS_CLAIM_INVALID、409 XS_DISABLED、500 …):按"没发出"处理,刷新卡片,返回提示文案。xsProcess = opts.xsProcess。 */
export function xsClaimNotSent(xsProcess, reply) {
  if (xsProcess && isXsId(xsProcess.sessionId)) {
    bumpEpoch(xsProcess.sessionId);
    void refreshInbox(xsProcess.sessionId);
  }
  const err = reply && typeof reply.error === 'string' && reply.error ? reply.error : '发送失败';
  return `跨会话消息没有发出：${err}。卡片已按最新状态刷新。`;
}

// ── 转发(对话框 XsForwardDialog 只调这里) ────────────────────────────────────────
export const XS_BODY_MAX_BYTES = 32768; // 正文 UTF-8 上限(X.3.5 固定值,与服务端判 XS_BODY_TOO_LARGE 同一口径)
export const XS_MAX_TARGETS = 8; // 单次转发的目标上限(同上,XS_TOO_MANY_TARGETS)
let utf8Encoder = null;
/** 正文的 UTF-8 字节数。孤立代理项按 3 字节计(编码成 U+FFFD),与服务端 Buffer.byteLength 一致。 */
export function xsUtf8Bytes(s) {
  if (typeof s !== 'string' || !s) return 0;
  if (!utf8Encoder) utf8Encoder = new TextEncoder();
  return utf8Encoder.encode(s).length;
}

/**
 * 转发对话框的目标列表:GET /api/xsession/sessions(按最近活动倒序,默认条数)。exclude = 来源会话,列表不含它;
 * query 为空时不带。返回 { ok:true, sessions } / { ok:false, error }。
 */
export async function listXsTargets({ query, exclude } = {}) {
  const qs = new URLSearchParams();
  const q = typeof query === 'string' ? query.trim().slice(0, 100) : ''; // 接口上限 100 字,超了整次 400
  if (q) qs.set('query', q);
  if (isXsId(exclude)) qs.set('exclude', exclude);
  const search = qs.toString();
  const r = await xsRequest('GET', `/api/xsession/sessions${search ? `?${search}` : ''}`);
  if (isDisabledReply(r)) applyEnabled(false);
  if (!r.ok || !r.body || !Array.isArray(r.body.sessions)) return { ok: false, error: replyError(r, '未能读取会话列表') };
  return { ok: true, sessions: r.body.sessions.filter((s) => s && isXsId(s.sessionId) && s.sessionId !== exclude) };
}

/**
 * 手动转发:POST /api/xsession/messages(一律落成卡片,没有"立即处理")。fromSessionId 不是会话 id 时请求体里
 * 不带这个键(传 null 会被拒为 400)。返回 { ok:true, messages } / { ok:false, code, error, targets }:失败时服务端
 * 整次拒绝、一条没发;targets 是 XS_TARGET_NOT_FOUND / XS_INBOX_FULL 附带的出错目标。
 */
export async function forwardXsMessage({ to, body, fromSessionId }) {
  const payload = { to: [...new Set(Array.isArray(to) ? to : [])], body: typeof body === 'string' ? body : '' };
  if (isXsId(fromSessionId)) payload.fromSessionId = fromSessionId;
  const r = await xsRequest('POST', '/api/xsession/messages', payload);
  if (r.ok && r.body && r.body.ok === true && Array.isArray(r.body.messages)) return { ok: true, messages: r.body.messages };
  if (isDisabledReply(r)) applyEnabled(false);
  const b = r.body && typeof r.body === 'object' ? r.body : {};
  return {
    ok: false,
    code: typeof b.code === 'string' ? b.code : '',
    error: replyError(r, r.status === 0 ? '网络错误，未能发送' : '发送失败'),
    targets: Array.isArray(b.targets) ? b.targets.filter(isXsId) : [],
  };
}

// ── 卡片文案 ─────────────────────────────────────────────────────────────────────
export function xsCardFromText(m) {
  const f = (m && m.from) || {};
  const title = typeof f.title === 'string' && f.title.trim() ? f.title : '';
  if (f.kind === 'user') return title ? `由你从 ${title} 转发` : '由你转发';
  return title ? `来自 ${title}` : '来自另一个会话';
}
// 会话正忙时点了【处理】、"处理这条消息"已排进前端队列(消息在服务端仍是 pending)时的原因文案
export const XS_LOCAL_QUEUED_TEXT = '已排队，当前回合结束后处理';
export function xsCardReasonText(m, queuedHere = false) {
  switch (m && m.status) {
    case 'pending': return queuedHere ? XS_LOCAL_QUEUED_TEXT : ((m.heldText && String(m.heldText)) || '');
    case 'queued': return '目标会话正在运行，回合结束后自动处理';
    case 'claimed': return '等待发送';
    case 'processing': return '处理中';
    default: return '';
  }
}

// ── 来源气泡(历史条目、直播 xs_message、直播 result.origin 三处同形) ───────────────────
// 历史条目:{ type:'peer-message', uuid, timestamp, fromName, from, body, hostInjected }(服务端产出)。
// 直播构造的同形,另带 via 与 live:true(只活在本地,回合落盘对账时见 keepLivePeer)。
export function peerVia(m) {
  if (m && (m.via === 'card' || m.via === 'auto' || m.via === 'native' || m.via === 'gui')) return m.via;
  return m && typeof m.from === 'string' && m.from.startsWith('gui:') ? 'gui' : 'native';
}
export function peerFromLabel(m) {
  const name = m && typeof m.fromName === 'string' && m.fromName.trim() ? m.fromName : '';
  if (!name) return '来自另一个会话';
  return m.from === 'gui:user' ? name : `来自 ${name}`; // 手动转发的来源名本身就是"用户转发自 <标题>"
}
export function peerFromSession(m) {
  if (m && isXsId(m.fromSessionId)) return m.fromSessionId;
  const f = m && typeof m.from === 'string' ? m.from : '';
  return f.startsWith('gui:') && isXsId(f.slice(4)) ? f.slice(4) : null;
}

/** 事件流 xs_message(点卡片兑换 / 自动投递的那一回合补发的一条)→ 气泡消息对象。 */
export function peerFromXsEvent(ev) {
  if (!ev || ev.type !== 'xs_message' || !isXsId(ev.id)) return null;
  const f = ev.from && typeof ev.from === 'object' ? ev.from : {};
  const manual = f.kind === 'user';
  const fromSid = isXsId(f.sessionId) ? f.sessionId : null;
  const title = typeof f.title === 'string' && f.title.trim() ? f.title : '';
  return {
    uuid: `xs-peer-${ev.id}`,
    type: 'peer-message',
    live: true,
    timestamp: new Date().toISOString(),
    via: ev.via === 'auto' ? 'auto' : 'card',
    from: manual ? 'gui:user' : (fromSid ? `gui:${fromSid}` : null),
    // 与服务端信封的来源名同一规则:手动转发"用户转发自 <来源标题>",没有来源会话为"用户";AI 发送取发送方标题
    fromName: manual ? (fromSid ? `用户转发自 ${title || '未命名会话'}` : '用户') : (title || null),
    fromSessionId: fromSid,
    body: typeof ev.body === 'string' ? ev.body : null,
  };
}

/** 回合的顶层 result 带 origin.kind:"peer"、没有 senderTaskId、没有 hostInjected(CLI 原生通道来的)→ 气泡;其余 null。 */
export function peerFromResultEvent(ev) {
  if (!ev || ev.type !== 'result' || ev.parent_tool_use_id) return null;
  const o = ev.origin;
  if (!o || typeof o !== 'object' || o.kind !== 'peer' || o.senderTaskId || o.hostInjected) return null;
  const key = ev.uuid || (ev.runId != null && ev.seq != null ? `${ev.runId}:${ev.seq}` : null);
  if (!key) return null;
  return {
    uuid: `peer-native-${key}`,
    type: 'peer-message',
    live: true,
    timestamp: new Date().toISOString(),
    via: 'native',
    from: typeof o.from === 'string' ? o.from : null,
    fromName: typeof o.name === 'string' && o.name.trim() ? o.name : null,
    body: typeof o.body === 'string' ? o.body : null,
  };
}

// 直播气泡只活在本地(历史里那条由服务端从会话记录读出,两者 uuid 不同)。回合落盘对账时:历史里已有
// 同一条(两边都有正文时正文相同;任一边没有正文时来源名相同)就交给历史,否则留着 —— 记录里没写出这条时
// 气泡不凭空消失。历史那条的 body 可能是 null(CLI 没给 origin.body、文本兜底也解析不出),这时只能按来源名认,
// 否则直播气泡永远不被接管,同一视图里出现两个来源气泡(判官建议 1)。
const PEER_LAND_WINDOW_MS = 6 * 60 * 60 * 1000;
function peerLanded(local, persisted) {
  if (!Array.isArray(persisted)) return false;
  const t0 = Date.parse(local.timestamp);
  for (const h of persisted) {
    if (!h || h.type !== 'peer-message' || h.live === true) continue;
    const ht = Date.parse(h.timestamp);
    if (Number.isFinite(t0) && Number.isFinite(ht) && ht < t0 - PEER_LAND_WINDOW_MS) continue;
    const byBody = local.body != null && h.body != null;
    if (byBody ? h.body === local.body : (h.fromName ?? null) === (local.fromName ?? null)) return true;
  }
  return false;
}
/** 对账过滤器:true = 这是还没被历史接管的直播来源气泡,保留。 */
export function keepLivePeer(m, persisted) {
  return !!m && m.type === 'peer-message' && m.live === true && !peerLanded(m, persisted);
}

/**
 * 回合整轮落盘后,留下来的本回合直播来源气泡(历史里没有同一条)记下锚点 = 历史里本回合的第一条回复
 * (sinceMs 之后的第一个 turn);渲染时由 placeAnchoredPeers 插回它之前,保持"在该回合之前"。
 * 已有锚点的、本回合之前就有的、找不到锚点的都不动(没有锚点的留在直播列表末尾)。没变化返回原数组。
 */
export function anchorLivePeers(list, persisted, sinceMs) {
  const since = Number(sinceMs);
  if (!Array.isArray(list) || !Number.isFinite(since)) return list;
  const isFresh = (m) => m && m.type === 'peer-message' && m.live === true && !m.anchorUuid && !(Date.parse(m.timestamp) < since);
  if (!list.some(isFresh) || !Array.isArray(persisted)) return list;
  const first = persisted.find((h) => h && h.type === 'turn' && h.uuid && Date.parse(h.timestamp) >= since);
  if (!first) return list;
  let changed = false;
  const next = list.map((m) => {
    if (!isFresh(m) || !keepLivePeer(m, persisted)) return m;
    changed = true;
    return { ...m, anchorUuid: first.uuid };
  });
  return changed ? next : list;
}

const EMPTY_SET = new Set();
/** 把带锚点的直播来源气泡插到历史列表里锚点那一条之前。返回 { list, placed };没有可插的返回原数组(不打穿 MessageList 的 memo)。 */
export function placeAnchoredPeers(list, chat) {
  if (!Array.isArray(list) || !Array.isArray(chat)) return { list, placed: EMPTY_SET };
  let byAnchor = null;
  for (const p of chat) {
    if (!p || p.type !== 'peer-message' || !p.anchorUuid) continue;
    if (!byAnchor) byAnchor = new Map();
    byAnchor.set(p.anchorUuid, [...(byAnchor.get(p.anchorUuid) || []), p]);
  }
  if (!byAnchor) return { list, placed: EMPTY_SET };
  const out = [];
  const placed = new Set();
  for (const m of list) {
    const ps = m && m.uuid ? byAnchor.get(m.uuid) : null;
    if (ps) for (const p of ps) { out.push(p); placed.add(p.uuid); }
    out.push(m);
  }
  return placed.size ? { list: out, placed } : { list, placed: EMPTY_SET };
}

// ── 订阅(选择器的默认值都是模块级常量:返回新引用会触发 React #185 整页白屏) ─────────────
export const useXsEnabled = () => useXsStore((s) => s.enabled);
export const useXsGuardFailureAt = () => useXsStore((s) => s.guardFailureAt);
export const useXsInbox = (sid) => useXsStore((s) => (s.enabled && sid && s.inbox[sid]) || EMPTY_LIST);
export const useXsBusy = (id) => useXsStore((s) => !!(id && s.busy[id]));
/** 这条消息的"处理"是否已排在前端队列里(选择器返回布尔,引用稳定)。 */
export const useXsQueuedHere = (id) => useStore((s) => queueHasXsProcess(s.messageQueue, id));
export const useXsSessionPending = (sid) => useXsStore((s) => (s.enabled && sid ? s.pendingBySession[sid] || 0 : 0));
export const useXsProjectPendingMap = () => useXsStore((s) => (s.enabled ? s.pendingByProject : EMPTY_MAP));
export const xsProjectPending = (map, path) => (map && map[normProjectPath(path)]) || 0;
