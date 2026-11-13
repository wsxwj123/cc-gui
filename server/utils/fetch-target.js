// r179 拉取模型的取值规则(零 IO 纯函数,文本 / 生图两个 fetch-models 路由与测试连接路由共用一份):
//   · 借已保存的 Key(请求里 Key 不是非空字符串):地址、代理用已保存的值;协议请求里带了就用请求的,
//     没带才用已保存的(r181:这些入口都不再跨主机跟随重定向,换协议只是在同一地址上换请求头与路径);
//     请求里带了地址且与已保存的不同 → 拒绝,不发上游请求。
//   · 自带 Key(请求里 Key 是非空字符串):每一项先用请求里的,请求里没带才用已保存的。
//   硬规则:借已保存 Key 时,发出去的地址永远是 stored.baseURL 原值;比较只决定拒绝与否,
//   不决定发往哪里 —— 即使 normalize 写错,已保存的 Key 也到不了别的地址。
// 两个接口的差异(字段名映射、代理校验、条目不存在时 404 还是按新建态)都留在路由层。

export const KEY_URL_MISMATCH_MSG = '接口地址已改动，已保存的密钥只会发往已保存的地址。要按新地址拉取模型，请重新填写密钥，或先保存再拉取。';
// 测试连接专用(r181):同一条规则,说的是「测试连接」。
export const KEY_URL_MISMATCH_TEST_MSG = '接口地址已改动，已保存的密钥只会发往已保存的地址。要按新地址测试连接，请重新填写密钥，或先保存再测试。';

/**
 * stored:  null | { baseURL, apiKey, protocol, proxyUrl? }
 * request: { baseURL, apiKey, protocol, proxyUrl }   —— req.body 的原值,不预处理
 * normalize: (url) => string,只用于比较地址是否相同
 * 返回 { reject: true }
 *    | { reject: false, borrowed, baseURL, apiKey, protocol, proxy: { from: 'stored'|'request', value }, sameAsStored }
 */
export function resolveFetchTarget(stored, request, normalize) {
  const reqBase = typeof request.baseURL === 'string' && request.baseURL.trim() ? request.baseURL : '';
  const ownKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';
  const reqProxyGiven = request.proxyUrl !== undefined && request.proxyUrl !== null;
  if (!stored) { // 不带 id / 条目不存在:请求原值,现状不变
    return {
      reject: false, borrowed: false, baseURL: request.baseURL, apiKey: request.apiKey,
      protocol: request.protocol, proxy: { from: 'request', value: request.proxyUrl }, sameAsStored: false,
    };
  }
  const storedProxy = typeof stored.proxyUrl === 'string' ? stored.proxyUrl : '';
  if (!ownKey) { // 借已保存 Key:地址、代理用已保存的;地址恒为 stored.baseURL 原值
    if (reqBase && normalize(reqBase) !== normalize(stored.baseURL)) return { reject: true };
    return {
      reject: false, borrowed: true, baseURL: stored.baseURL, apiKey: stored.apiKey,
      protocol: request.protocol || stored.protocol, proxy: { from: 'stored', value: storedProxy }, sameAsStored: true,
    };
  }
  const baseURL = reqBase || stored.baseURL; // 自带 Key:请求优先,缺省回落
  return {
    reject: false, borrowed: false, baseURL, apiKey: ownKey,
    protocol: request.protocol || stored.protocol,
    proxy: reqProxyGiven ? { from: 'request', value: request.proxyUrl } : { from: 'stored', value: storedProxy },
    sameAsStored: normalize(baseURL) === normalize(stored.baseURL),
  };
}
