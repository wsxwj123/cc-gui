import React from 'react';
import { Terminal, Wrench, Puzzle, Folder } from './Icon.jsx';
import { slashBlocked } from '../utils/slashCommands.js';

const TYPE_ICONS = {
  builtin: Terminal,
  skill: Wrench,
  plugin: Puzzle,
  project: Folder,
};

const TYPE_LABELS = {
  builtin: '内置',
  skill: '技能',
  plugin: '插件',
  project: '项目',
};

// className 默认值 = 会话内输入框的弹出方向(向上)。首页 composer 垂直居中,向上会被
// 顶栏切掉列表顶部(默认选中项就在那里),所以首页传向下弹的那串。
export function SlashCommandMenu({
  commands,
  selectedIndex = 0,
  provider = 'Anthropic',
  isAnthropic = true,
  onPick,
  className = 'glass-popover absolute bottom-full left-0 right-0 mb-3 max-h-80 overflow-y-auto z-30 animate-glass-rise',
}) {
  return (
    <div className={className}>
      <div className="px-3 py-2 text-[10px] text-ink-muted uppercase tracking-wider font-body border-b border-white/20 flex items-center justify-between">
        <span>Slash 命令</span>
        <span className="text-ink-ghost">
          {commands.length} 个 · {provider}{!isAnthropic && ' (cc switch)'}
        </span>
      </div>
      {commands.slice(0, 50).map((c, i) => {
        const Icon = TYPE_ICONS[c.type] || Terminal;
        const blocked = slashBlocked(c, isAnthropic);
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
            onClick={() => onPick(c)}
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
      {commands.length > 50 && (
        <div className="px-3 py-2 text-[10px] text-ink-faint text-center font-body">
          还有 {commands.length - 50} 个命令...
        </div>
      )}
    </div>
  );
}
