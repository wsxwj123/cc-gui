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
