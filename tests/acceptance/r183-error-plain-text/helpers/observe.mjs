// r183 套件的探针服务与页面观测。铁规:只听 127.0.0.1;只通过页面可见内容(消息区文字 / 元素 / data-cgui 挂点)观测。
import http from 'node:http';
import { expect } from '@playwright/test';
import { readList } from './runtime.mjs';

// 1×1 透明 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PORT_MIN = 6860;
const PORT_MAX = 6899;

/** 探针:在 6860–6899 里挑一个空闲端口,只听 127.0.0.1,记录每个请求(方法 + 路径),对任何请求回一张 1×1 PNG。 */
export async function startProbe() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length, 'access-control-allow-origin': '*' });
    res.end(PNG);
  });
  for (let port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1)), tries = 0; tries <= PORT_MAX - PORT_MIN; tries += 1) {
    const p = PORT_MIN + ((port - PORT_MIN + tries) % (PORT_MAX - PORT_MIN + 1));
    const ok = await new Promise((resolve) => {
      const onErr = () => resolve(false);
      server.once('error', onErr);
      server.listen(p, '127.0.0.1', () => { server.off('error', onErr); resolve(true); });
    });
    if (ok) {
      return { host: `127.0.0.1:${p}`, hits, close: () => new Promise((resolve) => server.close(() => resolve())) };
    }
  }
  throw new Error(`探针找不到 ${PORT_MIN}–${PORT_MAX} 里的空闲端口`);
}

/** 页面只允许访问回环地址:任何别的主机的请求直接掐掉(链接即使被页面预取也出不了本机)。 */
export async function blockNonLoopback(page) {
  await page.route('**/*', (route) => {
    let host = '';
    try { host = new URL(route.request().url()).hostname; } catch { /* 忽略 */ }
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host === '') return route.fallback();
    return route.abort('blockedbyclient');
  });
}

/** 消息区里的元素快照(全部在 [data-cgui="message-list"] 范围内取)。 */
export async function snapshotList(page, probeHost) {
  return await page.evaluate((host) => {
    const ml = document.querySelector('[data-cgui="message-list"]');
    if (!ml) return { hasList: false };
    const norm = (s) => (s || '').trim();
    const imgs = [...ml.querySelectorAll('img')].map((i) => i.getAttribute('src') || '');
    const links = [...ml.querySelectorAll('a, [role="link"]')].map((a) => ({ text: norm(a.textContent), href: a.getAttribute('href') || '' }));
    return {
      hasList: true,
      text: ml.innerText,
      probeImgs: imgs.filter((s) => s.includes(host)),
      allImgs: imgs,
      links,
      fakeLinks: links.filter((l) => l.text === '点这里充值'),
      strongTexts: [...ml.querySelectorAll('strong')].map((e) => norm(e.textContent)),
      h1Texts: [...ml.querySelectorAll('h1')].map((e) => norm(e.textContent)),
      tableCount: ml.querySelectorAll('table').length,
      errorTexts: [...document.querySelectorAll('[data-cgui="error-text"]')].map((e) => ({ inList: ml.contains(e), text: e.innerText, strong: e.querySelectorAll('strong').length, h1: e.querySelectorAll('h1').length, table: e.querySelectorAll('table').length, img: e.querySelectorAll('img').length })),
    };
  }, probeHost);
}

/** 整页范围内文字恰为 label 的按钮个数(button / [role=button])。 */
export async function countButtons(page, label) {
  return await page.evaluate((l) => [...document.querySelectorAll('button, [role="button"]')].filter((b) => (b.textContent || '').trim() === l).length, label);
}

/**
 * 在页面里装一个粘性监视器:每 25 毫秒 + 每次 DOM 变动,查消息区里有没有指向探针的图片、文字恰为「点这里充值」的链接,
 * 一旦出现过就记下(之后即使消失也保留)。用于「回合进行中」也不能出现的断言。
 */
export async function startBadMonitor(page, probeHost) {
  await page.evaluate((host) => {
    const st = { img: 0, link: 0 };
    const tick = () => {
      const ml = document.querySelector('[data-cgui="message-list"]');
      if (!ml) return;
      if ([...ml.querySelectorAll('img')].some((i) => (i.getAttribute('src') || '').includes(host))) st.img += 1;
      if ([...ml.querySelectorAll('a, [role="link"]')].some((a) => (a.textContent || '').trim() === '点这里充值')) st.link += 1;
    };
    window.__r183bad = st;
    setInterval(tick, 25);
    new MutationObserver(tick).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, probeHost);
}
export async function readBadMonitor(page) { return await page.evaluate(() => window.__r183bad || { img: -1, link: -1 }); }

/**
 * 观察时机(接口文件):报错出现后先确认文字可见(needle 出现在消息区),再等 3 秒复查,然后才下结论。
 * 返回 3 秒之后的消息区快照。needle 15 秒内没出现 → 直接失败(报错根本没显示)。
 */
export async function observeAfterError(page, needle, probeHost, what) {
  await expect.poll(async () => (await readList(page)).includes(needle), {
    timeout: 20_000, message: `${what}:报错出现后消息区应可见「${needle}」(20 秒内没等到)`,
  }).toBe(true);
  await page.waitForTimeout(3_000);
  return await snapshotList(page, probeHost);
}

/** 原文逐字可见:snapshot.text 里包含 want 的每一个字符(整段子串)。 */
export function expectVerbatim(snap, want, what) {
  expect.soft(snap.text, `${what}:消息区可见文字应逐字包含 ${JSON.stringify(want)};实际消息区 = ${JSON.stringify(snap.text.slice(-400))}`).toContain(want);
}
