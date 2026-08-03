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
// settled 原子标志:res close(挂起的 hook 连接断开)与 respond 几乎同时到达时,
// 两边都可能拿到 slot —— 只允许先到的 settle 生效,第二次直接 noop,否则卡片会
// 闪"已超时"后又被 allow 覆盖(双播 resolved)。返回是否真正完成了 settle。
function settle(slot, payload) {
  if (slot.settled) return false;
  slot.settled = true;
  if (slot.res) { try { slot.res.json(payload); } catch {} }
  else if (slot.resolve) { try { slot.resolve(payload); } catch {} }
  return true;
}

/**
 * 「kind 卡」:elicitation(MCP 服务器要用户填表)与 dialog(CLI 要宿主弹阻塞对话框)。
 * 两者都不是工具授权,但生命周期与授权卡完全一致 —— 等人回答、会话停了要撤、多端可见、
 * 断线要能补拉。共用这张挂起表,dropPendingForSession / 对账 / 送达重试 / 刷新补拉全部
 * 自动生效,不必各建一条通道。差别只在「决定怎么翻译回等待方」:授权卡回 {decision},
 * elicitation 回 MCP 的 {action, content},dialog 回 CLI 的 {behavior, result}。
 * 翻译函数随请求一起挂在 slot 上,所以清卡侧(dropPendingForSession)不需要认识这两类,
 * 一行都不用改:它照旧 settle 一个 deny payload,翻译函数把它变成正确的「未作答」终态。
 * 授权路径靠 toolName 判定(危险命令/白名单/切档重裁),kind 卡一律不带 toolName,
 * 因此天然不会被那些路径误判。
 */
function requestCard(fields, { signal, translate }) {
  return new Promise((resolve) => {
    const id = randomUUID();
    const request = { id, createdAt: Date.now(), ...fields };
    // 撤单权在上游(MCP 服务器默认 60s、CLI 的 park deadline),本地不自设超时。上游撤单
    // 经 signal 到达:此时必须把卡从表里删掉并撤下界面,否则用户对着一张已作废的卡填表。
    const onAbort = () => {
      const slot = pending.get(id);
      if (!slot) return;
      pending.delete(id);
      if (settle(slot, { decision: 'deny', reason: '请求已被发起方取消' })) {
        broadcast({ type: 'permission:resolved', id, decision: 'timeout' });
      }
    };
    pending.set(id, {
      request,
      resolve: (payload) => {
        try { signal?.removeEventListener('abort', onAbort); } catch {}
        resolve(translate(payload || {}));
      },
    });
    broadcast({ type: 'permission:request', request });
    if (signal?.aborted) onAbort();
    else { try { signal?.addEventListener('abort', onAbort, { once: true }); } catch {} }
  });
}

// 应答 → MCP ElicitResult。byUser 是「用户在界面上按了拒绝」的标记(由 respond 端点打):
// 没有它就是系统清卡(停止 / 进程退出 / 上游撤单),MCP 语义里那是 cancel(未作答),
// 不是 decline(明确拒绝)——服务器据此决定要不要重试,翻错会让它以为用户拒绝了。
export function elicitationResultFrom(payload = {}) {
  if (payload.decision === 'allow') {
    const content = (payload.content && typeof payload.content === 'object' && !Array.isArray(payload.content))
      ? payload.content : {};
    return { action: 'accept', content };
  }
  return payload.byUser ? { action: 'decline' } : { action: 'cancel' };
}

// 应答 → CLI UserDialogResult。result 取值只认这两个(界面按钮产生),其余一律 cancelled:
// 局域网客户端也能 POST /respond,不能让任意字符串直达 CLI。cancelled 也是清卡的终态 ——
// 停止/切会话时发 cancelled 而不是不应答,CLI 收到后走该对话框的默认行为,不必等到 park 超时。
const DIALOG_RESULTS = new Set(['retry_fallback', 'edit_prompt']);
export function userDialogResultFrom(payload = {}) {
  const result = payload.content?.result;
  if (payload.byUser && payload.decision === 'allow' && DIALOG_RESULTS.has(result)) {
    return { behavior: 'completed', result };
  }
  return { behavior: 'cancelled' };
}

/** MCP elicitation(SDK onElicitation)。只有外部 stdio/http server 会发,进程内 SDK server 不支持。 */
export function requestElicitation({ serverName, message, requestedSchema, title, displayName, description, sessionId, cwd, signal }) {
  return requestCard({
    kind: 'elicitation',
    serverName: serverName || 'MCP',
    message: typeof message === 'string' ? message : '',
    requestedSchema: (requestedSchema && typeof requestedSchema === 'object') ? requestedSchema : {},
    ...(title ? { title } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    sessionId: sessionId || null,
    cwd: cwd || null,
  }, { signal, translate: elicitationResultFrom });
}

/** CLI request_user_dialog(SDK onUserDialog)。当前只声明 refusal_fallback_prompt 一种。 */
export function requestUserDialog({ dialogKind, payload, toolUseID, sessionId, cwd, signal }) {
  return requestCard({
    kind: 'dialog',
    dialogKind: String(dialogKind || ''),
    payload: (payload && typeof payload === 'object') ? payload : {},
    ...(toolUseID ? { toolUseID } : {}),
    sessionId: sessionId || null,
    cwd: cwd || null,
  }, { signal, translate: userDialogResultFrom });
}

/**
 * 进程内权限请求(SDK canUseTool 用)。建 pending 项 + 广播弹窗,返回一个 Promise,
 * 用户在界面点击后由 /respond 端点 resolve。
 * resolve 值: { decision:'allow'|'deny', reason?, updatedInput?, always?, authorizeDir? }
 * blockedPath:SDK canUseTool 第三参透传的沙箱越界路径 → 前端渲染"越界访问"卡。
 */
export function requestPermission({ toolName, toolInput, sessionId, cwd, blockedPath, decisionReason, toolUseID }) {
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
      ...(blockedPath ? { blockedPath } : {}),
      ...(decisionReason ? { decisionReason } : {}),
      ...(toolUseID ? { toolUseID } : {}),
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
    // kind 卡(elicitation/dialog)同属「等人回来做决定」:撤单权在上游(MCP 服务器 /
    // CLI park deadline),经 signal 到达,本地不再叠一层 15 分钟。
    if (slot.request.kind || NO_TTL_TOOLS.has(slot.request.toolName)) continue;
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
    // 与 requestPermission 保持同构:越界路径透传给前端渲染越界卡。
    ...(typeof req.body?.blockedPath === 'string' && req.body.blockedPath ? { blockedPath: req.body.blockedPath } : {}),
    // bgAgent:请求来自后台代理(claude --bg 的 PermissionRequest hook)。前端据此
    // ①把卡片标成"后台代理" ②让它在当前窗格可见 —— 后台代理的会话通常没开在任何
    // 窗格,按会话归属过滤会把卡片整个藏掉,用户永远看不到、代理永远等不到答复。
    ...(req.body?.bgAgent === true ? { bgAgent: true } : {}),
  };

  pending.set(id, { request, res });

  // Push to all clients so the GUI can render a popup.
  broadcast({ type: 'permission:request', request });

  // If client disconnects before resolving (e.g. server restarted, response
  // socket died), drop the entry so the map doesn't leak.
  res.on('close', () => {
    const slot = pending.get(id);
    if (slot) {
      // 删除与置 settled 合并为原子段(单线程内不交出控制权):respond 若随后
      // 到达,settle 见 settled 直接 noop,不会 timeout 之后又补一条 allow。
      pending.delete(id);
      slot.settled = true;
      broadcast({ type: 'permission:resolved', id, decision: 'timeout' });
    }
  });
});

/**
 * POST /api/permissions/respond/:id
 * Body: { decision: 'allow'|'deny', reason?, updatedInput?, always?, authorizeDir? }
 * 把用户的决定送回等待方:旧 hook 走 HTTP res,SDK canUseTool 走进程内 resolve。
 * updatedInput:AskUserQuestion 的 {questions, answers}、或被用户改过的工具入参,
 * canUseTool 据此返回 {behavior:'allow', updatedInput}。
 * always=true:"始终允许" → canUseTool 经 updatedPermissions 写 settings.json 规则。
 * authorizeDir='session'|'permanent':越界卡"授权此目录" → addDirectories。
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
  const always = req.body?.always === true;
  const authorizeDir = ['session', 'permanent'].includes(req.body?.authorizeDir) ? req.body.authorizeDir : undefined;
  // content:kind 卡的结构化作答 —— elicitation 的表单值 / dialog 的 {result}。
  // byUser:标记这个终态来自用户界面(而非停止清卡/上游撤单)。kind 卡的翻译函数据此
  // 区分「明确拒绝」与「未作答」,两者对 MCP 服务器和 CLI 是不同语义。授权卡忽略这两个字段。
  const content = (req.body?.content && typeof req.body.content === 'object') ? req.body.content : undefined;
  pending.delete(req.params.id);
  // settle 返回 false = res close 抢先广播过 timeout:不再补播 allow,保持单一终态。
  if (settle(slot, { decision, reason, updatedInput, always, authorizeDir, content, byUser: true })) {
    broadcast({ type: 'permission:resolved', id: req.params.id, decision });
  }
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
/**
 * A1 切档重裁:用户中途切权限档位后,按新档对该会话已 pending 的请求重新自动裁决
 * (chat.js POST /chat/permission-mode 调用,decide = autoDecide 按新档柯里化)。
 * decide(request) 返回 { decision:'allow'|'deny', reason?, authorizeDir? } 或 null(留卡等人)。
 * 非 null 走既有 pending.delete + settle + broadcast 路径 —— 与用户手答完全同构,天然幂等:
 * 用户在途手答先到的话条目已不在表里,重裁不会二次 settle(先答先赢)。
 */
export function resolvePendingForSession(sessionId, decide) {
  for (const [id, slot] of pending.entries()) {
    if (slot.request.sessionId !== sessionId) continue;
    // 切档只重裁工具授权。kind 卡(MCP 表单 / CLI 对话框)不是权限请求,decide(autoDecide)
    // 对它无意义:toolName 为空会落进「其余 → 按档位裁决」,把用户正在填的表单静默判掉。
    if (slot.request.kind) continue;
    let verdict = null;
    try { verdict = decide(slot.request); } catch { verdict = null; }
    if (!verdict || !verdict.decision) continue;
    const decision = verdict.decision === 'allow' ? 'allow' : 'deny';
    pending.delete(id);
    // 与 respond 端点一致:settle 返回 false = res close 已抢先播过终态,不再补播,保持单一终态。
    if (settle(slot, {
      decision,
      reason: verdict.reason || null,
      ...(verdict.authorizeDir ? { authorizeDir: verdict.authorizeDir } : {}),
    })) {
      broadcast({ type: 'permission:resolved', id, decision });
    }
  }
}

export function dropPendingForSession(sessionId) {
  for (const [id, slot] of pending.entries()) {
    if (slot.request.sessionId === sessionId) {
      pending.delete(id);
      if (settle(slot, { decision: 'deny', reason: 'CLI 进程已退出' })) {
        broadcast({ type: 'permission:resolved', id, decision: 'deny' });
      }
    }
  }
}

export default router;
