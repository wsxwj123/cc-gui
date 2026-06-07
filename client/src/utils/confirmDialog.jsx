import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// Tauri 的 WKWebView/WebView2 会禁用原生 window.confirm() —— 破坏性操作的确认框
// 点了没反应(confirm 同步返回 false → 直接 return)。这是之前删除会话按钮失效的根因。
// 用一个 promise-based、自挂载的 React modal 替代:任何地方 `await confirmDialog(msg)`
// 即可,返回 true/false。Esc/点击遮罩=取消,Enter/确定按钮=确认。
function ConfirmModal({ message, danger, confirmText, cancelText, onResolve }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onResolve(false);
      else if (e.key === 'Enter') onResolve(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onResolve]);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 px-4 animate-fade-in"
      onClick={() => onResolve(false)}
    >
      <div
        className="w-[min(92vw,420px)] rounded-xl bg-canvas border border-canvas-deep shadow-2xl p-5 animate-glass-rise"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[13px] text-ink font-body whitespace-pre-wrap leading-relaxed mb-4">
          {message}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => onResolve(false)}
            className="px-3 py-1.5 rounded-md text-[12px] text-ink-muted hover:bg-canvas-warm font-body transition-colors"
          >
            {cancelText}
          </button>
          <button
            autoFocus
            onClick={() => onResolve(true)}
            className={`px-3 py-1.5 rounded-md text-[12px] text-white font-body transition-colors ${danger ? 'bg-red-600 hover:bg-red-500' : 'bg-accent hover:bg-accent/90'}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

export function confirmDialog(message, { danger = false, confirmText = '确定', cancelText = '取消' } = {}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      root.unmount();
      host.remove();
      resolve(result);
    };
    root.render(
      <ConfirmModal
        message={message}
        danger={danger}
        confirmText={confirmText}
        cancelText={cancelText}
        onResolve={finish}
      />
    );
  });
}
