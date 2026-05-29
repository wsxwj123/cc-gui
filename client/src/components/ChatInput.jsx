import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, Square, Terminal, Puzzle, Wrench, Gauge, ChevronDown, FolderPlus, X, Image as ImageIcon, Shield, ShieldOff, ClipboardList, Check, Pencil, Smartphone } from 'lucide-react';
import { useStore, PERMISSION_MODES } from '../stores/sessionStore.js';
import { PermissionPrompt } from './PermissionPrompt.jsx';
import { TodoPanel } from './TodoPanel.jsx';

// Permission mode metadata — mirrors `claude --permission-mode <choice>`.
const MODE_META = {
  default:           { label: '默认', desc: '每次工具调用前都弹窗询问', icon: Shield,        tone: 'text-ink-muted' },
  acceptEdits:       { label: '接受编辑', desc: '读取/列举/查看类工具自动放行；写入/编辑/删除仍弹窗', icon: Check,         tone: 'text-amber-600' },
  plan:              { label: '规划', desc: '只规划，不执行任何工具', icon: ClipboardList, tone: 'text-blue-600' },
  bypassPermissions: { label: '放任', desc: '跳过全部权限（危险）', icon: ShieldOff,     tone: 'text-red-500' },
};

export function PermissionModeSelector({ permKey }) {
  // Read THIS session's mode (keyed). Subscribing to the map slice keeps the
  // chip in sync when the active session changes underneath us.
  const permissionMode = useStore((s) => (permKey ? (s.permissionModeBySession[permKey] || 'default') : s.permissionMode));
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const current = MODE_META[permissionMode] || MODE_META.default;
  const Icon = current.icon;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-black/5 transition-colors"
        title={`权限: ${current.label} — ${current.desc}`}>
        <Icon size={12} className={current.tone} />
        <span className={`text-[11px] font-body ${current.tone}`}>{current.label}</span>
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      {open && (
        <div className="glass-popover absolute right-0 top-full mt-2 w-60 z-50 py-1 animate-glass-rise">
          <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider font-body">权限模式 (--permission-mode)</div>
          {PERMISSION_MODES.map((m) => {
            const meta = MODE_META[m];
            const MIcon = meta.icon;
            return (
              <button key={m} onClick={() => { setPermissionMode(m, permKey); setOpen(false); }}
                className={`w-full text-left px-3 py-2 hover:bg-black/5 flex items-start gap-2 ${permissionMode === m ? 'bg-accent/12' : ''}`}>
                <MIcon size={13} className={`${meta.tone} mt-0.5 shrink-0`} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-ink font-body">{meta.label}</div>
                  <div className="text-[10px] text-ink-faint font-body">{meta.desc}</div>
                </div>
                {permissionMode === m && <div className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const EFFORT_LEVELS = [
  { id: '',       label: '默认', desc: '让 CLI 自己决定' },
  { id: 'low',    label: '低',   desc: '快速、便宜' },
  { id: 'medium', label: '中',   desc: '平衡' },
  { id: 'high',   label: '高',   desc: '深思' },
  { id: 'xhigh',  label: '极高', desc: '复杂推理' },
  { id: 'max',    label: '极限', desc: '最大努力' },
];

function AddDirSelector() {
  const addDirs = useStore((s) => s.addDirs);
  const setAddDirs = useStore((s) => s.setAddDirs);
  const handleAdd = () => {
    const dir = prompt('额外可访问目录的绝对路径（CLI --add-dir）：');
    if (!dir || !dir.startsWith('/')) return;
    if (addDirs.includes(dir)) return;
    setAddDirs([...addDirs, dir]);
  };
  const handleRemove = (d) => setAddDirs(addDirs.filter((x) => x !== d));
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {addDirs.map((d) => (
        <span key={d} className="chip chip-accent group/dir gap-1" title={d}>
          <span className="truncate max-w-[140px]">{d.replace(/^.*\//, '')}</span>
          <button onClick={() => handleRemove(d)} className="opacity-50 hover:opacity-100">
            <X size={9} />
          </button>
        </span>
      ))}
      <button onClick={handleAdd}
        className="flex items-center gap-1 px-2 py-0.5 rounded-full hover:bg-black/5 transition-colors"
        title="添加额外工作目录 (--add-dir)">
        <FolderPlus size={11} className="text-ink-faint" />
        <span className="text-[10px] text-ink-faint font-body">add-dir</span>
      </button>
    </div>
  );
}

// Dropdown anchored to the trigger button (lightweight, no full-screen blur).
export function EffortSelector({ permKey = null }) {
  // Per-session effort (#9): show/select THIS session's level, falling back to
  // the global default when the session has no explicit pick.
  const effort = useStore((s) => (permKey && permKey in s.effortBySession ? s.effortBySession[permKey] : s.effort));
  const setEffort = (id) => useStore.getState().setEffortFor(permKey, id);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const current = EFFORT_LEVELS.find((e) => e.id === effort) || EFFORT_LEVELS[0];

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-black/5 transition-colors"
        title={`Effort: ${current.label}`}>
        <Gauge size={12} className="text-ink-muted" />
        <span className="text-[11px] font-body text-ink-muted">{current.label}</span>
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      {open && (
        <div className="glass-popover absolute right-0 top-full mt-2 w-44 z-50 py-1 animate-glass-rise">
          <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider font-body">推理力度 (--effort)</div>
          {EFFORT_LEVELS.map((e) => (
            <button key={e.id || 'default'} onClick={() => { setEffort(e.id); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 hover:bg-black/5 flex items-center justify-between ${effort === e.id ? 'bg-accent/12' : ''}`}>
              <div>
                <div className="text-xs font-medium text-ink font-body">{e.label}</div>
                <div className="text-[10px] text-ink-faint font-body">{e.desc}</div>
              </div>
              {effort === e.id && <div className="w-1.5 h-1.5 rounded-full bg-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const TYPE_ICONS = {
  builtin: Terminal,
  skill: Wrench,
  plugin: Puzzle,
};

const TYPE_LABELS = {
  builtin: '内置',
  skill: '技能',
  plugin: '插件',
};

export function ChatInput({ onSend, onStop, onAccelerate, disabled, isStreaming, backgroundWorking = false, queueLength = 0, queueItems = [], onRemoveFromQueue, onEditFromQueue, todos = null, permKey = null, sessionId = null }) {
  const [text, setText] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commands, setCommands] = useState([]);
  const [provider, setProvider] = useState('Anthropic');
  const [isAnthropic, setIsAnthropic] = useState(true);
  // Pending image attachments: { path, preview (data URL), name, bytes }
  const [attachments, setAttachments] = useState([]);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef(null);
  // Permission mode lives in the store, keyed per-session via permKey so each
  // conversation keeps its own mode. Fall back to the global value only when
  // no key is supplied (shouldn't happen in normal render).
  const permissionMode = useStore((s) => (permKey ? (s.permissionModeBySession[permKey] || 'default') : s.permissionMode));
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  // While the session is handed off to phone remote control, lock the composer:
  // the hidden `--remote-control` pty owns the session file, so spawning a `-p`
  // turn here would double-write the same jsonl. Reclaim to unlock.
  const rcLocked = useStore((s) => (sessionId ? !!s.remoteControlled[sessionId] : false));
  const reclaimRemote = async () => {
    if (!sessionId) return;
    try {
      await fetch('/api/remote-control/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    } catch {}
    useStore.getState().setRemoteControl(sessionId, false);
  };

  // Watch for "重新编辑" rollback action — store sets composerDraft to the
  // original message text; we lift it into our local input and clear the store.
  const composerDraft = useStore((s) => s.composerDraft);
  useEffect(() => {
    if (composerDraft) {
      setText(composerDraft);
      useStore.setState({ composerDraft: '' });
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [composerDraft]);

  // CustomEvent fallback fill — controlled-component, setText only. An
  // earlier version ALSO wrote textareaRef.current.value directly which
  // desynced React's internal value tracker: the textarea showed text but
  // the React `text` state stayed empty, so handleSend's `text.trim()`
  // returned '' and the send button silently no-op'd.
  useEffect(() => {
    const onFill = (e) => {
      const t = e?.detail?.text || '';
      if (!t) return;
      setText(t);
      const ta = textareaRef.current;
      if (ta) {
        // Visual flash so the user can't miss the fill.
        ta.classList.add('ring-2', 'ring-accent', 'ring-offset-2');
        setTimeout(() => {
          ta.classList.remove('ring-2', 'ring-accent', 'ring-offset-2');
        }, 1600);
        setTimeout(() => ta.focus(), 0);
      }
    };
    window.addEventListener('cgui:composer-fill', onFill);
    return () => window.removeEventListener('cgui:composer-fill', onFill);
  }, []);

  // Read a File/Blob as a data URL.
  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  // Upload an image File → server tmp dir. Returns the local absolute path
  // that gets appended to the outgoing prompt so Claude can read it.
  const uploadImage = async (file) => {
    if (!file.type.startsWith('image/')) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, name: file.name }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert('上传失败: ' + (data.error || res.status));
        return;
      }
      setAttachments((prev) => [...prev, {
        path: data.path,
        preview: dataUrl,
        name: file.name || data.path.split('/').pop(),
        bytes: data.bytes,
      }]);
    } catch (err) {
      alert('上传失败: ' + err.message);
    }
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) {
          e.preventDefault();
          uploadImage(f);
        }
      }
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files || []);
    for (const f of files) {
      if (f.type.startsWith('image/')) uploadImage(f);
    }
  };

  const removeAttachment = (path) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  // Refresh slash commands whenever the model/provider may have changed
  // (re-fetch on focus so cc switch picks up without page reload).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/slash-commands')
        .then(r => r.json())
        .then(data => {
          if (cancelled) return;
          setCommands(data.commands || []);
          setProvider(data.provider || 'Anthropic');
          setIsAnthropic(data.isAnthropic !== false);
        })
        .catch(() => {});
    };
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, []);

  // Auto-resize textarea. When empty, pin to a single line: an empty textarea's
  // scrollHeight still counts the (long, wrappable) placeholder, so in a narrow
  // split pane the placeholder wraps to 2 lines and inflates the resting height.
  // Only grow to fit real content.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = (text ? Math.min(el.scrollHeight, 200) : 24) + 'px';
  }, [text]);

  // Case-insensitive prefix match; rank exact-case matches first.
  const filteredCommands = (() => {
    if (!text.startsWith('/') || text.length === 0) return [];
    const q = text.toLowerCase();
    return commands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .sort((a, b) => {
        const aBlocked = a.requiresAnthropic === 'full' && !isAnthropic;
        const bBlocked = b.requiresAnthropic === 'full' && !isAnthropic;
        if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
        return 0;
      });
  })();

  useEffect(() => {
    setShowCommands(filteredCommands.length > 0 && text.startsWith('/') && text.length > 0);
    setSelectedIndex(0);
  }, [text]);

  const handleSend = () => {
    const trimmed = text.trim();
    // Allow send if there's text OR attachments (so "just describe this image" works).
    if (!trimmed && attachments.length === 0) return;
    if (disabled || rcLocked) return;
    // Append attachment paths to the prompt — Claude CLI sees absolute image
    // paths in user text and loads them as image content blocks automatically.
    const attachmentRefs = attachments.length > 0
      ? '\n\n' + attachments.map((a) => `[image: ${a.path}]`).join('\n')
      : '';
    onSend((trimmed || '请描述这些图片') + attachmentRefs);
    setText('');
    setAttachments([]);
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const selectCommand = (cmd) => {
    if (typeof cmd === 'object') {
      // Block selecting a fully-incompatible slash on a third-party endpoint.
      if (cmd.requiresAnthropic === 'full' && !isAnthropic) return;
      setText(cmd.name + ' ');
    } else {
      setText(cmd + ' ');
    }
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (showCommands) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && filteredCommands.length > 0)) {
        e.preventDefault();
        selectCommand(filteredCommands[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setShowCommands(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div>
      {/* Permission popup — sits ABOVE the composer (Claude Desktop style),
          filtered to the active session. No-op when no requests pending. */}
      <PermissionPrompt sessionId={sessionId} />
      {/* TODO checklist — sits between permission popup and composer, mirroring
          Claude Desktop. Auto-hides when there's no TodoWrite snapshot. */}
      <TodoPanel todos={todos} />
      {rcLocked && (
        <div className="px-6 pt-3">
          <div className="max-w-3xl mx-auto flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[12px] text-green-800 font-body">
            <span className="flex items-center gap-1.5">
              <Smartphone size={14} /> 已交给手机远程控制 · 输入框已锁定以避免双写
            </span>
            <button
              onClick={reclaimRemote}
              className="shrink-0 px-2 py-1 rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors text-[11px]"
            >
              收回控制
            </button>
          </div>
        </div>
      )}
    <div className="px-4 py-5">
      <div className="max-w-3xl mx-auto relative">
        {/* Slash command dropdown */}
        {showCommands && (
          <div className="glass-popover absolute bottom-full left-0 right-0 mb-3 max-h-80 overflow-y-auto z-30 animate-glass-rise">
            <div className="px-3 py-2 text-[10px] text-ink-muted uppercase tracking-wider font-body border-b border-white/20 flex items-center justify-between">
              <span>Slash 命令</span>
              <span className="text-ink-ghost">
                {filteredCommands.length} 个 · {provider}{!isAnthropic && ' (cc switch)'}
              </span>
            </div>
            {filteredCommands.slice(0, 50).map((c, i) => {
              const Icon = TYPE_ICONS[c.type] || Terminal;
              const blocked = c.requiresAnthropic === 'full' && !isAnthropic;
              const partial = c.requiresAnthropic === 'partial' && !isAnthropic;
              const interactiveOnly = !!c.interactiveOnly;
              const tipParts = [];
              if (c.note) tipParts.push(c.note);
              if (interactiveOnly) tipParts.push('CLI 仅在交互式终端响应此命令；GUI 内会收到 "isn\'t available in this environment"');
              if (blocked) tipParts.push(`当前端点 ${provider} 不支持此命令`);
              else if (partial) tipParts.push(`当前端点 ${provider} 下行为可能不准`);
              const tip = tipParts.join(' · ') || c.desc;
              return (
                <button
                  key={c.name}
                  onClick={() => selectCommand(c)}
                  disabled={blocked}
                  title={tip}
                  className={`w-full text-left px-3 py-2.5 flex items-center gap-2 transition-colors ${
                    blocked
                      ? 'opacity-40 cursor-not-allowed'
                      : i === selectedIndex ? 'bg-accent/12' : 'hover:bg-black/5'
                  }`}
                >
                  <Icon size={12} className="text-accent shrink-0" />
                  <span className={`text-xs font-mono shrink-0 ${blocked ? 'line-through text-ink-ghost' : 'text-ink-soft'}`}>
                    {c.name}
                  </span>
                  <span className="text-[11px] text-ink-faint font-body truncate flex-1">{c.desc}</span>
                  {interactiveOnly && (
                    <span className="text-[9px] px-1 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono shrink-0" title="仅交互式终端可用">
                      TUI
                    </span>
                  )}
                  {partial && (
                    <span className="text-[9px] px-1 py-0.5 bg-warning/10 text-warning rounded font-mono shrink-0">
                      partial
                    </span>
                  )}
                  {blocked && (
                    <span className="text-[9px] px-1 py-0.5 bg-error/10 text-error rounded font-mono shrink-0">
                      仅订阅
                    </span>
                  )}
                  <span className="text-[9px] px-1 py-0.5 bg-canvas-deep text-ink-ghost rounded font-mono shrink-0">
                    {TYPE_LABELS[c.type] || c.type}
                  </span>
                </button>
              );
            })}
            {filteredCommands.length > 50 && (
              <div className="px-3 py-2 text-[10px] text-ink-faint text-center font-body">
                还有 {filteredCommands.length - 50} 个命令...
              </div>
            )}
          </div>
        )}


        {/* Attachment thumbnails — sit above the composer when present */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 px-2">
            {attachments.map((a) => (
              <div key={a.path} className="relative group/att">
                <img
                  src={a.preview}
                  alt={a.name}
                  className="h-16 w-16 object-cover rounded-lg border border-canvas-deep shadow-sm"
                />
                <button
                  onClick={() => removeAttachment(a.path)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-canvas-deep text-ink-soft hover:bg-error hover:text-white flex items-center justify-center transition-colors opacity-0 group-hover/att:opacity-100"
                  title="移除"
                >
                  <X size={11} />
                </button>
                <span className="absolute bottom-0 left-0 right-0 text-[9px] text-white bg-black/60 px-1 py-px rounded-b-lg truncate text-center">
                  {a.name}
                </span>
              </div>
            ))}
          </div>
        )}

        <div
          className={`chat-composer glass-capsule flex items-end gap-2 px-5 py-3.5 ${dragging ? 'ring-2 ring-accent/60' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <AddDirSelector />
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={rcLocked ? '已交给手机远程控制 · 点上方「收回控制」解锁' : (dragging ? '松开以添加图片…' : '输入消息... (/ 打开命令, Enter 发送, Shift+Enter 换行, 可粘贴/拖入图片)')}
            disabled={disabled || rcLocked}
            rows={1}
            className="flex-1 bg-transparent text-[14px] text-ink placeholder-ink-faint resize-none focus:outline-none font-body leading-relaxed min-h-[24px] max-h-[200px]"
          />

          {isStreaming ? (
            <>
              {/* During streaming: input gets queued, "Send" button enqueues. */}
              <button
                onClick={handleSend}
                disabled={!text.trim() && attachments.length === 0}
                className="shrink-0 h-9 px-3 rounded-full bg-accent/10 hover:bg-accent/20 text-accent flex items-center justify-center gap-1 transition-colors disabled:opacity-50 text-[11px] font-medium"
                title="入队（当前消息发送完后自动发出）"
              >
                <Send size={13} />入队
              </button>
              {/* Small rounded-rect stop button, CLI-style. Always-clickable
                  whether streaming locally or only running in background. */}
              <button
                onClick={onStop}
                className="shrink-0 h-9 px-3 rounded-md bg-ink/90 hover:bg-ink text-canvas flex items-center justify-center gap-1.5 transition-colors text-[11px] font-medium"
                title="停止生成"
              >
                <Square size={11} className="fill-current" />
                停止
              </button>
            </>
          ) : (
            <button
              onClick={handleSend}
              disabled={(!text.trim() && attachments.length === 0) || disabled || rcLocked}
              className="btn-accent shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
              title="发送"
            >
              {disabled ? (
                <Loader2 size={15} className="text-white/80 animate-spin" />
              ) : (
                <Send size={15} className="text-white -mr-0.5" />
              )}
            </button>
          )}
        </div>

        {/* Background-streaming indicator. Shows when this session has a
            CLI process still working in the background (user came back to a
            session they had left mid-stream). */}
        {backgroundWorking && (
          <div className="mt-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 flex items-center gap-2 text-[11px] font-body text-amber-900">
            <Loader2 size={11} className="text-amber-700 animate-spin shrink-0" />
            <span className="flex-1">
              这个会话仍在后台工作中 · 新内容会随生成自动追加
            </span>
          </div>
        )}

        {/* Queue indicator + per-item preview + edit/delete + accelerate */}
        {queueLength > 0 && (
          <div className="mt-2 rounded-lg bg-accent/8 border border-accent/20 text-[11px] font-body overflow-hidden">
            <div className="px-3 py-1.5 flex items-center gap-2 border-b border-accent/15">
              <Send size={11} className="text-accent shrink-0" />
              <span className="text-ink-soft flex-1">
                <b>{queueLength}</b> 条消息已排队 · 当前回复完成后自动发出
              </span>
              {onAccelerate && (
                <button
                  onClick={onAccelerate}
                  className="px-2 py-0.5 rounded bg-accent text-white text-[10px] font-medium hover:bg-accent-hover"
                  title="立即中断当前回复，发出队列中的消息"
                >
                  ⚡ 引导
                </button>
              )}
            </div>
            <ul className="divide-y divide-accent/10">
              {queueItems.map((q, i) => (
                <li key={`${q.queuedAt}-${i}`} className="px-3 py-1.5 flex items-start gap-2 group hover:bg-accent/5">
                  <span className="text-[10px] text-ink-faint font-mono shrink-0 mt-0.5">#{i + 1}</span>
                  <span className="text-ink-soft flex-1 line-clamp-2 leading-snug" title={q.text}>{q.text}</span>
                  <div className="shrink-0 flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                    {onEditFromQueue && (
                      <button
                        onClick={() => onEditFromQueue(i)}
                        className="p-1 hover:bg-accent/15 rounded"
                        title="取出到输入框重新编辑"
                      >
                        <Pencil size={11} className="text-accent" />
                      </button>
                    )}
                    {onRemoveFromQueue && (
                      <button
                        onClick={() => onRemoveFromQueue(i)}
                        className="p-1 hover:bg-red-100 rounded"
                        title="从队列删除"
                      >
                        <X size={11} className="text-ink-faint hover:text-red-600" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-[10.5px] text-ink-faint mt-2.5 text-center font-body tracking-wide">
          本地运行 · 数据不离开设备
        </p>
      </div>
    </div>
    </div>
  );
}
