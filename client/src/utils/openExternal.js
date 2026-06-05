// 打开外部 URL 的跨平台 helper。
//
// Tauri WebView(WKWebView/WebView2)默认拦截 `<a target="_blank">` 跳转,
// 用户点链接没反应。所以所有"打开外部链接"应该走 server 用 OS shell 命令
// 打开默认浏览器。浏览器模式下 fallback 到 window.open。
export async function openExternalUrl(url) {
  try {
    const r = await fetch('/api/open-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (r.ok) return;
  } catch { /* fallthrough to window.open */ }
  try { window.open(url, '_blank', 'noopener,noreferrer'); } catch {}
}
