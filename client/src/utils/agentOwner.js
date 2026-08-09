// 子代理条目的会话归属校验(Bug5 分支串扰根治点)。
//
// 背景:分支(fork)= 逐行复制 jsonl,只重写顶层 sessionId,message.content 里的
// tool_use.id 原样保留(server/routes/fork.js:110);而 store.activeAgents 是一张
// 【全局、按 tool_use.id 为键】的表 —— 分支会话里那张 Task 卡片直接取到的就是源会话
// 【还活着】的那个 agent 对象:卡片显示运行中,点停止停的是源会话的子代理。
//
// 判定:agent 记着自己发起时的会话 id(App.jsx streamOwnerSid),与卡片所属会话不同
// → 当它不存在。调用方据此落进既有的"中断残骸"语义(灰环「已停止」+ 停止按钮不显示)。
// 任一侧缺 sessionId → 无从判断,按原逻辑放行,零回归:
//   - 流式中的本地 turn 对象没有 sessionId 字段(App.jsx 构造的 live turn);
//   - 老的 activeAgents 条目可能没记归属。
export function resolveOwnedAgent(agent, ownerSid) {
  if (!agent) return null;
  if (ownerSid && agent.sessionId && agent.sessionId !== ownerSid) return null;
  return agent;
}
