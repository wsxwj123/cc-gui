// genui action 消息的**识别与解析**(r64 M7,INTERFACE §3.2 末段 / §9.2)。
// 与 action-send.js 分文件的理由:那边是"怎么发",这边是"发出去的东西在会话里怎么认"。
// 前缀直接从那边 import(单一真相);数据块引导词那边是内联字面量,这边只能各存一份 ——
// 漂移由 tests/unit/check-genui-action-fold.mjs 的**往返用例**兜住(真造一条消息再解回来,
// 任一边改了字面量当场转红),不是靠"记得同步改"。
// 纯函数、不 import 任何运行时,裸 node 可跑。
import { ACTION_MESSAGE_PREFIX } from './action-send.js';

/** 与 action-send.js 的 buildActionMessage 里那段模板逐字一致。 */
const ACTION_DATA_MARKER = '数据: ';

/**
 * 这条用户消息是不是 genui action 消息 —— M7 折叠的唯一判据。
 * 只认**整条消息以前缀开头**:用户自己聊天里引用「[genui-action]」这段文字
 * 不该被折叠成一行,所以不 trim、不做包含匹配、不上宽松正则。
 */
export function isActionMessage(text) {
  return typeof text === 'string' && text.startsWith(ACTION_MESSAGE_PREFIX);
}

/**
 * 折叠标记收起态要显示的两样东西(PLAN §1.3.3 L4:动作名 + 组件类型)。
 * 不是 action 消息 → null,调用方据此决定折不折叠。
 *
 * 收起态显示的动作名是用户的审计入口,所以只认**真正的那个 `action` 字段** ——
 * `component` 里有用户自己填的值(§3.2 唯一的自由文本),值里写什么都不能顶掉它。
 * 用 JSON.parse 而不是正则扫 `"action":"…"`:两者对合法消息其实同样正确
 * (JSON 转义已经挡住了伪造),选它只因为同样长度下不必为转义规则做推理。
 *
 * 是 action 消息但数据块坏了(历史被外部截断等)→ 仍返回对象、字段留空:
 * 折叠照做、原文照样展得开 —— 可审计性(L4)不许因为解析失败而消失。
 */
export function parseActionMessage(text) {
  if (!isActionMessage(text)) return null;
  const at = text.lastIndexOf(`\n${ACTION_DATA_MARKER}`);
  if (at < 0) return { action: '', type: '' };
  try {
    const d = JSON.parse(text.slice(at + 1 + ACTION_DATA_MARKER.length));
    return {
      action: typeof d?.action === 'string' ? d.action : '',
      type: typeof d?.component?.type === 'string' ? d.component.type : '',
    };
  } catch { return { action: '', type: '' }; }
}
