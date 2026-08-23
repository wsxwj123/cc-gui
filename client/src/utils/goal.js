// /goal 命令的发送侧解析(纯函数,零 React/store 依赖) —— r31-goal-optimistic 抽出可测。
// 常驻条(GoalBar)的乐观显示依赖"发送文本是否 /goal、是设为新条件还是清除"的判定。
// 该判定同时被 App.jsx 的 handleSend(发送侧乐观亮/隐)与单测复用,故提为一个纯函数。
//
// 返回:
//   { type: 'set', condition: <string> }   —— /goal <条件> 设为新目标
//   { type: 'clear' }                      —— /goal clear 手动清除
//   null                                   —— 非 /goal 或不产生目标动作的 /goal
//        · 非 /goal 开头的普通消息
//        · 裸 /goal(无参数,CLI 走用法提示 / 查询当前目标,不设置)
//        · /goal clear 之外的 /goal 子命令不存在,但以防万一统一归 null
export function parseGoalCommand(text) {
  const t = String(text || '').trim();
  const m = /^\/goal\b\s*([\s\S]*)$/i.exec(t);
  if (!m) return null;            // 不是 /goal
  const rest = m[1].trim();
  if (/^clear\b/i.test(rest)) return { type: 'clear' };  // /goal clear
  if (!rest) return null;         // 裸 /goal:用法提示,不设目标
  return { type: 'set', condition: rest };
}

// 乐观目标不能只靠 SessionDetail 组件实例归属：同一 pane 切换会话时 React 会先用
// 新 session 重渲染、再运行清理 effect。把 owner 写进状态并在渲染期同步核对，旧会话
// 的目标便没有一帧机会画进新会话。
export function optimisticGoalForOwner(state, ownerKey) {
  if (!state || !ownerKey || state.ownerKey !== ownerKey) return null;
  return state.goal || null;
}

// draft 收到真实 session id 时，与 pane 换绑放在同一批状态更新中迁移 owner。
// 返回原引用表示本状态不属于该 draft，避免异步 init 误迁其他会话的乐观目标。
export function migrateOptimisticGoalOwner(state, fromOwnerKey, toOwnerKey) {
  if (!state || !fromOwnerKey || !toOwnerKey || state.ownerKey !== fromOwnerKey) return state;
  return { ...state, ownerKey: toOwnerKey };
}
