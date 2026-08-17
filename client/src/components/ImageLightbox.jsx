import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink } from './Icon.jsx';

// #7 全屏图片放大预览。portal 到 body(逃 transform 包含块,同 ArtifactPreview 全屏范式)。
// src 为空 → 不渲染。Esc 关闭(capture + stopImmediatePropagation,防误触上层 Esc:
// 中断会话/关面板);点背景关闭;锁 body 滚动。内置"用默认 App 打开"按钮(有 path 时)。
export function ImageLightbox({ src, name, path, onClose }) {
  useEffect(() => {
    if (!src) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true); // capture:先于冒泡阶段的其他 Esc 处理
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey, true); document.body.style.overflow = prev; };
  }, [src, onClose]);

  if (!src) return null;
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-6" onClick={onClose}>
      {path && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            fetch('/api/files/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).catch(() => {});
          }}
          className="absolute top-4 right-16 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-[12px] font-body transition-colors"
          title="用默认 App 打开"
        >
          <ExternalLink size={13} /> 用默认 App 打开
        </button>
      )}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
        title="关闭 (Esc)"
      >
        <X size={16} />
      </button>
      {/* 点图片本身不关闭;点背景才关 */}
      <img
        src={src}
        alt={name || ''}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[min(92vw,calc(var(--app-w,100vw)-1rem))] max-h-[min(92vh,calc(var(--app-h,100dvh)-1rem))] object-contain rounded-lg shadow-popover"
      />
    </div>,
    document.body,
  );
}
