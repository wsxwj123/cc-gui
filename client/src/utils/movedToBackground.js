// r198 转到后台:页面侧的判定、原句解析与提示文案(App.jsx 直播接线、BashCard 卡片与按钮共用)。

// 这条工具结果是不是「前台命令被转到后台」。只看结构化字段:直播事件的 tool_use_result(与会话文件的 toolUseResult
// 同形)带用户转的 backgroundedByUser、为送达消息转的 backgroundedToDeliverMessage、前台超时自动转的 timedOutAfterMs
// 之一;读历史时服务端已把它归成 movedToBackground:true(server/services/session-reader.js 同一判据)。
// 只有 backgroundTaskId 而三者都没有的,是模型自己用后台方式起的命令,不算。
export function isMovedToBackground(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.movedToBackground === true) return true;
  return meta.backgroundedByUser === true || meta.backgroundedToDeliverMessage === true || typeof meta.timedOutAfterMs === 'number';
}

// 命令行原句「… If it is still running after 30m in the background, it will be stopped …」里的后台时限;取不到回 null(不硬编码)。
export function parseBackgroundDeadline(text) {
  const m = typeof text === 'string' ? /after (\S+) in the background/.exec(text) : null;
  return m ? m[1] : null;
}

// 原句里的输出文件路径:「Output is being written to: <路径>」。非贪婪匹配到第一个 .output,路径可以含空格
// (Windows 用户名带空格);与模型后台起的命令取路径是同一条正则。
export function parseOutputPath(text) {
  const m = typeof text === 'string' ? /written to:\s*(.+?\.output)/.exec(text) : null;
  return m ? m[1] : null;
}

const RESULT_UNKNOWN = '移到后台的结果未知:';

// 回车 / 并入那一路(自动)的窗格提示:没有要提示的回 null。result 是状态库 moveToBackground 归一后的结果。
export function autoMoveNoticeText(result) {
  if (!result) return null;
  if (result.ok) {
    const n = Array.isArray(result.skipped) ? result.skipped.length : 0;
    return n > 0
      ? `有 ${n} 条命令设了超过 30 分钟的前台时限,移到后台会在后台满 30 分钟时被命令行停掉,这次没有移动;需要的话点它卡片上的「移到后台」。`
      : null;
  }
  switch (result.code) {
    case 'BG_NO_ACTIVE_TURN':
    case 'BG_STOPPING':
    case 'BG_XS_TURN':
    case 'BG_INVALID_INPUT':
      return null;
    case 'BG_REJECTED':
      return `没能移到后台:${rejectedWords(result.error)}`;
    case 'BG_FORBIDDEN':
      return '请求被拒绝(登录或来源校验未通过)';
    case 'BG_NETWORK':
      return '没连上后台服务,结果未知';
    default:
      return `${RESULT_UNKNOWN}${result.error || result.code || ''}`;
  }
}

// 按钮那一路的弹框文案:不弹回 null。
export function buttonMoveDialogText(result) {
  if (!result) return null;
  if (result.ok) {
    return Array.isArray(result.moved) && result.moved.length
      ? null
      : '这条命令已经不在前台运行(可能刚结束或已在后台),没有移动。';
  }
  switch (result.code) {
    case 'BG_NO_ACTIVE_TURN': return '这一轮已经结束,没有需要移动的命令。';
    case 'BG_STOPPING': return '这一轮正在停止,没有移动。';
    case 'BG_XS_TURN': return '这一轮在处理跨会话消息;移到后台会让对方先收到“已完成”,所以不移。';
    case 'BG_REJECTED': return `没能移到后台:${rejectedWords(result.error)}`;
    case 'BG_FORBIDDEN': return '请求被拒绝(登录或来源校验未通过)';
    case 'BG_NETWORK': return '没连上后台服务,结果未知';
    default: return `${RESULT_UNKNOWN}${result.error || result.code || ''}`;
  }
}

// 后端回的是「命令行拒绝转到后台:<原话>」,提示里只放原话。
function rejectedWords(error) {
  return String(error || '').replace(/^命令行拒绝转到后台:/, '');
}

// 「移到后台」按钮给不给这条调用:Bash、还没出结果、前台任务表里有它(fgEntry = store.fgTasks[toolCall.id]),
// 且卡片属主(TaskOwnerContext)与任务所属会话一致 —— 分支复制出的卡片与源会话共用 tool_use_id,属主对不上不给。
export function canMoveToBackground(toolCall, fgEntry, ownerSid) {
  if (!toolCall || toolCall.name !== 'Bash' || toolCall.result || !fgEntry) return false;
  return !ownerSid || !fgEntry.sessionId || fgEntry.sessionId === ownerSid;
}

// 工作组(收起时)头行上的按钮对着谁:组里最后一条可以转后台的调用;没有回 null。
export function foregroundMoveTarget(items, fgTasks, ownerSid) {
  const list = Array.isArray(items) ? items : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const tc = list[i] && list[i].type === 'tool_use' ? list[i].toolCall : null;
    const entry = tc && fgTasks ? fgTasks[tc.id] : null;
    if (canMoveToBackground(tc, entry, ownerSid)) return { toolCall: tc, sessionId: entry.sessionId || ownerSid || null };
  }
  return null;
}

// 组里有没有被转到后台的命令(这样的组默认展开,让「已移到后台运行 · 任务 …」那一行看得见)。
export function hasMovedCommand(items) {
  return (Array.isArray(items) ? items : []).some((b) => b && b.type === 'tool_use' && isMovedToBackground(b.toolCall && b.toolCall.result));
}

// 按钮的悬停说明与超长前台时限的确认文案。
export const MOVE_TO_BG_HINT = '移到后台:命令继续在后台运行,模型接着往下走;命令结束后会自动通知模型。移到后台的命令运行满命令行规定的时限(目前约 30 分钟)会被停止。';
export const LONG_FG_TIMEOUT_MS = 1_800_000;
export function longTimeoutConfirmText(timeoutMs) {
  const minutes = Math.round(Number(timeoutMs) / 60000);
  return `这条命令设了 ${minutes} 分钟的前台时限。移到后台后,命令行会在它后台运行满约 30 分钟时停掉它。仍要移到后台吗?`;
}
