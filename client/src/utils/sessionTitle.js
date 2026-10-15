// 会话标题的优先级链在 server/utils/session-title.js(前后端共用一份,服务端的跨会话目标列表也用它),
// 这里只转出;改优先级去那边改。
export { resolveSessionTitle } from '../../../server/utils/session-title.js';

// r11-⑪:会话行单行化(只显状态点+标题+置顶角标)后,模型/消息数/子任务数/时间
// 收进行的原生 title tooltip。纯函数组装,缺项跳过;model 剥 [1m] 后缀(与徽章同口径)。
export function sessionRowTooltip({ model, messageCount, subagentCount, timeText } = {}) {
  const parts = [];
  const m = typeof model === 'string' ? model.replace(/\[1m\]/i, '').trim() : '';
  if (m) parts.push(m);
  if (Number.isFinite(messageCount)) parts.push(`${messageCount} 条消息`);
  if (Number.isFinite(subagentCount) && subagentCount > 0) parts.push(`${subagentCount} 个子任务`);
  if (timeText) parts.push(timeText);
  return parts.join(' · ');
}
