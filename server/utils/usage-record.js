// r130:jsonl 记录分类(只服务端 usage-stats.js 用;前端不 import)。
// 唯一职责:一条 user 记录算不算"用户发的消息"(.devflow/INTERFACE-r130.md §A)。纯函数、零 IO。

/**
 * 合成回显:CLI 把斜杠命令 / 本地命令输出 / 后台任务通知以 user 记录形态落盘,不是用户说的话。
 * **与 server/services/session-reader.js 的 isLocalCommandEcho 正则逐字相同**(单测
 * tests/unit/check-r130-usage-record.mjs 跨文件钉相等)。不 import 那个模块 —— 它带 fs/IO,
 * 这里要保持纯函数。CLI 新增合成标签时两处一起改。
 * 刻意不收的:`<bash-input>`(用户敲的 `!` 命令)、`<pasted_content>`(用户粘贴)—— 那是用户发的。
 */
export const SYNTHETIC_USER_ECHO_RE = /^\s*<(local-command-(caveat|stdout|stderr)|command-(name|message|args)|task-notification|cgui-tool-retry)\b/;

/** 回显判定用的文本:字符串本身,或数组里第一个 text 块的文本;都没有 → null。 */
function echoProbeText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const first = content.find((b) => b && b.type === 'text');
    return first && typeof first.text === 'string' ? first.text : null;
  }
  return null;
}

/**
 * user 记录是否算一条用户消息:
 *   type==='user' 且 isMeta!==true 且 isSidechain!==true 且不在子代理文件里(inSubagentPath:
 *   路径含 /subagents/;与 isSidechain 取"或",只可能多排、不可能少排)且内容不是合成回显
 *   且(content 为字符串,或数组中至少一个块 type!=='tool_result')。
 * 只读 type / isMeta / isSidechain / content 块的 type / 文本开头 —— 不保留正文。
 */
export function isUserMessage(record, { inSubagentPath = false } = {}) {
  if (!record || record.type !== 'user') return false;
  if (record.isMeta === true || record.isSidechain === true || inSubagentPath) return false;
  const content = record.message?.content;
  const probe = echoProbeText(content);
  if (probe != null && SYNTHETIC_USER_ECHO_RE.test(probe)) return false;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) return content.some((b) => b && b.type !== 'tool_result');
  return false;
}
