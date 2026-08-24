import React, { useEffect, useState } from 'react';
import { Target, Pencil, Trash2, Check, X, EyeOff, ChevronRight } from './Icon.jsx';
import { confirmDialog } from '../utils/confirmDialog.jsx';
import { forgetHiddenGoalIdentity, goalIdentity, isGoalIdentityHidden, legacyGoalIdentities, migrateHiddenGoalIdentity, rememberHiddenGoalIdentity, resolveGoalHiddenState } from '../utils/goal.js';

/**
 * goal 常驻条(dsh 同款):渲染在 composer 正上方,会话有 /goal 相关记录时显示。
 * 数据源 = SessionDetail 的 activeGoal memo(取历史最后一条 goal,含达成/清除状态),
 * 经 props.goal 传入。三态:
 *   · 进行中:🎯 图标 + 目标条件文本(truncate)+「编辑」「清除」两枚操作图标;
 *   · 已达成:保留最近状态,常驻输入框上方;
 *   · 已清除:保留最近状态,常驻输入框上方;
 *   · 编辑:就地变可编辑文本框(预填当前 condition),保存走既有发送链路发
 *           `/goal <新文本>`(复用 onSend,不造第二条通道),取消不发送;
 *   · 清除:confirmDialog 确认后发 `/goal clear`(WKWebView 禁用原生 confirm)。
 * 分屏时各窗格各渲染各的 —— goal 已是 per-pane 数据,key 按 permKey 挂载即天然隔离。
 */
export function GoalBar({ goal, onSend, permKey = 'global' }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const hideKey = `cgui-goal-hidden:${permKey || 'global'}`;
  const goalFp = goalIdentity(goal);
  const legacyGoalFps = legacyGoalIdentities(goal);
  const [hiddenState, setHiddenState] = useState(null);
  let persistedHidden = false;
  try { persistedHidden = isGoalIdentityHidden(localStorage, hideKey, goalFp, legacyGoalFps); } catch {}
  // 本地瞬时态也显式绑定会话+身份；从隐藏 A 切到 B 的首帧同步读取 B，绝不继承 A 的 true。
  const hidden = resolveGoalHiddenState(hiddenState, hideKey, goalFp, persistedHidden);
  useEffect(() => {
    if (!goalFp) return;
    try { migrateHiddenGoalIdentity(localStorage, hideKey, goalFp, legacyGoalFps); } catch {}
  }, [hideKey, goalFp]); // legacy aliases 由稳定 goalFp 唯一决定，不作为数组依赖制造重复 effect

  if (!goal) return null;
  if (hidden) {
    return (
      <button
        onClick={() => {
          setHiddenState({ key: hideKey, identity: goalFp, hidden: false });
          try {
            forgetHiddenGoalIdentity(localStorage, hideKey, goalFp);
            for (const legacy of legacyGoalFps) forgetHiddenGoalIdentity(localStorage, hideKey, legacy);
          } catch {}
        }}
        className="mb-2 w-full flex items-center gap-1.5 px-3 py-1 text-[10px] text-ink-faint hover:text-ink-muted transition-colors"
      >
        <ChevronRight size={11} className="shrink-0" />
        <span>显示目标条</span>
      </button>
    );
  }
  const condition = goal.condition || '(无条件文本)';
  const reason = goal.reason || '';
  // 常驻条要覆盖目标完整生命周期:进行中 / 已达成 / 已清除,避免只在消息流里出现、
  // 一滚动就看不到。
  const isActive = !goal.met;
  const isAchieved = !!goal.met && !goal.sentinel;
  const isCleared = !!goal.met && !!goal.sentinel;
  const stateLabel = isCleared ? '目标已清除' : isAchieved ? '目标已达成' : '目标进行中';
  const stateSuffix = isAchieved && goal.iterations ? `（${goal.iterations} 轮）` : '';
  const title = isActive
    ? `目标进行中：${condition}${reason ? `\n最近判定：${reason}` : ''}`
    : `${stateLabel}：${condition}${reason ? `\n${reason}` : ''}`;
  const stateColor = isAchieved ? 'text-success' : isCleared ? 'text-ink-faint' : 'text-ink';

  const startEdit = () => { setDraft(goal.condition || ''); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setDraft(''); };
  const saveEdit = () => {
    const v = String(draft || '').trim();
    setEditing(false);
    // 无条件 / 与当前条件相同 → 不发(取消性保存)。
    if (!v || v === String(goal.condition || '').trim()) return;
    onSend('/goal ' + v);
  };
  const handleClear = async () => {
    const ok = await confirmDialog(
      '确定清除当前目标吗？将发送 /goal clear，并停止对当前目标的持续追踪。',
      { danger: true, confirmText: '清除目标', cancelText: '取消' },
    );
    if (!ok) return;
    onSend('/goal clear');
  };
  const hideGoal = () => {
    setHiddenState({ key: hideKey, identity: goalFp, hidden: true });
    try { rememberHiddenGoalIdentity(localStorage, hideKey, goalFp); } catch {}
  };

  return (
    <div data-cgui="goal-bar" data-testid="goal-bar" className="mb-2 rounded-full border border-canvas-deep bg-canvas-warm/60 backdrop-blur-soft px-3 py-1.5 flex items-center gap-2">
      {editing && isActive ? (
        <>
          <Target size={13} className="text-accent shrink-0" />
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // IME 合成期放行(同 composer);Enter=保存,Esc=取消(停住传播,别穿透到全局停止)。
            onKeyDown={(e) => {
              if (e.nativeEvent?.isComposing) return;
              if (e.key === 'Enter') { e.preventDefault(); saveEdit(); }
              else if (e.key === 'Escape') { e.preventDefault(); e.nativeEvent?.stopImmediatePropagation?.(); cancelEdit(); }
            }}
            placeholder="输入新的目标条件"
            className="flex-1 min-w-0 bg-transparent text-[12px] text-ink placeholder-ink-faint focus:outline-none font-body"
          />
          <button onClick={saveEdit} title="保存（发送 /goal <新文本>）"
            className="shrink-0 p-1 rounded hover:bg-canvas-deep/40 text-ink-muted hover:text-accent transition-colors">
            <Check size={13} />
          </button>
          <button onClick={cancelEdit} title="取消"
            className="shrink-0 p-1 rounded hover:bg-canvas-deep/40 text-ink-muted hover:text-ink transition-colors">
            <X size={13} />
          </button>
        </>
      ) : (
        <>
          <Target size={13} className={`shrink-0 ${stateColor}`} />
          <span title={title} className="flex-1 min-w-0 text-[12px] text-ink-muted font-body truncate">
            <span className={stateColor}>{isActive ? '目标进行中：' : `${stateLabel}${stateSuffix}：`}</span>{condition}
          </span>
          {/* r32 的「未达成 ×N」折叠徽标:reader 把同一段未达成判定折叠成一条并带 count,
              目标提示已不再进消息流,故次数落在常驻条上。met/已清除的记录不带 count。 */}
          {goal.count > 1 && (
            <span
              data-testid="goal-hook-count"
              title={`本会话目标钩子已拦截 ${goal.count} 次停止`}
              className="shrink-0 px-1.5 rounded-full bg-canvas-deep/60 text-[10px] leading-[1.4] text-ink-faint font-body tabular-nums"
            >
              ×{goal.count}
            </span>
          )}
          {isActive && (
            <>
              <button onClick={startEdit} title="编辑目标条件"
                data-cgui="goal-edit"
                className="shrink-0 p-1 rounded hover:bg-canvas-deep/40 text-ink-muted hover:text-accent transition-colors">
                <Pencil size={11} />
              </button>
              <button onClick={handleClear} title="清除目标（发送 /goal clear）"
                data-cgui="goal-clear"
                className="shrink-0 p-1 rounded hover:bg-canvas-deep/40 text-ink-muted hover:text-red-500 transition-colors">
                <Trash2 size={11} />
              </button>
            </>
          )}
          <button onClick={hideGoal} title="隐藏目标条" aria-label="隐藏目标条"
            data-testid="goal-hide"
            className="shrink-0 p-1 rounded hover:bg-canvas-deep/40 text-ink-muted hover:text-ink transition-colors">
            <EyeOff size={13} />
          </button>
        </>
      )}
    </div>
  );
}
