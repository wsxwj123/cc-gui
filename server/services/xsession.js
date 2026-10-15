// r151b T-X4:跨会话消息的核心(PLAN X.1.4、X.1.5、X.1.9;接口 X.3.1、X.3.3、X.3.6)。一期只有"人转发、人点处理":
//   转发 → 落成卡片(pending / target-card)→ 认领拿一次性凭据(claimed)→ 前端带凭据 POST /api/chat →
//   /chat 路由入口钩子兑换:请求的 prompt 换成服务端构造的信封、消息变 processing 并绑定到这一回合 →
//   回合开始时往事件流补一条 xs_message → 回合结束结算(completed → done;failed → pending/turn-error;
//   stopped → pending/interrupted)。
// 正文是另一个会话的模型输出 = 不可信输入:只原样存盘、原样给本机界面;进模型之前只经 xsession-envelope 的中和。
// 日志只带消息 id,不带正文与凭据;凭据(token)只出现在认领应答里,不进任何列表应答与广播(publicMessage 是白名单)。
// 依赖只朝一个方向:本模块经 chat.js 导出的窄接口挂钩子,chat.js 不认识本模块。
import { randomUUID, timingSafeEqual } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { readFileSync, statSync } from 'fs';
import { join, posix as posixPath, win32 as win32Path } from 'path';
import { homedir } from 'os';
import { broadcast } from '../broadcast.js';
import { readXsEnabledSync, readXsPrefsSync, updatePrefs } from '../routes/prefs.js';
import { registerSessionRuntimeHooks, deliverRunEvent, getActiveChatProcesses, preToolUseGuardTimeoutAt, startInternalTurn, summarizeTurnError } from '../routes/chat.js';
import { findSessionFile, isSessionIdShape } from './session-reader.js';
import { XS_LIMITS, XS_STATUSES, XsStorageError, clearXsInbox, isOpenStatus, listXsMessages, mutateXsInbox, readXsBody } from './xsession-store.js';
import { XS_PROFILE_MODES, XS_PROFILE_REPLAY_KEYS, dropXsProfile, mutateXsProfiles, readXsProfiles } from './xsession-store.js';
import { chainForNewTurn, decideRoute, providerFingerprint } from './xsession-policy.js';
import { createAutoBudget, createXsScheduler } from './xsession-scheduler.js';
import { assignShortIds, resolveTarget } from './xsession-resolve.js';
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

// heldReason → heldText(全角标点)。turn-error、wake-failed 后面接摘要 / 原因(heldDetail)。r151c 加自动处理的六种。
const HELD_TEXT = {
  'target-card': '等待你确认后处理',
  interrupted: '上次处理被中断',
  'chain-limit': `已到连锁上限（${XS_LIMITS.chainDepth} 次）`,
  paused: '自动处理已暂停',
  'no-profile': '没有可用的发送设置，需在该会话里手动处理',
  'profile-stale': '该会话上次发送后切换过 provider，需在该会话里手动处理一次',
  'class-mismatch': '发送方与目标会话的权限类别不同（一方是「放任」档、另一方不是），不自动处理',
  'target-stuck': '目标会话的上一条消息还没处理完',
};
const WAKE_FAILED_PREFIX = '未能开始处理：';
const TURN_ERROR_PREFIX = '处理该消息的回合出错：';
// failed 的摘要取回合结束通知带的 errorSummary(chat.js 已脱敏、截短);取不到时用这句固定话。"始终没开始回合"有自己的摘要。
const TURN_FAILED_SUMMARY = '模型返回了错误或进程提前退出';
const NEVER_STARTED_SUMMARY = '未能开始处理';

function heldTextOf(m) {
  if (m.status !== 'pending' || !m.heldReason) return null;
  if (m.heldReason === 'turn-error') return TURN_ERROR_PREFIX + (m.heldDetail || TURN_FAILED_SUMMARY);
  if (m.heldReason === 'wake-failed') return WAKE_FAILED_PREFIX + (m.heldDetail || NEVER_STARTED_SUMMARY);
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

// r151c 先修 5:删会话(dropXsMessagesForSession)只抹已结束记录里该会话的标题;那一刻还没结束、以它为来源的消息不动
// (卡片与信封还要用来源标题)。这些消息之后才结束(结算、忽略)时,在变为已结束的同一事务里补抹:来源会话的记录文件已不在
// → from.title 抹成空字符串(与 from.deleted 同一判据)。查不出时不动,不让结算 / 忽略因此失败。
async function eraseTitleIfSourceDeleted(m) {
  const sid = m.from?.sessionId;
  if (!sid || !m.from.title) return;
  try {
    if (!(await findSessionFile(sid))) m.from.title = '';
  } catch (e) {
    console.warn(`[xsession] 消息 ${m.id} 的来源会话查不出,来源标题未处理:${e?.code || e?.message || e}`);
  }
}

/** pending / queued / claimed → dismissed;正文随即删除(存储层在消息结束时删),认领过的凭据作废。 */
export async function dismissMessage(id) {
  assertMessageId(id);
  const m = await mutateXsInbox(async (messages) => {
    const m = findById(messages, id);
    if (!m) throw notFound();
    if (!['pending', 'queued', 'claimed'].includes(m.status)) throw new XsError(409, 'XS_NOT_PENDING', '这条消息不是待处理状态', { status: m.status });
    m.status = 'dismissed';
    m.heldReason = null;
    for (const k of ['heldBefore', 'heldDetail', 'token']) delete m[k];
    await eraseTitleIfSourceDeleted(m);
    return structuredClone(m);
  });
  await announce([m]);
  return { ok: true, id: m.id, status: 'dismissed' };
}

// ── 目标会话在本 GUI 里被删除(接口 X.3.6 末尾 2026-10-15 补的第一条)──────────────────────────────────
/**
 * DELETE /api/sessions/:sessionId 删掉记录文件之后调用:以它为目标、还没结束的消息连同正文一并删除(否则待处理条数与
 * Dock 角标会留下用户没处可清的数字),每条广播一次 xs:message。记录已不在,广播里 status 记为 dismissed(前端按
 * "已结束"收起卡片、减掉计数)。不看总开关:关着时留下的待处理,之后打开照样会计数;收件箱文件不存在时什么都不写。
 * 已结束(done / dismissed)的只剩元数据:其中该会话的标题(来源或目标一侧)抹成空字符串(标题常是首条提问原文,
 * 会话删了不再留着;接口 X.3.6 审计后补)。以它为来源、还没结束的消息不动(卡片与信封还要用来源标题)。返回删掉的条数。
 */
export async function dropXsMessagesForSession(sessionId) {
  if (!isIdString(sessionId)) return 0;
  const removed = await mutateXsInbox((messages) => {
    const gone = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (isOpenStatus(m.status)) {
        if (sameId(m.to?.sessionId, sessionId)) gone.unshift(...messages.splice(i, 1));
        continue;
      }
      if (m.to && sameId(m.to.sessionId, sessionId) && m.to.title) m.to.title = '';
      if (m.from && sameId(m.from.sessionId, sessionId) && m.from.title) m.from.title = '';
    }
    return gone; // 存储层在写盘成功后删掉这些消息的正文
  });
  if (!removed.length) return 0;
  for (const m of removed) dropInflight(m.id); // 已兑换 / 自动投递、还没结算的:它的回合不会再来结算了(或结算时找不到记录)
  await announce(removed.map((m) => ({ ...m, status: 'dismissed', heldReason: null })));
  releaseTurnHooksIfIdle();
  return removed.length;
}

/**
 * POST /api/xsession/clear 的业务(路由层已确认总开关关着):清空收件箱(记录、正文、损坏留存),返回删掉的消息总条数。
 * 已兑换、还没结算的回合记录已不在,不会再结算:撤掉它们的定时器与登记。不广播(开关关着时界面不显示卡片与计数)。
 */
export async function clearAllXsMessages() {
  const removed = await clearXsInbox();
  for (const id of [...inflight.keys()]) dropInflight(id);
  queuedHint.clear();
  releaseTurnHooksIfIdle();
  return removed;
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
export async function xsChatEntry({ body, sessionId, internal } = {}) {
  if (internal) return xsInternalEntry(internal, sessionId); // r151c:服务端自己起的自动处理回合(HTTP 请求恒为 null)
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
  // r151c A11:按来源种类构造信封 —— 会话里的 AI 发来的(kind:'session')来源是发送方会话、来源名是发送时存下的发送方标题;
  // 用户手动转发的是 gui:user 与"用户转发自 <标题>"/"用户"。
  const fromSession = m.from.kind === 'session' && isIdString(m.from.sessionId);
  const name = fromSession ? (m.from.title ?? '') : (m.from.sessionId ? `用户转发自 ${m.from.title ?? ''}` : '用户');
  const prompt = buildXsEnvelope({ from: fromSession ? `gui:${m.from.sessionId}` : 'gui:user', name, body: text });
  const event = {
    type: 'xs_message', id: m.id,
    from: { kind: m.from.kind, sessionId: m.from.sessionId ?? null, title: m.from.title ?? null },
    body: neutralizeXsBody(text), // 与模型收到的、历史里 origin.body 一致
    via: 'card', hop: m.hop,
  };
  const timer = setTimeout(() => { settleTurn(m.id, key, 'failed', NEVER_STARTED_SUMMARY); }, START_GUARD_MS);
  timer.unref?.();
  inflight.set(m.id, { key, event, timer, pid: null, sessionId: m.to.sessionId });
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
  noteTurnStartProfile(info);
  const hit = inflightFor(info?.tag);
  noteTurnStartChain(info, hit);
  if (!hit) return;
  const { id, f } = hit;
  clearTimeout(f.timer);
  f.timer = null;
  f.pid = info.pid;
  if (f.auto) f.started = true; // 自动处理:回合开始了 → 只等结束通知(方案 A3)
  if (!deliverRunEvent(info.pid, f.event)) console.warn(`[xsession] 消息 ${id} 的 xs_message 未能投递`);
  mutateXsInbox((messages) => {
    const m = findById(messages, id);
    if (m && m.status === 'processing' && m.turn?.key === f.key) m.turn = { key: f.key, pid: info.pid, turnEpoch: info.turnEpoch };
  }).catch((e) => console.warn(`[xsession] 消息 ${id} 的回合绑定未能落盘:${e?.cause?.code || e?.message || e}`));
}

function onTurnEnd(info) {
  noteTurnEndProfile(info);
  noteTurnEndChain(info);
  const hit = inflightFor(info?.tag);
  const detail = typeof info?.errorSummary === 'string' && info.errorSummary.trim() ? info.errorSummary : undefined;
  if (hit?.f.auto) {
    // 自动处理:结束通知与内部入口的应答谁先到都行;两样都到了才结算(failed 没有摘要时用应答里的原因)
    hit.f.ended = { outcome: info.outcome, detail };
    if (hit.f.responded) finishAutoTurn(hit.id, hit.f);
  } else if (hit) settleTurn(hit.id, hit.f.key, info.outcome, detail);
  if (info?.sessionId) scheduler.noteTurnEnd(info.sessionId); // 目标转空闲:有排队的,满 1.5 秒仍空闲再投
}

/** 结算一条 processing 的消息(只认本次兑换的回合 key,迟到的旧回合不动它)。 */
async function settleTurn(id, key, outcome, detail) {
  dropInflight(id, key);
  try {
    const m = await mutateXsInbox(async (messages) => {
      const m = findById(messages, id);
      if (!m || m.status !== 'processing' || m.turn?.key !== key) return null;
      delete m.turn;
      if (outcome === 'completed') {
        m.status = 'done'; // 正文由存储层删除
        m.heldReason = null;
        await eraseTitleIfSourceDeleted(m); // r151c 先修 5
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

// ── 原生 SendMessage 引导(T-X6;PLAN X.1.1,接口行为清单 25)──────────────────────────────────────
// 总开关开着时,会话里的模型(含子代理,它们的调用也经过本会话的 PreToolUse 回调)用 CLI 原生 SendMessage 发给本 GUI
// 的另一个会话 → 拒绝,让 GUI 会话之间只走 GUI 通道(卡片、上限不被绕过)。目标只按 CLI 的会话登记表认,不碰套接字。
// 失效(读不到登记表 / 内部出错 / chat.js 那边等了 2 秒没结果)→ 放行(= 现状),记日志并记下 nativeGuard.lastFailureAt 给设置块显示。
// H5b 实测(2026-10-15,CLI 2.1.296):SDK 的 default / bypassPermissions / auto / plan 四档下,回调拒绝都生效、
// 原因原样成为模型看到的工具结果;回调输入的 tool_input 带 CLI 补的 recipient 与 recipient_kind。
export const NATIVE_GUARD_REASON = '这个会话由 CC-GUI 管理，不接收经 SendMessage 发来的消息。如需把内容交给它，请告诉用户在 CC-GUI 里转发。';

let nativeGuardLastFailureAt = null;
export function noteNativeGuardFailure(at = new Date()) {
  nativeGuardLastFailureAt = at.toISOString();
}
// 两个来源取较晚的:本模块记的(读不到登记表 / 内部出错)与 chat.js 记的(守卫 2 秒没给结果)。ISO 字符串定长,按字符串比较即先后。
export function nativeGuardLastFailure() {
  const own = nativeGuardLastFailureAt;
  const timedOut = preToolUseGuardTimeoutAt();
  return own && timedOut ? (own > timedOut ? own : timedOut) : (own || timedOut);
}

// 套接字地址的比较口径(审计 S2 / 判官建议 10;目标与登记表两边同一口径):去掉 uds: 前缀;
//   · Windows 命名管道(\\.\pipe\…,斜杠方向不限)或在 Windows 上:按 Windows 规范化,名字不区分大小写 → 统一小写;
//   · 其余按 POSIX 规范化:合并重复斜杠、解析 . 与 ..、去掉结尾斜杠;/private/tmp 与 /tmp 是同一处(macOS 的 /tmp 是它的链接)。
//   · macOS(r151c 先修 3):默认文件系统不区分大小写,只差大小写的两个地址指向同一个套接字 → 两边统一转小写
//     (先转小写再认 /private/tmp,/Private/Tmp 也算)。只会多拒、不会漏拒;套接字名是 <pid>.sock,不会因此误伤别的会话。
const WIN_PIPE_RE = /^[\\/]{2}[.?][\\/]pipe[\\/]/i;
function socketKey(p) {
  const s = String(p).replace(/^uds:/i, '');
  if (process.platform === 'win32' || WIN_PIPE_RE.test(s)) return win32Path.normalize(s).toLowerCase();
  let n = posixPath.normalize(s);
  if (process.platform === 'darwin') n = n.toLowerCase();
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  if (n === '/private/tmp' || n.startsWith('/private/tmp/')) n = n.slice('/private'.length);
  return n;
}

// 发送目标由模型填写(可被提示词注入操纵),回调又跑在权限弹卡之前:超过这个长度的不可能是会话名或套接字地址,
// 直接判"不是 GUI 会话目标",后面的字符串处理只碰有界的输入。
const NATIVE_TARGET_MAX_CHARS = 512;

// ListAgents 把会话显示为"名字 [短号]":结尾(去空白后)是 "[…]" 且括号里没有 "]" 时去掉它。
// r151c 先修 3 实测(真 CLI 2.1.296,隔离 HOME、只连本地假接口):CLI 按名字找会话不区分大小写(mixcase-alpha、
// MIXCASE-ALPHA 都送到 MixCase-Alpha;重名时只回候选、不送达);"名字 [短号]"要名字(不分大小写)与短号(区分大小写)
// 都对上才送达,名字前缀加短号、单独的短号都不送达。短号是每个进程自己的 6 位十六进制,登记表任何字段(含 .key 文件)
// 都推不出来 → 没法按条目精确判:去掉短号只按名字认。偏严:同名的 GUI 会话与终端会话并存、短号指向终端那个时会误拒;
// 不会漏拒。
// 用 lastIndexOf / indexOf 线性判,不用带回溯的正则(审计 I1:"\s*\[[^\]]*\]\s*$" 对长输入是平方级)。
function stripShortIdSuffix(raw) {
  const s = raw.trim();
  if (!s.endsWith(']')) return s;
  const open = s.lastIndexOf('[');
  if (open < 0 || s.indexOf(']', open) !== s.length - 1) return s;
  return s.slice(0, open).trim();
}

/** SendMessage 的目标 → { kind:'name'|'session', value } | null(其它种类:main、子代理、bridge:、did: 等,一律不管;超长也不管)。 */
function nativeTargetOf(toolInput) {
  const raw = typeof toolInput?.recipient === 'string' ? toolInput.recipient : (typeof toolInput?.to === 'string' ? toolInput.to : '');
  if (!raw || raw.length > NATIVE_TARGET_MAX_CHARS) return null;
  // recipient_kind 是 CLI 补的;万一没补(别的 CLI 版本),按 to 的写法推:uds: 开头是地址,否则当名字(只有命中登记表才会拒)
  const kind = toolInput.recipient_kind ?? (/^uds:/i.test(raw) ? 'session' : 'name');
  if (kind === 'name') return { kind, value: stripShortIdSuffix(raw) };
  if (kind === 'session') return { kind, value: socketKey(raw) };
  return null;
}

// 已解析好的目标对登记表判定(xsNativeGuard 与 nativeGuardShouldDeny 共用,目标每次调用只解析一次)。
function targetIsOtherGuiSession(target, entries, guiSessionIds, selfSessionId) {
  if (!target || !target.value) return false;
  const gui = new Set([...guiSessionIds].filter((id) => typeof id === 'string').map((id) => id.toLowerCase()));
  return entries.some((e) => {
    if (!e || typeof e.sessionId !== 'string' || !gui.has(e.sessionId.toLowerCase()) || sameId(e.sessionId, selfSessionId)) return false;
    return target.kind === 'name' // 会话名不区分大小写(换个大小写不能绕过引导)
      ? typeof e.name === 'string' && e.name.toLowerCase() === target.value.toLowerCase()
      : typeof e.messagingSocketPath === 'string' && socketKey(e.messagingSocketPath) === target.value;
  });
}

/**
 * 纯判定:这次 SendMessage 要不要拒。命中登记表里的条目、条目的会话属于 GUI 当前的进程槽、且不是发送方自己 → 拒。
 * entries:登记表条目;guiSessionIds:GUI 存活进程槽的会话 id;selfSessionId:发送方会话。
 */
export function nativeGuardShouldDeny(toolInput, entries, guiSessionIds, selfSessionId) {
  return targetIsOtherGuiSession(nativeTargetOf(toolInput), entries, guiSessionIds, selfSessionId);
}

// CLI 会话登记表 <配置目录>/sessions/*.json(GUI 全仓按 ~/.claude 取配置目录)。目录读不出 → 抛出(算失效);
// 单个文件读不出或不是 JSON(正被改写、或刚随进程退出删掉)→ 跳过这一个。
async function readCliRegistry() {
  const dir = join(homedir(), '.claude', 'sessions');
  const entries = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json')) continue;
    try { entries.push(JSON.parse(await readFile(join(dir, f), 'utf-8'))); } catch { /* 跳过这一个 */ }
  }
  return entries;
}

function nativeGuardFailed(why) {
  noteNativeGuardFailure();
  console.warn(`[xsession] 原生 SendMessage 引导未能检查目标,本次放行:${why}`);
  return null;
}

/** preToolUse 钩子:只看 SendMessage;拒绝时返回 PreToolUse 的 deny 输出,其余返回 null(既有判定照常)。 */
export async function xsNativeGuard(input, ctx) {
  if (input?.tool_name !== 'SendMessage') return null;
  try {
    if (!readXsEnabledSync()) return null; // 开关以偏好文件为准(与路由闸门同源):关着一律不管
    const target = nativeTargetOf(input.tool_input);
    if (!target) return null;
    let entries;
    try { entries = await readCliRegistry(); } catch (e) { return nativeGuardFailed(`读不到 CLI 会话登记表(${e?.code || e?.message || e})`); }
    const guiSessionIds = getActiveChatProcesses().filter((p) => p.sessionId && p.exitCode == null).map((p) => p.sessionId);
    if (!targetIsOtherGuiSession(target, entries, guiSessionIds, ctx?.sessionId)) return null;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: NATIVE_GUARD_REASON } };
  } catch (e) {
    return nativeGuardFailed(`内部出错(${e?.message || e})`);
  }
}

// ── r151c:发送档案(方案 A5 / A6 / A12 / A13)───────────────────────────────────────────────────────────────
// 开关开着时,每个回合开始按本回合的会话级参数记一份档案:replay(重放用:请求原值,model 为解析值)与 judge(判定用:界面档位、
// provider 指纹、记录时刻)。新会话首回合开始时还没有会话 id,到回合结束时补记。内容没变不写盘;本次启用之前记的档案即使内容
// 没变也重记一次(刷新记录时刻,否则重新打开开关后它永远不算数)。写失败只记日志:该会话按旧档案或没有档案判(偏安全)。
// 切档(/chat/permission-mode 200)同步改 replay.permissionMode 与 judge.mode;删会话时删档案(forgetXsSession)。
const TURN_RECORDS_MAX = 512;
const turnRecords = new Map(); // `${runId}:${turnEpoch}` → { sessionId(回合开始时的), params };回合开始记、结束删

let accountCache = { key: null, accountId: '' };
/** GUI 起会话时 CLI 读的那份配置里的 provider 身份(与起进程同源,不读宿主进程环境变量)。凭据原文只留在内存里、不出本函数的调用方。 */
function readProviderIdentitySync() {
  let settings = null;
  try { settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf-8')); } catch { /* 没有 / 损坏 → 全空 */ }
  const accountPath = join(homedir(), '.claude.json');
  try {
    const st = statSync(accountPath); // ~/.claude.json 可能很大且 CLI 常写:按修改时间 + 大小缓存解析结果
    const key = `${st.mtimeMs}:${st.size}`;
    if (accountCache.key !== key) {
      let id = '';
      try { id = JSON.parse(readFileSync(accountPath, 'utf-8'))?.oauthAccount?.accountUuid; } catch { /* 读不到为空串 */ }
      accountCache = { key, accountId: typeof id === 'string' ? id : '' };
    }
  } catch { accountCache = { key: null, accountId: '' }; }
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  return { settingsEnv: s.env, apiKeyHelper: s.apiKeyHelper, accountId: accountCache.accountId };
}

/** 当前配置的 provider 指纹(salt 取自档案文件,见 readXsProfiles)。 */
export function currentProviderFp(salt) {
  return providerFingerprint({ ...readProviderIdentitySync(), salt });
}

/** 档案是不是本次启用(xsEnabledAt)之后记录的;enabledAt 为 null 时一律不认。 */
export function profileIsCurrent(profile, enabledAt) {
  if (!profile || typeof enabledAt !== 'string') return false;
  const at = Date.parse(enabledAt);
  const rec = Date.parse(profile.judge?.recordedAt);
  return Number.isFinite(at) && Number.isFinite(rec) && rec >= at;
}

async function recordProfile(sessionId, params) {
  if (!isIdString(sessionId) || !params || typeof params !== 'object') return;
  const prefs = readXsPrefsSync();
  if (!prefs.enabled) return; // 档案只在开着时写(关开关时回合钩子会为在途回合多留一会儿)
  const body = params.body && typeof params.body === 'object' ? params.body : {};
  const replay = Object.fromEntries(XS_PROFILE_REPLAY_KEYS.map((k) => [k, body[k] === undefined ? null : body[k]]));
  const mode = params.guiMode;
  try {
    await mutateXsProfiles((d) => {
      const providerFp = currentProviderFp(d.salt);
      const prevKey = Object.keys(d.sessions).find((k) => sameId(k, sessionId));
      const prev = prevKey ? d.sessions[prevKey] : null;
      const same = prev && prev.judge.mode === mode && prev.judge.providerFp === providerFp && JSON.stringify(prev.replay) === JSON.stringify(replay);
      if (same && (profileIsCurrent(prev, prefs.enabledAt) || !prefs.enabledAt)) return; // 内容没变不写盘
      if (prevKey) delete d.sessions[prevKey];
      d.sessions[sessionId] = { replay, judge: { mode, providerFp, recordedAt: new Date().toISOString() } };
    });
  } catch (e) {
    console.warn(`[xsession] 会话 ${sessionId} 的发送档案未能落盘:${e?.cause?.code || e?.code || e?.message || e}`);
  }
}

function noteTurnStartProfile(info) {
  const params = info?.params;
  if (!params || typeof params !== 'object' || !info.runId) return;
  if (turnRecords.size >= TURN_RECORDS_MAX) turnRecords.delete(turnRecords.keys().next().value); // 兜底:没等到结束的回合不无限累积
  turnRecords.set(`${info.runId}:${info.turnEpoch | 0}`, { sessionId: info.sessionId || null, params });
  if (info.sessionId) recordProfile(info.sessionId, params);
}

function noteTurnEndProfile(info) {
  const key = `${info?.runId}:${info?.turnEpoch | 0}`;
  const rec = turnRecords.get(key);
  if (!rec) return;
  turnRecords.delete(key);
  if (!rec.sessionId && info.sessionId) recordProfile(info.sessionId, rec.params); // 新会话首回合:开始时还没有会话 id
}

// modeChange 钩子:切档生效(或会话没有进程)时同步该会话档案里的两处档位;没有档案不新建。
async function xsModeChange({ sessionId, mode } = {}) {
  if (!isIdString(sessionId) || !XS_PROFILE_MODES.includes(mode) || !readXsEnabledSync()) return;
  try {
    await mutateXsProfiles((d) => {
      for (const [k, p] of Object.entries(d.sessions)) {
        if (!sameId(k, sessionId)) continue;
        p.replay.permissionMode = mode;
        p.judge.mode = mode;
      }
    });
  } catch (e) {
    console.warn(`[xsession] 会话 ${sessionId} 的档案档位未能落盘:${e?.cause?.code || e?.code || e?.message || e}`);
  }
}

/** DELETE /api/sessions/:id 删掉记录文件之后调用:删该会话的发送档案(接收设置由 removeSessionFromPrefs 清)。不看总开关;文件不存在时什么都不写。 */
export async function forgetXsSession(sessionId) {
  if (!isIdString(sessionId)) return false;
  for (const [k, r] of turnRecords) if (sameId(r.sessionId, sessionId)) turnRecords.delete(k);
  for (const [k, r] of turnChains) if (sameId(r.sessionId, sessionId)) turnChains.delete(k); // 连锁标记与单回合发送计数
  scheduler.forget(sessionId);
  queuedHint.delete(sessionId.toLowerCase());
  return dropXsProfile(sessionId);
}

// ── r151c:自动处理(方案 A2 / A3 / A10 / A12,§3 调度与判定;接口 §4 去向表与错误总表)──────────────────────────────
// 消息到达(AI 发送)时按去向表判一次:落卡片的直接 pending;其余写成 queued,提交后通知调度器。调度器在目标会话的串行链上
// 评估:一次存储事务里把该会话的 queued 按去向表全部重判(不满足的转 pending)、取最早一条置 processing / via:auto /
// turn.key 并计数;事务提交之后才登记 inflight 并调内部入口起回合(入口钩子也读收件箱、走同一条存储队列,在事务里起回合会自锁)。
// 结算只看这条消息的回合有没有开始:开始了只等结束通知(completed → done、stopped → interrupted、failed → turn-error);
// 没开始(应答非 200 或抛错):409 CHAT_SESSION_BUSY → 退回 queued 等下一次;其余 → pending / wake-failed,不自动重试。
// 防失控:连锁深度 4(hop 记在消息上,标记记进回合记录)、单次 8 个目标、单回合 16 条、全局 10 分钟 20 次(触顶即暂停,
// 写盘 + 广播 xs:config,重启仍暂停,用户恢复时清窗口)。自动处理超过 30 分钟未结算 → 该会话"卡住":排队中的与新到的落
// target-stuck,直到那条结算;那个回合不被自动中止。时长一律在事件到来时拿 Date.now() 比较起算时刻(定时器只是提前叫醒)。
export const XS_STUCK_MS = 30 * 60_000;
const AUTO_PLACEHOLDER_PROMPT = '（跨会话消息）'; // 内部回合的占位 prompt:入口钩子随即整条换成信封
const queuedHint = new Set(); // 可能有 queued 消息的会话(小写);只用来省掉无谓的评估,真假以收件箱为准
let autoPausedMem = false; // 本进程内的暂停(触顶那一刻立即生效;写盘失败时也按它暂停)
const budget = createAutoBudget({ limit: XS_LIMITS.autoPerWindow, windowMs: XS_LIMITS.autoWindowMs });
const scheduler = createXsScheduler({ evaluate: evaluateSession, hasQueued: (id) => queuedHint.has(String(id).toLowerCase()) });

const isAutoPaused = (prefs) => autoPausedMem || prefs.autoPaused === true;
/** GET /api/xsession/config 的 autoPaused 与 autoBudget.used。 */
export function xsAutoState() {
  return { paused: isAutoPaused(readXsPrefsSync()), used: budget.used() };
}

/** 撤掉一条 inflight 登记(给了 key 时只撤这一次的)与它的定时器;返回撤掉的登记或 null。 */
function dropInflight(id, key) {
  const f = inflight.get(id);
  if (!f || (key !== undefined && f.key !== key)) return null;
  clearTimeout(f.timer);
  clearTimeout(f.stuckTimer);
  inflight.delete(id);
  return f;
}

// 目标忙:有正在跑的回合(判据同 findBusySlot)、或有已兑换 / 已投递还没结算的消息;调度投递时另把"刚转空闲、没满 1.5 秒"算作忙。
function targetBusy(sessionId, includeSettling) {
  if (includeSettling && scheduler.settling(sessionId)) return true;
  for (const f of inflight.values()) if (sameId(f.sessionId, sessionId)) return true;
  return getActiveChatProcesses().some((p) => sameId(p.sessionId, sessionId) && p.busy);
}
// 卡住:有一条自动处理的消息开始处理超过 30 分钟仍未结算(按此刻的 Date.now() 判)。
function targetStuck(sessionId) {
  const now = Date.now();
  for (const f of inflight.values()) if (f.auto && sameId(f.sessionId, sessionId) && now - f.startedAt > XS_STUCK_MS) return true;
  return false;
}
// 存活槽的界面档位(有就优先于档案,方案 A5)。
function liveGuiMode(sessionId) {
  let mode = null;
  for (const p of getActiveChatProcesses()) if (sameId(p.sessionId, sessionId) && p.exitCode === null && p.guiMode) mode = p.guiMode;
  return mode;
}
function fingerprintOrNull(salt) {
  try { return currentProviderFp(salt); } catch { return null; }
}
// 去向表里与目标有关的几项。判定与重放用同一读数的档位(targetMode)。
function targetFacts(sessionId, prefs, profiles, fp) {
  const inbound = Object.keys(prefs.inbound).some((k) => sameId(k, sessionId)) ? 'auto' : 'card';
  const pk = profiles ? Object.keys(profiles.sessions).find((k) => sameId(k, sessionId)) : null;
  const profile = pk ? profiles.sessions[pk] : null;
  return {
    inbound,
    hasProfile: profileIsCurrent(profile, prefs.enabledAt),
    profileFresh: !!profile && !!fp && profile.judge.providerFp === fp,
    targetMode: liveGuiMode(sessionId) ?? profile?.judge.mode ?? null,
    replay: profile?.replay ?? null,
  };
}
async function readProfilesQuietly() {
  try { return await readXsProfiles(); } catch (e) {
    console.warn(`[xsession] 读发送档案失败,按没有档案判:${e?.code || e?.message || e}`);
    return null;
  }
}

// ── 连锁标记与单回合发送计数:记进回合记录(键 runId:turnEpoch;回合结束后保留,回合结束后才发消息的后台任务读的仍是它)──
const TURN_CHAINS_MAX = 1024;
const turnChains = new Map(); // key → { sessionId, chain: { chainId, hop } | null, sends }
function rememberTurnChain(key, rec) {
  turnChains.delete(key);
  if (turnChains.size >= TURN_CHAINS_MAX) turnChains.delete(turnChains.keys().next().value);
  turnChains.set(key, rec);
  return rec;
}
function noteTurnStartChain(info, hit) {
  if (!info?.runId) return;
  const epoch = info.turnEpoch | 0;
  const plain = !hit && info.tag === undefined;
  const liveTasks = plain ? (getActiveChatProcesses().find((p) => p.pid === info.pid)?.liveTasks | 0) : 0;
  const previous = liveTasks > 0 ? (turnChains.get(`${info.runId}:${epoch - 1}`)?.chain ?? null) : null;
  rememberTurnChain(`${info.runId}:${epoch}`, { sessionId: info.sessionId || null, chain: chainForNewTurn({ redeemed: hit?.f ?? null, liveTasks, previous }), sends: 0 });
}
function noteTurnEndChain(info) {
  const rec = info?.runId ? turnChains.get(`${info.runId}:${info.turnEpoch | 0}`) : null;
  if (rec && !rec.sessionId && info.sessionId) rec.sessionId = info.sessionId; // 新会话首回合:开始时还没有会话 id
}
function senderTurnRecord({ runId, turnEpoch, sessionId }) {
  const key = `${runId}:${turnEpoch | 0}`;
  return turnChains.get(key) || rememberTurnChain(key, { sessionId: sessionId || null, chain: null, sends: 0 });
}

// ── 会话里的 AI 发消息(mcp__ccgui-sessions__send_message 的业务;接口 §4 错误总表的 ①④–⑧ 与单项失败)──────────────
export const XS_SEND_NOTICE = '发送后不会同步收到回复。对方若回复，会作为一条新的跨会话消息到达本会话。对方处理消息会消耗额度。';
const SEND_NOTE = {
  card: '对方设置为待处理，需其用户确认后才会处理',
  queued: '对方正在运行，回合结束后自动处理',
  auto: '对方将立即开始处理',
  merged: '与前面的目标是同一个会话，已合并',
};
const AI_TO_MAX_ITEMS = 32;
const AI_TO_ITEM_MAX_CHARS = 256;
const AI_MESSAGE_MAX_CHARS = 65536;
const XS_INTERNAL_TEXT = '发送失败，未投递任何消息';
// 字数按码点计;输入是另一个模型的输出,先看 UTF-16 长度,超了才逐个数(数到上限即停,不为超长输入分配大数组)。
function exceedsChars(s, max) {
  if (s.length <= max) return false;
  let n = 0;
  for (const _ of s) if (++n > max) return true; // eslint-disable-line no-unused-vars
  return false;
}

/**
 * sender = { sessionId, runId, turnEpoch, guiMode }(发送方槽在调用那一刻的值);rows = 已落盘会话行(与会话列表同一认定,
 * [{ sessionId, title, project, projectDir }])。整次失败抛 XsError(code 为 XS_DISABLED / XS_INTERNAL / XS_INVALID_INPUT /
 * XS_TOO_MANY_TARGETS / XS_BODY_TOO_LARGE / XS_TURN_SEND_LIMIT),一条不发、不计入 16;否则返回 { results, notice }。
 */
export async function sendAiMessages({ sender, to, message } = {}, rows) {
  const invalid = (msg) => new XsError(400, 'XS_INVALID_INPUT', msg);
  if (!readXsEnabledSync()) throw new XsError(409, 'XS_DISABLED', XS_DISABLED_TEXT);
  if (!isIdString(sender?.sessionId) || typeof sender.runId !== 'string' || !sender.runId) throw new XsError(500, 'XS_INTERNAL', '取不到发送方会话');
  const specs = typeof to === 'string' ? [to] : to;
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > AI_TO_MAX_ITEMS
    || !specs.every((x) => typeof x === 'string' && x.trim() && !exceedsChars(x, AI_TO_ITEM_MAX_CHARS))) {
    throw invalid(`to 须为会话 id 或标题：非空字符串，或 1–${AI_TO_MAX_ITEMS} 项的数组，每项不超过 ${AI_TO_ITEM_MAX_CHARS} 字`);
  }
  if (typeof message !== 'string' || !message.trim() || exceedsChars(message, AI_MESSAGE_MAX_CHARS)) {
    throw invalid(`message 须为非空字符串，不超过 ${AI_MESSAGE_MAX_CHARS} 字`);
  }
  const all = Array.isArray(rows) ? rows : [];
  const shortIds = assignShortIds(all.map((r) => r.sessionId));
  const sessions = all.map((r) => ({ ...r, shortId: shortIds.get(r.sessionId) }));
  const senderRow = sessions.find((r) => sameId(r.sessionId, sender.sessionId)) || null;
  // 解析并按会话去重(同一会话写两次只发一条);解析不了、是自己的项单独失败,不计入 8 个
  const items = [];
  const firstOf = new Map();
  for (const spec of specs) {
    const r = resolveTarget(spec, sessions);
    if (!r.ok) {
      items.push({ to: spec, fail: r.reason === 'ambiguous'
        ? { error: 'XS_TARGET_AMBIGUOUS', message: '有多个会话叫这个名字，请改用 id', candidates: r.candidates.map((c) => ({ id: c.shortId, name: c.title, project: c.project })) }
        : { error: 'XS_TARGET_NOT_FOUND', message: '没有叫这个名字的会话，请先调用 list_sessions' } });
      continue;
    }
    const k = r.session.sessionId.toLowerCase();
    if (sameId(k, sender.sessionId)) items.push({ to: spec, fail: { error: 'XS_SELF_TARGET', message: '不能发给当前会话自己' } });
    else if (firstOf.has(k)) items.push({ to: spec, key: k, merged: true });
    else { firstOf.set(k, r.session); items.push({ to: spec, key: k }); }
  }
  const targets = [...firstOf.values()];
  if (targets.length > XS_LIMITS.targetsPerSend) throw new XsError(400, 'XS_TOO_MANY_TARGETS', `一次最多发给 ${XS_LIMITS.targetsPerSend} 个会话`);
  const bodyBytes = Buffer.byteLength(message, 'utf8');
  if (bodyBytes > XS_LIMITS.bodyBytes) throw new XsError(400, 'XS_BODY_TOO_LARGE', `正文超过 ${XS_LIMITS.bodyBytes} 字节`);
  const rec = senderTurnRecord(sender);
  if (rec.sends + targets.length > XS_LIMITS.sendsPerTurn) throw new XsError(400, 'XS_TURN_SEND_LIMIT', `一个回合最多发 ${XS_LIMITS.sendsPerTurn} 条`);

  let outcome = new Map();
  if (targets.length) {
    rec.sends += targets.length; // 先占住名额(同一回合并发的两次调用不会一起越过 16),提交后按实际入箱数退回差额
    const prefs = readXsPrefsSync();
    const profiles = await readProfilesQuietly();
    const fp = profiles ? fingerprintOrNull(profiles.salt) : null;
    // 连锁:发送方当前回合的标记 + 1;没有标记 = 新链(同一次发送共用一个 chainId)
    const chainId = rec.chain?.chainId ?? randomUUID();
    const hop = (rec.chain?.hop ?? 0) + 1;
    const from = { kind: 'session', sessionId: senderRow ? senderRow.sessionId : sender.sessionId, title: senderRow ? senderRow.title : null, mode: typeof sender.guiMode === 'string' ? sender.guiMode : null };
    const createdAt = new Date().toISOString();
    try {
      outcome = await mutateXsInbox((messages, tx) => {
        const openOf = new Map(); // "待处理已满 50":自动处理这一路把 queued 也算进去(排着的同样占着用户的待办)
        for (const m of messages) {
          if (m.status === 'pending' || m.status === 'queued') openOf.set(m.to.sessionId.toLowerCase(), (openOf.get(m.to.sessionId.toLowerCase()) || 0) + 1);
        }
        const res = new Map();
        for (const t of targets) {
          const k = t.sessionId.toLowerCase();
          if ((openOf.get(k) || 0) >= XS_LIMITS.pendingPerSession) { res.set(k, { full: true }); continue; }
          const f = targetFacts(t.sessionId, prefs, profiles, fp);
          const route = decideRoute({
            manual: false, inbound: f.inbound, hop, paused: isAutoPaused(prefs), hasProfile: f.hasProfile, profileFresh: f.profileFresh,
            senderMode: from.mode, targetMode: f.targetMode, stuck: targetStuck(t.sessionId), busy: targetBusy(t.sessionId, false),
          });
          const m = {
            id: randomUUID(), createdAt, status: route.status === 'pending' ? 'pending' : 'queued', chainId, hop,
            from: { ...from }, to: { sessionId: t.sessionId, title: t.title, projectPath: t.projectDir ?? null },
            bodyBytes, via: null, heldReason: route.status === 'pending' ? route.heldReason : null,
          };
          messages.push(m);
          tx.putBody(m.id, message);
          res.set(k, { m: structuredClone(m), delivery: route.status === 'pending' ? 'card' : route.status === 'queued' ? 'queued' : 'auto' });
        }
        return res;
      });
    } catch (e) {
      rec.sends -= targets.length;
      if (e instanceof XsError) throw e;
      console.warn(`[xsession] AI 发送未能落盘:${e?.cause?.code || e?.code || e?.message || e}`);
      throw new XsError(500, 'XS_INTERNAL', XS_INTERNAL_TEXT);
    }
    const created = [...outcome.values()].filter((x) => x.m).map((x) => x.m);
    rec.sends -= targets.length - created.length; // 失败的目标不计入 16
    if (created.length) await announce(created);
    for (const m of created) {
      if (m.status !== 'queued') continue;
      queuedHint.add(m.to.sessionId.toLowerCase());
      scheduler.kick(m.to.sessionId);
    }
  }
  const noteOf = (x) => {
    if (x.delivery === 'card') return x.m.heldReason === 'target-card' ? SEND_NOTE.card : heldTextOf(x.m);
    return SEND_NOTE[x.delivery];
  };
  const results = items.map((it) => {
    if (it.fail) return { to: it.to, ok: false, ...it.fail };
    const x = outcome.get(it.key);
    if (x.full) return { to: it.to, ok: false, error: 'XS_INBOX_FULL', message: `目标会话的待处理消息已满（${XS_LIMITS.pendingPerSession} 条）` };
    const t = firstOf.get(it.key);
    return { to: it.to, ok: true, id: t.shortId, name: t.title, delivery: x.delivery, note: it.merged ? SEND_NOTE.merged : noteOf(x) };
  });
  return { results, notice: XS_SEND_NOTICE };
}

// ── 调度器的评估(每会话串行;见 xsession-scheduler.js)──────────────────────────────────────────────────────────
async function evaluateSession(sessionId) {
  const prefs = readXsPrefsSync();
  if (!prefs.enabled) return { queuedLeft: false, busy: false }; // 关着不投;排着的留到重新打开时重判(或重启转卡片)
  const profiles = await readProfilesQuietly();
  const fp = profiles ? fingerprintOrNull(profiles.salt) : null;
  const key = randomUUID();
  let noted = null; // 本次事务里记的那一次计数(写盘失败时退回)
  let pausedHere = false;
  let out;
  try {
    out = await mutateXsInbox(async (messages) => {
      const changed = [];
      let pick = null;
      let left = 0;
      let busy = targetBusy(sessionId, true);
      for (const m of messages) {
        if (m.status !== 'queued' || !sameId(m.to.sessionId, sessionId)) continue;
        const f = targetFacts(m.to.sessionId, prefs, profiles, fp);
        const route = decideRoute({
          manual: m.from?.kind !== 'session', inbound: f.inbound, hop: m.hop, paused: isAutoPaused(prefs), hasProfile: f.hasProfile,
          profileFresh: f.profileFresh, senderMode: m.from?.mode, targetMode: f.targetMode, stuck: targetStuck(sessionId), busy,
        });
        if (route.status === 'queued') { left += 1; continue; }
        if (route.status === 'pending') {
          m.status = 'pending';
          m.heldReason = route.heldReason;
          changed.push(structuredClone(m));
          continue;
        }
        const text = await readXsBody(m.id);
        let prompt = null;
        try { if (text !== null) prompt = buildXsEnvelope({ from: `gui:${m.from.sessionId}`, name: m.from.title ?? '', body: text }); } catch { prompt = null; }
        if (prompt === null || !f.replay?.cwd) {
          m.status = 'pending';
          m.heldReason = 'wake-failed';
          m.heldDetail = text === null ? '消息正文缺失' : '没有可用的发送设置';
          changed.push(structuredClone(m));
          continue;
        }
        m.status = 'processing';
        m.via = 'auto';
        m.heldReason = null;
        delete m.heldDetail;
        m.turn = { key };
        // 计数与"已暂停"判断在同一个存储事务里(各会话的事务在存储队列里串行):触顶那一刻起后面的都按暂停判
        noted = budget.note();
        if (noted.reached && !autoPausedMem) { autoPausedMem = true; pausedHere = true; }
        pick = { m: structuredClone(m), text, prompt, targetMode: f.targetMode, replay: f.replay };
        busy = true;
        changed.push(structuredClone(m));
      }
      return { changed, pick, left };
    });
  } catch (e) {
    if (noted) budget.refund(noted.stamp);
    if (pausedHere) autoPausedMem = false;
    console.warn(`[xsession] 会话 ${sessionId} 的排队消息未能处理(写盘失败,稍后再试):${e?.cause?.code || e?.message || e}`);
    return { queuedLeft: true, busy: true };
  }
  if (out.changed.length) announce(out.changed);
  if (out.pick) launchAuto(out.pick, key, noted.stamp);
  if (pausedHere) announceAutoPaused();
  if (out.left) queuedHint.add(sessionId.toLowerCase());
  else queuedHint.delete(sessionId.toLowerCase());
  return { queuedLeft: out.left > 0, busy: !!out.pick || targetBusy(sessionId, false) };
}

// 触顶:广播一次 xs:config;写 xsAutoPaused(失败只记日志,本进程内仍暂停);排着的都按暂停重判。
function announceAutoPaused() {
  broadcast({ type: 'xs:config', enabled: true, autoPaused: true });
  updatePrefs((p) => { p.xsAutoPaused = true; })
    .catch((e) => console.warn(`[xsession] 自动处理已暂停,暂停状态未能写盘(本进程内仍暂停):${e?.code || e?.message || e}`));
  kickAllXsQueued();
}

/** PUT /api/xsession/config {autoPaused:false} 写盘成功后:清内存暂停与 10 分钟窗口,对有 queued 的会话评估一次。 */
export function resumeXsAuto() {
  autoPausedMem = false;
  budget.clear();
  kickAllXsQueued();
}

/** 对收件箱里有 queued 消息的会话各评估一次(开关打开、恢复、触顶时)。 */
export async function kickAllXsQueued() {
  let list;
  try { list = await listXsMessages(); } catch { return; }
  const ids = new Map();
  for (const m of list) if (m.status === 'queued') ids.set(m.to.sessionId.toLowerCase(), m.to.sessionId);
  for (const id of ids.values()) {
    queuedHint.add(id.toLowerCase());
    scheduler.kick(id);
  }
}

/** PUT …/sessions/:id/inbound 写盘成功后:改成 card 时该会话排着的立即重判(落 target-card)。 */
export function noteXsInboundChanged(sessionId) {
  if (queuedHint.has(String(sessionId).toLowerCase())) scheduler.kick(sessionId);
}

// 事务提交之后:登记 inflight(信封、补发事件、30 分钟卡住提醒),再经内部入口起回合。
function launchAuto(pick, key, budgetStamp) {
  const { m, text, prompt, targetMode, replay } = pick;
  const sessionId = m.to.sessionId;
  const event = {
    type: 'xs_message', id: m.id,
    from: { kind: 'session', sessionId: m.from.sessionId, title: m.from.title ?? null },
    body: neutralizeXsBody(text), via: 'auto', hop: m.hop,
  };
  const stuckTimer = setTimeout(() => scheduler.kick(sessionId), XS_STUCK_MS + 1000);
  stuckTimer.unref?.();
  inflight.set(m.id, {
    key, event, timer: null, stuckTimer, pid: null, sessionId, auto: true, chainId: m.chainId, hop: m.hop, prompt,
    startedAt: Date.now(), started: false, responded: null, ended: null, budgetStamp,
  });
  // 重放档案:去掉值为 null 的键,档位用判定时的同一读数
  const body = { ...Object.fromEntries(Object.entries(replay).filter(([, v]) => v !== null)), sessionId, prompt: AUTO_PLACEHOLDER_PROMPT, permissionMode: targetMode };
  let call;
  try { call = startInternalTurn(body, { kind: 'xs-auto', messageId: m.id, key }); } catch (e) { call = Promise.reject(e); }
  call.then((res) => onAutoResponse(m.id, key, res), (e) => onAutoResponse(m.id, key, { status: 0, body: { error: e?.message || String(e) } }));
}

// 内部入口应答里的原因 → 给人看的一行(脱敏、≤200 字);200 为 null。
function responseReason(res) {
  if (!res || res.status === 200) return null;
  const b = res.body && typeof res.body === 'object' ? res.body : {};
  const raw = typeof b.error === 'string' && b.error.trim() ? b.error : typeof b.code === 'string' ? b.code : `HTTP ${res.status}`;
  return summarizeTurnError(raw) || `HTTP ${res.status}`;
}

function onAutoResponse(id, key, res) {
  const f = inflight.get(id);
  if (!f || f.key !== key) return;
  f.responded = res;
  if (res.status === 200) broadcast({ type: 'xs:turn', sessionId: f.sessionId, pid: res.body?.pid ?? f.pid ?? null, messageId: id });
  if (f.started) { // 回合开始了:只等结束通知(若它已先到,现在结算)
    if (f.ended) finishAutoTurn(id, f);
    return;
  }
  if (res.status === 409 && res.body?.code === 'CHAT_SESSION_BUSY') return requeueAuto(id, f); // 目标正忙:回 queued 等下一次
  settleNotStarted(id, f, responseReason(res) || '回合没有开始');
}

function finishAutoTurn(id, f) {
  const { outcome, detail } = f.ended;
  settleTurn(id, f.key, outcome, detail || (outcome === 'failed' ? responseReason(f.responded) || undefined : undefined))
    .then(() => scheduler.kick(f.sessionId));
}

// 回合没开始的两种结算:退回排队(不算一次自动处理)/ 转卡片 wake-failed(不自动重试)。
async function settleAutoNotStarted(id, f, apply) {
  dropInflight(id, f.key);
  budget.refund(f.budgetStamp);
  try {
    const m = await mutateXsInbox((messages) => {
      const m = findById(messages, id);
      if (!m || m.status !== 'processing' || m.turn?.key !== f.key) return null;
      delete m.turn;
      apply(m);
      return structuredClone(m);
    });
    if (m) {
      if (m.status === 'queued') queuedHint.add(f.sessionId.toLowerCase());
      await announce([m]);
    }
  } catch (e) {
    console.warn(`[xsession] 消息 ${id} 的结算未能落盘:${e?.cause?.code || e?.message || e}`);
  }
  releaseTurnHooksIfIdle();
  scheduler.kick(f.sessionId);
}
function requeueAuto(id, f) {
  return settleAutoNotStarted(id, f, (m) => { m.status = 'queued'; m.via = null; });
}
function settleNotStarted(id, f, reason) {
  return settleAutoNotStarted(id, f, (m) => { m.status = 'pending'; m.heldReason = 'wake-failed'; m.heldDetail = reason; });
}

// r151c:经 startInternalTurn 起的自动处理回合(internal = { kind:'xs-auto', messageId, key })。调度器已在存储事务里把消息
// 置为 processing、绑定 turn.key,并登记了 inflight(信封、补发事件);这里只核对、不改任何状态(内部请求遇忙的 409 在入口
// 钩子之后才回,有副作用就收不回来)。
async function xsInternalEntry(internal, sessionId) {
  if (internal.kind !== 'xs-auto' || !isIdString(internal.messageId) || typeof internal.key !== 'string') return reject(400, 'XS_CLAIM_INVALID', XS_CLAIM_INVALID_TEXT);
  if (!readXsEnabledSync()) return reject(409, 'XS_DISABLED', XS_DISABLED_TEXT);
  const f = inflight.get(internal.messageId);
  if (!f || !f.auto || f.key !== internal.key) return reject(409, 'XS_CLAIM_INVALID', XS_CLAIM_INVALID_TEXT);
  try {
    const current = await mutateXsInbox((messages) => {
      const m = findById(messages, internal.messageId);
      return !!m && m.status === 'processing' && m.turn?.key === internal.key && sameId(m.to.sessionId, sessionId);
    });
    if (!current) return reject(409, 'XS_CLAIM_INVALID', XS_CLAIM_INVALID_TEXT);
  } catch (e) {
    console.warn(`[xsession] 自动处理消息 ${internal.messageId} 核对失败:${e?.cause?.code || e?.message || e}`);
    return reject(500, 'STORAGE_WRITE_FAILED', XS_STORAGE_FAILED_TEXT);
  }
  return { prompt: f.prompt, tag: { xsMessageId: internal.messageId, key: internal.key } };
}

// ── 钩子挂接与总开关 ────────────────────────────────────────────────────────────────────────
// 总开关关时只挂 chatEntry(两个新字段都没带时立即返回 null = 零影响);开着时再挂回合开始 / 结束与原生引导。
// 关掉时若还有已兑换、没结算的回合,回合钩子留到它们结算完再撤(否则它们永远等不到结算);原生引导随开关即撤。
let unhookEntry = null;
let unhookTurns = null;
let unhookGuard = null;
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
  // r151c:切档通知(同步发送档案的档位)与原生引导同一生命周期:随开关即挂即撤
  if (turnHooksWanted && !unhookGuard) unhookGuard = registerSessionRuntimeHooks({ preToolUse: xsNativeGuard, modeChange: xsModeChange });
  else if (!turnHooksWanted && unhookGuard) {
    unhookGuard();
    unhookGuard = null;
  }
  releaseTurnHooksIfIdle();
}

/** 启动时调用一次(server/index.js,在开始接请求之前):挂 chatEntry,按当前开关挂回合钩子。 */
export function installXsessionRuntime() {
  if (!unhookEntry) unhookEntry = registerSessionRuntimeHooks({ chatEntry: xsChatEntry });
  syncXsRuntimeHooks(readXsEnabledSync());
  backfillXsEnabledAt();
}

// 主会话裁定(2026-10-15):总开关开着、却没有(合法的)启用时刻 = 一期升级上来的用户 → 启动时补记一次。一期从未写过档案,
// 补记不会让任何旧档案生效。关着时什么都不写(行为与改动前相同)。写失败只记日志:没有启用时刻时所有档案都不认(偏安全)。
function backfillXsEnabledAt() {
  const prefs = readXsPrefsSync();
  if (!prefs.enabled || prefs.enabledAt) return;
  updatePrefs((p) => {
    const valid = typeof p.xsEnabledAt === 'string' && !Number.isNaN(Date.parse(p.xsEnabledAt));
    if (p.xsEnabled === true && !valid) p.xsEnabledAt = new Date().toISOString();
  }).catch((e) => console.warn(`[xsession] 启动时补记启用时刻失败:${e?.code || e?.message || e}`));
}
