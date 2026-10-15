// r151b T-X4:跨会话消息的核心(PLAN X.1.4、X.1.5、X.1.9;接口 X.3.1、X.3.3、X.3.6)。一期只有"人转发、人点处理":
//   转发 → 落成卡片(pending / target-card)→ 认领拿一次性凭据(claimed)→ 前端带凭据 POST /api/chat →
//   /chat 路由入口钩子兑换:请求的 prompt 换成服务端构造的信封、消息变 processing 并绑定到这一回合 →
//   回合开始时往事件流补一条 xs_message → 回合结束结算(completed → done;failed → pending/turn-error;
//   stopped → pending/interrupted)。
// 正文是另一个会话的模型输出 = 不可信输入:只原样存盘、原样给本机界面;进模型之前只经 xsession-envelope 的中和。
// 日志只带消息 id,不带正文与凭据;凭据(token)只出现在认领应答里,不进任何列表应答与广播(publicMessage 是白名单)。
// 依赖只朝一个方向:本模块经 chat.js 导出的窄接口挂钩子,chat.js 不认识本模块(/chat 入口兑换与回合结算随后加入)。
import { randomUUID } from 'crypto';
import { broadcast } from '../broadcast.js';
import { findSessionFile, isSessionIdShape } from './session-reader.js';
import { XS_LIMITS, XS_STATUSES, XsStorageError, isOpenStatus, listXsMessages, mutateXsInbox, readXsBody } from './xsession-store.js';

export const XS_DISABLED_TEXT = '跨会话消息未开启';
export const XS_STORAGE_FAILED_TEXT = '保存失败，请重试';

/** 业务错误:路由层按 { ok:false, code, error, ...extra } 应答。 */
export class XsError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'XsError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// 会话 id / 消息 id / 凭据的形状。isSessionIdShape 内部会 String() 入参(单元素数组也能过),这里先要求是字符串。
const isIdString = (v) => typeof v === 'string' && isSessionIdShape(v);
const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// heldReason → heldText(一期只会出现这三种;全角标点)。turn-error 后面接摘要。
const HELD_TEXT = { 'target-card': '等待你确认后处理', interrupted: '上次处理被中断' };
const TURN_ERROR_PREFIX = '处理该消息的回合出错：';
// 回合结束通知只给 outcome、不带错误文本,所以 failed 的摘要是这句固定话;"始终没开始回合"有自己的摘要。
const TURN_FAILED_SUMMARY = '模型返回了错误或进程提前退出';

function heldTextOf(m) {
  if (m.status !== 'pending' || !m.heldReason) return null;
  if (m.heldReason === 'turn-error') return TURN_ERROR_PREFIX + (m.heldDetail || TURN_FAILED_SUMMARY);
  return HELD_TEXT[m.heldReason] ?? null;
}

/** 对外的消息对象(白名单字段;不带 token / heldBefore / heldDetail / turn / projectPath)。body 不传 = 不带 body 键(广播用)。 */
function publicMessage(m, { deleted = false, body } = {}) {
  return {
    id: m.id,
    createdAt: m.createdAt,
    status: m.status,
    chainId: m.chainId,
    hop: m.hop,
    from: { kind: m.from?.kind ?? 'user', sessionId: m.from?.sessionId ?? null, title: m.from?.title ?? null, deleted },
    to: { sessionId: m.to.sessionId, title: m.to?.title ?? null },
    ...(body !== undefined ? { body } : {}),
    bodyBytes: m.bodyBytes,
    via: m.via ?? null,
    heldReason: m.status === 'pending' ? (m.heldReason ?? null) : null,
    heldText: heldTextOf(m),
  };
}

// 来源会话被删(记录文件找不到)的那些来源 id。没有来源会话(from.sessionId 为 null)的不算被删。
async function deletedSources(records) {
  const ids = [...new Set(records.map((m) => m.from?.sessionId).filter(Boolean))];
  const gone = new Set();
  for (const id of ids) if (!(await findSessionFile(id))) gone.add(id);
  return gone;
}

// WS xs:message:每次状态变化播一次,不带正文。串成一条链,保证广播顺序与状态变化顺序一致
// (各次广播前都要查一次来源会话还在不在,并发跑的话快的会插到前面)。
let announceChain = Promise.resolve();
function announce(records) {
  const run = announceChain.then(async () => {
    const gone = await deletedSources(records);
    for (const m of records) {
      broadcast({ type: 'xs:message', message: publicMessage(m, { deleted: gone.has(m.from?.sessionId) }) });
    }
  });
  announceChain = run.catch((e) => console.warn(`[xsession] 广播失败:${e?.message || e}`));
  return announceChain;
}

const findById = (messages, id) => messages.find((m) => sameId(m.id, id));
const notFound = () => new XsError(404, 'XS_MESSAGE_NOT_FOUND', '消息不存在');
function assertMessageId(id) {
  if (!isIdString(id)) throw new XsError(400, 'XS_INVALID_INPUT', '消息 id 形状不对');
}

// ── POST /api/xsession/messages(手动转发;一律落成卡片)──────────────────────────────────────

const SEND_KEYS = new Set(['to', 'body', 'fromSessionId']);

/**
 * 校验顺序第 2–5 条(第 1 条总开关在路由闸门):非法输入 → 目标数 → 正文字节数 → 目标含自己。命中即抛 XsError。
 * 返回 { to(去重后,保留首次出现的写法), body, fromSessionId(没给为 null) }。会话 id 去重不分大小写。
 */
export function parseManualSend(raw) {
  const invalid = (msg) => new XsError(400, 'XS_INVALID_INPUT', msg);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('请求体须为对象');
  if (Object.keys(raw).some((k) => !SEND_KEYS.has(k))) throw invalid('请求体只能有 to、body、fromSessionId');
  const { to, body, fromSessionId } = raw;
  if (!Array.isArray(to) || to.length === 0 || !to.every(isIdString)) throw invalid('to 须为非空的会话 id 数组');
  if (typeof body !== 'string' || !body.trim()) throw invalid('body 须为非空字符串');
  if (fromSessionId !== undefined && !isIdString(fromSessionId)) throw invalid('fromSessionId 须为会话 id');
  const seen = new Set();
  const targets = [];
  for (const id of to) {
    const key = id.toLowerCase();
    if (!seen.has(key)) { seen.add(key); targets.push(id); }
  }
  if (targets.length > XS_LIMITS.targetsPerSend) throw new XsError(400, 'XS_TOO_MANY_TARGETS', `一次最多发给 ${XS_LIMITS.targetsPerSend} 个会话`);
  if (Buffer.byteLength(body, 'utf8') > XS_LIMITS.bodyBytes) throw new XsError(400, 'XS_BODY_TOO_LARGE', `正文超过 ${XS_LIMITS.bodyBytes} 字节`);
  if (fromSessionId !== undefined && seen.has(fromSessionId.toLowerCase())) throw new XsError(400, 'XS_SELF_TARGET', '目标里不能有来源会话自己');
  return { to: targets, body, fromSessionId: fromSessionId ?? null };
}

/**
 * 校验顺序第 6–9 条并落盘。sessionRows:已落盘的会话 [{ sessionId, title, projectDir }](与 GET /api/xsession/sessions 同一认定)。
 * "每会话最多 50 条待处理"在同一次存储事务里判(并发转发不会超)。返回应答里的 messages。
 */
export async function sendManualMessages({ to, body, fromSessionId }, sessionRows) {
  const byId = new Map(sessionRows.map((r) => [r.sessionId.toLowerCase(), r]));
  const source = fromSessionId ? byId.get(fromSessionId.toLowerCase()) : null;
  if (fromSessionId && !source) throw new XsError(404, 'XS_SOURCE_NOT_FOUND', '来源会话不存在');
  const missing = to.filter((id) => !byId.has(id.toLowerCase()));
  if (missing.length) throw new XsError(404, 'XS_TARGET_NOT_FOUND', '目标会话不存在', { targets: missing });
  const targets = to.map((id) => byId.get(id.toLowerCase()));
  const createdAt = new Date().toISOString();
  const chainId = randomUUID(); // 手动转发 = 新链、hop 1(同一次发送共用一个 chainId)
  const bodyBytes = Buffer.byteLength(body, 'utf8');

  const created = await mutateXsInbox((messages, tx) => {
    const pendingOf = new Map();
    for (const m of messages) if (m.status === 'pending') pendingOf.set(m.to.sessionId, (pendingOf.get(m.to.sessionId) || 0) + 1);
    const full = targets.filter((t) => (pendingOf.get(t.sessionId) || 0) >= XS_LIMITS.pendingPerSession).map((t) => t.sessionId);
    if (full.length) throw new XsError(409, 'XS_INBOX_FULL', `目标会话的待处理消息已满（${XS_LIMITS.pendingPerSession} 条）`, { targets: full });
    return targets.map((t) => {
      const m = {
        id: randomUUID(), createdAt, status: 'pending', chainId, hop: 1,
        from: { kind: 'user', sessionId: source ? source.sessionId : null, title: source ? source.title : null },
        // projectPath:发送时该会话所属项目的目录(与侧栏分组同口径),GET /api/xsession/pending 用
        to: { sessionId: t.sessionId, title: t.title, projectPath: t.projectDir ?? null },
        bodyBytes, via: null, heldReason: 'target-card',
      };
      messages.push(m);
      tx.putBody(m.id, body); // 存原文:卡片显示原文;中和只在交给模型时做
      return structuredClone(m);
    });
  });
  await announce(created);
  return created.map((m) => ({ id: m.id, to: { sessionId: m.to.sessionId, title: m.to.title }, status: m.status }));
}

// ── GET /api/xsession/messages、GET /api/xsession/pending ───────────────────────────────────

const DEFAULT_LIST_STATUSES = ['pending', 'queued', 'claimed', 'processing'];

/** 查询参数校验:sessionId 必填且形状对;status 可选,逗号分隔,只能是六种状态。返回 { sessionId, statuses:Set }。 */
export function parseListQuery(q = {}) {
  if (!isIdString(q.sessionId)) throw new XsError(400, 'XS_INVALID_INPUT', 'sessionId 须为会话 id');
  let statuses = DEFAULT_LIST_STATUSES;
  if (q.status !== undefined) {
    statuses = typeof q.status === 'string' ? q.status.split(',') : null;
    if (!statuses || !statuses.every((s) => XS_STATUSES.includes(s))) throw new XsError(400, 'XS_INVALID_INPUT', `status 只能是 ${XS_STATUSES.join('、')}`);
  }
  return { sessionId: q.sessionId, statuses: new Set(statuses) };
}

/** 某会话收到的消息(按到达先后),带正文;done / dismissed 的正文已删除,为 null。会话不存在 → []。 */
export async function listInboxMessages({ sessionId, statuses }) {
  const mine = (await listXsMessages()).filter((m) => sameId(m.to.sessionId, sessionId) && statuses.has(m.status));
  const gone = await deletedSources(mine);
  const out = [];
  for (const m of mine) {
    const body = isOpenStatus(m.status) ? await readXsBody(m.id) : null;
    out.push(publicMessage(m, { deleted: gone.has(m.from?.sessionId), body }));
  }
  return out;
}

/** 待处理计数:只列有 status=pending 消息的会话,不受会话列表条数上限影响。 */
export async function pendingSummary() {
  const bySession = new Map();
  for (const m of await listXsMessages()) {
    if (m.status !== 'pending') continue;
    const row = bySession.get(m.to.sessionId);
    if (row) row.pending += 1;
    else bySession.set(m.to.sessionId, { sessionId: m.to.sessionId, projectPath: m.to.projectPath ?? null, pending: 1 });
  }
  const sessions = [...bySession.values()];
  return { total: sessions.reduce((n, s) => n + s.pending, 0), sessions };
}

// ── 认领 / 撤回 / 忽略 ─────────────────────────────────────────────────────────────────────

/** pending / queued → claimed,发一次性凭据(加密安全的随机数;撤回、忽略、兑换、重启都会让它作废)。 */
export async function claimMessage(id) {
  assertMessageId(id);
  const token = randomUUID();
  const m = await mutateXsInbox((messages) => {
    const m = findById(messages, id);
    if (!m) throw notFound();
    if (m.status !== 'pending' && m.status !== 'queued') throw new XsError(409, 'XS_NOT_PENDING', '这条消息不是待处理状态', { status: m.status });
    m.heldBefore = m.heldReason ?? null; // 撤回时恢复
    m.status = 'claimed';
    m.heldReason = null;
    m.token = token;
    return structuredClone(m);
  });
  await announce([m]);
  return { ok: true, id: m.id, sessionId: m.to.sessionId, token };
}

/** claimed → pending,heldReason 恢复为认领前的值;旧凭据作废。 */
export async function releaseMessage(id) {
  assertMessageId(id);
  const m = await mutateXsInbox((messages) => {
    const m = findById(messages, id);
    if (!m) throw notFound();
    if (m.status !== 'claimed') throw new XsError(409, 'XS_NOT_CLAIMED', '这条消息不是认领状态', { status: m.status });
    m.status = 'pending';
    m.heldReason = m.heldBefore || 'target-card'; // 从 queued 认领的没有原因,退回卡片的默认原因
    delete m.heldBefore;
    delete m.token;
    return structuredClone(m);
  });
  await announce([m]);
  return { ok: true, id: m.id, status: 'pending' };
}

/** pending / queued / claimed → dismissed;正文随即删除(存储层在消息结束时删),认领过的凭据作废。 */
export async function dismissMessage(id) {
  assertMessageId(id);
  const m = await mutateXsInbox((messages) => {
    const m = findById(messages, id);
    if (!m) throw notFound();
    if (!['pending', 'queued', 'claimed'].includes(m.status)) throw new XsError(409, 'XS_NOT_PENDING', '这条消息不是待处理状态', { status: m.status });
    m.status = 'dismissed';
    m.heldReason = null;
    for (const k of ['heldBefore', 'heldDetail', 'token']) delete m[k];
    return structuredClone(m);
  });
  await announce([m]);
  return { ok: true, id: m.id, status: 'dismissed' };
}
