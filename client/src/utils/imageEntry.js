// r84 生图历史条目的"取哪张图"(纯函数,零依赖,可直接被单测 import)。
//
// 背景:一个任务可能出多张图 —— Midjourney 一次返回 4 张【独立单图】,服务端逐张下载落盘,
// 条目里 files 是全部路径;同步三协议的一图任务【没有 files 字段】(r82 起就是这个形态,
// file / previewUrl 恒指第一张)。面板上"预览 / 放大 / 以此图修改 / 在文件夹中显示"这几个
// 单图操作原先一律读 h.file,于是 4 张里只有第一张能被操作,后 3 张只能去文件夹翻。
//
// 这里把两种形态统一成一个数组 + 一个受钳的下标,面板所有消费点都从这里取:
//  - 单图条目(无 files)的产物与改动前逐字一致 —— 向后兼容靠这一条保证;
//  - 下标一律钳进 [0, len-1]:越界会让下游拿到 undefined 路径,再一路传给预览端点、
//    「在文件夹中显示」和「以此图修改」(后者会把 undefined 当参考图路径发给服务端)。

/** 条目里全部图片路径。无图返回空数组(running / error 条目)。 */
export function entryFiles(h) {
  if (!h || typeof h !== 'object') return [];
  if (Array.isArray(h.files) && h.files.length) return h.files.filter((f) => typeof f === 'string' && f);
  return typeof h.file === 'string' && h.file ? [h.file] : [];
}

/** 受钳的选中下标。非数字 / 越界 / 负数 / 空条目一律回落 0。 */
export function pickedIndex(h, idx) {
  const len = entryFiles(h).length;
  if (!len) return 0;
  const n = Math.floor(Number(idx));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, len - 1);
}

/** 选中的那张的绝对路径。无图返回空串(调用方据此不渲染按钮)。 */
export function pickedFile(h, idx) {
  return entryFiles(h)[pickedIndex(h, idx)] || '';
}

/**
 * 预览地址。与服务端写进条目的 previewUrl 同一个模板(server/routes/image.js 的
 * `/api/image/preview?file=…`)—— 多图的后几张服务端没写 previewUrl,只能在这里拼。
 * 路径不落地时返回空串,不要拼出一个 file= 为空的请求。
 */
export function entryPreviewUrl(file) {
  return file ? `/api/image/preview?file=${encodeURIComponent(file)}` : '';
}

/** 选中那张的预览地址(上面两个的组合,消费点最常用的形态)。 */
export function pickedPreviewUrl(h, idx) {
  return entryPreviewUrl(pickedFile(h, idx));
}
