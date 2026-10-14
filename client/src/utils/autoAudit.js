// r151a 功能 Y:第三方 provider 下「自动」档的前端判据、不可用标记的键、选择器文案(纯函数,单测直接 import)。
// 判"是不是第三方"统一读 GET /api/auto-audit/status 的 official(与服务端同判据);状态还没取到时沿用 providerHint。

export function isThirdPartyProvider(auditStatus, providerHint) {
  if (auditStatus && typeof auditStatus.official === 'boolean') return !auditStatus.official;
  return (providerHint || 'anthropic') !== 'anthropic';
}

const bareModelName = (model) => String(model || '').replace(/\[1m\]/i, '');
// 不可用标记(localStorage cgui-auto-unavailable)的键:官方 `<providerHint>|<模型>`(既有写法,逐字不变);
// 第三方 `tp:<providerId 或 unknown>|<模型>`(两个第三方互不污染)。模型名都去掉 [1m]。
export const officialAutoKey = (providerHint, model) => `${providerHint || 'anthropic'}|${bareModelName(model)}`;
export const thirdPartyAutoKey = (providerId, model) => `tp:${providerId || 'unknown'}|${bareModelName(model)}`;
export function autoUnavailableKeyFor(auditStatus, providerHint, model) {
  return isThirdPartyProvider(auditStatus, providerHint)
    ? thirdPartyAutoKey(auditStatus?.providerId, model)
    : officialAutoKey(providerHint, model);
}

// 第三方下「自动」档的说明与审核模型行(INTERFACE Y.3.4 权限档选择器)。
export const THIRD_PARTY_AUTO_DESC = '由审核模型逐动作判定，通过即执行，判定有风险则拒绝。每次审核额外消耗约 3 万输入 token；审核模型判错可能放行危险操作。';
export function auditModelLineText(auditStatus) {
  const name = auditStatus?.auditModel;
  if (typeof name !== 'string' || !name) return '审核模型：未知';
  return auditStatus.auditModelSource === 'default' ? `审核模型：${name}（未单独设置）` : `审核模型：${name}`;
}
