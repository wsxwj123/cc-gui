import React, { useState, useEffect } from 'react';
import { Check, Circle, ClipboardList, Loader2, ChevronDown, ChevronRight, EyeOff } from 'lucide-react';

/**
 * 任务清单条,渲染在 composer 同一列内、紧贴输入框上方(作为输入框的"附着条",而非独立
 * 悬浮面板)。每次 TaskCreate/TaskUpdate 重建完整清单,最新一份为准 —— 见 currentTodos。
 * todos 为空则整块不渲染。
 *
 * 两个按钮:折叠(只留"任务清单"标题行 + "下一条")/ 隐藏(整块消失,直到下次任务清单
 * 更新)。任务全部完成时自动折叠。
 */
export function TodoPanel({ todos, plan = '' }) {
  const hasTodos = Array.isArray(todos) && todos.length > 0;
  const cleanPlan = String(plan || '').trim();
  if (!hasTodos && !cleanPlan) return null;
  if (!hasTodos) {
    return (
      <div className="mb-2 rounded-xl border border-canvas-deep bg-canvas-warm/60 backdrop-blur-sm overflow-hidden">
        <PlanBlock plan={cleanPlan} />
      </div>
    );
  }
  return <TodoChecklist todos={todos} cleanPlan={cleanPlan} />;
}

function TodoChecklist({ todos, cleanPlan }) {
  const [collapsed, setCollapsed] = useState(true);
  // 隐藏态记录隐藏那一刻的"完整状态签名"(含 status):任务清单一旦有任何更新(内容或勾选
  // 变化)签名即变 → 自动重新显示 = "完全隐藏直到下次任务清单更新"。
  const sig = todos.map((t) => `${t.content || ''}${t.status || ''}`).join('');
  const [hiddenSig, setHiddenSig] = useState(null);
  const done = todos.filter((t) => t.status === 'completed').length;
  const total = todos.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const allComplete = total > 0 && done === total;
  const nextTodo = todos.find((t) => t.status === 'in_progress')
    || todos.find((t) => t.status === 'pending')
    || todos[todos.length - 1];

  // 全部完成 → 自动折叠(只在"变为全完成"这一刻触发;此后用户手动展开不再被强制折叠,因为
  // allComplete 维持 true、effect 不再重跑)。挂载时若已全完成也会折叠(历史完成清单默认收起)。
  useEffect(() => {
    if (allComplete) setCollapsed(true);
  }, [allComplete]);

  // 已隐藏:整块不渲染,直到 sig 变化(下次任务清单更新)自动恢复。
  if (hiddenSig === sig) return null;

  return (
    <div className="mb-2 rounded-xl border border-canvas-deep bg-canvas-warm/60 backdrop-blur-sm overflow-hidden">
      {cleanPlan && <PlanBlock plan={cleanPlan} />}
      {/* Header:折叠切换(整段可点)+ 右侧独立隐藏按钮(button 不可嵌套,故并列)。
          折叠时不画下边框,折叠后只剩"标题行 + 下一条"两行。 */}
      <div className={`w-full flex items-center gap-2 px-3 py-2 ${collapsed ? '' : 'border-b border-canvas-deep/60'}`}>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开任务清单' : '折叠(只留标题 + 下一条)'}
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
          title="隐藏任务清单(整块收起,下次任务清单更新时自动再现)"
          className="shrink-0 p-1 rounded hover:bg-canvas-deep/40 text-ink-faint hover:text-ink-muted transition-colors"
        >
          <EyeOff size={13} />
        </button>
      </div>
      {/* 折叠:标题行 + 下一条;展开:完整清单(上限 40vh 滚动,给输入框留空间) */}
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
