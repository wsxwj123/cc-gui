// R25:历史变换(trim / compact-segment / trim-before-tool / strip-thinking / repair-official-compat)
// 的**唯一客户端入口**。
//
// 服务端合同:实际提交一律 POST + 业务参数 + `dryRun:false,baseVersion,previewToken`;dryRun
// 缺省/非布尔一律 400(**字段缺失绝不等于"直接执行"**)。所以任何调用点都不要自己拼 body ——
// 走这里的两步流:先 dryRun:true 拿预览信封,再原参数 + 预览令牌提交。
// 提交成功且有 backupRef 时广播事件,由 HistoryBackupNotice 提供「在访达中显示」入口
// (副本是整份会话原文,只让用户去文件管理器里拿,不进浏览器 —— 详见 server/routes/session-history.js)。
export const HISTORY_BACKUP_EVENT = 'cgui:history-backup';

export function emitHistoryBackup(detail) {
  try { window.dispatchEvent(new CustomEvent(HISTORY_BACKUP_EVENT, { detail })); } catch { /* SSR/无 window */ }
}

async function postJson(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/**
 * 预览 + 提交一次历史操作。
 * 返回 {ok:true, data(提交信封), preview, sessionReset} 或
 *      {ok:false, stage:'preview'|'submit', status, code, error, preview?}
 * 调用点据此显示结果;失败时会话一定没被改(服务端保证零改写)。
 */
export async function runHistoryOp(sessionId, op, params = {}) {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/${encodeURIComponent(op)}`;
  const preview = await postJson(url, { ...params, dryRun: true });
  if (preview.status !== 200 || !preview.body?.previewToken) {
    return {
      ok: false, stage: 'preview', status: preview.status,
      code: preview.body?.code || null,
      error: preview.body?.error || `预览失败（HTTP ${preview.status}）`,
    };
  }
  const submit = await postJson(url, {
    ...params,
    dryRun: false,
    baseVersion: preview.body.baseVersion,
    previewToken: preview.body.previewToken,
  });
  if (submit.status !== 200) {
    return {
      ok: false, stage: 'submit', status: submit.status,
      code: submit.body?.code || null,
      error: submit.body?.error || `提交失败（HTTP ${submit.status}）`,
      preview: preview.body,
    };
  }
  const data = submit.body || {};
  // 结果入口:backupRef 是只读副本引用(不是路径),只用来在文件管理器里定位副本文件。
  if (data.backupRef) {
    emitHistoryBackup({ sessionId, op, backupRef: data.backupRef, changed: data.changed === true, report: data.report || null });
  }
  // sessionReset:结果会话要新建(原会话里已没有可继续的对话)→ 调用点据此转 draft。
  return { ok: true, status: submit.status, data, preview: preview.body, sessionReset: data.resultSessionId === null };
}

// ── r188:回滚类操作「先停、等它停稳、再动磁盘」的两个小步骤(不依赖组件状态,便于单测)──────────
// 后端在回合进行中一律拒绝裁剪(409 SESSION_RUNNING);回合停下后进程退出时可能再追加一笔收尾记录,
// 预览与提交之间文件变了会回 409 SESSION_CHANGED。这两种重新预览再提交即可,其它失败不重试。
export const TRIM_RETRY_CODES = Object.freeze(['SESSION_RUNNING', 'SESSION_CHANGED']);
export const STOP_WAIT_MAX_MS = 5000;
export const TRIM_RETRY_MAX_MS = 6000;
export const TRIM_RETRY_INTERVAL_MS = 400;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发停止请求并等它回话,最多等 maxWaitMs(绝不无限等控制类调用;回话更晚也不要紧,裁剪重试会接着等)。
 * 带 owner 时后端走「停下后等回合记录结算再回话」那条路;owner 只传能证明属于这个 pid 的身份
 * (resolveStopOwner 给出的),给不出就不带。身份不符后端回 409 且不停,此时补发一次不带身份的。
 * 返回 { sent, replied }。pid 为空时什么都不发、不等。
 */
export async function stopTurnAndWait({ pid, owner = null, fetchImpl, maxWaitMs = STOP_WAIT_MAX_MS } = {}) {
  if (!pid) return { sent: false, replied: false };
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const url = `/api/chat/${pid}/stop`;
  const init = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let replied = false;
  const req = Promise.resolve()
    .then(() => doFetch(url, init(owner ? { hard: true, owner } : { hard: true })))
    .then((r) => (owner && r && r.status === 409 ? doFetch(url, init({ hard: true })) : r))
    .then(() => { replied = true; }, () => { replied = true; });
  let timer = null;
  await Promise.race([req, new Promise((r) => { timer = setTimeout(r, maxWaitMs); })]);
  if (timer) clearTimeout(timer);
  return { sent: true, replied };
}

/**
 * 跑一次历史操作;遇 SESSION_RUNNING / SESSION_CHANGED 时隔 intervalMs 重新预览再提交,
 * 从第一次尝试起最多 maxMs。其它失败与成功都立即返回(runOp 抛出的异常照原样抛出)。
 */
export async function runHistoryOpSettled(sessionId, op, params = {}, {
  runOp = runHistoryOp, maxMs = TRIM_RETRY_MAX_MS, intervalMs = TRIM_RETRY_INTERVAL_MS, now = () => Date.now(),
} = {}) {
  const t0 = now();
  for (;;) {
    const r = await runOp(sessionId, op, params);
    if (r?.ok || !TRIM_RETRY_CODES.includes(r?.code)) return r;
    if (now() - t0 + intervalMs > maxMs) return r;
    await sleepMs(intervalMs);
  }
}

/**
 * 在系统文件管理器中定位备份副本(只读,无副作用)。
 * 路径由服务端按 backupRef 取,客户端不传路径;失败返回 {status, body},由调用点显示。
 */
export async function revealHistoryBackup(sessionId, backupRef) {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/backups/${encodeURIComponent(backupRef)}/reveal`, {});
}
