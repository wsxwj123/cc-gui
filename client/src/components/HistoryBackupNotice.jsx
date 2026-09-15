import React, { useEffect, useState } from 'react';
import { HISTORY_BACKUP_EVENT, revealHistoryBackup } from '../utils/historyOps.js';

// R25:历史操作(裁剪/压缩/剥离思考/兼容修复)完成后的结果入口。
// 【为什么不再有"应用内查看副本"】副本是整份会话原文(实报会话 16.9MB / 1691 万字符)。
// 旧实现把它整个塞进弹层 <pre>:WebKit 排版 11.9s、界面 38.1s 对任何操作没应答(正文 347 万 px 高)。
// 现在只让服务端在系统文件管理器里定位这份文件 —— 看原文交给用户的编辑器,应用内不碰正文。
const OP_TEXT = {
  trim: '裁剪历史',
  'compact-segment': '压缩片段',
  'trim-before-tool': '回退到工具调用前',
  'strip-thinking': '剥离思考块',
  'repair-official-compat': '官方兼容修复',
};

/** 按钮文案随平台走:mac 是访达,Windows 是资源管理器。 */
function revealText() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return '在资源管理器中显示';
  if (/Linux/i.test(ua)) return '在文件管理器中显示';
  return '在访达中显示';
}

/** 挂在 App 顶层一次即可:收到历史操作成功事件就留一行结果提示。 */
export function HistoryBackupNotice() {
  const [entry, setEntry] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const onBackup = (e) => { setEntry(e.detail || null); setBusy(false); setError(null); };
    window.addEventListener(HISTORY_BACKUP_EVENT, onBackup);
    return () => window.removeEventListener(HISTORY_BACKUP_EVENT, onBackup);
  }, []);
  if (!entry) return null;
  const onReveal = async () => {
    setBusy(true);
    setError(null);
    const r = await revealHistoryBackup(entry.sessionId, entry.backupRef).catch(() => ({ status: 0, body: {} }));
    setBusy(false);
    if (r.status !== 200) setError(r.body?.error || `打开失败（HTTP ${r.status}）`);
  };
  return (
    <div className="fixed bottom-4 right-4 z-[9990] flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-canvas/90 border border-canvas-deep shadow-popover text-[11px] font-body text-ink-faint">
      <span>{OP_TEXT[entry.op] || '历史操作'}完成{entry.changed === false ? '（无改动）' : ''}</span>
      {entry.backupRef && (
        <button
          type="button"
          disabled={busy}
          onClick={onReveal}
          className="text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-50"
        >{revealText()}</button>
      )}
      {error && <span className="text-error">{error}</span>}
      <button
        type="button"
        onClick={() => setEntry(null)}
        className="px-1 rounded text-ink-faint hover:text-ink"
        aria-label="关闭备份入口"
      >×</button>
    </div>
  );
}
