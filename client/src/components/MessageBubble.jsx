import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { User, Brain, Copy, Check, RotateCcw, Pencil, GitBranch, Archive, Scissors } from 'lucide-react';
import { computeCost, formatCost } from '../utils/pricing.js';
import { copyText } from '../utils/clipboard.js';
import { useStore } from '../stores/sessionStore.js';

// User messages can be huge (pasted logs, long prompts). Collapse to ~10 lines
// by default with a fade + "展开全部" toggle so the chat stays scannable.
const COLLAPSED_MAX_PX = 240; // ≈ 10 lines at 15px / leading-relaxed
function CollapsibleUserText({ text }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > COLLAPSED_MAX_PX + 4);
  }, [text]);
  const collapsed = overflowing && !expanded;
  return (
    <div>
      <div className="relative">
        <div
          ref={ref}
          className="text-[15px] font-reading leading-relaxed whitespace-pre-wrap text-ink overflow-hidden"
          style={collapsed ? { maxHeight: COLLAPSED_MAX_PX } : undefined}
        >
          {text}
        </div>
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-canvas-warm to-transparent" />
        )}
      </div>
      {overflowing && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[12px] text-accent hover:underline font-body"
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  );
}

// Custom user avatar — persisted as data URL in localStorage. Click the
// avatar circle (only on user messages) to upload an image. Showing the
// chosen image makes the chat feel personal; falling back to the default
// User icon when nothing is set.
function UserAvatar() {
  const [src, setSrc] = useState(() => {
    try { return localStorage.getItem('cgui-user-avatar') || ''; } catch { return ''; }
  });
  const fileRef = useRef(null);
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'cgui-user-avatar') setSrc(e.newValue || '');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const pick = () => fileRef.current?.click();
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setSrc(dataUrl);
      try { localStorage.setItem('cgui-user-avatar', dataUrl); } catch {}
    };
    reader.readAsDataURL(f);
  };
  return (
    <>
      <button
        onClick={pick}
        title="点击更换头像"
        className="w-7 h-7 rounded-full bg-accent flex items-center justify-center overflow-hidden hover:ring-2 hover:ring-accent/40 transition-shadow"
      >
        {src
          ? <img src={src} alt="me" className="w-full h-full object-cover" />
          : <User size={14} className="text-white" />}
      </button>
      <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" />
    </>
  );
}
import { ModelBadge, ProviderAvatar } from './ModelBadge.jsx';
import { ToolCallCard } from './ToolCallCard.jsx';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';
import { thinkingLabel } from '../utils/streamStatus.js';
import { ImageLightbox } from './ImageLightbox.jsx';

// Per-message rollback menu. Shows three choices on click:
//   - rollback message + later replies only (chat trim)
//   - rollback message + files, then resend
//   - rollback message + files, then put text back in composer
// onAction is invoked with { mode: 'message'|'both'|'edit' }.
function RollbackMenu({ message, onAction }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null); // {top,right} viewport coords
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const hasSha = !!message.checkpointSha;

  // Outside-click closes — but only if click hits OUTSIDE both the trigger
  // and the portal'd menu (menu is no longer a descendant of wrapRef).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    // mousedown closes too aggressively (clicking inside menu before mouseup
    // can race with the close listener). Use `click` instead — fires only
    // after a complete press-release on the same target.
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation();
    if (!open && wrapRef.current) {
      const r = wrapRef.current.getBoundingClientRect();
      const gap = 6;
      // 关键:<html> 用了 CSS zoom(字号缩放)。window.innerWidth/Height 是 zoom 不变的,
      // 但 getBoundingClientRect 在 zoom 下是另一套坐标 → 二者相减(原 right=innerWidth-
      // r.right)会按 zoom 倍数错位,菜单飞到一边(用户报告)。改为完全不用 innerWidth/Height
      // 定位:left 放到按钮右缘 + translateX(-100%) 右对齐;上/下用 translateY 翻转。
      // 全部基于 rect + 自身百分比,与 zoom 无关。
      // innerHeight 是 zoom 不变的,r 是 zoom 后视觉坐标 → 需按 --ui-zoom 折算到同一空间
      // (与 App 里 --app-h = innerHeight/z 的约定一致),否则缩放>1 时会误判向下开导致
      // 菜单超出屏幕底部。
      const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
      const visH = window.innerHeight / z;
      const visW = window.innerWidth / z;
      // 实测根因(z>1 时溢出):getBoundingClientRect 返回【视觉px=布局px×z】,而 position:fixed
      // 的 left/top 按【布局px】解释(渲染时再×z)。原代码把视觉px 的 r.right 直接和布局px 的
      // visW/left 混用 → 钳制按错误尺度算 → 菜单横向冲出边界。统一把 r.* 除以 z 折算到布局px。
      const rRight = r.right / z, rTop = r.top / z, rBottom = r.bottom / z;
      const openBelow = (visH - rBottom) >= rTop;
      // 菜单右对齐(translateX -100%)到按钮右缘;窗口比菜单(256)还窄时菜单动态收窄,
      // 保证 right≤visW-8 且 left≥8 同时成立。全部用布局px。
      const menuW = Math.min(256, Math.max(160, visW - 16));
      const left = Math.max(menuW + 8, Math.min(rRight, visW - 8));
      setCoords({
        left,
        top: openBelow ? rBottom + gap : rTop - gap,
        ty: openBelow ? '0' : '-100%',
        w: menuW,
      });
    }
    setOpen(!open);
  };

  // 渲染后兜底钳制:坐标计算在 zoom/平台下可能有边缘误差,这里直接量【实际渲染矩形】
  // (getBoundingClientRect 与 window.innerWidth/Height 同为"视觉px"空间,zoom 无关),
  // 任何方向越界就把 fixed left/top 拉回(视觉超出量 ÷ z 换算成布局px)。收敛 1~2 帧。
  // 这是横向/纵向溢出的最终保险:无论计算对错,渲染出来一定在视口内。
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !coords) return;
    const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
    const m = menuRef.current.getBoundingClientRect();
    const pad = 8;
    let nl = coords.left, nt = coords.top;
    if (m.right > window.innerWidth - pad) nl -= (m.right - (window.innerWidth - pad)) / z;
    if (m.left < pad) nl += (pad - m.left) / z;
    if (m.bottom > window.innerHeight - pad) nt -= (m.bottom - (window.innerHeight - pad)) / z;
    if (m.top < pad) nt += (pad - m.top) / z;
    if (Math.abs(nl - coords.left) > 0.5 || Math.abs(nt - coords.top) > 0.5) {
      setCoords((c) => ({ ...c, left: nl, top: nt }));
    }
  }, [open, coords]);

  // Render the menu in a portal at body level so it doesn't get clipped by
  // any ancestor's overflow / transform / opacity. z-index now actually means
  // "on top of everything" rather than "on top of siblings".
  const menu = open && coords && (
    <div
      ref={menuRef}
      style={{ position: 'fixed', left: coords.left, top: coords.top, width: coords.w || 256, transform: `translate(-100%, ${coords.ty})`, zIndex: 9999 }}
      className="max-w-[calc(var(--app-w,100vw)-16px)] max-h-[80vh] overflow-y-auto py-1 rounded-lg shadow-xl bg-canvas border border-canvas-deep animate-glass-rise"
    >
      <div className="px-3 py-2 text-[10px] text-ink-faint uppercase tracking-wider font-body border-b border-canvas-deep">
        回滚此消息{hasSha ? '' : ' · 自动查找快照'}
      </div>
      <button
        onClick={() => { onAction({ mode: 'message' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
      >
        <RotateCcw size={13} className="text-accent mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">仅回退消息</div>
          <div className="text-[11px] text-ink-faint font-body">裁剪会话后自动重发，不动项目文件</div>
        </div>
      </button>
      <button
        onClick={() => { onAction({ mode: 'both' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
        title={hasSha ? '' : '点击后会按消息时间和文本查找对应快照'}
      >
        <RotateCcw size={13} className="text-amber-600 mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">回退消息和文件</div>
          <div className="text-[11px] text-ink-faint font-body">还原文件快照，裁剪会话，再次发送本条</div>
        </div>
      </button>
      <button
        onClick={() => { onAction({ mode: 'edit' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
        title={hasSha ? '' : '点击后会按消息时间和文本查找对应快照'}
      >
        <Pencil size={13} className="text-accent mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">编辑后重发</div>
          <div className="text-[11px] text-ink-faint font-body">自动回退文件，文本回到输入框</div>
        </div>
      </button>
      <div className="border-t border-canvas-deep" />
      <button
        onClick={() => { onAction({ mode: 'summarize-before' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
      >
        <Archive size={13} className="text-accent mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">压缩此前对话</div>
          <div className="text-[11px] text-ink-faint font-body">此条之前的对话替换为 AI 摘要，此条及之后保留，降低上下文占用</div>
        </div>
      </button>
      <button
        onClick={() => { onAction({ mode: 'summarize-after' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
      >
        <Scissors size={13} className="text-amber-600 mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">总结后回退到此处</div>
          <div className="text-[11px] text-ink-faint font-body">回退到此条之前，此条及之后的对话压缩为摘要保留在上下文中</div>
        </div>
      </button>
    </div>
  );

  return (
    <div ref={wrapRef} className="relative inline-flex">
      {/* Bigger hit area + permanently visible (50% opacity) so user can find &
          click it without first hover-locating a 1-character-wide icon. */}
      <button
        onClick={toggle}
        className="opacity-60 hover:opacity-100 transition-opacity p-1.5 hover:bg-canvas-deep rounded inline-flex items-center justify-center"
        title="回滚 / 重新编辑"
      >
        <RotateCcw size={14} className="text-ink-muted" />
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="p-1 hover:bg-canvas-deep rounded"
      title="复制"
    >
      {copied ? (
        <Check size={12} className="text-success" />
      ) : (
        <Copy size={12} className="text-ink-faint" />
      )}
    </button>
  );
}

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function UsageDisplay({ usage, model }) {
  // hook 必须无条件调用:移到 early return 之前(原在 if(!usage)return 之后=条件调用 hook,
  // usage 有无切换时 hooks 数量变→React 崩;ESLint rules-of-hooks 抓出的真隐患)。
  const provider = useStore((s) => s.currentProvider);
  if (!usage) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cost = computeCost(model, usage, provider);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-faint mt-2 pt-2 border-t border-canvas-deep/50">
      <span>输入 {input.toLocaleString()}</span>
      <span>输出 {output.toLocaleString()}</span>
      {cacheRead > 0 && <span title="cache_read_input_tokens">缓存命中 {cacheRead.toLocaleString()}</span>}
      {cacheWrite > 0 && <span title="cache_creation_input_tokens">缓存写入 {cacheWrite.toLocaleString()}</span>}
      {cost && (
        <span
          className="ml-auto text-accent/80 font-mono"
          title={
            `本条估算（人民币；美元计价模型按 1 USD ≈ 7.2 CNY 换算，人民币计价模型为原生定价）\n` +
            `input ${formatCost(cost.breakdown.input)}\n` +
            `output ${formatCost(cost.breakdown.output)}\n` +
            `cache read ${formatCost(cost.breakdown.cacheRead)}\n` +
            `cache write ${formatCost(cost.breakdown.cacheWrite)}`
          }
        >
          {formatCost(cost.totalUsd)}
        </span>
      )}
    </div>
  );
}

export function MessageBubble({ message, onRollback, onFork }) {
  const isUser = message.role === 'user';
  const [showThinking, setShowThinking] = useState(false);
  const [zoomImage, setZoomImage] = useState(null); // #7 单击放大的图片附件

  if (isUser) {
    return (
      <div className="group px-6 py-4 animate-fade-up" style={{ animationDuration: '0.25s' }}>
        <div className="max-w-[var(--content-max)] mx-auto flex flex-row-reverse gap-3">
          <div className="shrink-0 mt-0.5">
            <UserAvatar />
          </div>
          <div className="flex-1 min-w-0 flex flex-col items-end">
            <div className="flex items-center gap-2 mb-1.5">
              {onRollback && <RollbackMenu message={message} onAction={(a) => onRollback(message, a)} />}
              {onFork && (
                <button onClick={() => onFork(message.uuid)} title="从这条消息分叉出一条新线(只保留到此为止的上下文,丢弃其后对话,原会话不动)"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-ink-faint hover:text-accent hover:bg-canvas-warm transition-colors">
                  <GitBranch size={11} /><span className="hidden md:inline">分叉</span>
                </button>
              )}
              <CopyButton text={message.text} />
              <span className="text-[11px] text-ink-faint font-mono">{formatTime(message.timestamp)}</span>
              <span className="text-[13px] font-medium text-ink font-body">你</span>
            </div>
            <div className="chat-user-bubble max-w-[85%] bg-canvas-warm border border-canvas-deep rounded-lg px-4 py-2.5">
              {/* L3: 附件在文本上方,符合"附件→说明"的自然阅读顺序;CLI 仍收带 @path 的完整 outbound */}
              {Array.isArray(message.attachments) && message.attachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {message.attachments.map((a, i) => {
                    const isImg = a.kind === 'image' && a.preview;
                    return (
                    <div key={i}
                      // #7 决策:图片卡去双击(单击图片放大);非图片文件卡保持双击打开默认 App。
                      onDoubleClick={isImg ? undefined : () => { fetch('/api/files/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: a.path }) }).catch(() => {}); }}
                      className={`flex items-center gap-2 px-2 py-1 bg-canvas border border-canvas-deep rounded-lg max-w-[260px] hover:border-accent/40 transition-colors ${isImg ? '' : 'cursor-pointer'}`}
                      title={isImg ? a.path : `双击用默认应用打开\n${a.path}`}>
                      {isImg ? (
                        <img src={a.preview} alt={a.name}
                          onClick={(e) => { e.stopPropagation(); setZoomImage({ src: a.preview, name: a.name, path: a.path }); }}
                          className="w-10 h-10 rounded object-cover shrink-0 cursor-zoom-in" />
                      ) : (
                        <div className="w-10 h-10 rounded bg-accent/10 flex items-center justify-center shrink-0">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-[12px] text-ink font-body truncate">{a.name}</div>
                        {a.bytes ? <div className="text-[10px] text-ink-faint font-mono">{(a.bytes/1024).toFixed(1)} KB</div> : null}
                      </div>
                    </div>
                  );
                  })}
                </div>
              )}
              <CollapsibleUserText text={(message.attachments?.length && message.displayText !== undefined) ? message.displayText : message.text} />
            </div>
          </div>
        </div>
        {/* #7 已发送图片单击放大;lightbox 内含"用默认 App 打开" */}
        <ImageLightbox src={zoomImage?.src} name={zoomImage?.name} path={zoomImage?.path} onClose={() => setZoomImage(null)} />
      </div>
    );
  }

  return (
    <div className="group px-6 py-4 animate-fade-up" style={{ animationDuration: '0.25s' }}>
      <div className="max-w-[var(--content-max)] mx-auto flex gap-3">
        <div className="mt-0.5">
          <ProviderAvatar model={message.model} size={34} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[13px] font-medium text-ink font-body">Claude</span>
            {message.model && <ModelBadge model={message.model} compact />}
            <span className="text-[11px] text-ink-faint font-mono">{formatTime(message.timestamp)}</span>
            <div className="flex-1" />
            <CopyButton text={message.text} />
          </div>

          {message.thinking && (
            <div className="mb-3">
              <button
                onClick={() => setShowThinking(!showThinking)}
                className="flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink-muted transition-colors font-body"
              >
                <Brain size={12} className="shrink-0" />
                <span className="truncate">{thinkingLabel(message.thinking)}</span>
                <span className="text-[10px] shrink-0">{showThinking ? '▾' : '▸'}</span>
              </button>
              {showThinking && (
                <div className="thinking-block mt-2 p-4 rounded-lg text-xs text-ink-muted whitespace-pre-wrap max-h-64 overflow-y-auto font-body leading-relaxed">
                  {message.thinking}
                </div>
              )}
            </div>
          )}

          {message.text && <MarkdownRenderer content={message.text} dockKeyPrefix={message.uuid} />}

          {message.toolCalls?.length > 0 && (
            <div className="mt-2">
              {message.toolCalls.map((tc, i) => (
                <ToolCallCard key={tc.id || i} toolCall={tc} result={tc.result} />
              ))}
            </div>
          )}

          <UsageDisplay usage={message.usage} model={message.model} />
        </div>
      </div>
    </div>
  );
}
