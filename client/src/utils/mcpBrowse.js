// r73:MCP 注册表浏览层的分面纯函数。只做视图筛选,不发请求、不碰添加流程。
//
// 分面维度只有一个:kind。服务端 normalizeRegistryEntry 已把每条归成 remote(远程 URL)/
// npm(npx)/pypi(uvx),这是条目自带的真实类型,不用新造。namespace(reverse-DNS)实测
// 前 1000 条里有 661 个不同取值,太碎,不做分面。
//
// 计数口径 = **已加载的条目**(注册表是 cursor 浅翻,一次只拿一页;不做全量镜像,
// 所以拿不到全库分面计数)。界面上必须写明是"已加载 N 条"里的分布,不能冒充全库统计。
export const ALL_KINDS = '__all__';

export const KIND_LABELS = { remote: '远程 URL', npm: 'npx (npm)', pypi: 'uvx (pypi)' };

/** { [kind]: n } —— 只数列表里真有的条目。 */
export function countByKind(list) {
  const out = {};
  for (const it of (Array.isArray(list) ? list : [])) {
    const k = it?.kind;
    if (k) out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** kind 为 ALL_KINDS/空 时返回原数组身份(不打断调用方的引用比较)。 */
export function filterByKind(list, kind = ALL_KINDS) {
  const arr = Array.isArray(list) ? list : [];
  if (!kind || kind === ALL_KINDS) return arr;
  return arr.filter((it) => it?.kind === kind);
}

/** 追加下一页并按 name 去重(同一 server 换页重复出现时不叠加)。 */
export function appendPage(prev, next) {
  const seen = new Set((Array.isArray(prev) ? prev : []).map((it) => it?.name));
  return [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(next) ? next : []).filter((it) => it?.name && !seen.has(it.name))];
}
