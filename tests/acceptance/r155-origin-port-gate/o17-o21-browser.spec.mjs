// O17-O21:真浏览器(chromium / webkit)。攻击页被拒、后端自己的页面放行、Vite 开发代理放行、真实局域网 IP。
// 受害实例是真实后端,不用 Playwright 的 route 拦截发往它的请求。页面脚本只记录状态与计数,不保留帧内容。
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { withInstance, logSize, waitLogSince, LAN_IP, PASSWORD, WRONG_PASSWORD } from './helpers/world.mjs';
import { engines, startStatic, startVite, pageWs, pageFetch, loginInit } from './helpers/browser.mjs';

/** 起浏览器 → 跑 fn → 无论成败都关浏览器。 */
async function withBrowser(engineName, fn) {
  const browser = await engines[engineName].launch({ headless: true });
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ───────────────────────── O17 / O18 攻击页被拒 ─────────────────────────
function attackTest(id, engineName) {
  test(`${id} 攻击页被拒(${engineName}):他端口网页的 WS 不 open、跨源 fetch 与预检读不到、不写入授权`, async () => {
    test.setTimeout(180_000);
    await withInstance({ label: id.toLowerCase() }, async (i) => {
      const stat = await startStatic();
      try {
        await withBrowser(engineName, async (browser) => {
          const page = await (await browser.newContext()).newPage();
          const combos = [['localhost', 'localhost'], ['127.0.0.1', '127.0.0.1'], ['127.0.0.1', 'localhost']];
          for (const [pageHost, victimHost] of combos) {
            const pageOrigin = `http://${pageHost}:${stat.port}`;
            const victim = `${victimHost}:${i.port}`;
            const tag = `${id} 页面 ${pageHost}:Q → 受害 ${victimHost}:P`;
            const off = logSize(i);
            await page.goto(`${pageOrigin}/`);
            const ws = await pageWs(page, `ws://${victim}/ws`, 3000, false);
            const get = await pageFetch(page, `http://${victim}/api/network`);
            const post = await pageFetch(page, `http://${victim}/api/computer-use/grants`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-cgui-grant-token': 'x' },
              body: JSON.stringify({ bundleId: 'com.apple.TextEdit', granted: true }),
            });
            expect.soft(ws.opened, `${tag} ①WS 不应触发 open,实际 ${JSON.stringify(ws)}`).toBe(false);
            expect.soft(ws.messages, `${tag} ①WS 不应收到任何帧(含 cu:grant-token、model),实际收到 ${ws.messages} 帧`).toBe(0);
            expect.soft(get.resolved, `${tag} ②跨源 fetch /api/network 应被拒绝(读不到),实际 Promise 兑现了,状态 ${get.status}`).toBe(false);
            expect.soft(post.resolved, `${tag} ③带自定义头的 POST /api/computer-use/grants(预检)应被拒绝,实际 Promise 兑现了,状态 ${post.status}`).toBe(false);
            const wsLine = `[ws] blocked origin="${pageOrigin}"`;
            const corsLine = `[cors] blocked origin="${pageOrigin}"`;
            const log = await waitLogSince(i, off, (t) => t.includes(wsLine) && t.includes(corsLine), 2000);
            expect.soft(log.includes(wsLine), `${tag} ④日志增量应含 ${wsLine}`).toBe(true);
            expect.soft(log.includes(corsLine), `${tag} ④日志增量应含 ${corsLine}`).toBe(true);
          }
        });
        let granted = false;
        try { granted = fs.readFileSync(path.join(i.home, '.claude-gui', 'cu-runtime', 'grants.json'), 'utf8').includes('com.apple.TextEdit'); } catch { /* 文件不存在 = 没写入 */ }
        expect.soft(granted, `${id} ⑤假家目录的 grants.json 不应含 com.apple.TextEdit(攻击页不应能写入授权)`).toBe(false);
      } finally {
        expect.soft(await stat.close(), `${id} 攻击页静态服务端口应已释放`).toBe(true);
      }
    });
  });
}
attackTest('O17', 'chromium');
attackTest('O18', 'webkit');

// ───────────────────────── O19 后端自己的页面 ─────────────────────────
function ownPageTest(id, engineName) {
  test(`${id} 后端自己的页面(${engineName}):127.0.0.1 与 localhost 两个文档里同源 WS 与登录都放行`, async () => {
    test.setTimeout(180_000);
    await withInstance({ label: `${id.toLowerCase()}-${engineName}` }, async (i) => {
      await withBrowser(engineName, async (browser) => {
        const ctx = await browser.newContext();
        for (const h of ['127.0.0.1', 'localhost']) {
          const tag = `${id} http://${h}:P/api/health 文档内`;
          const page = await ctx.newPage();
          await page.goto(`http://${h}:${i.port}/api/health`);
          const ws = await pageWs(page, '/ws', 5000, true);
          expect.soft(ws.opened, `${tag} 同源 WS 应 open,实际 ${JSON.stringify(ws)}`).toBe(true);
          expect.soft(ws.messages, `${tag} 同源 WS 应至少收到一帧,实际 ${ws.messages} 帧`).toBeGreaterThanOrEqual(1);
          const lg = await pageFetch(page, '/api/login', loginInit(PASSWORD), { keepText: true });
          expect.soft(lg.status, `${tag} 同源登录应 200,实际 ${lg.status}${lg.error ? ` ${lg.error}` : ''}`).toBe(200);
          expect.soft((lg.text ?? '').trim(), `${tag} 同源登录正文`).toBe('{"ok":true}');
        }
      });
    });
  });
}
for (const e of ['chromium', 'webkit']) ownPageTest('O19', e);

// ───────────────────────── O20 开发代理(与产线同形)─────────────────────────
function viteTest(id, engineName) {
  test(`${id} 开发代理(${engineName}):经 Vite 代理的 WS、正确密码登录、错误密码登录都进了后端处理器`, async () => {
    test.setTimeout(180_000);
    await withInstance({ label: `${id.toLowerCase()}-${engineName}` }, async (i) => {
      const vite = await startVite(i.port);
      try {
        await withBrowser(engineName, async (browser) => {
          const ctx = await browser.newContext();
          for (const h of ['127.0.0.1', 'localhost']) {
            const tag = `${id} http://${h}:V/ 页面内`;
            const page = await ctx.newPage();
            try {
              await page.goto(`http://${h}:${vite.port}/`, { timeout: 15_000 });
            } catch (e) {
              if (h === '127.0.0.1') { expect.soft(false, `${tag} 页面打不开:${String(e.message).split('\n')[0]}`).toBe(true); continue; }
              test.info().annotations.push({ type: 'note', description: `http://localhost:V/ 连不上(Vite 只绑 127.0.0.1),只测了 127.0.0.1:${String(e.message).split('\n')[0]}` });
              continue;
            }
            const ws = await pageWs(page, '/ws', 5000, true);
            expect.soft(ws.opened, `${tag} 经代理的 WS 应 open,实际 ${JSON.stringify(ws)}`).toBe(true);
            expect.soft(ws.messages, `${tag} 经代理的 WS 应至少收到一帧,实际 ${ws.messages} 帧`).toBeGreaterThanOrEqual(1);
            const bad = await pageFetch(page, '/api/login', loginInit(WRONG_PASSWORD), { keepText: true });
            expect.soft(bad.status, `${tag} 错误密码经代理的 POST:期望 401(进了处理器),实际 ${bad.status} ${bad.text}${bad.error ? ` ${bad.error}` : ''}`).toBe(401);
            expect.soft((bad.text ?? '').trim(), `${tag} 错误密码正文`).toBe('{"error":"密码错误"}');
            const ok = await pageFetch(page, '/api/login', loginInit(PASSWORD), { keepText: true });
            expect.soft(ok.status, `${tag} 正确密码经代理的 POST:期望 200,实际 ${ok.status} ${ok.text}${ok.error ? ` ${ok.error}` : ''}`).toBe(200);
            expect.soft((ok.text ?? '').trim(), `${tag} 正确密码正文`).toBe('{"ok":true}');
          }
        });
      } finally {
        expect.soft(await vite.close(), `${id} Vite 端口应已释放`).toBe(true);
      }
    });
  });
}
for (const e of ['chromium', 'webkit']) viteTest('O20', e);

// ───────────────────────── O21 真实局域网 IP(chromium)─────────────────────────
test('O21 真实局域网 IP(chromium):本站登录后 WS 放行;同 IP 另一端口的页面带着登录 cookie 也连不上', async () => {
  test.skip(!LAN_IP, '本机没有名字以 en 开头的非内部 IPv4 地址,无法做局域网用例(O21)');
  test.setTimeout(180_000);
  // 已获用户同意:实例与静态服务在用例期间短暂绑 0.0.0.0(实例有已知随机密码);finally 里杀掉并核对端口释放
  await withInstance({ label: 'o21', bindAll: true }, async (i) => {
    const stat = await startStatic({ host: '0.0.0.0' });
    try {
      await withBrowser('chromium', async (browser) => {
        const ctx = await browser.newContext();
        // ① 本站:登录(浏览器随之存 cookie)→ WS → 写探针
        const own = await ctx.newPage();
        await own.goto(`http://${LAN_IP}:${i.port}/api/health`);
        const lg = await pageFetch(own, '/api/login', loginInit(PASSWORD), { keepText: true });
        expect.soft(lg.status, `O21① 局域网本站登录:期望 200,实际 ${lg.status}${lg.error ? ` ${lg.error}` : ''}`).toBe(200);
        expect.soft((lg.text ?? '').trim(), 'O21① 登录正文').toBe('{"ok":true}');
        const ws = await pageWs(own, '/ws', 5000, true);
        expect.soft(ws.opened, `O21① 局域网本站 WS 应 open,实际 ${JSON.stringify(ws)}`).toBe(true);
        expect.soft(ws.messages, `O21① 局域网本站 WS 应至少收到一帧,实际 ${ws.messages} 帧`).toBeGreaterThanOrEqual(1);
        const wr = await pageFetch(own, '/api/login', loginInit(PASSWORD), { keepText: true });
        expect.soft(wr.status, `O21① 写探针:期望 200,实际 ${wr.status}`).toBe(200);
        const cookies = await ctx.cookies(`http://${LAN_IP}:${i.port}`);
        expect(cookies.some((c) => c.name === 'cgui_token'), '前置:浏览器应已存下该主机的 cgui_token cookie(②才有意义)').toBe(true);
        // ② 同 IP 另一端口的页面(cookie 不分端口,握手会带上它)
        const pageOrigin = `http://${LAN_IP}:${stat.port}`;
        const off = logSize(i);
        const atk = await ctx.newPage();
        await atk.goto(`${pageOrigin}/`);
        const ws2 = await pageWs(atk, `ws://${LAN_IP}:${i.port}/ws`, 3000, false);
        expect.soft(ws2.opened, `O21② 他端口页面的 WS 不应 open,实际 ${JSON.stringify(ws2)}`).toBe(false);
        expect.soft(ws2.messages, `O21② 他端口页面的 WS 不应收到任何帧,实际 ${ws2.messages} 帧`).toBe(0);
        const wsLine = `[ws] blocked origin="${pageOrigin}"`;
        const log = await waitLogSince(i, off, (t) => t.includes(wsLine), 2000);
        expect.soft(log.includes(wsLine), `O21② 日志增量应含 ${wsLine}`).toBe(true);
      });
    } finally {
      expect.soft(await stat.close(), 'O21 绑 0.0.0.0 的静态服务端口应已释放').toBe(true);
    }
  });
});
