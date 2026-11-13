// r178:「本地提示」与「只活在本地的条目」判定。
//
// 本地提示 = 页面自己画的回合类条目,命令行不把它写进会话文件(没有历史孪生):
//   'error'  流里报错的本地 ❌ 块、发送失败的 ❌ 块;
//   'empty'  provider 什么都没回时的 ⚠️ 提示;
//   'budget' 花费上限提示;
//   'stall'  r178c:静默超时结束了本回合时的提示(服务端事件带 ended:true;只提示、不结束
//            的那种不打标,回合结束即过期,照旧被清);
//   'done'   r178c:「会话已清空 / 上下文已压缩」完成提示。
// 打标字段 localNotice。这类条目不得带 srcUuids / roundStartTs(localTurnTakenOver 会据此把它
// 当成已被历史接管而藏掉)。
//
// 收尾 / 文件监听 / 兜底去重三处「整轮已存盘 → 整清本地副本」都按 isLocalOnlyEntry 保留,
// 留到同一会话发下一条消息(由发送入口撤掉)或切会话 / 刷新为止。

export const LOCAL_NOTICE_KINDS = ['error', 'empty', 'budget', 'stall', 'done'];

export function isLocalNotice(m) {
  return !!m && m.type === 'turn' && LOCAL_NOTICE_KINDS.includes(m.localNotice);
}

// 只活在本地、永远没有历史孪生的条目:旁问、自动拒绝提示、模式提示、本地提示。
export function isLocalOnlyEntry(m) {
  if (!m) return false;
  return m.type === 'btw' || m.type === 'denial' || m.type === 'mode-mismatch' || isLocalNotice(m);
}

// 同一会话新起一轮时撤掉上一轮遗留的本地提示(只撤归属本会话的;其它会话的不动)。
// ownerKeys:一个键或键数组(本会话的队列键与真实 sessionId —— 本地提示的 ownerKey 取
// streamSid || 队列键,draft 升级前后两种形态都可能出现)。空键忽略;没有有效键时什么都不撤。
// 返回原数组表示没有可撤的。
export function dropLocalNoticesOf(list, ownerKeys) {
  const keys = (Array.isArray(ownerKeys) ? ownerKeys : [ownerKeys]).filter(Boolean);
  if (!Array.isArray(list) || !list.length || !keys.length) return list;
  const next = list.filter((m) => !(isLocalNotice(m) && keys.includes(m.ownerKey)));
  return next.length === list.length ? list : next;
}
