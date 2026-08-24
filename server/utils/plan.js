// ExitPlanMode 的 persisted / local-finished / streaming 三类来源共用同一套纯规则。
// 该文件位于 Tauri 必定打包的 server 资源树；浏览器侧 wrapper 只复用这些纯函数。
export function normalizePlanText(value) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
}

export function planTextOfToolCall(toolCall) {
  if (toolCall?.name !== 'ExitPlanMode') return '';
  return normalizePlanText(toolCall.input?.plan ?? toolCall.input?.content ?? '');
}

export function planSignature(toolCall) {
  return planTextOfToolCall(toolCall);
}

export function isApprovedPlanToolCall(toolCall) {
  if (toolCall?.name !== 'ExitPlanMode') return false;
  const result = toolCall?.result;
  if (!result || result.interrupted || result.synthetic) return false;
  if (!result.isError) return true;
  const text = typeof result.content === 'string'
    ? result.content
    : (Array.isArray(result.content) ? result.content.map((part) => part?.text || '').join('') : '');
  return /用户已批准此计划/.test(text);
}

// 保留首卡；只有后卡带来首卡尚无的“已批准”结果时才合并 result。
export function mergeEquivalentPlanToolCall(first, later) {
  if (!first || !later || planSignature(first) !== planSignature(later)) return first;
  if (!isApprovedPlanToolCall(first) && isApprovedPlanToolCall(later)) {
    return { ...first, result: later.result };
  }
  return first;
}

