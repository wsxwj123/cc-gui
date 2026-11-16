// r146b:给某个会话留一条"回到它时才看得到"的一次性提示。
//
// 场景:A 窗格里的回退还在等裁剪 / 还原,用户已经切到 B。剩下的窗格动作与自动重发都放弃了,
// 但 A 需要知道发生了什么(会话已回退、原定的重发没有发出、内容放回了输入框)。窗格级的提示条
// 此刻挂在 B 上,写进去就是错位;所以按会话键留言,A 再次显示在某个窗格时取出(取出即删)。
// 为什么是模块级 Map:同一页面里各窗格共享;不落盘(要找回的内容本身已进输入框草稿,提示只说明
// 来由,刷新后不再提示可以接受)。
const notices = new Map();

export function leaveSessionNotice(key, text) {
  if (!key || !text) return;
  notices.set(key, text);
}

export function takeSessionNotice(key) {
  if (!key) return null;
  const text = notices.get(key) || null;
  if (text) notices.delete(key);
  return text;
}

/**
 * r193 F1:新会话拿到正式编号时,把留给草稿编号的留言改挂到正式编号(切回这个会话时才取得到)。
 * 正式编号下已有留言时两句接在一起(旧的在前);同一句不重复。草稿编号下没有留言时不做事。
 */
export function migrateSessionNotice(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const text = notices.get(fromKey);
  if (!text) return;
  notices.delete(fromKey);
  const existing = notices.get(toKey);
  notices.set(toKey, existing && existing !== text ? `${existing} ${text}` : text);
}

/**
 * r193 F1:窗格里正显示的提示(带 ownerKey 的那种)按所属会话改挂。只看 ownerKey,不看文字:
 * 所属会话是 fromKey 的改成 toKey(其余字段原样);没有所属会话、或属于别的会话的提示原样返回(同一引用)。
 */
export function migrateNoticeOwner(notice, fromKey, toKey) {
  if (!notice || !fromKey || !toKey || notice.ownerKey !== fromKey) return notice;
  return { ...notice, ownerKey: toKey };
}

/**
 * r146c:把"本来要重发的内容"并进某会话输入框的已有草稿。
 * 判"已经在里面"只认整串相等或结尾那一段相等(上一次留回就是追加在结尾的);中间碰巧包含同样的
 * 字(例如很短的"继续")不算,照样追加 —— 原来用 includes,会把这种情况误判成已在、什么都不留。
 * @returns {{ next: string, outcome: 'none'|'placed'|'appended'|'same' }} outcome 供提示按实际结果措辞
 */
export function mergeDraftText(cur, left) {
  const c = String(cur || '');
  const l = String(left || '');
  if (!l) return { next: c, outcome: 'none' };
  if (!c.trim()) return { next: l, outcome: 'placed' };
  if (c === l || c.endsWith(`\n\n${l}`)) return { next: c, outcome: 'same' };
  return { next: `${c}\n\n${l}`, outcome: 'appended' };
}
