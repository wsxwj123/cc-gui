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
