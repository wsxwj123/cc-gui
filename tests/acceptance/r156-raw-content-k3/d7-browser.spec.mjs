// D7:真浏览器里他站网页的 no-cors 请求被后端拒绝(日志 rule=no-origin-sfs-veto),同源对照不受影响。修复前红。
// 他端口页 http://127.0.0.1:Q/(浏览器自报 same-site)与跨站别名页 http://localhost:Q/(自报 cross-site),各发 img / fetch(no-cors) / iframe / audio 四种请求。
import { test, expect } from '@playwright/test';
import { withInstance, waitLogSince } from './helpers/world.mjs';
import { PNG, writeFixture, dl } from './helpers/fixtures.mjs';
import { launchEngine, startStatic, fireCrossSite, pageImg, pageFetchStatus } from './helpers/browser.mjs';

const KINDS = ['img', 'fetch', 'iframe', 'audio'];
const PAGES = [['p127', '127.0.0.1', 'same-site'], ['plh', 'localhost', 'cross-site']];
/** 日志整行:origin=null,path 里带 probe=<标签>,sfs 为浏览器自报值,rule=no-origin-sfs-veto。 */
const lineRe = (label, sfs) => new RegExp(`^\\[cors\\] blocked origin=null host="[^"]*" path="[^"]*probe=${label}(?:&[^"]*)?" sfs="${sfs}" rule=no-origin-sfs-veto( |$)`);

for (const engine of ['chromium', 'webkit']) {
  test(`D7-${engine} 他站网页的 img / fetch(no-cors) / iframe / audio 都被后端拒绝,同源页面的 img 与 fetch 不受影响`, async () => {
    await withInstance({ label: `d7-${engine}` }, async (inst) => {
      const png = writeFixture(inst.home, dl('a.png'), PNG);
      // 主会话修订(r156):拒绝日志里 path 字段会被截到 200 字符(与 r155 的拒绝日志同一口径);工作树路径一长,
      // 放在 URL 末尾的 probe 标记就被截没。所以标记放在查询串最前面,不管路径多长都留得住。
      const probeUrl = (label) => `${inst.base}/api/files/read?probe=${label}&raw=1&path=${encodeURIComponent(png)}`;
      const stat = await startStatic();
      const browser = await launchEngine(engine);
      const fired = {};
      let ctl;
      try {
        for (const [tag, host] of PAGES) {
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await page.goto(`http://${host}:${stat.port}/`);
          const u = (kind) => probeUrl(`${tag}-${kind}`);
          fired[tag] = await fireCrossSite(page, { img: u('img'), fetch: u('fetch'), iframe: u('iframe'), audio: u('audio') });
          await ctx.close();
        }
        const ctx = await browser.newContext(); // 同源对照
        const page = await ctx.newPage();
        await page.goto(`${inst.base}/api/health`);
        ctl = {
          img: await pageImg(page, probeUrl('ctl-img')),
          fetch: await pageFetchStatus(page, probeUrl('ctl-fetch')),
        };
        await ctx.close();
      } finally {
        await browser.close();
        await stat.close();
      }

      const wanted = PAGES.flatMap(([tag, , sfs]) => KINDS.map((k) => [`${tag}-${k}`, sfs]));
      const hasAll = (t) => { const ls = t.split('\n'); return wanted.every(([label, sfs]) => ls.some((l) => lineRe(label, sfs).test(l))); };
      const log = await waitLogSince(inst, 0, hasAll, 3000);
      const lines = log.split('\n');
      for (const [label, sfs] of wanted) {
        expect.soft(lines.some((l) => lineRe(label, sfs).test(l)), `D7-${engine} ${label}:日志里应至少有一行 origin=null、sfs="${sfs}"、rule=no-origin-sfs-veto 的拒绝行`).toBe(true);
      }
      for (const [tag] of PAGES) expect.soft(fired[tag]?.imgError, `D7-${engine} ${tag}-img:<img> 的 onerror 应触发(imgLoad=${fired[tag]?.imgLoad})`).toBe(true);

      expect.soft(ctl.img.w, `D7-${engine} 同源对照 <img>:应加载成功(${JSON.stringify(ctl.img)})`).toBeGreaterThan(0);
      expect.soft(ctl.fetch.status, `D7-${engine} 同源对照 fetch:应 200(${JSON.stringify(ctl.fetch)})`).toBe(200);
      const ctlVeto = lines.filter((l) => /probe=ctl-(img|fetch)(?:&[^"]*)?"/.test(l) && l.includes('no-origin-sfs-veto'));
      expect.soft(ctlVeto, `D7-${engine} 同源对照的两个标签在日志里不得有 no-origin-sfs-veto 行`).toEqual([]);
    });
  });
}
