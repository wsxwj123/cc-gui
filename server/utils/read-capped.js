// r26-J2:限量读取 fetch Response 的文本 body(从 routes/provider-quota.js:64 抽出共用)。
//
// 为什么必须限量:本后端的下游 host 全是【用户自填】的(生图/额度查询的中转站),
// 坏掉或恶意的上游回一坨超大 body,单进程后端无界读 = 全局 OOM。
//
// 两道闸:①content-length 预检 —— 声明超限直接取消流,一个字节都不读;
// ②流式限量读 —— 上游谎报 content-length(或 chunked 无声明)时,读到超限即停,
// 退出 for-await 会取消流,不会继续收。
//
// 返回: string = 完整 body;null = 超限(调用方按"体积过大"处理,别当内容用)。
// 默认上限 1MB 保持 provider-quota 既有行为;调用方按场景传自己的限值。
export async function readCapped(res, maxBytes = 1_000_000) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) { await res.body?.cancel?.().catch(() => {}); return null; }
  if (!res.body) return '';
  let size = 0;
  const parts = [];
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) return null; // 退出 for-await 会取消流,不会继续收
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}
