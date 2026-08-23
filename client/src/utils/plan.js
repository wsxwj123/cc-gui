// ExitPlanMode 的 persisted / local-finished / streaming 三类来源共用同一套纯规则。
// 等价性刻意很窄：只统一 CRLF→LF，再去首尾空白；内部 Markdown、大小写与空白原样保留。
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

export function reconcilePlanToolCalls(toolCalls) {
  const reconciled = [];
  const indexBySignature = new Map();
  for (const toolCall of Array.isArray(toolCalls) ? toolCalls : []) {
    const signature = planSignature(toolCall);
    if (!signature) continue;
    const previousIndex = indexBySignature.get(signature);
    if (previousIndex == null) {
      indexBySignature.set(signature, reconciled.length);
      reconciled.push({ signature, toolCall });
      continue;
    }
    const previous = reconciled[previousIndex];
    const merged = mergeEquivalentPlanToolCall(previous.toolCall, toolCall);
    if (merged !== previous.toolCall) reconciled[previousIndex] = { ...previous, toolCall: merged };
  }
  return reconciled;
}

// localStorage key 保持短小；完整签名仍作为 value 校验，hash 碰撞时只会安全地“不隐藏”。
export function planIdentityKey(signature) {
  let hash = 2166136261;
  const text = normalizePlanText(signature);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

// draft→real 与 pane 换绑前迁移按会话键存的 UI 可见性。storage 由调用方注入，
// 单测可使用真实行为的内存实现；任一写失败都保留旧键，不做破坏性清理。
export function migrateSessionVisibilityOwner(storage, fromOwnerKey, toOwnerKey) {
  if (!storage || !fromOwnerKey || !toOwnerKey || fromOwnerKey === toOwnerKey) return false;
  const exactKeys = [`cgui-goal-hidden:${fromOwnerKey}`];
  const planPrefix = `cgui-plan-hidden:${fromOwnerKey}:`;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(planPrefix)) exactKeys.push(key);
  }
  let migrated = false;
  for (const fromKey of exactKeys) {
    const value = storage.getItem(fromKey);
    if (value == null) continue;
    const suffix = fromKey.slice(fromKey.indexOf(':', 'cgui-plan-hidden:'.length) + 1);
    const toKey = fromKey.startsWith('cgui-plan-hidden:')
      ? `cgui-plan-hidden:${toOwnerKey}:${suffix}`
      : `cgui-goal-hidden:${toOwnerKey}`;
    try {
      storage.setItem(toKey, value);
      if (storage.getItem(toKey) !== value) continue;
      storage.removeItem(fromKey);
      migrated = true;
    } catch {}
  }
  return migrated;
}
