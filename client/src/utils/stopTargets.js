// 「停止后台 N」总闸的目标分类(批A A7)。纯函数,tests/unit/check-stop-background-empty.mjs 真 import。
//
// 三态,对应总闸的三条出路:
//   procs 非空       → 正常发选择性 /stop
//   procs 空 + busy  → 主回合在跑,不发请求(会连坐 interrupt 续跑的正文),只提示
//   procs 空 + !busy → 服务端已无本会话任何可停对象,卡片是残留 → 提示 + 清僵尸卡
//
// 原来只算 procs,空了就静默 return —— 用户点了按钮什么都不发生(#10)。
export function classifyStopTargets(agents, sessionId) {
  const all = (agents || []).filter((a) => a && a.kind === 'chat-process' && a.sessionId === sessionId);
  // 只停 idle 槽位:busy(streaming/starting)说明主回合在跑,含"子代理刚完、主 agent
  // 续跑、前端尚未 reattach"的秒级窗口,此时选择性 /stop 会把续跑正文一并 interrupt。
  const procs = all.filter((a) => a.stoppable === true && a.status === 'idle');
  const busy = all.some((a) => a.stoppable === true && a.status !== 'idle');
  return { all, procs, busy };
}
