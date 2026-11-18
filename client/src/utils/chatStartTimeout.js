// r197:发送接口的「初始化超时」(504 CHAT_START_TIMEOUT)怎么认、提示怎么画。
//
// 后端在 15 秒内等不到命令行开口时,POST /api/chat 回 504,带 code:'CHAT_START_TIMEOUT'、pid、
// delivered:'unknown'、status:'running';命令行进程没有被结束,内容可能稍后到达(server/routes/chat.js
// armTurnStartup / waitTurnStartup)。同一判决另经流再报一次:{type:'error', code:'CHAT_START_TIMEOUT', error}
// 进流的缓冲,之后第一次接流时回放(已有人接着时直接送达)。
//
// 页面的处理(App.jsx handleSend):
//   - 不当发送失败:不抛错、不画 ❌ 回合,照常认领 pid、接这一轮的流(停止键还在);
//   - 提示同一轮只显示一次:发送应答那处与流里那条(含重新接上时的回放)共用 appendChatStartTimeoutNotice 去重;
//   - 排队的消息等这一轮真正结束再发:流收尾(结果到达 / 进程退出 / 静默超时被结束 / 用户点停止)时由既有排空发出。
//
// 「同一轮」用 pid 认:初始化超时只发生在新拉起进程的那一轮(复用常驻进程的回合不等初始化),一个进程至多一次。
// 启动失败(500 CHAT_START_FAILED)同样带 pid,但进程已经退出,照旧当发送失败。

export const CHAT_START_TIMEOUT_CODE = 'CHAT_START_TIMEOUT';

// 后端原文(接口契约里的那句);应答 / 事件里没带文字时兜底用。
export const CHAT_START_TIMEOUT_TEXT = '会话进程 15 秒内未完成初始化；内容可能稍后到达，请勿据此重发';

// 提示条目的本地提示标记:沿用 'error'(服务端报来的错误判决;见 utils/localNotice.js 的五种标记,单测核对它被认作本地提示)。
const NOTICE_KIND = 'error';

// 发送接口的应答是不是初始化超时(这一轮还在跑)。pid 的判法与发送处「!respJson.pid 即失败」同口径:
// 不带 pid 的 504 没有可接的流,照旧当发送失败。
export function isChatStartTimeoutResponse(status, body) {
  return status === 504 && !!body && body.code === CHAT_START_TIMEOUT_CODE && !!body.pid;
}

// 流里的同一判决。
export function isChatStartTimeoutEvent(event) {
  return !!event && event.type === 'error' && event.code === CHAT_START_TIMEOUT_CODE;
}

// 提示条目。本地提示(页面自己画、命令行不写进会话文件):留在对话里,直到同一会话发下一条消息时由发送入口撤掉,
// 或切会话 / 刷新为止。不带 srcUuids / roundStartTs(带了会被当成已被历史接管而藏掉)。
// startTimeoutPid 是去重键;中性提示(⏳ 前缀,不是 ❌ 报错块)。
export function makeChatStartTimeoutNotice({ pid, text, ownerKey, model = null, now = Date.now() } = {}) {
  const content = `⏳ ${typeof text === 'string' && text.trim() ? text : CHAT_START_TIMEOUT_TEXT}`;
  return {
    uuid: `chat-start-timeout-${String(pid)}-${now}`,
    type: 'turn',
    localNotice: NOTICE_KIND,
    startTimeoutPid: String(pid),
    ownerKey: ownerKey || null,
    timestamp: new Date(now).toISOString(),
    model: model || null,
    text: [content],
    thinking: [],
    toolCalls: [],
    blocks: [{ type: 'text', content }],
    usage: null,
  };
}

// 追加提示:同一个 pid 的提示已在列表里就原样返回(返回原数组 = 没有变化)。
export function appendChatStartTimeoutNotice(list, notice) {
  if (!notice || !notice.startTimeoutPid) return list;
  const arr = Array.isArray(list) ? list : [];
  if (arr.some((m) => m && m.startTimeoutPid === notice.startTimeoutPid)) return list;
  return [...arr, notice];
}
