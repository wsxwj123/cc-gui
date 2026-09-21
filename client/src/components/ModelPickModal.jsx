// r52 模型勾选弹窗:文本 provider 表单、聊天模型弹层、生图 provider 表单共用同一个。
// r125 语义:拉取到的全量目录作候选进本弹窗;**已在列表里的模型预先勾上且可以弃选**,
// 确认后调用方以本弹窗的最终勾选集为准写回(勾掉的移除、新勾的加入,见 utils/modelPick.js
// replaceModelLines;候选目录外的既有 id 由调用方原样保留)。「全选 / 全不选」只作用于当前
// 搜索筛选结果 —— 中转站目录动辄几百条,全库全选毫无意义且会把噪音一次性灌进白名单。
//
// 模态红线:portal 到 body(调用方的弹层/面板带 animate-glass-rise 收尾 transform,
// 其内的 fixed 遮罩会被困住盖不满全屏);flex 列三段(头/正文/底),不用 sticky
// (WKWebView 的 transform 滚动容器内 sticky 失效);不用 window.confirm/alert(Tauri 禁用)。
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from './Icon.jsx';
import { filterModels } from '../utils/modelPick.js';

// 纯逻辑在 utils/modelPick.js(单测直击),此处一并转出,调用方只 import 这一个模块即可。
export { JUNK_MODEL_RE, filterModels, mergeModelLines, replaceModelLines, selectAllTargets, stripJunkModels } from '../utils/modelPick.js';

// r87 单选形态:传 onPick 就变成「点一行即选中并关闭」——「浏览」按钮用它给模型输入框
// 回填一个值。此时 existing 只做"已在候选列表中"的标注,不再禁用整行(候选本身就是白名单,
// 全禁用等于一行都点不了),底栏的确认/全选也不出现(单选没有"批量确认"这回事)。
//
// 多选形态(onConfirm):existing = 打开时的初始勾选集(调用方给"当前已在列表里的模型")。
// 其中不在 candidates 里的 id 没有对应行,留在勾选集里原样带回(头部小字提示数量),
// 调用方据此保留用户手填的模型。
export function ModelPickModal({ candidates = [], existing = [], onConfirm, onPick, onClose, title = '选择模型' }) {
  const [query, setQuery] = useState('');
  // r125:初始勾选 = existing 全部(已选的显示为"选中且可取消",不再禁用、不再打「已添加」)。
  const [checked, setChecked] = useState(() => new Set((existing || []).filter((id) => typeof id === 'string' && id.trim())));
  const existingSet = useMemo(() => new Set(existing || []), [existing]);
  const filtered = useMemo(() => filterModels(candidates, query), [candidates, query]);
  const candidateSet = useMemo(() => new Set(Array.isArray(candidates) ? candidates : []), [candidates]);
  // 勾选集里没有对应行的 id(候选目录外的既有模型):只提示数量,写回时由调用方保留。
  const hiddenKept = useMemo(() => [...checked].filter((id) => !candidateSet.has(id)).length, [checked, candidateSet]);
  const visibleChecked = checked.size - hiddenKept;

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
  // 「全选 / 全不选」只作用于当前筛选结果(r125:已选项可被弃选,故全选要把筛选结果里被
  // 弃选的已有项也重新勾回,不再跳过 existing)。
  const selectAll = () => setChecked((prev) => new Set([...prev, ...filtered]));
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
      {/* data-testid="model-pick-modal":INTERFACE-r125 §B 公开锚点(弹窗根)。挂在面板节点而不是
          外层遮罩上:面板才是"同时罩住行列表与底栏按钮的最深容器",与按形态定位的既有用法落在同一元素。
          r125:面板只做淡入(animate-fade-in),不用 animate-glass-rise —— 那个 320ms 的 translateY+scale
          会让勾选行在入场期间持续位移,弹出即点(用户手快 / 自动化)会点到相邻一行;既有项现在可弃选,
          错点一行就是把别的模型勾掉。opacity 动画不改几何,首帧起坐标即稳定。 */}
      <div data-cgui-panel data-testid="model-pick-modal"
        className="glass-popover w-[520px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[min(80vh,calc(var(--app-h,100dvh)-2rem))] flex flex-col overflow-hidden rounded-panel shadow-popover animate-fade-in"
        onClick={(e) => e.stopPropagation()}>
        {/* 头:标题 + 已选中计数 + 搜索 */}
        <div className="shrink-0 px-4 py-3 border-b border-canvas-deep bg-canvas space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 text-[13px] font-medium text-ink font-body">{title}</div>
            <span className="text-[11px] text-ink-faint font-body">{onPick ? `${filtered.length} 个` : `已选中 ${visibleChecked} 个`}</span>
            <button type="button" onClick={() => onClose?.()} className="p-1 rounded hover:bg-canvas-warm transition-colors">
              <X size={13} className="text-ink-faint" />
            </button>
          </div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索模型…" autoFocus
            data-testid="model-pick-search"
            className="w-full bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-[12px] text-ink font-body focus:outline-none focus:border-accent/50" />
          <div className="text-[10px] text-ink-faint font-body leading-snug">
            {onPick
              ? '点击任一模型即填入「模型」输入框并关闭本窗口。列表为该 provider 已保存的候选模型；要新增候选请用「拉取模型」。'
              : '已在列表中的模型已预先勾选，取消勾选即从列表移除；点「确认」后以本窗口的勾选结果为准写回。'}
            {!onPick && hiddenKept > 0 && (
              <span className="block mt-0.5">另有 {hiddenKept} 个已有模型不在本次拉取的目录中，确认后原样保留。</span>
            )}
          </div>
        </div>
        {/* 正文:整行可点(label 包裹 checkbox) */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-[12px] text-ink-faint font-body text-center">无匹配模型。</div>
          )}
          {filtered.map((id, i) => {
            const added = existingSet.has(id);
            // 单选形态:整行是一个按钮(键盘 Tab 可达、回车可选),没有勾选框。
            if (onPick) {
              return (
                <button
                  type="button"
                  key={id}
                  data-testid="model-pick-row"
                  data-model-id={id}
                  onClick={() => onPick(id)}
                  className={`w-full text-left flex items-center gap-2 px-4 py-2 transition-colors hover:bg-canvas-warm ${i % 2 ? 'bg-canvas-warm/30' : ''}`}
                >
                  <span className="flex-1 min-w-0 text-[12px] font-mono text-ink truncate">{id}</span>
                  {added && <span className="text-[10px] text-ink-faint font-body shrink-0">当前候选</span>}
                </button>
              );
            }
            // r125:已在列表里的行与新候选同样可勾可弃,不再 disabled、不再标「已添加」。
            return (
              <label key={id}
                data-testid="model-pick-row"
                data-model-id={id}
                className={`flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors hover:bg-canvas-warm ${
                  i % 2 ? 'bg-canvas-warm/30' : ''}`}>
                <input type="checkbox" checked={checked.has(id)}
                  onChange={() => toggle(id)} className="accent-accent shrink-0" />
                <span className="flex-1 min-w-0 text-[12px] font-mono text-ink truncate">{id}</span>
              </label>
            );
          })}
        </div>
        {/* 底:左确认/取消,右全选/全不选(均只作用于当前筛选结果)。单选形态只留「取消」。
            确认在勾选集为空时禁用(避免误清空)。 */}
        <div className="shrink-0 px-4 py-3 border-t border-canvas-deep bg-canvas flex items-center gap-2">
          {!onPick && <button type="button" disabled={checked.size === 0}
            data-testid="model-pick-confirm"
            onClick={() => onConfirm?.([...checked])}
            className="px-3 py-1.5 rounded-md bg-accent text-on-accent text-[12px] font-body disabled:bg-canvas-deep disabled:text-ink-ghost transition-colors flex items-center gap-1">
            <Check size={12} />确认
          </button>}
          <button type="button" onClick={() => onClose?.()}
            className="px-3 py-1.5 rounded-md border border-canvas-deep text-[12px] text-ink-soft font-body">取消</button>
          <div className="flex-1" />
          {!onPick && <button type="button" onClick={selectAll}
            className="px-2 py-1 rounded-md text-[11px] text-accent font-body hover:bg-canvas-warm transition-colors">全选</button>}
          {!onPick && <button type="button" onClick={clearAll}
            className="px-2 py-1 rounded-md text-[11px] text-ink-soft font-body hover:bg-canvas-warm transition-colors">全不选</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ModelPickModal;
