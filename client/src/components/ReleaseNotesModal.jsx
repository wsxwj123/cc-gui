import { useCallback, useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from './Icon.jsx'; // 全仓 lucide 唯一出口(皮肤可替换)
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { loadVersionNotes, releaseNotesIndex } from '../utils/releaseNotes.js';

// 「更新说明」弹窗:装完新版打开 GUI 时自动弹一次(同版本只弹一次),也可从
// 设置 → 通用 → GUI 版本与更新 里的「查看更新说明」手动打开、翻看历史版本。
//
// 内容来自 bundle 里的 generated/release-notes/*.json(构建期从 CHANGELOG.md 切的),
// 不联网。正文用项目自带的 MarkdownRenderer 渲染,不引新库。
//
// 布局硬约束:flex 列三段(头 shrink-0 / 正文 flex-1 min-h-0 overflow-y-auto / 底 shrink-0)。
// ⚠️ 禁止 sticky 底栏 —— .glass-popover 的 animate-glass-rise 以 scale(1) + fill:both 收尾,
// 卡片永久带 transform,而带 transform 的滚动容器内 sticky bottom-0 在 WKWebView/WebView2
// 下是哑的:长内容滚不到底、看不见「已知晓」。项目已踩过一次。
export function ReleaseNotesModal({ open, initialVersion, initialNotes = null, onClose }) {
  const list = releaseNotesIndex;
  const startIdx = Math.max(0, list.findIndex((v) => v.version === initialVersion));
  const [idx, setIdx] = useState(startIdx);
  const [notes, setNotes] = useState(null);
  const [failed, setFailed] = useState(false);
  const cur = list[idx] || null;

  // 每次打开都回到"当前运行的这一版",不继承上次翻到哪。
  useEffect(() => { if (open) setIdx(startIdx); }, [open, startIdx]);

  useEffect(() => {
    if (!open || !cur) return undefined;
    // 自动弹的那次正文已在 App 里预加载好(先备好内容再弹,避免空窗闪一下)。
    if (initialNotes && initialNotes.version === cur.version) { setNotes(initialNotes); setFailed(false); return undefined; }
    let alive = true;
    setNotes(null);
    setFailed(false);
    loadVersionNotes(cur.version)
      .then((d) => { if (alive) setNotes(d); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [open, cur, initialNotes]);

  // Esc 关闭。捕获阶段拦截并 stopPropagation:阻断冒泡到全局的「双击 Esc 停止流」监听
  // (与 ProviderManagerModal / ShortcutsPanel 同手法)。
  const close = useCallback(() => { onClose?.(); }, [onClose]);
  useEffect(() => {
    if (!open) return undefined;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [open, close]);

  if (!open || !cur) return null;
  const groups = Array.isArray(notes?.groups) ? notes.groups : [];
  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/40 backdrop-blur-soft animate-fade-in"
      onClick={close}
    >
      <div
        className="glass-popover w-[520px] max-w-[calc(var(--app-w,100vw)-1.5rem)] max-h-[min(80vh,calc(var(--app-h,100dvh)-3rem))] rounded-panel shadow-popover animate-glass-rise overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头 */}
        <div className="shrink-0 flex items-start gap-3 px-5 py-4 border-b border-canvas-deep">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 text-[18px]">✨</div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-display font-semibold text-ink">
              本次更新 <span className="font-mono text-accent">v{cur.version}</span>
            </div>
            <div className="text-[11px] text-ink-faint font-body mt-0.5">
              {cur.date || '更新说明'}
              {list.length > 1 && <span className="ml-2">共 {list.length} 个版本可翻看</span>}
            </div>
          </div>
          <button onClick={close} className="p-1 rounded hover:bg-canvas-warm text-ink-faint hover:text-ink shrink-0" title="关闭">
            <X size={15} />
          </button>
        </div>

        {/* 正文:唯一的滚动区 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {failed && <div className="text-[12px] text-ink-muted font-body">这一版的更新说明没能载入。</div>}
          {!failed && !notes && <div className="text-[12px] text-ink-faint font-body">载入中…</div>}
          {groups.map((g, i) => (
            <div key={`${g.title}-${i}`} className="space-y-1.5">
              {g.title && (
                <div className="text-[11px] font-body font-medium text-ink-muted uppercase tracking-wider">{g.title}</div>
              )}
              <div className="text-[12.5px] text-ink font-body leading-relaxed">
                <MarkdownRenderer content={g.items.map((it) => `- ${it}`).join('\n')} />
              </div>
            </div>
          ))}
          {notes && !groups.length && (
            <div className="text-[12px] text-ink-muted font-body">这一版没有记录条目。</div>
          )}
        </div>

        {/* 底:不用 sticky,靠 flex 列固定在卡片底部 */}
        <div className="shrink-0 px-5 py-3 border-t border-canvas-deep flex items-center justify-between gap-2 bg-canvas-warm/40">
          <div className="flex items-center gap-1 text-[11px] text-ink-faint font-mono">
            <button
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx === 0}
              className="p-1 rounded hover:bg-canvas-warm text-ink-muted hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
              title="更新的版本"
            >
              <ChevronLeft size={14} />
            </button>
            <span>{idx + 1}/{list.length}</span>
            <button
              onClick={() => setIdx((i) => Math.min(list.length - 1, i + 1))}
              disabled={idx >= list.length - 1}
              className="p-1 rounded hover:bg-canvas-warm text-ink-muted hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
              title="更早的版本"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <button
            onClick={close}
            className="px-3 py-1.5 text-[12px] text-on-accent bg-accent hover:bg-accent/90 rounded-md transition-colors"
          >
            已知晓
          </button>
        </div>
      </div>
    </div>
  );
}
