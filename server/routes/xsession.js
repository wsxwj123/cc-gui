// r151b:跨会话消息的 HTTP 接口(接口 X.3.1)。挂在 /api 下,在 index.js 的 authMiddleware 之后(同既有鉴权)。
// 错误体一律 { ok:false, code, error }。【二期】接口一期不存在(总开关开着时落到 404)。
import { Router } from 'express';
import { broadcast } from '../broadcast.js';
import { isAuthorized } from '../services/auth.js';
import { loadPrefs, readXsEnabledSync, updatePrefs } from './prefs.js';
import { getActiveChatProcesses } from './chat.js';
import { listProjects, listSessions, isSessionIdShape } from '../services/session-reader.js';
import { XS_LIMITS, XsStorageError, pendingCountsBySession } from '../services/xsession-store.js';
import {
  XS_DISABLED_TEXT, XS_STORAGE_FAILED_TEXT, XsError, parseManualSend, sendManualMessages, parseListQuery, listInboxMessages,
  pendingSummary, claimMessage, releaseMessage, dismissMessage, syncXsRuntimeHooks,
} from '../services/xsession.js';
import { assignShortIds, selectXsSessions } from '../services/xsession-resolve.js';
import { resolveSessionTitle } from '../utils/session-title.js';

const router = Router();

const DISABLED_TEXT = XS_DISABLED_TEXT;
const STORAGE_FAILED_TEXT = XS_STORAGE_FAILED_TEXT;

export function xsError(res, status, code, error, extra) {
  return res.status(status).json({ ok: false, code, error, ...extra });
}

// config 两个接口不受总开关约束。判法与 Express 的路由匹配同口径(不分大小写、容忍结尾斜杠)。
const CONFIG_PATH_RE = /^\/config\/?$/i;

// 总开关闸门:关着时 /api/xsession/ 下除 config 以外的请求一律 409(含【二期】路径)。
// 按整个前缀判,而不是逐个接口挂:逐个挂时路径写法(大小写、结尾斜杠)与路由匹配稍有出入就会漏过闸门。
router.use('/xsession', (req, res, next) => {
  if (CONFIG_PATH_RE.test(req.path) || readXsEnabledSync()) return next();
  return xsError(res, 409, 'XS_DISABLED', DISABLED_TEXT);
});

// nativeGuard.lastFailureAt:原生 SendMessage 引导最近一次检查失效的时刻(ISO 字符串),由引导守卫(T-X6)调用记下。
let nativeGuardLastFailureAt = null;
export function noteNativeGuardFailure(at = new Date()) {
  nativeGuardLastFailureAt = at.toISOString();
}

// GET /api/xsession/config → 一期字段(autoPaused、autoBudget、limits 的另三项是【二期】,不出现)。
// 偏好文件损坏或读不出 → readXsEnabledSync 给 false,照常 200。
router.get('/xsession/config', (_req, res) => {
  res.json({
    enabled: readXsEnabledSync(),
    limits: { bodyBytes: XS_LIMITS.bodyBytes, pendingPerSession: XS_LIMITS.pendingPerSession },
    nativeGuard: { lastFailureAt: nativeGuardLastFailureAt },
  });
});

// PUT /api/xsession/config { enabled } —— 一期只认 enabled;其它键(含二期的 autoPaused、chainLimit)一律 400,不写文件。
router.put('/xsession/config', async (req, res) => {
  const body = req.body;
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
  if (!keys || keys.length === 0 || keys.some((k) => k !== 'enabled') || typeof body.enabled !== 'boolean') {
    return xsError(res, 400, 'XS_INVALID_INPUT', '请求体须为 { enabled: 布尔值 }，不能带其它键');
  }
  const { enabled } = body;
  try {
    await updatePrefs((prefs) => { prefs.xsEnabled = enabled; });
  } catch {
    return xsError(res, 500, 'STORAGE_WRITE_FAILED', STORAGE_FAILED_TEXT);
  }
  syncXsRuntimeHooks(enabled); // 开着才挂回合开始 / 结束钩子(关着时只留 /chat 入口钩子)
  broadcast({ type: 'xs:config', enabled });
  res.json({ ok: true, enabled });
});

// ── GET /api/xsession/sessions?query=&limit=&exclude=&ids= ─────────────────────────────────────
// 转发对话框的目标列表,也用来查单个会话。

const UNTITLED = '未命名会话';
const DEFAULT_LIMIT = 30;
const dirNameOf = (p) => String(p || '').split(/[/\\]/).filter(Boolean).pop() || String(p || '');
const strOrEmpty = (v) => (typeof v === 'string' ? v : '');

// 所有项目里已落盘的会话。认定口径与侧栏会话列表相同,直接复用它的两层:listProjects(滤掉 /tmp、已删目录、
// ~/.claude 内部目录)+ listSessions(滤掉没有用户提问的文件、子代理记录、空壳,compact 续段折成一条)。不另写过滤。
// projectDir 取项目条目的路径(侧栏按它分组),不取会话行里可能是有损解码的 projectPath。
async function listAllSessions() {
  let projects;
  try { projects = await listProjects(); } catch (e) {
    if (e?.code === 'ENOENT') return []; // 还没有任何会话(~/.claude/projects 不存在)
    throw e;
  }
  const out = [];
  for (const p of projects) {
    let sessions;
    try { sessions = await listSessions(p.hash); } catch { continue; } // 单个项目读不了不连累整张表
    for (const s of sessions) out.push({ ...s, projectDir: p.path });
  }
  return out;
}

// running(有回合在跑)/ idle(有常驻进程、没在跑)/ stopped(没有进程)。进程收尾后槽还会在表里留一会儿(exitCode 已置),不算。
function runtimeStates() {
  const states = new Map();
  for (const p of getActiveChatProcesses()) {
    if (!p.sessionId || p.exitCode !== null) continue;
    if (states.get(p.sessionId) !== 'running') states.set(p.sessionId, p.idle ? 'idle' : 'running');
  }
  return states;
}

// 查询参数校验:不合规 → 返回错误文案;合规 → 返回解析结果。
function parseSessionsQuery(q) {
  const out = { query: '', limit: DEFAULT_LIMIT, exclude: null, ids: null };
  if (q.query !== undefined) {
    if (typeof q.query !== 'string' || [...q.query].length > 100) return { error: 'query 须为不超过 100 字的字符串' };
    out.query = q.query;
  }
  if (q.limit !== undefined) {
    const n = typeof q.limit === 'string' && /^[0-9]+$/.test(q.limit) ? Number(q.limit) : NaN;
    if (!(n >= 1 && n <= 100)) return { error: 'limit 须为 1–100 的整数' };
    out.limit = n;
  }
  if (q.exclude !== undefined) {
    if (typeof q.exclude !== 'string' || !isSessionIdShape(q.exclude)) return { error: 'exclude 须为一个会话 id' };
    out.exclude = q.exclude;
  }
  if (q.ids !== undefined) {
    const parts = typeof q.ids === 'string' ? q.ids.split(',') : null;
    if (!parts || parts.length > 50 || !parts.every((id) => isSessionIdShape(id))) return { error: 'ids 须为逗号分隔的会话 id，最多 50 个' };
    out.ids = parts;
  }
  return out;
}

// 已落盘会话的行(按最近活动倒序、同 id 只留最近的一条),sessions 接口与转发接口共用:转发能发到的目标,
// 就是转发对话框里列得出来的会话。projectDir 只给服务端用(转发时记进消息,GET /api/xsession/pending 用),不进应答。
async function loadSessionRows() {
  const [all, prefs, pending] = await Promise.all([listAllSessions(), loadPrefs(), pendingCountsBySession()]);
  const customTitles = prefs?.customTitles && typeof prefs.customTitles === 'object' ? prefs.customTitles : {};
  const autoTitles = prefs?.autoTitles && typeof prefs.autoTitles === 'object' ? prefs.autoTitles : {};
  const states = runtimeStates();
  const timeOf = (s) => { const t = Date.parse(s.lastActivity); return Number.isFinite(t) ? t : 0; };
  // 按最近活动倒序;同一个 id 出现在两个项目目录里时只留最近的那条
  all.sort((a, b) => timeOf(b) - timeOf(a) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  const seen = new Set();
  const rows = [];
  for (const s of all) {
    const key = s.sessionId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const t = timeOf(s);
    rows.push({
      sessionId: s.sessionId,
      title: resolveSessionTitle(s, strOrEmpty(customTitles[s.sessionId]), strOrEmpty(autoTitles[s.sessionId])) || UNTITLED,
      project: dirNameOf(s.projectDir),
      state: states.get(s.sessionId) || 'stopped',
      pending: pending.get(s.sessionId) || 0,
      lastActivity: t ? new Date(t).toISOString() : (s.lastActivity || null),
      projectDir: s.projectDir,
    });
  }
  return rows;
}

router.get('/xsession/sessions', async (req, res) => {
  const opts = parseSessionsQuery(req.query || {});
  if (opts.error) return xsError(res, 400, 'XS_INVALID_INPUT', opts.error);
  let rows;
  try { rows = await loadSessionRows(); } catch {
    return xsError(res, 500, 'XS_LIST_FAILED', '读取会话列表失败');
  }
  const shortIds = assignShortIds(rows.map((r) => r.sessionId)); // 冲突按全部会话判,筛选之前算
  const sessions = selectXsSessions(rows.map((r) => ({ ...r, shortId: shortIds.get(r.sessionId) })), opts)
    .map(({ sessionId, shortId, title, project, state, pending: n, lastActivity }) => ({ sessionId, shortId, title, project, state, pending: n, lastActivity }));
  res.json({ sessions });
});

// ── 转发、收件列表、认领 / 撤回 / 忽略、待处理计数(接口 X.3.1;业务在 services/xsession.js)──────────────

// 业务错误按它的状态码与错误码应答;写接口落盘失败(含读不出收件箱、没法写)→ 500 STORAGE_WRITE_FAILED;
// 读接口读盘出错 → 500 XS_READ_FAILED。日志只记错误码,不带正文。
function sendXsFailure(res, e, isWrite) {
  if (e instanceof XsError) return xsError(res, e.status, e.code, e.message, e.extra);
  if (!(e instanceof XsStorageError)) console.warn(`[xsession] 收件箱${isWrite ? '写入' : '读取'}失败:${e?.code || e?.message || e}`);
  if (isWrite) return xsError(res, 500, 'STORAGE_WRITE_FAILED', STORAGE_FAILED_TEXT);
  return xsError(res, 500, 'XS_READ_FAILED', '读取跨会话消息失败，请重试');
}

// POST /api/xsession/messages { to, body, fromSessionId? } —— 手动转发,一律落成卡片。校验顺序见 parseManualSend / sendManualMessages。
router.post('/xsession/messages', async (req, res) => {
  let parsed;
  try { parsed = parseManualSend(req.body); } catch (e) { return sendXsFailure(res, e, true); }
  let rows;
  try { rows = await loadSessionRows(); } catch {
    return xsError(res, 500, 'XS_LIST_FAILED', '读取会话列表失败');
  }
  try { res.json({ ok: true, messages: await sendManualMessages(parsed, rows) }); } catch (e) { sendXsFailure(res, e, true); }
});

// GET /api/xsession/messages?sessionId=&status= —— 某会话收到的消息(按到达先后),带正文。
router.get('/xsession/messages', async (req, res) => {
  let query;
  try { query = parseListQuery(req.query || {}); } catch (e) { return sendXsFailure(res, e, false); }
  try { res.json({ messages: await listInboxMessages(query) }); } catch (e) { sendXsFailure(res, e, false); }
});

// POST /api/xsession/messages/:id/claim | release | dismiss —— 卡片上的【处理】【撤回】【忽略】。
for (const [action, run] of [['claim', claimMessage], ['release', releaseMessage], ['dismiss', dismissMessage]]) {
  router.post(`/xsession/messages/:id/${action}`, async (req, res) => {
    try { res.json(await run(req.params.id)); } catch (e) { sendXsFailure(res, e, true); }
  });
}

// GET /api/xsession/pending —— 侧栏会话行、项目行汇总与 Dock 角标共用的待处理计数。
router.get('/xsession/pending', async (_req, res) => {
  try { res.json(await pendingSummary()); } catch (e) { sendXsFailure(res, e, false); }
});

// index.js 的全局 JSON 解析器在路由之前跑:请求体不是 JSON、或是 "on" / null 这类非对象时直接进错误链,到不了上面的
// 闸门与校验。这个错误处理器(index.js 挂在通用错误处理之前)把 /api/xsession/* 的请求体错误改回本节的错误体:
// 总开关关着(config 除外)先回 409,否则解析失败回 400 XS_INVALID_INPUT。未通过鉴权的请求、其它路径、其它错误
// 原样交给下一个错误处理器(未鉴权时不透露开关状态)。
const XS_URL_RE = /^\/api\/xsession(\/[^?]*)?(?:\?|$)/i;
export function xsessionBodyErrorHandler(err, req, res, next) {
  const m = XS_URL_RE.exec(req.originalUrl || '');
  const isBodyError = typeof err?.type === 'string' && err.status >= 400 && err.status < 500;
  if (!m || !isBodyError || res.headersSent || !isAuthorized(req)) return next(err);
  if (!CONFIG_PATH_RE.test(m[1] || '/') && !readXsEnabledSync()) return xsError(res, 409, 'XS_DISABLED', DISABLED_TEXT);
  if (err.type === 'entity.parse.failed') return xsError(res, 400, 'XS_INVALID_INPUT', '请求体不是合法的 JSON 对象');
  return next(err);
}

export default router;
