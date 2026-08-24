// 共享核心必须位于 Tauri 会打包的 server 资源树。此前 server 反向导入 client/src，
// 源码测试可用、安装包却没有 client/src，导致后端启动即 ERR_MODULE_NOT_FOUND。
import {
  isApprovedPlanToolCall,
  mergeEquivalentPlanToolCall,
  normalizePlanText,
  planSignature,
  planTextOfToolCall,
} from '../../../server/utils/plan.js';

export {
  isApprovedPlanToolCall,
  mergeEquivalentPlanToolCall,
  normalizePlanText,
  planSignature,
  planTextOfToolCall,
};

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

// TodoPanel 的输入兼容层：新链路传复数 plans；旧调用方仍可传 singular plan。
// 复数输入存在时不回退 singular，避免旧 prop 在真实计划列表为空/切换时制造幽灵卡。
export function visiblePlanItems(plans, plan = '') {
  if (Array.isArray(plans)) {
    return plans.filter((item) => normalizePlanText(item?.plan));
  }
  const cleanPlan = normalizePlanText(plan);
  return cleanPlan ? [{ signature: cleanPlan, plan: cleanPlan, approved: true }] : [];
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
