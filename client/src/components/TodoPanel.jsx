import React, { useState } from 'react';
import { Check, Circle, ClipboardList, Loader2, ChevronDown, ChevronRight, EyeOff } from 'lucide-react';

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
export function TodoPanel({ todos, plan = '' }) {
  const hasTodos = Array.isArray(todos) && todos.length > 0;
  const cleanPlan = String(plan || '').trim();
  if (!hasTodos && !cleanPlan) return null;
  if (!hasTodos) {
    return (
      <div className="px-6 pt-3 pb-1">
        <div className="max-w-[var(--content-max)] mx-auto rounded-xl border border-canvas-deep bg-canvas-warm/60 backdrop-blur-sm overflow-hidden">
          <PlanBlock plan={cleanPlan} />
        </div>
      </div>
    );
  }
  return <TodoChecklist todos={todos} cleanPlan={cleanPlan} />;
}

// BI-1: 默认折叠,只显"下一条要做"(优先 in_progress,否则首个 pending,全完成则末项);
// 点头部展开看完整清单。折叠态仍保留进度条作总览。
function TodoChecklist({ todos, cleanPlan }) {
  const [collapsed, setCollapsed] = useState(true);
  // 隐藏态用"任务内容签名"记忆,而非布尔:隐藏只对当前这份清单生效;出现内容不同的新清单
  // 时签名变 → 自动重新显示(不会永久消失)。签名只取 content(不含 status),所以运行中
  // 勾选状态变化不会把已隐藏的清单重新弹出来。
  const sig = todos.map((t) => t.content || '').join('');
  const [hiddenSig, setHiddenSig] = useState(null);
  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const nextTodo = todos.find((t) => t.status === 'in_progress')
    || todos.find((t) => t.status === 'pending')
    || todos[todos.length - 1];

  // 已隐藏:只留一个"显示任务清单"小药丸,点它恢复。
  if (hiddenSig === sig) {
    return (
      <div className="px-6 pt-3 pb-1">
        <div className="max-w-[var(--content-max)] mx-auto flex justify-end">
          <button
            onClick={() => setHiddenSig(null)}
            title="显示任务清单"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-canvas-deep bg-canvas-warm/60 backdrop-blur-sm text-[10px] font-body text-ink-muted hover:bg-canvas-deep/30 transition-colors"
          >
            <ClipboardList size={12} className="text-accent shrink-0" />
            显示任务清单
            <span className="font-mono text-ink-faint">{done}/{total}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 pt-3 pb-1">
      <div className="max-w-[var(--content-max)] mx-auto rounded-xl border border-canvas-deep bg-canvas-warm/60 backdrop-blur-sm overflow-hidden">
        {cleanPlan && <PlanBlock plan={cleanPlan} />}
        {/* Header — 折叠切换(整段可点)+ 右侧独立"隐藏"按钮(不可嵌套 button,故并列) */}
        <div className="w-full flex items-center gap-2 px-3 py-2 border-b border-canvas-deep/60">
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? '展开任务清单' : '折叠(只显下一条)'}
            className="flex items-center gap-2 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
          >
            {collapsed ? <ChevronRight size={13} className="text-ink-faint shrink-0" /> : <ChevronDown size={13} className="text-ink-faint shrink-0" />}
            <span className="text-[11px] font-body font-medium text-ink shrink-0">任务清单</span>
            <span className="text-[10px] font-mono text-ink-faint shrink-0">{done}/{total}</span>
            <div className="flex-1 h-1 rounded-full bg-canvas-deep overflow-hidden">
              <div className="h-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[10px] font-mono text-ink-faint shrink-0">{pct}%</span>
          </button>
          <button
            onClick={() => setHiddenSig(sig)}
            title="隐藏任务清单(不删除,出现新清单会再显示)"
            className="shrink-0 p-1 rounded hover:bg-canvas-deep/40 text-ink-faint hover:text-ink-muted transition-colors"
          >
            <EyeOff size={13} />
          </button>
        </div>
        {/* 折叠态:只显下一条;展开态:完整清单(上限 40vh 滚动,给输入框留空间) */}
        {collapsed ? (
          <div className="py-1.5">{nextTodo && <TodoRow todo={nextTodo} />}</div>
        ) : (
          <div className="max-h-[40vh] overflow-y-auto py-1.5">
            {todos.map((t, i) => (
              <TodoRow key={t.id ?? t.taskId ?? t.content ?? i} todo={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PlanBlock({ plan }) {
  return (
    <div className="px-3 py-2 border-b border-canvas-deep/60">
      <div className="flex items-center gap-2 mb-1">
        <ClipboardList size={13} className="text-accent shrink-0" />
        <span className="text-[11px] font-body font-medium text-ink">执行计划</span>
      </div>
      <div className="text-[12px] text-ink-soft font-body leading-snug whitespace-pre-wrap max-h-32 overflow-y-auto">
        {plan}
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
