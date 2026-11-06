// C 组:应用自己的预览不受影响(同源页面;每个用例末尾断言服务日志里没有任何 [cors] blocked 行)。修复前后都绿。
// C-chromium / C-webkit:同源 img、fetch→blob→img、audio/video;C-pdf-chromium:PDF iframe 出现查看器;C-vite-*:Vite 开发代理形态。
import { test, expect } from '@playwright/test';
import { withInstance, logSince, blockedLines } from './helpers/world.mjs';
import { SVG_PLAIN, PNG, MP4, WEBM, makeWav, makePdf, writeFixture, dl, rawPath } from './helpers/fixtures.mjs';
import { launchEngine, startVite, pageImg, pageBlobImg, pageMedia, pageIframe, waitPdfViewerFrame } from './helpers/browser.mjs';

function writeAll(inst) {
  const w = (name, buf) => writeFixture(inst.home, dl(name), buf);
  return {
    svg: w('plain.svg', Buffer.from(SVG_PLAIN, 'utf8')), png: w('a.png', PNG), wav: w('a.wav', makeWav()),
    mp4: w('a.mp4', MP4), webm: w('a.webm', WEBM), pdf: w('a.pdf', makePdf()),
  };
}
const noBlockedLog = (inst, label) => expect.soft(blockedLines(logSince(inst, 0)), `${label}:服务日志里不得有任何 [cors] blocked 行`).toEqual([]);

/** 在已打开目标源文档的 page 里,用 prefix(与页面同源的 http://主机:端口)发图片/blob/音频(可选视频)请求并断言。 */
async function previewChecks(page, prefix, f, label, { video }) {
  const url = (abs) => `${prefix}${rawPath(abs)}`;
  const svgImg = await pageImg(page, url(f.svg));
  expect.soft(svgImg.w, `${label} <img> 无脚本 SVG:naturalWidth 应大于 0(${JSON.stringify(svgImg)})`).toBeGreaterThan(0);
  const pngImg = await pageImg(page, url(f.png));
  expect.soft(pngImg.w, `${label} <img> PNG:naturalWidth 应大于 0(${JSON.stringify(pngImg)})`).toBeGreaterThan(0);
  const blobImg = await pageBlobImg(page, url(f.png));
  expect.soft(blobImg.status, `${label} fetch PNG:状态码`).toBe(200);
  expect.soft(blobImg.w, `${label} fetch→blob→createObjectURL→<img>:naturalWidth 应大于 0(${JSON.stringify(blobImg)})`).toBeGreaterThan(0);
  const items = [['<audio> WAV', 'audio', f.wav]];
  if (video) items.push(['<video> MP4', 'video', f.mp4], ['<video> WebM', 'video', f.webm]);
  for (const [name, kind, abs] of items) {
    const m = await pageMedia(page, kind, url(abs));
    expect.soft(m.ok, `${label} ${name}:loadedmetadata 应触发(${JSON.stringify(m)})`).toBe(true);
    expect.soft(m.duration, `${label} ${name}:duration 应大于 0`).toBeGreaterThan(0);
  }
}

for (const engine of ['chromium', 'webkit']) {
  test(`C-${engine} 应用自己的同源预览(img / fetch→blob / audio / video)不受影响,日志无拒绝行`, async () => {
    await withInstance({ label: `c-${engine}` }, async (inst) => {
      const f = writeAll(inst);
      const browser = await launchEngine(engine);
      try {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${inst.base}/api/health`);
        await previewChecks(page, inst.base, f, `C-${engine}`, { video: true });
        await ctx.close();
      } finally {
        await browser.close();
      }
      noBlockedLog(inst, `C-${engine}`);
    });
  });
}

test('C-pdf-chromium PDF iframe(不带 sandbox)在完整版 Chromium 里出现 PDF 查看器,日志无拒绝行', async () => {
  await withInstance({ label: 'c-pdf' }, async (inst) => {
    const f = writeAll(inst);
    const browser = await launchEngine('chromium');
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${inst.base}/api/health`);
      const r = await pageIframe(page, `${inst.base}${rawPath(f.pdf)}`);
      expect.soft(r.loaded, 'C-pdf-chromium:iframe 的 load 事件应触发').toBe(true);
      expect.soft(await waitPdfViewerFrame(page), 'C-pdf-chromium:page.frames() 里应出现 chrome-extension:// 开头的框架(PDF 查看器)').toBe(true);
      await ctx.close();
    } finally {
      await browser.close();
    }
    noBlockedLog(inst, 'C-pdf-chromium');
  });
});

for (const engine of ['chromium', 'webkit']) {
  test(`C-vite-${engine} Vite 开发代理形态下预览(img / fetch→blob / audio${engine === 'chromium' ? ' / PDF iframe' : ''})不受影响,日志无拒绝行`, async () => {
    await withInstance({ label: `c-vite-${engine}` }, async (inst) => {
      const f = writeAll(inst);
      const vite = await startVite(inst.port);
      const browser = await launchEngine(engine);
      try {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${vite.base}/api/health`); // 经 Vite 代理到后端的同源 JSON 文档
        await previewChecks(page, vite.base, f, `C-vite-${engine}`, { video: false });
        if (engine === 'chromium') {
          const r = await pageIframe(page, `${vite.base}${rawPath(f.pdf)}`);
          expect.soft(r.loaded, 'C-vite-chromium:PDF iframe 的 load 事件应触发').toBe(true);
          expect.soft(await waitPdfViewerFrame(page), 'C-vite-chromium:应出现 chrome-extension:// 开头的 PDF 查看器框架').toBe(true);
        }
        await ctx.close();
      } finally {
        await browser.close();
        await vite.close();
      }
      noBlockedLog(inst, `C-vite-${engine}`);
    });
  });
}
