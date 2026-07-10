import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// Tauri 的 WKWebView/WebView2 会禁用原生 window.confirm() —— 破坏性操作的确认框
// 点了没反应(confirm 同步返回 false → 直接 return)。这是之前删除会话按钮失效的根因。
// 用一个 promise-based、自挂载的 React modal 替代:任何地方 `await confirmDialog(msg)`
// 即可,返回 true/false。Esc/点击遮罩=取消,Enter/确定按钮=确认。
function ConfirmModal({ message, danger, confirmText, cancelText, onResolve }) {
  useEffect(() => {
    // 只全局监听 Escape=取消。Enter=确认交给下方按钮的 autoFocus(焦点在按钮时
    // 浏览器原生用 Enter 激活),避免 input 聚焦场景下全局 Enter 误确认危险操作。
    const onKey = (e) => {
      if (e.key === 'Escape') onResolve(false);
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
          {/* danger 时焦点给取消键:队列化后弹窗一个接一个弹,若确认键 autoFocus,上一个通知弹窗
              按 Enter 关闭后下一个 danger 删除弹窗立即挂载并聚焦红键,Enter 连击/长按会未经阅读误删。 */}
          <button
            autoFocus={danger}
            onClick={() => onResolve(false)}
            className="px-3 py-1.5 rounded-md text-[12px] text-ink-muted hover:bg-canvas-warm font-body transition-colors"
          >
            {cancelText}
          </button>
          <button
            autoFocus={!danger}
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

// 并发弹窗队列化:多处同时 confirmDialog(如多个技能同时更新完成)时,若各自独立挂载
// 会完全同位重叠只见最上一个,且每个都监听 document Esc → 按一次全关、底下的通知丢失。
// 用模块级 promise 链排队:同一时刻只显示一个,确认后下一个自动弹出。
let _dialogQueue = Promise.resolve();
export function confirmDialog(message, opts) {
  const p = _dialogQueue.then(() => showConfirmDialog(message, opts));
  _dialogQueue = p.catch(() => {});
  return p;
}

function showConfirmDialog(message, { danger = false, confirmText = '确定', cancelText = '取消' } = {}) {
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
