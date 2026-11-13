// r178:「本地提示」与「只活在本地的条目」判定。
//
// 本地提示 = 页面自己画的回合类条目,命令行不把它写进会话文件(没有历史孪生):
//   'error'  流里报错的本地 ❌ 块、发送失败的 ❌ 块;
//   'empty'  provider 什么都没回时的 ⚠️ 提示;
//   'budget' 花费上限提示。
// 打标字段 localNotice。这类条目不得带 srcUuids / roundStartTs(localTurnTakenOver 会据此把它
// 当成已被历史接管而藏掉)。
//
// 收尾 / 文件监听 / 兜底去重三处「整轮已存盘 → 整清本地副本」都按 isLocalOnlyEntry 保留,
// 留到同一会话发下一条消息(由发送入口撤掉)或切会话 / 刷新为止。

export const LOCAL_NOTICE_KINDS = ['error', 'empty', 'budget'];

export function isLocalNotice(m) {
  return !!m && m.type === 'turn' && LOCAL_NOTICE_KINDS.includes(m.localNotice);
}

// 只活在本地、永远没有历史孪生的条目:旁问、自动拒绝提示、模式提示、本地提示。
export function isLocalOnlyEntry(m) {
  if (!m) return false;
  return m.type === 'btw' || m.type === 'denial' || m.type === 'mode-mismatch' || isLocalNotice(m);
}

// 同一会话新起一轮时撤掉上一轮遗留的本地提示(只撤归属 ownerKey 的;其它会话的不动)。
// 返回原数组表示没有可撤的。
export function dropLocalNoticesOf(list, ownerKey) {
  if (!Array.isArray(list) || !list.length || !ownerKey) return list;
  const next = list.filter((m) => !(isLocalNotice(m) && m.ownerKey === ownerKey));
  return next.length === list.length ? list : next;
}
