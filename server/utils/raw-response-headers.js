// 读文件接口 raw=1 成功响应的安全头(r156)。
// 该接口把用户磁盘上的文件以后台同源身份下发;浏览器若把它当文档打开(例如带脚本的 SVG),
// 脚本会以后台页面身份运行。CSP sandbox 让该文档落进不透明来源、不运行脚本(四个引擎实测
// nosniff 单独不够,sandbox 才是必需的);nosniff 补充防止按内容嗅探成别的类型。
// PDF 是唯一豁免:带 sandbox 时 macOS 上 WKWebView(Tauri 应用的引擎)的 PDF 插件不加载,预览变成空白
// (实测截图);Chromium 151 的 PDF 查看器不受 sandbox 影响,为跨引擎一致统一豁免。
// 判据按最终发出的 Content-Type,不按扩展名:默认一律带 sandbox,将来映射表里新增
// html/xml 等类型也自动受保护。

const PDF_MEDIA_TYPE = 'application/pdf';

/**
 * @param {unknown} contentType 最终要发出的 Content-Type 值
 * @returns {Record<string, string>} 需要设置的响应头(名 → 值)
 */
export function rawResponseSecurityHeaders(contentType) {
  const headers = { 'X-Content-Type-Options': 'nosniff' };
  // 非字符串(缺失/异常)按"不是 PDF"处理,即带 sandbox:失败方向只会是多限制。
  const mediaType = typeof contentType === 'string'
    ? contentType.split(';')[0].trim().toLowerCase()
    : '';
  if (mediaType !== PDF_MEDIA_TYPE) headers['Content-Security-Policy'] = 'sandbox';
  return headers;
}
