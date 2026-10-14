// r151a:匹配 CLI 英文原文的常量,前后端共用(升级 CLI 时只对照这一处,方案审查 S8)。
// 必须保持零 node 依赖的纯模块:前端(ChatInput / App)经 vite 直接引用(先例 vision-capability.js)。

// CLI 判定 auto 档不可用时的四句原文(调研 Y §2)。第三方 provider 下运行时回退只认这四句:
// 宽正则在第三方下容易被上游的普通报错误伤(报错里带 auto / mode 之类的词很常见)。
export const AUTO_UNAVAILABLE_PHRASES = [
  'auto mode disabled by settings',
  'auto mode is unavailable for your plan',
  'auto mode unavailable while fast mode is on',
  'auto mode unavailable for this model',
];

// 报错文本里是否含其中一句(不区分大小写;CLI 可能把句首字母大写)。
export function matchesAutoUnavailable(text) {
  const s = String(text || '').toLowerCase();
  return AUTO_UNAVAILABLE_PHRASES.some((p) => s.includes(p));
}

// 自动档审核的拒绝事件(system/permission_denied,decision_reason_type === 'classifier')里,
// 表示"审核没有给出结论"(不可用 / 超时 / 解析不出)的原文(调研 Y §3)。与"判定为拦"要分开说:
// 前者不是对操作安全性的判定。
export const CLASSIFIER_UNAVAILABLE = 'Classifier unavailable';
export const AUTO_COULD_NOT_EVALUATE_PREFIX = 'Auto mode could not evaluate';
export const TEMPORARILY_UNAVAILABLE = 'temporarily unavailable';

// 拒绝提示行的种类(INTERFACE Y.3.4):来源是自动档审核 → 没给出结论为 'unavailable',否则是判定结果 'blocked';
// 其它来源(权限规则、当前档位等)→ 'other'。reason = decision_reason,message = 事件的说明文字。
export function denialKind(reasonType, reason, message) {
  if (reasonType !== 'classifier') return 'other';
  const r = String(reason || '');
  if (r === CLASSIFIER_UNAVAILABLE || r.startsWith(AUTO_COULD_NOT_EVALUATE_PREFIX)
    || String(message || '').includes(TEMPORARILY_UNAVAILABLE)) return 'unavailable';
  return 'blocked';
}

// 审核连续拦下多次后,CLI 把这次调用交给宿主(canUseTool),原因以 "3 consecutive actions were blocked" 开头。
export const AUDIT_STREAK_PHRASE = 'consecutive actions were blocked';
export function isAuditStreakReason(text) {
  return String(text || '').includes(AUDIT_STREAK_PHRASE);
}
