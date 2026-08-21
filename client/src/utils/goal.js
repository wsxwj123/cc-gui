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
