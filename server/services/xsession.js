// r151b T-X4:跨会话消息的核心(PLAN X.1.4、X.1.5、X.1.9;接口 X.3.1、X.3.3、X.3.6)。一期只有"人转发、人点处理":
//   转发 → 落成卡片(pending / target-card)→ 认领拿一次性凭据(claimed)→ 前端带凭据 POST /api/chat →
//   /chat 路由入口钩子兑换:请求的 prompt 换成服务端构造的信封、消息变 processing 并绑定到这一回合 →
//   回合开始时往事件流补一条 xs_message → 回合结束结算(completed → done;failed → pending/turn-error;
//   stopped → pending/interrupted)。
// 正文是另一个会话的模型输出 = 不可信输入:只原样存盘、原样给本机界面;进模型之前只经 xsession-envelope 的中和。
// 日志只带消息 id,不带正文与凭据;凭据(token)只出现在认领应答里,不进任何列表应答与广播(publicMessage 是白名单)。
// 依赖只朝一个方向:本模块经 chat.js 导出的窄接口挂钩子,chat.js 不认识本模块。
import { randomUUID, timingSafeEqual } from 'crypto';
import { broadcast } from '../broadcast.js';
import { readXsEnabledSync } from '../routes/prefs.js';
import { registerSessionRuntimeHooks, deliverRunEvent } from '../routes/chat.js';
import { findSessionFile, isSessionIdShape } from './session-reader.js';
import { XS_LIMITS, XS_STATUSES, XsStorageError, isOpenStatus, listXsMessages, mutateXsInbox, readXsBody } from './xsession-store.js';
import { buildXsEnvelope, neutralizeXsBody } from './xsession-envelope.js';

export const XS_DISABLED_TEXT = '跨会话消息未开启';
export const XS_CLAIM_INVALID_TEXT = '跨会话消息凭据无效';
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
const NEVER_STARTED_SUMMARY = '未能开始处理';

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

// ── /chat 路由入口:兑换凭据、换成信封、绑定回合;回合开始补 xs_message;回合结束结算 ─────────────────

// 已兑换、还没结算的消息:id → { key(本次兑换的回合标识), event(预先备好的 xs_message), timer, pid }。
// 回合开始通知是同步的,事件必须在那一刻同步投递才能排在本回合 CLI 输出之前,所以正文在兑换时就读好、中和好。
const inflight = new Map();
let redeeming = 0; // 正在兑换(还没进 inflight)的请求数:关开关时不能在这期间撤掉回合钩子
// 兑换后迟迟等不到回合开始(chat.js 在起回合前抛了异常)→ 退回 pending,免得卡在 processing 直到重启。
// 正常情况回合开始只比兑换晚几秒(复用路径最多等热切 5 秒,冷启路径最多等旧进程收尾 4 秒)。
const START_GUARD_MS = 60_000;

const reject = (status, code, error) => ({ reject: { status, body: { ok: false, code, error } } });
const claimInvalid409 = () => new XsError(409, 'XS_CLAIM_INVALID', XS_CLAIM_INVALID_TEXT);

function tokenMatches(stored, given) {
  if (typeof stored !== 'string' || typeof given !== 'string') return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * chatEntry 钩子。请求里两个新字段都没带 → 立即 null(不读盘、不做别的,总开关开关都一样)。
 * 带了:总开关关 → 409 XS_DISABLED(先于字段形状);只带一个或形状不对 → 400 XS_CLAIM_INVALID;
 * 消息不存在 / 凭据对不上 / 不是 claimed / 目标不是请求的 sessionId → 409 XS_CLAIM_INVALID;都不起进程。
 * 通过 → { prompt: 信封, tag }。自己兜住所有错误(抛出去会变成 500 CHAT_ENTRY_HOOK_FAILED)。
 */
export async function xsChatEntry({ body, sessionId } = {}) {
  const hasId = body?.xsMessageId !== undefined;
  const hasToken = body?.xsToken !== undefined;
  if (!hasId && !hasToken) return null;
  if (!readXsEnabledSync()) return reject(409, 'XS_DISABLED', XS_DISABLED_TEXT);
  if (!isIdString(body.xsMessageId) || !isIdString(body.xsToken)) return reject(400, 'XS_CLAIM_INVALID', XS_CLAIM_INVALID_TEXT);
  // 开关以偏好文件为准(与路由闸门同源):文件里是开着的,就确保回合钩子在位,否则兑换后等不到补事件与结算。
  syncXsRuntimeHooks(true);
  redeeming += 1;
  try {
    return await redeemClaim(body.xsMessageId, body.xsToken, sessionId);
  } catch (e) {
    if (e instanceof XsError) return reject(e.status, e.code, e.message);
    console.warn(`[xsession] 兑换消息 ${body.xsMessageId} 失败:${e?.cause?.code || e?.message || e}`);
    return reject(500, 'STORAGE_WRITE_FAILED', XS_STORAGE_FAILED_TEXT);
  } finally {
    redeeming -= 1;
  }
}

async function redeemClaim(messageId, token, sessionId) {
  const key = randomUUID();
  const { m, text } = await mutateXsInbox(async (messages) => {
    const m = findById(messages, messageId);
    if (!m || m.status !== 'claimed' || !tokenMatches(m.token, token) || !sameId(m.to.sessionId, sessionId)) throw claimInvalid409();
    const text = await readXsBody(m.id);
    if (text === null) {
      console.warn(`[xsession] 消息 ${m.id} 的正文缺失,不兑换`);
      throw claimInvalid409();
    }
    m.status = 'processing';
    m.via = 'card';
    m.heldReason = null;
    for (const k of ['heldBefore', 'heldDetail', 'token']) delete m[k]; // 凭据只能兑换一次
    m.turn = { key };
    return { m: structuredClone(m), text };
  });
  const name = m.from.sessionId ? `用户转发自 ${m.from.title ?? ''}` : '用户';
  const prompt = buildXsEnvelope({ from: 'gui:user', name, body: text }); // 一期只有手动转发
  const event = {
    type: 'xs_message', id: m.id,
    from: { kind: m.from.kind, sessionId: m.from.sessionId ?? null, title: m.from.title ?? null },
    body: neutralizeXsBody(text), // 与模型收到的、历史里 origin.body 一致
    via: 'card', hop: m.hop,
  };
  const timer = setTimeout(() => { settleTurn(m.id, key, 'failed', NEVER_STARTED_SUMMARY); }, START_GUARD_MS);
  timer.unref?.();
  inflight.set(m.id, { key, event, timer, pid: null });
  announce([m]);
  return { prompt, tag: { xsMessageId: m.id, key } };
}

function inflightFor(tag) {
  const id = tag && typeof tag === 'object' ? tag.xsMessageId : null;
  const f = id ? inflight.get(id) : null;
  return f && f.key === tag.key ? { id, f } : null;
}

// 回合开始:补 xs_message(同步投递 → 排在本回合任何 CLI 输出之前),记下承载它的进程号与回合代数。
function onTurnStart(info) {
  const hit = inflightFor(info?.tag);
  if (!hit) return;
  const { id, f } = hit;
  clearTimeout(f.timer);
  f.timer = null;
  f.pid = info.pid;
  if (!deliverRunEvent(info.pid, f.event)) console.warn(`[xsession] 消息 ${id} 的 xs_message 未能投递`);
  mutateXsInbox((messages) => {
    const m = findById(messages, id);
    if (m && m.status === 'processing' && m.turn?.key === f.key) m.turn = { key: f.key, pid: info.pid, turnEpoch: info.turnEpoch };
  }).catch((e) => console.warn(`[xsession] 消息 ${id} 的回合绑定未能落盘:${e?.cause?.code || e?.message || e}`));
}

function onTurnEnd(info) {
  const hit = inflightFor(info?.tag);
  if (hit) settleTurn(hit.id, hit.f.key, info.outcome);
}

/** 结算一条 processing 的消息(只认本次兑换的回合 key,迟到的旧回合不动它)。 */
async function settleTurn(id, key, outcome, detail) {
  const f = inflight.get(id);
  if (f && f.key === key) {
    clearTimeout(f.timer);
    inflight.delete(id);
  }
  try {
    const m = await mutateXsInbox((messages) => {
      const m = findById(messages, id);
      if (!m || m.status !== 'processing' || m.turn?.key !== key) return null;
      delete m.turn;
      if (outcome === 'completed') {
        m.status = 'done'; // 正文由存储层删除
        m.heldReason = null;
      } else if (outcome === 'stopped') {
        m.status = 'pending';
        m.heldReason = 'interrupted';
      } else {
        m.status = 'pending';
        m.heldReason = 'turn-error';
        if (detail) m.heldDetail = detail;
      }
      return structuredClone(m);
    });
    if (m) await announce([m]);
  } catch (e) {
    // 写不进去:消息停在 processing,重启时恢复成 pending / interrupted(不自动重跑)
    console.warn(`[xsession] 消息 ${id} 的结算未能落盘:${e?.cause?.code || e?.message || e}`);
  }
  releaseTurnHooksIfIdle();
}

// ── 钩子挂接与总开关 ────────────────────────────────────────────────────────────────────────
// 总开关关时只挂 chatEntry(两个新字段都没带时立即返回 null = 零影响);开着时再挂回合开始 / 结束。
// 关掉时若还有已兑换、没结算的回合,回合钩子留到它们结算完再撤(否则它们永远等不到结算)。
let unhookEntry = null;
let unhookTurns = null;
let turnHooksWanted = false;

function releaseTurnHooksIfIdle() {
  if (unhookTurns && !turnHooksWanted && inflight.size === 0 && redeeming === 0) {
    unhookTurns();
    unhookTurns = null;
  }
}

/** 开关变化时调用(PUT /api/xsession/config 写盘成功后)。 */
export function syncXsRuntimeHooks(enabled) {
  turnHooksWanted = enabled === true;
  if (turnHooksWanted && !unhookTurns) unhookTurns = registerSessionRuntimeHooks({ turnStart: onTurnStart, turnEnd: onTurnEnd });
  releaseTurnHooksIfIdle();
}

/** 启动时调用一次(server/index.js,在开始接请求之前):挂 chatEntry,按当前开关挂回合钩子。 */
export function installXsessionRuntime() {
  if (!unhookEntry) unhookEntry = registerSessionRuntimeHooks({ chatEntry: xsChatEntry });
  syncXsRuntimeHooks(readXsEnabledSync());
}
