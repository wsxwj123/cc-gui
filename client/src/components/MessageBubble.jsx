import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { User, Brain, Copy, Check, RotateCcw, Pencil, X } from 'lucide-react';
import { computeCost, formatCost } from '../utils/pricing.js';
import { useStore } from '../stores/sessionStore.js';

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

// Per-message rollback menu. Shows three choices on click:
//   - rollback message + AI replies after it (chat trim)
//   - rollback files via git checkpoint sha
//   - both
// onAction is invoked with { mode: 'message'|'files'|'both' } or { mode: 'edit' }.
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
      // Place menu just below trigger, right-aligned. Viewport-relative
      // (position: fixed) so it floats above every parent's stacking ctx.
      setCoords({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
    setOpen(!open);
  };

  // Render the menu in a portal at body level so it doesn't get clipped by
  // any ancestor's overflow / transform / opacity. z-index now actually means
  // "on top of everything" rather than "on top of siblings".
  const menu = open && coords && (
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: coords.top, right: coords.right, zIndex: 9999 }}
      className="w-64 py-1 rounded-lg shadow-xl bg-canvas border border-canvas-deep animate-glass-rise"
    >
      <div className="px-3 py-2 text-[10px] text-ink-faint uppercase tracking-wider font-body border-b border-canvas-deep">
        回滚此消息{hasSha ? '' : ' · 无 git 快照'}
      </div>
      <button
        onClick={() => { onAction({ mode: 'message' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
      >
        <RotateCcw size={13} className="text-accent mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">回滚并重发</div>
          <div className="text-[11px] text-ink-faint font-body">还原 {hasSha ? 'git + ' : ''}会话到发送前，再次发送本条</div>
        </div>
      </button>
      <button
        onClick={() => { onAction({ mode: 'edit' }); setOpen(false); }}
        className="w-full text-left px-3 py-2.5 hover:bg-canvas-warm flex items-start gap-2"
      >
        <Pencil size={13} className="text-accent mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">重新编辑</div>
          <div className="text-[11px] text-ink-faint font-body">还原 {hasSha ? 'git + ' : ''}会话，文本回到输入框</div>
        </div>
      </button>
      <button
        disabled={!hasSha}
        onClick={() => { onAction({ mode: 'files' }); setOpen(false); }}
        className={`w-full text-left px-3 py-2.5 flex items-start gap-2 ${hasSha ? 'hover:bg-canvas-warm' : 'opacity-50 cursor-not-allowed'}`}
        title={hasSha ? '' : '没有可用的 git 快照'}
      >
        <X size={13} className="text-amber-600 mt-0.5 shrink-0" />
        <div>
          <div className="text-[13px] font-medium text-ink font-body">只还原文件</div>
          <div className="text-[11px] text-ink-faint font-body">仅 git 还原，保留会话</div>
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
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-canvas-deep rounded"
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
  if (!usage) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const provider = useStore((s) => s.currentProvider);
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
            `本条估算（${cost.currency === 'CNY' ? '原价 CNY，已按 1 USD ≈ 7.2 CNY 换算' : 'USD'}）\n` +
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

export function MessageBubble({ message, onRollback }) {
  const isUser = message.role === 'user';
  const [showThinking, setShowThinking] = useState(false);

  if (isUser) {
    return (
      <div className="group px-6 py-4 animate-fade-up" style={{ animationDuration: '0.25s' }}>
        <div className="max-w-3xl mx-auto flex flex-row-reverse gap-3">
          <div className="shrink-0 mt-0.5">
            <UserAvatar />
          </div>
          <div className="flex-1 min-w-0 flex flex-col items-end">
            <div className="flex items-center gap-2 mb-1.5">
              {onRollback && <RollbackMenu message={message} onAction={(a) => onRollback(message, a)} />}
              <CopyButton text={message.text} />
              <span className="text-[11px] text-ink-faint font-mono">{formatTime(message.timestamp)}</span>
              <span className="text-[13px] font-medium text-ink font-body">你</span>
            </div>
            <div className="max-w-[85%] bg-canvas-warm border border-canvas-deep rounded-2xl rounded-tr-md px-4 py-2.5">
              <div className="text-[15px] font-reading leading-relaxed whitespace-pre-wrap text-ink">{message.text}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group px-6 py-4 animate-fade-up" style={{ animationDuration: '0.25s' }}>
      <div className="max-w-3xl mx-auto flex gap-3">
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
                <Brain size={12} />
                <span>思考过程</span>
                <span className="text-[10px]">{showThinking ? '▾' : '▸'}</span>
              </button>
              {showThinking && (
                <div className="thinking-block mt-2 p-4 rounded-lg text-xs text-ink-muted whitespace-pre-wrap max-h-64 overflow-y-auto font-body leading-relaxed">
                  {message.thinking}
                </div>
              )}
            </div>
          )}

          {message.text && <MarkdownRenderer content={message.text} />}

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
