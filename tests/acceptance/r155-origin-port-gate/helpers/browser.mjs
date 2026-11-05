// r155 浏览器侧夹具:攻击页静态服务、Vite 开发代理夹具、页内 WS / fetch 脚本。
// 铁规:不用 Playwright 的 route 拦截发往受害实例的请求(那样会绕过被测的服务端校验);页面脚本只记录计数/状态,不保留帧内容。
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from '@playwright/test';
import { worktree, suiteDir, artifacts, pickPort, listenerPids, sleep } from './world.mjs';

export const engines = { chromium, webkit };

/** 攻击页:在空闲端口 Q 起的静态 HTTP 服务,只返回一个空 HTML。bindAll 时绑 0.0.0.0(局域网用例)。 */
export async function startStatic({ host = '127.0.0.1' } = {}) {
  const port = pickPort();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>r155 攻击页</title><p>r155 attack page</p>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    port,
    /** 关闭并核对端口已释放,返回是否已释放。 */
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      for (let n = 0; n < 30; n += 1) {
        if (!listenerPids(port).length) return true;
        await sleep(100);
      }
      return false;
    },
  };
}

/**
 * Vite 开发代理夹具:在 client/vite.config.js 默认导出基础上,用程序化 API 起 dev server。
 * 代理与 client/vite.config.js 同形:'/api' 是字符串目标(Vite 对字符串目标会改写 Host),'/ws' 是对象且不加 changeOrigin(WS 不改写 Host)。
 * plugins 置空(测试页是纯 HTML,不需要 React / Tailwind 插件)。
 */
export async function startVite(apiPort) {
  const req = createRequire(path.join(worktree, 'client', 'package.json'));
  const viteDir = path.dirname(req.resolve('vite/package.json'));
  const { createServer } = await import(pathToFileURL(path.join(viteDir, 'dist', 'node', 'index.js')).href);
  const baseMod = await import(pathToFileURL(path.join(worktree, 'client', 'vite.config.js')).href);
  let base = baseMod.default;
  if (typeof base === 'function') base = await base({ command: 'serve', mode: 'development' });
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
    async close() {
      await server.close();
      for (let n = 0; n < 30; n += 1) {
        if (!listenerPids(port).length) return true;
        await sleep(100);
      }
      return false;
    },
  };
}

// ───────────────────────── 页内脚本(经 page.evaluate 执行,必须自包含)─────────────────────────

/**
 * 在页面里开 WebSocket。target 以 "/" 开头 = 同源(用 location.host 拼,和真实前端一致),否则是完整 ws:// 地址。
 * 返回 { opened, messages, errored, closed, thrown }:messages 只是帧数。
 * stopAtFirstFrame=true:收到第一帧就返回(期望放行时用);false:等到关闭/出错后稍候,或到 waitMs(期望被拒时用)。
 */
export function pageWs(page, target, waitMs = 3000, stopAtFirstFrame = false) {
  return page.evaluate(({ target, waitMs, stopAtFirstFrame }) => new Promise((resolve) => {
    const r = { opened: false, messages: 0, errored: false, closed: false, thrown: null };
    let finished = false;
    let ws = null;
    const done = () => { if (finished) return; finished = true; try { ws.close(); } catch (e) { /* 已关 */ } resolve(r); };
    try {
      ws = new WebSocket(target.startsWith('/') ? `ws://${location.host}${target}` : target);
    } catch (e) { r.thrown = String(e); resolve(r); return; }
    ws.onopen = () => { r.opened = true; };
    ws.onmessage = () => { r.messages += 1; if (stopAtFirstFrame) done(); };
    ws.onerror = () => { r.errored = true; };
    ws.onclose = () => { r.closed = true; setTimeout(done, 300); };
    setTimeout(done, waitMs);
  }), { target, waitMs, stopAtFirstFrame });
}

/** 在页面里 fetch(默认 CORS 模式)。target 以 "/" 开头 = 相对路径(同源);resolved=false 表示 Promise 被拒绝(读不到)。keepText 才回传正文。 */
export function pageFetch(page, target, init, { keepText = false } = {}) {
  return page.evaluate(async ({ target, init, keepText }) => {
    try {
      const r = await fetch(target, init);
      const t = await r.text();
      return { resolved: true, status: r.status, text: keepText ? t : '' };
    } catch (e) {
      return { resolved: false, status: null, text: '', error: String(e) };
    }
  }, { target, init, keepText });
}

export const loginInit = (password) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
