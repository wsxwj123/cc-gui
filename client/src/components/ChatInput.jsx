import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, Square, Terminal, Puzzle, Wrench, Gauge, ChevronDown } from 'lucide-react';
import { ModelSelector } from '../App.jsx';
import { useStore } from '../stores/sessionStore.js';

const EFFORT_LEVELS = [
  { id: '',       label: '默认', desc: '让 CLI 自己决定' },
  { id: 'low',    label: '低',   desc: '快速、便宜' },
  { id: 'medium', label: '中',   desc: '平衡' },
  { id: 'high',   label: '高',   desc: '深思' },
  { id: 'xhigh',  label: '极高', desc: '复杂推理' },
  { id: 'max',    label: '极限', desc: '最大努力' },
];

function EffortSelector() {
  const effort = useStore((s) => s.effort);
  const setEffort = useStore((s) => s.setEffort);
  const [open, setOpen] = useState(false);
  const current = EFFORT_LEVELS.find((e) => e.id === effort) || EFFORT_LEVELS[0];
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-black/5 transition-colors"
        title={`Effort: ${current.label}`}>
        <Gauge size={12} className="text-ink-muted" />
        <span className="text-[11px] font-body text-ink-muted">{current.label}</span>
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="glass-popover absolute left-0 bottom-full mb-2 w-44 z-50 py-1 animate-glass-rise">
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
        </>
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

export function ChatInput({ onSend, onStop, disabled, isStreaming }) {
  const [text, setText] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commands, setCommands] = useState([]);
  const [provider, setProvider] = useState('Anthropic');
  const [isAnthropic, setIsAnthropic] = useState(true);
  const textareaRef = useRef(null);

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

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
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
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
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
    <div className="px-6 py-5">
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

        <div className="chat-composer glass-capsule flex items-end gap-2 px-5 py-3.5">
          <ModelSelector compact />
          <EffortSelector />
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (/ 打开命令, Enter 发送, Shift+Enter 换行)"
            disabled={disabled}
            rows={1}
            className="flex-1 bg-transparent text-[14px] text-ink placeholder-ink-faint resize-none focus:outline-none font-body leading-relaxed min-h-[24px] max-h-[200px]"
          />

          {isStreaming ? (
            <button
              onClick={onStop}
              className="shrink-0 w-9 h-9 rounded-full bg-error/15 hover:bg-error/25 flex items-center justify-center transition-colors"
              title="停止生成"
            >
              <Square size={14} className="text-error" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!text.trim() || disabled}
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

        <p className="text-[10.5px] text-ink-faint mt-2.5 text-center font-body tracking-wide">
          本地运行 · 数据不离开设备
        </p>
      </div>
    </div>
  );
}
