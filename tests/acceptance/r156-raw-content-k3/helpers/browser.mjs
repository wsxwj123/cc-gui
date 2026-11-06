// r156 浏览器侧夹具:引擎启动、他端口静态页服务、Vite 开发代理夹具、页内脚本(全部自包含,经 page.evaluate 执行)。
// 铁规:不用 Playwright 的 route 拦截发往被测后端的请求(会绕过服务端判断);页面脚本只记计数/类型/状态,不保留任何 WebSocket 帧内容。
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from '@playwright/test';
import { worktree, suiteDir, artifacts, pickPort, listenerPids, sleep } from './world.mjs';

/** Chromium 一律用完整版新无头(channel:'chromium'),PDF 查看器才存在;WebKit 用 Playwright 自带的。 */
export const launchEngine = (name) => (name === 'chromium' ? chromium.launch({ channel: 'chromium' }) : webkit.launch());

async function waitReleased(port) {
  for (let n = 0; n < 30; n += 1) {
    if (!listenerPids(port).length) return true;
    await sleep(100);
  }
  return false;
}

/** 他端口网页:在空闲端口 Q 起的静态 HTTP 服务,只回一个空 HTML(监听 127.0.0.1;用 localhost 访问时靠浏览器回退到 IPv4)。 */
export async function startStatic() {
  const port = pickPort();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>r156 他站页</title><p>r156 other-site page</p>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    port,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      return waitReleased(port);
    },
  };
}

/**
 * Vite 开发代理夹具(与 client/vite.config.js 同形):'/api' 是字符串目标(Vite 会改写 Host 为 localhost:后端端口),
 * '/ws' 是对象且 ws:true;plugins 置空,root 指向只有静态 index.html 的目录,host 固定 127.0.0.1,端口取空闲口。
 */
export async function startVite(apiPort) {
  const req = createRequire(path.join(worktree, 'client', 'package.json'));
  const viteDir = path.dirname(req.resolve('vite/package.json'));
  const { createServer } = await import(pathToFileURL(path.join(viteDir, 'dist', 'node', 'index.js')).href);
  let base = {};
  try {
    const mod = await import(pathToFileURL(path.join(worktree, 'client', 'vite.config.js')).href);
    base = typeof mod.default === 'function' ? await mod.default({ command: 'serve', mode: 'development' }) : mod.default;
  } catch { /* 基础配置读不到不影响本夹具(F1 专门管配置) */ }
  const port = pickPort();
  const server = await createServer({
    ...base,
    configFile: false,
    plugins: [],
    root: path.join(suiteDir, 'vite-root'),
    cacheDir: path.join(artifacts, `vite-cache-${port}`),
    logLevel: 'error',
    clearScreen: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...(base.server || {}),
      host: '127.0.0.1', port, strictPort: true, hmr: false, open: false,
      proxy: { '/api': `http://localhost:${apiPort}`, '/ws': { target: `ws://localhost:${apiPort}`, ws: true } },
    },
  });
  await server.listen();
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await server.close();
      return waitReleased(port);
    },
  };
}

// ───────────────────────── 页内脚本(必须自包含)─────────────────────────

/** 页里建 <img>:返回 {ok,w}(onload 且 naturalWidth)。 */
export const pageImg = (page, url) => page.evaluate((u) => new Promise((resolve) => {
  const el = document.createElement('img');
  const t = setTimeout(() => resolve({ ok: false, w: 0, timeout: true }), 10000);
  el.onload = () => { clearTimeout(t); resolve({ ok: true, w: el.naturalWidth }); };
  el.onerror = () => { clearTimeout(t); resolve({ ok: false, w: 0 }); };
  el.src = u;
  (document.body || document.documentElement).appendChild(el);
}), url);

/** 页里 fetch → blob() → URL.createObjectURL → <img>。 */
export const pageBlobImg = (page, url) => page.evaluate(async (u) => {
  try {
    const r = await fetch(u);
    const blob = await r.blob();
    const obj = URL.createObjectURL(blob);
    const img = await new Promise((resolve) => {
      const el = new Image();
      el.onload = () => resolve({ ok: true, w: el.naturalWidth });
      el.onerror = () => resolve({ ok: false, w: 0 });
      el.src = obj;
    });
    return { status: r.status, bytes: blob.size, ...img };
  } catch (e) { return { status: null, bytes: 0, ok: false, w: 0, error: String(e) }; }
}, url);

/** 页里 fetch,只返回状态(读完正文)。 */
export const pageFetchStatus = (page, url) => page.evaluate(async (u) => {
  try { const r = await fetch(u); await r.arrayBuffer(); return { status: r.status }; } catch (e) { return { status: null, error: String(e) }; }
}, url);

/** 页里建 <audio>/<video>:等 loadedmetadata,返回 {ok,duration}。 */
export const pageMedia = (page, kind, url) => page.evaluate(({ kind, u }) => new Promise((resolve) => {
  const el = document.createElement(kind);
  el.muted = true;
  el.preload = 'auto';
  const t = setTimeout(() => resolve({ ok: false, duration: null, timeout: true }), 15000);
  el.onloadedmetadata = () => { clearTimeout(t); resolve({ ok: true, duration: el.duration }); };
  el.onerror = () => { clearTimeout(t); resolve({ ok: false, duration: null, errCode: el.error ? el.error.code : null }); };
  el.src = u;
  (document.body || document.documentElement).appendChild(el);
  el.load();
}), { kind, u: url });

/**
 * 页里建 <iframe>:先设 src 再插入(否则初始 about:blank 的 load 会抢先触发),load 后返回 {loaded,state,exc}。
 * probe 是要读的 contentWindow 属性名;读取被拒绝(跨源/沙箱)抛异常时记在 exc。
 */
export const pageIframe = (page, url, probe) => page.evaluate(({ u, probe }) => new Promise((resolve) => {
  const f = document.createElement('iframe');
  const t = setTimeout(() => resolve({ loaded: false }), 15000);
  f.onload = () => {
    clearTimeout(t);
    let state;
    let exc = null;
    try { state = probe ? String(f.contentWindow[probe]) : undefined; } catch (e) { exc = String(e).slice(0, 80); }
    resolve({ loaded: true, state, exc });
  };
  f.src = u;
  (document.body || document.documentElement).appendChild(f);
}), { u: url, probe });

/** 他站页里一次发出四种请求(img / fetch no-cors / iframe / audio);等 2.5 秒后返回 <img> 的 onload/onerror 结果。 */
export const fireCrossSite = (page, urls) => page.evaluate((us) => new Promise((resolve) => {
  const body = () => document.body || document.documentElement;
  const out = { imgError: false, imgLoad: false };
  const img = new Image();
  img.onerror = () => { out.imgError = true; };
  img.onload = () => { out.imgLoad = true; };
  img.src = us.img;
  fetch(us.fetch, { mode: 'no-cors' }).catch(() => {});
  const f = document.createElement('iframe');
  f.src = us.iframe;
  body().appendChild(f);
  const a = document.createElement('audio');
  a.preload = 'auto';
  a.src = us.audio;
  body().appendChild(a);
  a.load();
  setTimeout(() => resolve(out), 2500);
}), urls);

/** 完整版 Chromium 里等 PDF 查看器框架(URL 以 chrome-extension:// 开头)出现,最多 ms 毫秒。 */
export async function waitPdfViewerFrame(page, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (page.frames().some((f) => f.url().startsWith('chrome-extension://'))) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}
