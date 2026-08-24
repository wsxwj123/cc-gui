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

// 输入框上方【只常驻已批准的计划】。未决计划归 PlanReviewCard 审批弹窗(同一份内容
// 出两遍是重复);被驳回的计划不再留卡 —— 否则一轮协商 4-5 版就是 4-5 张永久叠着的
// "计划待审查",正是 r32 修掉的计划卡洪水换了个形状回来。
export function approvedPlanItems(toolCalls) {
  return reconcilePlanToolCalls(toolCalls)
    .filter(({ toolCall }) => isApprovedPlanToolCall(toolCall))
    .map(({ signature, toolCall }) => ({
      signature,
      plan: planTextOfToolCall(toolCall),
      approved: true,
    }));
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

export const MAX_HIDDEN_PLAN_IDENTITIES = 32;

// 每隐藏一份计划就留一个 `cgui-plan-hidden:<owner>:<hash>` 键，value 是【计划全文】
// (hash 碰撞时安全地"不隐藏")。无上界时，长会话反复隐藏会把 5MB 配额吃掉；而入队现在
// 是"写不进就硬拒"，配额一满连带发不出消息。照 goal 的 32 条上界淘汰最旧。
// ponytail: "最旧"取 storage.key() 的枚举序 —— WKWebView/WebView2 都是插入序；即便某个
// 实现不保证，被淘汰的也只是一条隐藏偏好(那份计划重新显示出来)，没有数据损失。
export function pruneHiddenPlanIdentities(storage, ownerKey, keepKey = '', limit = MAX_HIDDEN_PLAN_IDENTITIES) {
  if (!storage || !ownerKey) return 0;
  const prefix = `cgui-plan-hidden:${ownerKey}:`;
  const cap = Math.max(1, Number(limit) || MAX_HIDDEN_PLAN_IDENTITIES);
  const keys = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) && key !== keepKey) keys.push(key);
    }
  } catch { return 0; }
  const excess = keys.length + (keepKey ? 1 : 0) - cap;
  let removed = 0;
  for (let index = 0; index < excess; index += 1) {
    try { storage.removeItem(keys[index]); removed += 1; } catch {}
  }
  return removed;
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
