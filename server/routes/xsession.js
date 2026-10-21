// r151b:跨会话消息的 HTTP 接口(接口 X.3.1)。挂在 /api 下,在 index.js 的 authMiddleware 之后(同既有鉴权)。
// 错误体一律 { ok:false, code, error }。r151c 起有【二期】字段与 PUT …/sessions/:id/inbound(接口 r151c §4)。
import { Router } from 'express';
import { broadcast } from '../broadcast.js';
import { isAuthorized } from '../services/auth.js';
import { inboundModeOf, loadPrefs, readXsEnabledSync, readXsPrefsSync, updatePrefs } from './prefs.js';
import { getActiveChatProcesses } from './chat.js';
import { listProjects, listSessions, isSessionIdShape } from '../services/session-reader.js';
import { XS_LIMITS, XsStorageError, countUnfinishedXsMessages, pendingCountsBySession, readXsProfiles } from '../services/xsession-store.js';
import {
  XS_DISABLED_TEXT, XS_STORAGE_FAILED_TEXT, XsError, parseManualSend, sendManualMessages, parseListQuery, listInboxMessages,
  pendingSummary, claimMessage, releaseMessage, dismissMessage, syncXsRuntimeHooks, noteNativeGuardFailure, nativeGuardLastFailure,
  clearAllXsMessages, xsAutoState, resumeXsAuto, kickAllXsQueued, noteXsInboundChanged, profileCountsFor, setXsSessionRowsLoader,
  XS_SEND_SETTING_KEYS, setXsSendSettings, forgetXsSendSettings,
} from '../services/xsession.js';
import { assignShortIds, selectXsSessions } from '../services/xsession-resolve.js';
import { resolveSessionTitle } from '../utils/session-title.js';

const router = Router();

const DISABLED_TEXT = XS_DISABLED_TEXT;
const STORAGE_FAILED_TEXT = XS_STORAGE_FAILED_TEXT;

export function xsError(res, status, code, error, extra) {
  return res.status(status).json({ ok: false, code, error, ...extra });
}

// 不受总开关约束的:config 两个接口、POST clear(它只在关着时可用)。判法与 Express 的路由匹配同口径(不分大小写、容忍结尾斜杠)。
const CONFIG_PATH_RE = /^\/config\/?$/i;
const CLEAR_PATH_RE = /^\/clear\/?$/i;
const isClearRequest = (method, path) => method === 'POST' && CLEAR_PATH_RE.test(path);

// 总开关闸门:关着时 /api/xsession/ 下除 config 与 POST clear 以外的请求一律 409(含【二期】路径)。
// 按整个前缀判,而不是逐个接口挂:逐个挂时路径写法(大小写、结尾斜杠)与路由匹配稍有出入就会漏过闸门。
router.use('/xsession', (req, res, next) => {
  if (CONFIG_PATH_RE.test(req.path) || isClearRequest(req.method, req.path) || readXsEnabledSync()) return next();
  return xsError(res, 409, 'XS_DISABLED', DISABLED_TEXT);
});

// nativeGuard.lastFailureAt:原生 SendMessage 引导最近一次检查失效的时刻(ISO 字符串)。状态放在 services/xsession.js
// (引导守卫在那里;从这里 import 回去会成环),这里转出原名。
export { noteNativeGuardFailure };

// GET /api/xsession/config → 一期字段 + 二期的 autoPaused、autoBudget、limits 的另三项。
// 偏好文件损坏或读不出 → readXsEnabledSync 给 false,照常 200。stored.unfinished:收件箱里未结束的消息条数,
// 开关关着也给(设置块据此提示"仍有 N 条…"并给【清空】);只读,不产生任何文件,收件箱读不出时为 0。
// autoPaused:偏好里的 xsAutoPaused(非布尔按 false)或本进程触顶时的暂停;autoBudget.used 是内存计数,服务重启清零。
router.get('/xsession/config', async (_req, res) => {
  const enabled = readXsEnabledSync();
  const unfinished = await countUnfinishedXsMessages();
  const auto = xsAutoState();
  res.json({
    enabled,
    autoPaused: auto.paused,
    autoBudget: { limit: XS_LIMITS.autoPerWindow, windowMs: XS_LIMITS.autoWindowMs, used: auto.used },
    limits: {
      bodyBytes: XS_LIMITS.bodyBytes, pendingPerSession: XS_LIMITS.pendingPerSession,
      chainDepth: XS_LIMITS.chainDepth, targetsPerSend: XS_LIMITS.targetsPerSend, sendsPerTurn: XS_LIMITS.sendsPerTurn,
    },
    nativeGuard: { lastFailureAt: nativeGuardLastFailure() },
    stored: { unfinished },
  });
});

// POST /api/xsession/clear —— 设置块的【清空】。只在总开关关着时可用;不需要请求体(给了也忽略)。
// 删 ~/.claude-gui/xsession/ 下的收件箱记录、全部正文、损坏留存(messages.json.corrupt-*),回删掉的消息总条数。
const CLEAR_WHILE_ENABLED_TEXT = '请先关闭跨会话消息，或在卡片上逐条处理';
async function handleXsClear(_req, res) {
  if (readXsEnabledSync()) return xsError(res, 409, 'XS_CLEAR_WHILE_ENABLED', CLEAR_WHILE_ENABLED_TEXT);
  try {
    res.json({ ok: true, removed: await clearAllXsMessages() });
  } catch (e) {
    console.warn(`[xsession] 清空收件箱失败:${e?.cause?.code || e?.code || e?.message || e}`);
    xsError(res, 500, 'STORAGE_WRITE_FAILED', STORAGE_FAILED_TEXT);
  }
}
router.post('/xsession/clear', handleXsClear);

// PUT /api/xsession/config { enabled?, autoPaused? } —— 认 enabled(布尔)与 autoPaused(只能是 false = 恢复自动处理),
// 至少给一个、可同时给,一次偏好写入完成;其它键(含 chainLimit)、autoPaused:true 一律 400,不写文件、不广播。
// 写盘失败 → 500,enabled / autoPaused / 启用时刻都不变、不广播、10 分钟窗口不清。应答 { ok, enabled, autoPaused },广播 xs:config 同值。
const CONFIG_KEYS = new Set(['enabled', 'autoPaused']);
router.put('/xsession/config', async (req, res) => {
  const body = req.body;
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
  if (!keys || keys.length === 0 || keys.some((k) => !CONFIG_KEYS.has(k))
    || ('enabled' in body && typeof body.enabled !== 'boolean') || ('autoPaused' in body && body.autoPaused !== false)) {
    return xsError(res, 400, 'XS_INVALID_INPUT', '请求体须为 { enabled?: 布尔值, autoPaused?: false }，至少给一个，不能带其它键');
  }
  const resume = body.autoPaused === false;
  let enabled = false;
  let turnedOn = false;
  try {
    // r151c:由关变开的同一次写入里记启用时刻 —— 之前记下的发送档案从此不再算数(见 xsession.js profileIsCurrent / profileCountsFor)
    await updatePrefs((prefs) => {
      const was = prefs.xsEnabled === true;
      if (typeof body.enabled === 'boolean') {
        if (body.enabled && !was) {
          // r151q:之前既没开过总开关、也没定过入站默认 = 新用户第一次打开 → 同一次写入里记 xsInboundDefault:'auto'
          // (新用户默认自动处理);开过的老用户不写,没单独设置的会话保持卡片(见 prefs.js inboundDefaultOf)。
          if (prefs.xsEnabledAt === undefined && prefs.xsInboundDefault === undefined) prefs.xsInboundDefault = 'auto';
          prefs.xsEnabledAt = new Date().toISOString();
        }
        prefs.xsEnabled = body.enabled;
      }
      if (resume) delete prefs.xsAutoPaused;
      enabled = prefs.xsEnabled === true;
      turnedOn = enabled && !was;
    });
  } catch {
    return xsError(res, 500, 'STORAGE_WRITE_FAILED', STORAGE_FAILED_TEXT);
  }
  if (resume) resumeXsAuto(); // 清内存暂停与 10 分钟窗口,对有 queued 的会话评估一次
  syncXsRuntimeHooks(enabled); // 开着才挂回合开始 / 结束钩子(关着时只留 /chat 入口钩子)
  if (turnedOn && !resume) kickAllXsQueued(); // 关着时排着的(若有)按去向表重判
  const autoPaused = xsAutoState().paused;
  broadcast({ type: 'xs:config', enabled, autoPaused });
  res.json({ ok: true, enabled, autoPaused });
});

// ── GET /api/xsession/sessions?query=&limit=&exclude=&ids= ─────────────────────────────────────
// 转发对话框的目标列表,也用来查单个会话。

const UNTITLED = '未命名会话';
const DEFAULT_LIMIT = 30;
const dirNameOf = (p) => String(p || '').split(/[/\\]/).filter(Boolean).pop() || String(p || '');
const strOrEmpty = (v) => (typeof v === 'string' ? v : '');

// 所有项目里已落盘的会话。认定口径与侧栏会话列表相同,直接复用它的两层:listProjects(滤掉 /tmp、已删目录、
// ~/.claude 内部目录)+ listSessions(滤掉没有用户提问的文件、子代理记录、空壳,compact 续段折成一条)。不另写过滤。
// projectDir 取项目条目的路径(侧栏按它分组),不取会话行里可能是有损解码的 projectPath;projectHash 取项目条目的
// 目录编码名(与既有历史接口 / 侧栏用的 projectHash 同一口径,前端据此判断所在项目在侧栏是否显示)。
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
    for (const s of sessions) out.push({ ...s, projectDir: p.path, projectHash: p.hash });
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
export async function loadSessionRows() {
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
      projectHash: s.projectHash,
      projectDir: s.projectDir,
    });
  }
  return rows;
}

// 给模型的两个工具读会话行也用它(services 不能 import 本文件,成环),在这里登记过去。
setXsSessionRowsLoader(loadSessionRows);

router.get('/xsession/sessions', async (req, res) => {
  const opts = parseSessionsQuery(req.query || {});
  if (opts.error) return xsError(res, 400, 'XS_INVALID_INPUT', opts.error);
  let rows;
  try { rows = await loadSessionRows(); } catch {
    return xsError(res, 500, 'XS_LIST_FAILED', '读取会话列表失败');
  }
  const shortIds = assignShortIds(rows.map((r) => r.sessionId)); // 冲突按全部会话判,筛选之前算
  // inbound(接收设置):显式值照用,没设置按偏好的入站默认(r151q,见 prefs.js inboundDefaultOf / inboundModeOf);
  // hasProfile(有本次启用之后记录的发送档案;不看 provider 是否已换)
  const prefs = readXsPrefsSync();
  let profiled = new Set();
  try {
    const { sessions: profiles } = await readXsProfiles();
    profiled = new Set(Object.entries(profiles).filter(([k, p]) => profileCountsFor(k, p, prefs.enabledAt)).map(([k]) => k.toLowerCase()));
  } catch (e) { console.warn(`[xsession] 读发送档案失败,hasProfile 按 false:${e?.code || e?.message || e}`); }
  const sessions = selectXsSessions(rows.map((r) => ({ ...r, shortId: shortIds.get(r.sessionId) })), opts)
    .map(({ sessionId, shortId, title, project, projectHash, state, pending: n, lastActivity }) => ({
      sessionId, shortId, title, project, projectHash, state, pending: n, lastActivity,
      inbound: inboundModeOf(prefs.inbound, sessionId, prefs.inboundDefault), hasProfile: profiled.has(sessionId.toLowerCase()),
    }));
  res.json({ sessions });
});

// PUT /api/xsession/sessions/:id/inbound { mode:'card'|'auto' } —— 接收设置。判定顺序(接口 r151c §4 错误总表):总开关关 → 409
// (前缀闸门)→ id 形状 / 请求体 / mode → 400 → 会话不在会话列表的认定里 → 404 → 读会话列表失败 → 500 XS_LIST_FAILED →
// 写偏好失败 → 500 STORAGE_WRITE_FAILED;失败时设置不变、不广播。r151k:auto 与 card 都写键(不再用删键表示 card),
// 这样「显式等你确认」与「没设置(默认自动处理)」可区分;会话 id 不分大小写。
// 成功:广播 xs:inbound,改成 card 时该会话排着的消息立即重判(落 target-card)。
const INBOUND_MODES = new Set(['card', 'auto']);
router.put('/xsession/sessions/:id/inbound', async (req, res) => {
  const id = req.params.id;
  const body = req.body;
  if (!isSessionIdShape(id) || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((k) => k !== 'mode') || !INBOUND_MODES.has(body.mode)) {
    return xsError(res, 400, 'XS_INVALID_INPUT', '会话 id 形状不对，或请求体须为 { mode: "card" | "auto" }');
  }
  let rows;
  try { rows = await loadSessionRows(); } catch {
    return xsError(res, 500, 'XS_LIST_FAILED', '读取会话列表失败');
  }
  const row = rows.find((r) => r.sessionId.toLowerCase() === id.toLowerCase());
  if (!row) return xsError(res, 404, 'XS_TARGET_NOT_FOUND', '目标会话不存在');
  const { mode } = body;
  try {
    await updatePrefs((prefs) => {
      const inbound = prefs.xsInbound && typeof prefs.xsInbound === 'object' && !Array.isArray(prefs.xsInbound) ? prefs.xsInbound : {};
      for (const k of Object.keys(inbound)) if (k.toLowerCase() === row.sessionId.toLowerCase()) delete inbound[k];
      inbound[row.sessionId] = mode;
      prefs.xsInbound = inbound;
    });
  } catch {
    return xsError(res, 500, 'STORAGE_WRITE_FAILED', STORAGE_FAILED_TEXT);
  }
  broadcast({ type: 'xs:inbound', sessionId: row.sessionId, mode });
  noteXsInboundChanged(row.sessionId);
  res.json({ ok: true, sessionId: row.sessionId, mode });
});

// ── PUT /api/xsession/send-settings(r151c 审计 I1;接口"审计之后的补充约定"第 3 条)──────────────────────────
// 界面把随每次发送带上的全局设置的当前值同步过来(启动、总开关打开、断线重连、这几项变化时,打开期间另每 5 分钟一次),
// 自动处理按它起进程。请求体另带界面实例标识 uiId(8–64 个字母、数字、- 或 _),服务端按 uiId 分开记、多个界面时取最窄
// (接口"复审之后的补充约定"第 2 条;合并与有效期见 services/xsession.js effectiveSendSettings)。只在服务端内存;不广播;
// 受总开关闸门约束(关着 409)。uiId 加六个键都要给、不能有别的键;六个键的形态与界面发送 /api/chat 时一致。
// 不合规 → 400 XS_INVALID_INPUT(固定文案);uiId 本身合规时另删掉这个界面之前的记录、按其余有效界面重算(没有就按最窄;
// 接口"复审之后的补充约定"第 3 条),uiId 不合规时不删任何记录。
const SEND_SETTINGS_MAX_DIRS = 64;
const SEND_SETTINGS_MAX_DIR_CHARS = 4096;
const SEND_SETTINGS_MAX_BUDGET_USD = 1_000_000;
export function parseSendSettings(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const keys = Object.keys(b);
  if (keys.length !== XS_SEND_SETTING_KEYS.length || !XS_SEND_SETTING_KEYS.every((k) => Object.hasOwn(b, k))) return null;
  const { globalRead, addDirs, maxBudgetUsd, keepAlive, promptSuggestions, genui } = b;
  if (typeof globalRead !== 'boolean' || typeof keepAlive !== 'boolean' || typeof genui !== 'boolean') return null;
  if (promptSuggestions !== true && promptSuggestions !== false && promptSuggestions !== 'auto') return null;
  if (maxBudgetUsd !== null && !(typeof maxBudgetUsd === 'number' && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0 && maxBudgetUsd <= SEND_SETTINGS_MAX_BUDGET_USD)) return null;
  if (!Array.isArray(addDirs) || addDirs.length > SEND_SETTINGS_MAX_DIRS
    || !addDirs.every((d) => typeof d === 'string' && d.length > 0 && d.length <= SEND_SETTINGS_MAX_DIR_CHARS)) return null;
  return { globalRead, addDirs: [...addDirs], maxBudgetUsd, keepAlive, promptSuggestions, genui };
}
const UI_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SEND_SETTINGS_INVALID_TEXT = '请求体须为 { uiId, globalRead, addDirs, maxBudgetUsd, keepAlive, promptSuggestions, genui }，七个键都要给，不能带其它键（uiId 为 8–64 个字母、数字、- 或 _）';
router.put('/xsession/send-settings', (req, res) => {
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  const uiId = b && typeof b.uiId === 'string' && UI_ID_RE.test(b.uiId) ? b.uiId : null;
  let v = null;
  if (uiId) {
    const { uiId: _uiId, ...settings } = b;
    v = parseSendSettings(settings);
  }
  if (!v) {
    if (uiId) forgetXsSendSettings(uiId);
    return xsError(res, 400, 'XS_INVALID_INPUT', SEND_SETTINGS_INVALID_TEXT);
  }
  setXsSendSettings(uiId, v);
  res.json({ ok: true });
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
// POST clear 照常处理(它忽略请求体);总开关关着(config 除外)先回 409,否则解析失败回 400 XS_INVALID_INPUT。未通过鉴权的请求、其它路径、其它错误
// 原样交给下一个错误处理器(未鉴权时不透露开关状态)。
const XS_URL_RE = /^\/api\/xsession(\/[^?]*)?(?:\?|$)/i;
export function xsessionBodyErrorHandler(err, req, res, next) {
  const m = XS_URL_RE.exec(req.originalUrl || '');
  const isBodyError = typeof err?.type === 'string' && err.status >= 400 && err.status < 500;
  if (!m || !isBodyError || res.headersSent || !isAuthorized(req)) return next(err);
  if (isClearRequest(req.method, m[1] || '/')) return handleXsClear(req, res); // clear 本来就忽略请求体:解析不了也照常处理
  if (!CONFIG_PATH_RE.test(m[1] || '/') && !readXsEnabledSync()) return xsError(res, 409, 'XS_DISABLED', DISABLED_TEXT);
  if (err.type === 'entity.parse.failed') return xsError(res, 400, 'XS_INVALID_INPUT', '请求体不是合法的 JSON 对象');
  return next(err);
}

export default router;
