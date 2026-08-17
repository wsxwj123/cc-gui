import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, X } from './Icon.jsx';

// 窗内检索浮层(Cmd/Ctrl+F)。高亮用 CSS Custom Highlight API(CSS.highlights +
// Range),**完全不改 DOM** —— 否则边流式 re-render 边包 <mark> 会触发 React
// removeChild 崩溃。不支持该 API 的旧 webview 退化为"只滚动定位、不高亮"。
//
// 匹配在单个文本节点内查找(跨元素边界的匹配忽略,聊天里极少见),够用且稳。

const HL = 'cgui-search';
const HL_ACTIVE = 'cgui-search-active';
const supportsHighlight = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

export default function ChatSearch({ containerRef, onClose }) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(0); // 1-based;0 = 无
  const activeRef = useRef(0);              // 与 active 同步,供 go() 计算下一项(不在 setState updater 里做副作用)
  const inputRef = useRef(null);
  const rangesRef = useRef([]);

  const clearHighlights = useCallback(() => {
    if (!supportsHighlight) return;
    CSS.highlights.delete(HL);
    CSS.highlights.delete(HL_ACTIVE);
  }, []);

  // 收集匹配 Range
  const buildRanges = useCallback((q) => {
    const el = containerRef.current;
    if (!el || !q) return [];
    const needle = q.toLowerCase();
    const ranges = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        // 跳过本搜索浮层自身的文本
        const p = node.parentElement;
        if (p && p.closest('[data-cgui-search-ui]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.toLowerCase();
      let idx = text.indexOf(needle);
      while (idx !== -1) {
        const r = document.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + needle.length);
        ranges.push(r);
        idx = text.indexOf(needle, idx + needle.length);
      }
    }
    return ranges;
  }, [containerRef]);

  // 高亮当前激活项 + 滚动到视图
  const paintActive = useCallback((ranges, activeIdx) => {
    if (!supportsHighlight || ranges.length === 0) return;
    CSS.highlights.set(HL, new Highlight(...ranges));
    const a = ranges[activeIdx - 1];
    if (a) {
      CSS.highlights.set(HL_ACTIVE, new Highlight(a));
      try {
        const rect = a.getBoundingClientRect();
        const el = containerRef.current;
        const cr = el.getBoundingClientRect();
        if (rect.top < cr.top + 40 || rect.bottom > cr.bottom - 40) {
          el.scrollTop += rect.top - cr.top - cr.height / 3;
        }
      } catch {}
    }
  }, [containerRef]);

  // query 变化 → 重算
  useEffect(() => {
    const q = query.trim();
    clearHighlights();
    if (!q) { rangesRef.current = []; setCount(0); setActive(0); return; }
    const ranges = buildRanges(q);
    rangesRef.current = ranges;
    setCount(ranges.length);
    const first = ranges.length ? 1 : 0;
    activeRef.current = first;
    setActive(first);
    paintActive(ranges, first);
  }, [query, buildRanges, paintActive, clearHighlights]);

  const go = useCallback((dir) => {
    const n = rangesRef.current.length;
    if (!n) return;
    const next = ((activeRef.current - 1 + dir + n) % n) + 1;
    activeRef.current = next;
    setActive(next);
    paintActive(rangesRef.current, next);
  }, [paintActive]);

  useEffect(() => {
    inputRef.current?.focus();
    return () => clearHighlights();
  }, [clearHighlights]);

  // Esc 关检索:挂 window 捕获(本组件只在检索打开期间挂载,卸载即摘)。元素级 onKeyDown
  // 只在输入框聚焦时收得到 —— 点了正文再按 Esc 就直穿到 window 上的会话级监听,变成
  // "关个检索框停掉整回合"。
  // R1:原来挂 document 冒泡,晚于右侧面板监听的 document 捕获 → 面板开着时这一击先关面板、
  // 检索框留着(层级颠倒)。改与灯箱/预览等浮层同款的 window 捕获,stopPropagation 一样
  // 挡得住后面所有相位(含会话级停止监听)。
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
  };

  return (
    <div
      data-cgui-search-ui
      className="absolute top-3 right-8 left-3 md:left-auto z-50 flex items-center gap-1.5 glass-popover rounded-lg pl-3 pr-1.5 py-1.5 shadow-popover animate-fade-in max-w-[calc(var(--app-w,100vw)-2.75rem)]"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="窗内检索…"
        className="bg-transparent outline-none text-[13px] text-ink font-body w-44 min-w-0 flex-1 md:flex-none placeholder:text-ink-ghost"
      />
      <span className="text-[11px] text-ink-faint font-mono tabular-nums min-w-[42px] text-right">
        {count ? `${active}/${count}` : (query.trim() ? '0' : '')}
      </span>
      <button onClick={() => go(-1)} disabled={!count} className="p-1 rounded hover:bg-canvas-deep/50 disabled:opacity-30 text-ink-soft" title="上一个 (Shift+Enter)"><ChevronUp size={15} /></button>
      <button onClick={() => go(1)} disabled={!count} className="p-1 rounded hover:bg-canvas-deep/50 disabled:opacity-30 text-ink-soft" title="下一个 (Enter)"><ChevronDown size={15} /></button>
      <button onClick={onClose} className="p-1 rounded hover:bg-canvas-deep/50 text-ink-soft" title="关闭 (Esc)"><X size={15} /></button>
      {!supportsHighlight && <span className="text-[10px] text-warning ml-1" title="当前 webview 不支持高亮,仅滚动定位">⚠</span>}
    </div>
  );
}
