import React, { useState, useEffect, useRef } from 'react';
import { Check, Circle, ClipboardList, Loader2, ChevronDown, ChevronRight, EyeOff } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer.jsx';

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
  // 计划卡与任务清单是两张独立并列的卡(兄弟节点),各自带外壳、各管各的隐藏 ——
  // 隐藏清单不影响计划,隐藏计划不影响清单。
  return (
    <>
      {cleanPlan && <PlanBlock plan={cleanPlan} />}
      {hasTodos && <TodoChecklist todos={todos} />}
    </>
  );
}

// 隐藏后留下的极细"显示"小条:单行,点它取消隐藏恢复完整卡。别做大。
function ShowBar({ label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="mb-2 w-full flex items-center gap-1.5 px-3 py-1 text-[10px] text-ink-faint hover:text-ink-muted transition-colors"
    >
      <ChevronRight size={11} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}

function TodoChecklist({ todos }) {
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

  // 全部完成 → 自动折叠,但每份"全完成快照"只折一次:ref 记已为哪个签名折叠过。这样用户
  // 手动展开后,AI 把某项重开再完成(签名回到同一个全完成态)不会再次强制折叠打断;只有真正
  // 换成内容不同的新清单完成时(签名不同)才再自动折叠。挂载时若已全完成也折叠一次。
  const collapsedForSigRef = useRef(null);
  useEffect(() => {
    if (allComplete && collapsedForSigRef.current !== sig) {
      collapsedForSigRef.current = sig;
      setCollapsed(true);
    }
  }, [allComplete, sig]);

  // 已隐藏:只留一条可点"显示"小条(不占输入框空间),点它恢复;sig 变化(下次任务清单
  // 更新)仍自动恢复完整卡。
  if (hiddenSig === sig) return <ShowBar label="显示任务清单" onClick={() => setHiddenSig(null)} />;

  return (
    <div className="mb-2 rounded-xl border border-canvas-deep bg-canvas-warm/60 backdrop-blur-sm overflow-hidden">
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

/**
 * 已批准计划的常驻块:默认折叠成一行标题(不挤输入区),展开后 markdown 渲染全文
 * (上限 40vh 滚动)。隐藏按钮按"计划全文"记忆——同一份计划隐藏后不再出现,
 * 下次批准新计划(文本不同)自动恢复,与 TodoChecklist 的 hiddenSig 同一套语义。
 * markdown 只在展开时渲染,避免长计划在折叠态也参与输入区的高频重渲。
 */
function PlanBlock({ plan }) {
  const [open, setOpen] = useState(false);
  const [hiddenPlan, setHiddenPlan] = useState(null);
  // 已隐藏:留一条可点"显示"小条恢复;批准新计划(plan 变)仍自动恢复完整卡。
  if (hiddenPlan === plan) return <ShowBar label="显示已批准的计划" onClick={() => setHiddenPlan(null)} />;
  return (
    <div className="mb-2 rounded-xl border border-canvas-deep bg-canvas-warm/60 backdrop-blur-sm overflow-hidden">
      <div className="w-full flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setOpen((o) => !o)}
          title={open ? '收起计划全文' : '展开查看已批准的计划全文'}
          className="flex items-center gap-2 flex-1 min-w-0 text-left hover:opacity-80 transition-opacity"
        >
          {open ? <ChevronDown size={13} className="text-ink-faint shrink-0" /> : <ChevronRight size={13} className="text-ink-faint shrink-0" />}
          <ClipboardList size={13} className="text-accent shrink-0" />
          <span className="text-[11px] font-body font-medium text-ink shrink-0">已批准的计划</span>
          {!open && (
            <span className="text-[10px] text-ink-faint truncate">
              {plan.split('\n')[0].replace(/^#+\s*/, '')}
            </span>
          )}
        </button>
        <button
          onClick={() => setHiddenPlan(plan)}
          title="隐藏计划(批准新计划时自动再现)"
          className="shrink-0 p-1 rounded hover:bg-canvas-deep/40 text-ink-faint hover:text-ink-muted transition-colors"
        >
          <EyeOff size={13} />
        </button>
      </div>
      {open && (
        // MarkdownRenderer 顶层自带 text-[15px] 基准(标题用 em 相对字号),这里是输入框
        // 上方的小面板,用后代选择器把基准压到 12.5px,整套排版等比缩小。
        <div className="px-3 pb-2.5 max-h-[40vh] overflow-y-auto [&_.markdown-content]:text-[12.5px]">
          <MarkdownRenderer content={plan} />
        </div>
      )}
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
