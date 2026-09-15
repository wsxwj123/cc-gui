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

/**
 * 在系统文件管理器中定位备份副本(只读,无副作用)。
 * 路径由服务端按 backupRef 取,客户端不传路径;失败返回 {status, body},由调用点显示。
 */
export async function revealHistoryBackup(sessionId, backupRef) {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/backups/${encodeURIComponent(backupRef)}/reveal`, {});
}
