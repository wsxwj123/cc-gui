import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink, ChevronLeft, ChevronRight } from './Icon.jsx';

// #7 全屏图片放大预览。portal 到 body(逃 transform 包含块,同 ArtifactPreview 全屏范式)。
// src 为空 → 不渲染。Esc 关闭(capture + stopImmediatePropagation,防误触上层 Esc:
// 中断会话/关面板);点背景关闭;锁 body 滚动。内置"用默认 App 打开"按钮(有 path 时)。
//
// r95 左右切图:onPrev / onNext / counter 三个可选 prop。本组件仍是哑的 —— 序列由调用方
// 算好,这里只管"发方向"和"到头那侧不画按钮"。三个 prop 都不传 = 与 r95 之前逐字同行为
// (方向键完全不拦截),会话消息与输入框附件的放大层就走这条路。
//
// r94 像素尺寸与 1:1:meta(像素文本,如 1456×816)/ actualSize(是否按原始像素显示)/
// onToggleActualSize(切换)同样是可选 prop,同样不传就完全不渲染 —— 组件保持无 state,
// 尺寸由调用方测、开关由调用方持有。
export function ImageLightbox({ src, name, path, onClose, onPrev, onNext, counter, meta, actualSize, onToggleActualSize }) {
  const open = !!src;
  const nav = !!(onPrev || onNext); // 这个调用方接了导航吗 —— 方向键是否归本模态所有的唯一判据

  // 滚动锁单独一个 effect,依赖【只有 open】:与键盘 effect 合在一起的话,切一张图就
  // cleanup + 重跑一遍,第二次捕获到的 prev 已经是 'hidden' → 关闭后 body 永久锁死。
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); onClose(); return; }
      if (!nav) return; // 没接导航的调用方一个键都不碰:输入框/问答卡的左右键照旧
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // 与 Esc 同口径:模态开着的时候方向键归它,不漏给面板外的全局快捷键。
        e.stopImmediatePropagation();
        e.preventDefault();
        if (e.key === 'ArrowLeft') onPrev?.();
        else onNext?.();
      }
    };
    window.addEventListener('keydown', onKey, true); // capture:先于冒泡阶段的其他 Esc 处理
    return () => { window.removeEventListener('keydown', onKey, true); };
  }, [open, nav, onClose, onPrev, onNext]);

  if (!src) return null;
  const navBtnCls = 'absolute top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors';
  return createPortal(
    <div
      className={`fixed inset-0 z-[200] flex bg-black/80 p-6 ${actualSize ? 'overflow-auto' : 'items-center justify-center'}`}
      onClick={onClose}
    >
      {(counter || meta || onToggleActualSize) && (
        /* fixed 而非 absolute:1:1 档下遮罩自己是滚动容器，absolute 的工具条会跟着内容
           滚出视口，"自适应"就再也点不回来了（它没有键盘替代，Esc 只关不还原）。
           portal 到 body、无 transform 祖先，fixed 的落点与原来的 absolute 逐像素相同。 */
        <div className="fixed top-4 left-4 z-10 flex items-center gap-2">
          {counter && (
            <div className="px-2.5 py-1.5 rounded-lg bg-white/10 text-white text-[12px] font-body">{counter}</div>
          )}
          {meta && (
            <div className="px-2.5 py-1.5 rounded-lg bg-white/10 text-white text-[12px] font-mono" title="图片实际像素">{meta}</div>
          )}
          {onToggleActualSize && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleActualSize(); }}
              className={`px-2.5 py-1.5 rounded-lg text-[12px] font-body transition-colors ${actualSize ? 'bg-white/30 text-white' : 'bg-white/10 hover:bg-white/20 text-white'}`}
              title={actualSize ? '恢复自适应缩放' : '按原始像素显示（超出部分可滚动）'}
            >
              {actualSize ? '自适应' : '1:1'}
            </button>
          )}
        </div>
      )}
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
      {/* 翻页按钮(触屏/无键盘的兜底)。到头那侧调用方传 null → 直接不渲染,"没有按钮"
          就是"按不动了"的可视化。onClick 必须先吃掉冒泡,否则会落到遮罩的 onClose 上。 */}
      {onPrev && (
        <button
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
          className={`${navBtnCls} left-4`}
          title="上一张 (←)"
        >
          <ChevronLeft size={18} />
        </button>
      )}
      {onNext && (
        <button
          onClick={(e) => { e.stopPropagation(); onNext(); }}
          className={`${navBtnCls} right-4`}
          title="下一张 (→)"
        >
          <ChevronRight size={18} />
        </button>
      )}
      {/* 点图片本身不关闭;点背景才关。
          1:1 档:去掉全部尺寸上限按原始像素铺开,超出部分靠遮罩的 overflow-auto 滚动;
          m-auto 让小于视口的图仍居中 —— 用 justify-center 居中的话,溢出的左/上半边会被
          裁掉且滚不回来(flex 溢出的老坑),auto margin 在溢出时自动归零没有这个问题。 */}
      <img
        src={src}
        alt={name || ''}
        onClick={(e) => e.stopPropagation()}
        className={actualSize
          ? 'shrink-0 max-w-none max-h-none m-auto rounded-lg shadow-popover'
          : 'max-w-[min(92vw,calc(var(--app-w,100vw)-1rem))] max-h-[min(92vh,calc(var(--app-h,100dvh)-1rem))] object-contain rounded-lg shadow-popover'}
      />
    </div>,
    document.body,
  );
}
