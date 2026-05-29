import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { broadcast } from '../index.js';

const router = Router();

/**
 * In-memory registry of pending permission requests.
 * id → { resolve, request: {toolName, toolInput, sessionId, cwd}, createdAt }
 */
const pending = new Map();

// Safety-net sweep: a held request whose socket never fires 'close' (CLI wedged
// without exiting) would otherwise pin its entry — and its held HTTP socket —
// forever. Drop anything older than 15 min. Normal requests resolve in seconds.
const PENDING_TTL_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, slot] of pending.entries()) {
    if (now - slot.request.createdAt > PENDING_TTL_MS) {
      pending.delete(id);
      try { slot.res.json({ decision: 'deny', reason: '权限请求超时（15 分钟未响应）' }); } catch {}
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
 * Body: { decision: 'allow'|'deny', reason? }
 * Resolves the held request, which lets the hook bridge return to CLI.
 */
router.post('/permissions/respond/:id', (req, res) => {
  const slot = pending.get(req.params.id);
  if (!slot) return res.status(404).json({ error: 'not pending' });
  const decision = req.body?.decision === 'allow' ? 'allow' : 'deny';
  const reason = req.body?.reason || null;
  pending.delete(req.params.id);
  try { slot.res.json({ decision, reason }); } catch {}
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
      try { slot.res.json({ decision: 'deny', reason: 'CLI 进程已退出' }); } catch {}
      broadcast({ type: 'permission:resolved', id, decision: 'deny' });
    }
  }
}

export default router;
