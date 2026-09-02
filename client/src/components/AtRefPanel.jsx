import React from 'react';
import { AtSign, CornerLeftUp, Folder, FileText, MessagesSquare, Loader2 } from './Icon.jsx';

// 会话内输入框的弹出方向(向上);首页 composer 垂直居中,传向下弹的那串。
const DEFAULT_CLASS = 'glass-popover absolute bottom-full left-0 right-0 mb-3 max-h-80 overflow-y-auto z-30 animate-glass-rise';

// `@` 引用选择器:文件 / 会话 两个 tab(Tab 键切换),把选中项作为上下文引用插入输入框。
// 纯展示,状态机在 hooks/useAtRef.js。
export function AtRefPanel({
  open,
  tab,
  onTab,
  query = '',
  dir = '',
  busy = false,
  items = [],
  files = [],
  sessions = [],
  index = 0,
  cwd = '',
  onPick,
  className = DEFAULT_CLASS,
}) {
  if (!open) return null;
  return (
    <div className={className}>
      <div className="px-3 py-2 border-b border-white/20 flex items-center gap-2">
        <AtSign size={11} className="text-accent shrink-0" />
        <button onClick={() => onTab('files')}
          className={`text-[11px] px-2 py-0.5 rounded font-body ${tab === 'files' ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink'}`}>
          文件
        </button>
        <button onClick={() => onTab('sessions')}
          className={`text-[11px] px-2 py-0.5 rounded font-body ${tab === 'sessions' ? 'bg-accent/15 text-accent' : 'text-ink-faint hover:text-ink'}`}>
          会话
        </button>
        <span className="ml-auto text-[10px] text-ink-ghost font-body">Tab 切换 · Enter 选择/进入</span>
      </div>
      {/* 层级浏览时显示当前所在目录(面包屑) */}
      {tab === 'files' && !query && dir && (
        <div className="px-3 py-1 border-b border-white/10 text-[10px] font-mono text-ink-faint truncate">
          {dir}/
        </div>
      )}
      {busy && (
        <div className="px-3 py-3 text-[11px] text-ink-faint font-body flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />正在生成会话引用...
        </div>
      )}
      {!busy && items.length === 0 && (
        <div className="px-3 py-3 text-[11px] text-ink-faint font-body">
          {tab === 'files'
            ? (cwd ? '没有匹配的文件' : '当前会话无项目目录')
            : '本项目没有其它可引用的会话'}
        </div>
      )}
      {!busy && tab === 'files' && files.map((f, i) => (
        <button key={f.kind === 'up' ? '..' : f.rel} onClick={() => onPick(f)}
          className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${i === index ? 'bg-accent/12' : 'hover:bg-black/5'}`}>
          {f.kind === 'up' ? <CornerLeftUp size={12} className="text-ink-faint shrink-0" />
            : f.kind === 'dir' ? <Folder size={12} className="text-amber-600 shrink-0" />
            : <FileText size={12} className="text-accent shrink-0" />}
          <span className="text-[11px] font-mono text-ink-soft truncate">
            {f.kind === 'up' ? '返回上级' : query ? f.rel : f.name}{f.kind === 'dir' ? '/' : ''}
          </span>
        </button>
      ))}
      {!busy && tab === 'sessions' && sessions.map((s, i) => (
        <button key={s.sessionId} onClick={() => onPick(s)}
          title="将该会话内容(精简 Markdown)作为上下文引用"
          className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${i === index ? 'bg-accent/12' : 'hover:bg-black/5'}`}>
          <MessagesSquare size={12} className="text-accent shrink-0" />
          <span className="text-[11px] font-body text-ink-soft truncate flex-1">{s.firstPrompt || s.sessionId}</span>
          <span className="text-[9px] text-ink-ghost font-mono shrink-0">{(s.lastActivity || '').slice(5, 16).replace('T', ' ')}</span>
        </button>
      ))}
    </div>
  );
}
