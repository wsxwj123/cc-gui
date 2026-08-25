// r58 参考图 MIME(纯函数,零依赖,可直接被单测 import)。
//
// 为什么不能一律回落 image/png:Windows 上注册表缺 MIME 映射时 File.type 是空串
// (webp 尤其常见 —— 系统没装解码器就没这条映射),原先 `f.type || 'image/png'` 会把一张
// webp 的字节标成 png 发上去,上游按声明的 MIME 解码 → 直接拒,用户只看到一句"格式错误"。
// 扩展名是这种情况下唯一还剩的线索,认不出才回落 image/png(现状,兜底不撒更大的谎)。
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export function refMime(file) {
  const type = String(file?.type || '').trim();
  if (type) return type; // 浏览器给了就信它(它看的是系统映射/真实字节,比扩展名可靠)
  const ext = String(file?.name || '').toLowerCase().split('.').pop();
  return EXT_MIME[ext] || 'image/png';
}
