// 会话标题的唯一优先级链(所有显示点共用,改这里就够):
//   ① session.customTitle —— 会话 jsonl 里的 custom-title(改名落盘,CLI/其它客户端同源)
//   ② prefsCustom        —— 服务端 prefs.customTitles(历史手改存量 + 跨端广播缓存 +
//                            未落盘 draft 会话唯一能记住标题的地方)
//   ③ session.aiTitle    —— 会话 jsonl 里的 ai-title(CLI 首轮后自动生成)
//   ④ prefsAuto          —— 服务端 prefs.autoTitles(GUI 自己生成的自动标题)
//   ⑤ session.firstPrompt
// 手改的两档(①②)必须整体压过自动的两档(③④):自动标题什么时候刷新不由用户控制,
// 排到手改前面就是"改完过一会儿又被改回去"。也正因此 custom 与 ai 在读侧分开取,
// 不能学 SDKSessionInfo.customTitle 把 ai-title 并进同一个字段。
// 第 2/3 参是【已取好的字符串】不是 map:列表项用 primitive selector 只订阅自己那一条,
// 传整张 map 会让任何一次改名重渲染整个会话列表。
export function resolveSessionTitle(session, prefsCustom, prefsAuto) {
  return session?.customTitle
    || prefsCustom
    || session?.aiTitle
    || prefsAuto
    || session?.firstPrompt
    || '';
}

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
