import React from 'react';
import { Check, Circle, Loader2 } from 'lucide-react';

/**
 * Renders the latest TodoWrite snapshot from Claude as a checklist above the
 * composer (Claude Desktop style). Each TodoWrite tool call REPLACES the full
 * list, so the freshest call is the source of truth — see SessionDetail's
 * derived `currentTodos`.
 *
 * Item shape (Claude's TodoWrite contract):
 *   { content: string, status: 'pending'|'in_progress'|'completed', activeForm: string }
 *
 * Hidden entirely when todos is null/empty so the composer doesn't grow a
 * useless empty block.
 */
export function TodoPanel({ todos }) {
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div className="px-6 pt-3 pb-1">
      <div className="max-w-3xl mx-auto rounded-xl border border-canvas-deep bg-canvas-warm/60 backdrop-blur-sm overflow-hidden">
        {/* Header — title + progress chip + progress bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-canvas-deep/60">
          <span className="text-[11px] font-body font-medium text-ink">任务清单</span>
          <span className="text-[10px] font-mono text-ink-faint">{done}/{total}</span>
          <div className="flex-1 h-1 rounded-full bg-canvas-deep overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] font-mono text-ink-faint shrink-0">{pct}%</span>
        </div>
        {/* List — keeps full list visible; user wanted "勾选" behavior, not
            collapse. Capped to ~50vh via overflow so the composer always has
            room when there are 30+ items. */}
        <div className="max-h-[40vh] overflow-y-auto py-1.5">
          {todos.map((t, i) => (
            <TodoRow key={i} todo={t} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TodoRow({ todo }) {
  const status = todo.status || 'pending';
  // Claude convention: when in_progress, show the activeForm (present-tense
  // progressive). Fall back to content if activeForm is missing.
  const label = status === 'in_progress'
    ? (todo.activeForm || todo.content || '')
    : (todo.content || '');

  let Icon, iconCls, textCls;
  if (status === 'completed') {
    Icon = Check;
    iconCls = 'text-success';
    textCls = 'text-ink-faint line-through';
  } else if (status === 'in_progress') {
    Icon = Loader2;
    iconCls = 'text-accent animate-spin';
    textCls = 'text-ink font-medium';
  } else {
    Icon = Circle;
    iconCls = 'text-ink-ghost';
    textCls = 'text-ink-soft';
  }

  return (
    <div className="flex items-start gap-2 px-3 py-1.5 hover:bg-canvas-deep/40 transition-colors">
      <Icon size={13} className={`${iconCls} shrink-0 mt-0.5`} strokeWidth={status === 'completed' ? 3 : 2} />
      <span className={`text-[12px] font-body leading-snug ${textCls}`}>{label}</span>
    </div>
  );
}
