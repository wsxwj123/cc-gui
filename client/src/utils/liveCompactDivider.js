// r208:直播那条「上下文已压缩」分隔线与历史里同一次压缩的分隔线只画一条。
//
// 两个来源:①直播 —— 流里收到 system/compact_boundary 时,本地列表追加一条
// { type:'compact', uuid:'live-compact', _live:true, roundStartTs };②历史 —— 会话记录里每条 isCompactSummary
// 读成 { type:'compact', uuid, timestamp }。正常发送时本轮历史被截断(streamHistCutoff),只有直播那条;
// 没有快照的重接、或截断作废(stream_gap)时历史是展示来源,反复重读会把本轮写下的那次压缩带进来,
// 这时直播那条要让位。
//
// 判据:已显示的历史里有一条压缩分隔线,时间不早于直播那条记下的这一轮起点(roundStartTs)→ 直播那条不画。
// 历史里还没有(还没重读到)、或只有更早的压缩 → 照画(用户当场看到压缩)。没记下起点(0 / 非数)的直播那条
// 一律照画,不拿它去和历史比。历史那几条一条不动。
// 起点在追加直播那条时定(App.jsx 收到 compact_boundary 处):正常发送 / 带快照的重接 = 本流的起流时刻
// (发送时刻,或服务端报的回合开始时刻);没有快照的重接 = 历史里这一轮提示词的时间,取不到再用起流时刻。

export function isLiveCompactDivider(m) {
  return m?.type === 'compact' && m._live === true;
}

/** 历史里有没有不早于 roundStartTs 的压缩分隔线(直播那条不算;没有时间、时间解析不出的不算)。 */
export function historyHasRoundCompact(history, roundStartTs) {
  if (!Number.isFinite(roundStartTs) || roundStartTs <= 0) return false;
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.type !== 'compact' || m._live) continue;
    const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (Number.isFinite(t) && t >= roundStartTs) return true;
  }
  return false;
}

/**
 * 本地列表里去掉「历史已画了本轮那次压缩」的直播分隔线;其余条目原样保留。
 * 不需要去掉时返回原数组(不打穿下游 memo)。
 */
export function dropLiveCompactCoveredByHistory(local, history) {
  const list = Array.isArray(local) ? local : [];
  if (!list.some(isLiveCompactDivider)) return list;
  const next = list.filter((m) => !(isLiveCompactDivider(m) && historyHasRoundCompact(history, m.roundStartTs)));
  return next.length === list.length ? list : next;
}
