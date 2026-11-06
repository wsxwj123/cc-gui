// B 组:浏览器里打开带脚本 SVG,脚本不得运行(Chromium 一个用例、WebKit 一个用例;不带 route 拦截)。
// 修复前红:四种打开方式下脚本都会运行(window.__state === 'ran')。
// 每个引擎里依次做四件事,每件事用全新的浏览器上下文。
import { test, expect } from '@playwright/test';
import { withInstance, sleep } from './helpers/world.mjs';
import { SVG_SCRIPT, writeFixture, dl, rawUrl } from './helpers/fixtures.mjs';
import { launchEngine, startStatic, pageIframe } from './helpers/browser.mjs';

// 只带出"有没有建起 __frames"的布尔值:页面脚本从 WS 帧里解出来的任何内容都不带出页面(不打印、不落盘)。
const snapshot = (page) => page.evaluate(() => ({ state: window.__state, framesDefined: window.__frames !== undefined, ct: document.contentType, origin: location.origin }));

for (const engine of ['chromium', 'webkit']) {
  test(`B-${engine} 带脚本 SVG:地址栏直开、他端口页跳转、跨站别名页跳转、同源 iframe 四种方式下脚本都不运行`, async () => {
    await withInstance({ label: `b-${engine}` }, async (inst) => {
      const svg = writeFixture(inst.home, dl('x.svg'), Buffer.from(SVG_SCRIPT, 'utf8'));
      const victim = rawUrl(inst.base, svg);
      const other = await startStatic();
      const browser = await launchEngine(engine);
      try {
        // 1. 地址栏式直接打开:脚本不运行,仍按图片文档显示,location.origin 是后端
        {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await page.goto(victim);
          await sleep(1500);
          const s = await snapshot(page);
          expect.soft(s.state, 'B-1 地址栏直开:window.__state 应为 undefined(脚本没运行)').toBeUndefined();
          expect.soft(s.ct, 'B-1 地址栏直开:document.contentType 应仍是 image/svg+xml').toBe('image/svg+xml');
          expect.soft(s.origin, 'B-1 地址栏直开:location.origin 应是后端').toBe(inst.base);
          await ctx.close();
        }
        // 2、3. 他端口页 / 跨站别名页里 location.href 跳到受害地址:脚本不运行,也没建起 __frames
        for (const [name, origin] of [
          ['B-2 他端口页(127.0.0.1:Q)跳转', `http://127.0.0.1:${other.port}/`],
          ['B-3 跨站别名页(localhost:Q)跳转', `http://localhost:${other.port}/`],
        ]) {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await page.goto(origin);
          await Promise.all([
            page.waitForURL((u) => u.origin === inst.base && u.pathname === '/api/files/read', { timeout: 15_000 }),
            page.evaluate((u) => { setTimeout(() => { location.href = u; }, 0); }, victim),
          ]);
          await sleep(1500);
          const s = await snapshot(page);
          expect.soft(s.state, `${name}:window.__state 应为 undefined(脚本没运行)`).toBeUndefined();
          expect.soft(s.framesDefined, `${name}:window.__frames 应为 undefined(脚本没跑过,没建起 __frames)`).toBe(false);
          await ctx.close();
        }
        // 4. 同源页面里建 iframe 指向受害地址:load 后 contentWindow.__state 不是 'ran'(访问被拒绝抛异常也算通过)
        {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await page.goto(`${inst.base}/api/health`);
          const f = await pageIframe(page, victim, '__state');
          expect.soft(f.loaded, 'B-4 同源 iframe:load 事件应触发').toBe(true);
          expect.soft(f.state, `B-4 同源 iframe:contentWindow.__state 不得是 'ran'(读取异常=${f.exc ?? '无'})`).not.toBe('ran');
          await ctx.close();
        }
      } finally {
        await browser.close();
        await other.close();
      }
    });
  });
}
