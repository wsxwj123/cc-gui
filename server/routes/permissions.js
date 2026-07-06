import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { broadcast } from '../broadcast.js';
import { isLocalReq } from '../services/auth.js';

const router = Router();

/**
 * In-memory registry of pending permission requests.
 * 两类 slot 共用一张表,区别只在"怎么把决定送回去":
 *   - res-backed     { request, res }      旧 hook bridge 走 HTTP,挂起 res 直到 respond
 *   - resolve-backed { request, resolve }  SDK canUseTool 进程内 await 一个 Promise
 * respond / dropPendingForSession / TTL 三处都两类都处理。
 */
const pending = new Map();

// 把决定送回等待方(HTTP res 或进程内 resolve 皆可),并从表里移除。
function settle(slot, payload) {
  if (slot.res) { try { slot.res.json(payload); } catch {} }
  else if (slot.resolve) { try { slot.resolve(payload); } catch {} }
}

/**
 * 进程内权限请求(SDK canUseTool 用)。建 pending 项 + 广播弹窗,返回一个 Promise,
 * 用户在界面点击后由 /respond 端点 resolve。
 * resolve 值: { decision:'allow'|'deny', reason?, updatedInput? }
 */
export function requestPermission({ toolName, toolInput, sessionId, cwd }) {
  return new Promise((resolve) => {
    const id = randomUUID();
    const request = {
      id,
      toolName: toolName || 'unknown',
      toolInput: toolInput || {},
      sessionId: sessionId || null,
      cwd: cwd || null,
      hookEvent: 'canUseTool',
      createdAt: Date.now(),
    };
    pending.set(id, { request, resolve });
    broadcast({ type: 'permission:request', request });
  });
}

// Safety-net sweep: a held request whose socket never fires 'close' (CLI wedged
// without exiting) would otherwise pin its entry — and its held HTTP socket —
// forever. Drop anything older than 15 min. Normal requests resolve in seconds.
// 例外:AskUserQuestion(提问卡)/ExitPlanMode(计划确认卡)是"等人回来做决定"的
// 卡片,永不超时(用户明确要求:等到点提交为止)。挂着只是进程内 Promise,无 socket
// 泄漏;所属进程结束时 dropPendingForSession 会清,不会永久悬挂。
const NO_TTL_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const PENDING_TTL_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, slot] of pending.entries()) {
    if (NO_TTL_TOOLS.has(slot.request.toolName)) continue;
    if (now - slot.request.createdAt > PENDING_TTL_MS) {
      pending.delete(id);
      settle(slot, { decision: 'deny', reason: '权限请求超时（15 分钟未响应）' });
      broadcast({ type: 'permission:resolved', id, decision: 'timeout' });
    }
  }
}, 60 * 1000).unref();

/**
 * POST /api/permissions/request   (called by the hook bridge)
 * Body: { toolName, toolInput, sessionId, cwd, hookEvent }
 * Response (held open): { decision: 'allow'|'deny', reason? }
 *
 * Server holds the HTTP response until the user clicks Allow/Deny in the
 * client, OR until the matching CLI process exits (cleanup).
 */
router.post('/permissions/request', (req, res) => {
  // 安全:此端点只给本机 hook bridge 用(走 loopback)。拒绝非本机来源,否则已认证的
  // 局域网客户端/同机恶意进程可伪造任意 toolName/toolInput 的授权弹窗诱导用户点"允许"
  // (opus 审计 P2)。hook 永远命中 127.0.0.1,本限制不影响正常流程。
  if (!isLocalReq(req)) {
    return res.status(403).json({ error: 'permission requests must originate locally' });
  }
  const id = randomUUID();
  const request = {
    id,
    toolName: req.body?.toolName || 'unknown',
    toolInput: req.body?.toolInput || {},
    sessionId: req.body?.sessionId || null,
    cwd: req.body?.cwd || null,
    hookEvent: req.body?.hookEvent || 'PreToolUse',
    createdAt: Date.now(),
  };

  pending.set(id, { request, res });

  // Push to all clients so the GUI can render a popup.
  broadcast({ type: 'permission:request', request });

  // If client disconnects before resolving (e.g. server restarted, response
  // socket died), drop the entry so the map doesn't leak.
  res.on('close', () => {
    if (pending.has(id)) {
      pending.delete(id);
      broadcast({ type: 'permission:resolved', id, decision: 'timeout' });
    }
  });
});

/**
 * POST /api/permissions/respond/:id
 * Body: { decision: 'allow'|'deny', reason?, updatedInput? }
 * 把用户的决定送回等待方:旧 hook 走 HTTP res,SDK canUseTool 走进程内 resolve。
 * updatedInput:AskUserQuestion 的 {questions, answers}、或被用户改过的工具入参,
 * canUseTool 据此返回 {behavior:'allow', updatedInput}。
 */
router.post('/permissions/respond/:id', (req, res) => {
  const slot = pending.get(req.params.id);
  // Already-resolved (or never-existed) slot: a permission decision is idempotent
  // and repeat requests are safe, so return ok:true instead of 404. Fixes the
  // double-click / two-instance case where the second respond hit a deleted slot
  // and the frontend treated the 404 as a failure. Already-resolved vs.
  // never-existed are indistinguishable here; unify to a harmless idempotent ok.
  if (!slot) return res.json({ ok: true, alreadyResolved: true });
  const decision = req.body?.decision === 'allow' ? 'allow' : 'deny';
  const reason = req.body?.reason || null;
  const updatedInput = req.body?.updatedInput;
  pending.delete(req.params.id);
  settle(slot, { decision, reason, updatedInput });
  broadcast({ type: 'permission:resolved', id: req.params.id, decision });
  res.json({ ok: true });
});

/**
 * GET /api/permissions/pending — for a freshly-loaded client that missed the
 * WS broadcast (refresh while a permission was waiting).
 */
router.get('/permissions/pending', (req, res) => {
  const list = [];
  for (const { request } of pending.values()) list.push(request);
  res.json({ items: list });
});

/**
 * Internal helper used by chat.js when a CLI process exits — drop any pending
 * requests for that session so the hook bridge times out cleanly instead of
 * hanging forever.
 */
export function dropPendingForSession(sessionId) {
  for (const [id, slot] of pending.entries()) {
    if (slot.request.sessionId === sessionId) {
      pending.delete(id);
      settle(slot, { decision: 'deny', reason: 'CLI 进程已退出' });
      broadcast({ type: 'permission:resolved', id, decision: 'deny' });
    }
  }
}

export default router;
