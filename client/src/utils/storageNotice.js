// 待发消息存不进本地存储时给用户看的话(r149 S6)。
//
// 什么时候会走到这里:入队那一下落盘失败,并且已经自动腾过空间重试(先给输入历史瘦身,不够再删没在显示的
// 会话的输入历史,见 utils/inputHistory.js 的 freeInputHistoryAndRetry)仍然失败 —— 也就是占满本地存储的
// 不是可以自动清理的东西。
// 原来不论有没有附件都说「附件仍保留，请移除部分附件后重试」;用户没带附件时这句话既不对也没法照做。
//   没有附件:只陈述事实。
//   有附件:保留原来的句子(整图预览确实可能是写不进的原因,移除附件是可行的做法)。
export function queueSaveFailedNotice({ hasAttachments = false, inSession = false } = {}) {
  if (!hasAttachments) return '无法保存待发消息：本地存储已满。';
  return inSession
    ? '无法保存待发消息：本地存储空间不足。附件与草稿仍保留，请处理后重试。'
    : '无法保存待发消息：本地存储空间不足。附件仍保留，请移除部分附件后重试。';
}
