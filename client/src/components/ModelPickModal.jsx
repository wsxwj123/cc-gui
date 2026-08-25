// r52 模型勾选弹窗:文本 provider 表单、聊天模型弹层、生图 provider 表单共用同一个。
// 语义:拉取到的全量目录只作候选进本弹窗,确认后 merge 进白名单(只增不减,删除权在
// 用户手上)。「全选 / 全不选」只作用于当前搜索筛选结果 —— 中转站目录动辄几百条,
// 全库全选毫无意义且会把噪音一次性灌进白名单。
//
// 模态红线:portal 到 body(调用方的弹层/面板带 animate-glass-rise 收尾 transform,
// 其内的 fixed 遮罩会被困住盖不满全屏);flex 列三段(头/正文/底),不用 sticky
// (WKWebView 的 transform 滚动容器内 sticky 失效);不用 window.confirm/alert(Tauri 禁用)。
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from './Icon.jsx';
import { filterModels, selectAllTargets } from '../utils/modelPick.js';

// 纯逻辑在 utils/modelPick.js(单测直击),此处一并转出,调用方只 import 这一个模块即可。
export { JUNK_MODEL_RE, filterModels, mergeModelLines, selectAllTargets, stripJunkModels } from '../utils/modelPick.js';

export function ModelPickModal({ candidates = [], existing = [], onConfirm, onClose, title = '选择要添加的模型' }) {
  const [query, setQuery] = useState('');
  const [checked, setChecked] = useState(() => new Set());
  const existingSet = useMemo(() => new Set(existing || []), [existing]);
  const filtered = useMemo(() => filterModels(candidates, query), [candidates, query]);

  // Esc:先清搜索,搜索已空则关闭。
  // 相位必须是 window 捕获 + stopImmediatePropagation(与 ImageLightbox 同款):仓内浮层
  // (弹层 AnchoredPopover / Provider 管理弹窗 / 右侧面板守卫)全挂 window|document 捕获,
  // 挂 document 冒泡就排在相位链最末 —— 被全员抢跑:弹层关错层、面板连同未保存表单一起关、
  // 焦点在本弹窗输入框时事件还会被面板守卫截走变哑键。宿主侧另有 data-cgui-modelpick 让行
  // (同相位、注册更早的监听抢不过 stopImmediatePropagation,只能靠宿主主动查标记避让)。
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (query) setQuery(''); else onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [query, onClose]);

  const toggle = (id) => setChecked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setChecked((prev) => new Set([...prev, ...selectAllTargets(filtered, existingSet)]));
  const clearAll = () => setChecked((prev) => {
    const next = new Set(prev);
    for (const id of filtered) next.delete(id);
    return next;
  });

  return createPortal(
    // data-cgui-modelpick:宿主(Provider 管理弹窗 / 右侧面板 Esc 守卫)据此让行,与既有
    // data-cgui-confirm 同手法。z 值压过 AnchoredPopover 的内联 zIndex:9999(否则被弹层盖住)。
    <div data-cgui-modelpick="1"
      className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/40 backdrop-blur-soft animate-fade-in px-4"
      onClick={() => onClose?.()}>
      <div data-cgui-panel
        className="glass-popover w-[520px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[min(80vh,calc(var(--app-h,100dvh)-2rem))] flex flex-col overflow-hidden rounded-panel shadow-popover animate-glass-rise"
        onClick={(e) => e.stopPropagation()}>
        {/* 头:标题 + 已选中计数 + 搜索 */}
        <div className="shrink-0 px-4 py-3 border-b border-canvas-deep bg-canvas space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 text-[13px] font-medium text-ink font-body">{title}</div>
            <span className="text-[11px] text-ink-faint font-body">已选中 {checked.size} 个</span>
            <button type="button" onClick={() => onClose?.()} className="p-1 rounded hover:bg-canvas-warm transition-colors">
              <X size={13} className="text-ink-faint" />
            </button>
          </div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型…" autoFocus
            className="w-full bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-[12px] text-ink font-body focus:outline-none focus:border-accent/50" />
          <div className="text-[10px] text-ink-faint font-body leading-snug">
            已在列表中的模型标为「已添加」，勾选新模型后点「确认」即并入；本弹窗只增不减，删除模型请在模型列表中操作。
          </div>
        </div>
        {/* 正文:整行可点(label 包裹 checkbox) */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-[12px] text-ink-faint font-body text-center">无匹配模型。</div>
          )}
          {filtered.map((id, i) => {
            const added = existingSet.has(id);
            return (
              <label key={id}
                className={`flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors hover:bg-canvas-warm ${
                  i % 2 ? 'bg-canvas-warm/30' : ''} ${added ? 'opacity-75' : ''}`}>
                <input type="checkbox" checked={added || checked.has(id)} disabled={added}
                  onChange={() => toggle(id)} className="accent-accent shrink-0" />
                <span className="flex-1 min-w-0 text-[12px] font-mono text-ink truncate">{id}</span>
                {added && <span className="text-[10px] text-ink-faint font-body shrink-0">已添加</span>}
              </label>
            );
          })}
        </div>
        {/* 底:左确认/取消,右全选/全不选(均只作用于当前筛选结果) */}
        <div className="shrink-0 px-4 py-3 border-t border-canvas-deep bg-canvas flex items-center gap-2">
          <button type="button" disabled={checked.size === 0}
            onClick={() => onConfirm?.([...checked])}
            className="px-3 py-1.5 rounded-md bg-accent text-on-accent text-[12px] font-body disabled:bg-canvas-deep disabled:text-ink-ghost transition-colors flex items-center gap-1">
            <Check size={12} />确认
          </button>
          <button type="button" onClick={() => onClose?.()}
            className="px-3 py-1.5 rounded-md border border-canvas-deep text-[12px] text-ink-soft font-body">取消</button>
          <div className="flex-1" />
          <button type="button" onClick={selectAll}
            className="px-2 py-1 rounded-md text-[11px] text-accent font-body hover:bg-canvas-warm transition-colors">全选</button>
          <button type="button" onClick={clearAll}
            className="px-2 py-1 rounded-md text-[11px] text-ink-soft font-body hover:bg-canvas-warm transition-colors">全不选</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ModelPickModal;
