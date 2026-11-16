// r193 用例共用的页面操作、造图、读收信日志、读应答的小工具(只用页面可见的东西与对外接口,不碰实现内部)。
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { expect } from '@playwright/test';
import { readReceived, readStatus } from './fixtures.mjs';
import { composerBox, stopBtn } from './runtime.mjs';

// ───────────────────────── 造 PNG(随机像素,压不小) ─────────────────────────
function crc32(buf) { let crc = 0xFFFFFFFF; for (const b of buf) { crc ^= b; for (let k = 0; k < 8; k += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
/** 随机像素 PNG。level 0 = 不压缩(大图用,省时间;仍是合法 PNG)。 */
export function png(w, h, level = 6) {
  const row = w * 3 + 1; const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y += 1) { raw[y * row] = 0; crypto.randomFillSync(raw, y * row + 1, w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const b64Len = (buf) => Math.ceil(buf.length / 3) * 4;
const image = (name, buf) => ({ name, buf, mimeType: 'image/png', sha: sha256(buf), b64Len: b64Len(buf) });
export const smallImage = (name) => image(name, png(16, 16)); // 约 850 字节(20KB 以内)
export const bigImage = (name) => image(name, png(400, 300)); // 约 360KB(300KB 以上)
export const hugeImage = (name, mb) => (mb === 15 ? image(name, png(2300, 2200, 0)) : image(name, png(2700, 2600, 0))); // 约 15MB / 21MB
/** 文件头完好(前 64 字节)、后面全是随机字节的「损坏 PNG」。 */
export function damagedImage(name) {
  const good = png(100, 100);
  const buf = Buffer.concat([good.subarray(0, 64), crypto.randomBytes(good.length - 64)]);
  return image(name, buf);
}
/** 非图片的文档类附件(.txt)。 */
export function textFile(name) { return { name, buf: Buffer.from(`r193 文本附件 ${'x'.repeat(2400)}`), mimeType: 'text/plain' }; }
/** .heic:内容随便,但要够 1KB,卡片上才会写「KB」而不是「B」。 */
export function heicFile(name) { return { name, buf: crypto.randomBytes(3000), mimeType: 'image/heic' }; }

// ───────────────────────── 页面元素 ─────────────────────────
export const queueLoc = (page) => page.locator('[data-testid="queue-item"]');
// 输入框上方的附件卡片(排除待发列表里的条目内部可能出现的同名锚点)。
export const cardsLoc = (page) => page.locator('[data-testid="attachment-item"]:not([data-testid="queue-item"] [data-testid="attachment-item"])');

/** 递归收集 JSON 里所有叫 path 的字符串字段(上传应答的完整路径)。 */
function findPaths(o, acc = []) {
  if (Array.isArray(o)) o.forEach((x) => findPaths(x, acc));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) { if (k === 'path' && typeof v === 'string') acc.push(v); else findPaths(v, acc); }
  }
  return acc;
}
const isUpload = (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/upload';

/**
 * 往输入框添加一批文件。返回 { collect }:调用方等 UI 上传完成之后调用 collect(),得到
 * 添加期间所有 POST /api/upload 应答里的完整路径(按应答先后)。不在这里等上传完成。
 */
async function setFiles(page, files) {
  const bodies = [];
  const onResp = (r) => { if (isUpload(r)) bodies.push(r.json().catch(() => null)); };
  page.on('response', onResp);
  await page.locator('[data-cgui="composer"] input[type=file], [data-cgui="home"] input[type=file]').first().setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buf })));
  return {
    /** 等到至少收到 n 个上传应答(应答已到 = 后端已存好文件)。 */
    waitUploaded: async (n, timeout = 60_000) => {
      const end = Date.now() + timeout;
      while (bodies.length < n) {
        if (Date.now() > end) throw new Error(`${timeout}ms 内只收到 ${bodies.length} 个 /api/upload 应答(需要 ${n} 个)`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    collect: async () => {
      page.off('response', onResp);
      const paths = [];
      for (const j of await Promise.all(bodies)) paths.push(...findPaths(j));
      return paths;
    },
  };
}

/** 这张图自己的卡片里出现了加载成功的图片。 */
function cardImageLoaded(page, names) {
  return page.evaluate((nms) => Array.from(document.querySelectorAll('[data-testid="attachment-item"]'))
    .filter((c) => !c.closest('[data-testid="queue-item"]'))
    .filter((c) => { const img = c.querySelector('img'); return Boolean(img) && nms.includes(img.alt) && img.complete && img.naturalWidth > 0; }).length, names);
}

/**
 * 往输入框添加一张图片,等附件卡片数变成 expectCards,再等这张图上传完成(卡片里出现加载成功的图片)。
 * 返回上传后文件的完整路径(读 POST /api/upload 的应答)。
 */
export async function addImage(page, img, expectCards) {
  const { collect } = await setFiles(page, [img]);
  await expect(cardsLoc(page), `添加 ${img.name} 后附件卡片数应为 ${expectCards}`).toHaveCount(expectCards, { timeout: 30_000 });
  await expect.poll(() => cardImageLoaded(page, [img.name]), { message: `${img.name} 应上传完成(它的卡片里出现加载成功的图片)`, timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  const paths = await collect();
  expect(paths.length, `添加 ${img.name} 时应读到 /api/upload 应答里的 path`).toBe(1);
  return paths[0];
}

/** 一次添加多张图片(21 张用),等卡片数与加载成功的图片数都到位。返回各应答里的路径。 */
export async function addImages(page, imgs, expectStart = 0) {
  const { collect } = await setFiles(page, imgs);
  await expect(cardsLoc(page), `添加 ${imgs.length} 张后附件卡片数应为 ${expectStart + imgs.length}`).toHaveCount(expectStart + imgs.length, { timeout: 60_000 });
  await expect.poll(() => cardImageLoaded(page, imgs.map((i) => i.name)), { message: `${imgs.length} 张图都应上传完成`, timeout: 90_000 }).toBe(imgs.length);
  return collect();
}

/** 添加一个文档类 / .heic 附件(卡片上没有图片):等卡片数到位、且卡片文字里出现文件名与大小(KB)。返回完整路径。 */
export async function addFile(page, file, expectCards, { expectKB = true } = {}) {
  const { collect, waitUploaded } = await setFiles(page, [file]);
  await expect(cardsLoc(page), `添加 ${file.name} 后附件卡片数应为 ${expectCards}`).toHaveCount(expectCards, { timeout: 30_000 });
  await waitUploaded(1);
  if (expectKB) {
    await expect.poll(() => page.evaluate((name) => Array.from(document.querySelectorAll('[data-testid="attachment-item"]'))
      .filter((c) => !c.closest('[data-testid="queue-item"]'))
      .some((c) => { const t = c.innerText || ''; return t.includes(name) && /\d\s*KB/i.test(t); }), file.name),
    { message: `${file.name} 应上传完成(卡片文字里出现文件名与 KB)`, timeout: 60_000 }).toBe(true);
  } else {
    // 内容损坏的图片页面可能画不出预览、卡片上也未必有大小:以上传应答已到为准,再留一小会儿让界面把它标成「已上传」。
    await page.waitForTimeout(1_000);
  }
  const paths = await collect();
  expect(paths.length, `添加 ${file.name} 时应读到 /api/upload 应答里的 path`).toBe(1);
  return paths[0];
}

/**
 * 在输入框填 text 按回车,等 POST /api/chat(或 /api/chat/steer)的应答。
 * 返回 { status, raw(应答原文), json, reqBody(页面发出的请求体) }。
 */
export async function sendAndGetResponse(page, text, endpoint = '/api/chat') {
  const box = composerBox(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.focus();
  const respP = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === endpoint, { timeout: 60_000 });
  await box.press('Enter');
  const resp = await respP;
  const raw = await resp.text();
  let json = null; try { json = JSON.parse(raw); } catch { /* 留 null */ }
  let reqBody = null; try { reqBody = resp.request().postDataJSON(); } catch { /* 留 null */ }
  return { status: resp.status(), raw, json, reqBody };
}

// ───────────────────────── 假命令行收信日志 ─────────────────────────
/** 日志一行的文字:字符串取全文;数组取所有文字块拼接。 */
export function entryText(e) {
  if (e.kind === 'string') return e.text;
  if (e.kind === 'array') return (e.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return '';
}
export const imageBlocks = (e) => (e.kind === 'array' ? (e.blocks || []).filter((b) => b.type === 'image') : []);
export const textBlocks = (e) => (e.kind === 'array' ? (e.blocks || []).filter((b) => b.type === 'text') : []);

/** 等收信日志里「文字含 marker」的条数达到 atLeast,返回这些条目(按收到顺序)。 */
export async function waitReceived(page, ctx, marker, { atLeast = 1, timeout = 30_000 } = {}) {
  const end = Date.now() + timeout;
  let hits = [];
  for (;;) {
    hits = readReceived(ctx.workspaceName).filter((e) => entryText(e).includes(marker));
    if (hits.length >= atLeast) return hits;
    if (Date.now() > end) throw new Error(`${timeout}ms 内假命令行收信日志里「含 ${marker}」的消息只有 ${hits.length} 条(需要 ${atLeast} 条);日志全文 = ${JSON.stringify(readReceived(ctx.workspaceName).map((e) => ({ kind: e.kind, steer: e.steer, text: entryText(e).slice(0, 80), images: imageBlocks(e).length })))}`);
    await page.waitForTimeout(100);
  }
}

/** 「文字 + 空行 + 附件: + 每行一个 @路径」(改动前发给命令行的文字)。 */
export const expectedText = (T, paths) => `${T}\n\n附件:\n${paths.map((p) => `@${p}`).join('\n')}`;

/** 等假命令行把已收到的这一轮演完(收信日志里 marker 已出现、状态 ended),再等页面上停止键消失。 */
export async function finishTurn(page, ctx, marker) {
  await waitReceived(page, ctx, marker, { timeout: 45_000 });
  await expect.poll(() => { const st = readStatus(ctx.workspaceName); return Boolean(st && st.ended); }, { message: `这一轮(含 ${marker})应在 40 秒内演完`, timeout: 40_000 }).toBe(true);
  await expect(stopBtn(page), '这一轮结束后停止键应消失').toBeHidden({ timeout: 40_000 });
}

// ───────────────────────── 页面提示 ─────────────────────────
const normPunct = (s) => String(s).replace(/：/g, ':').replace(/（/g, '(').replace(/）/g, ')').replace(/，/g, ',').replace(/\s+/g, '');
export const HINT_KEY = '没能带上';
/** 页面整体文字(规整标点与空白后)里是否含 expected。 */
export async function pageHasHint(page, expected) {
  const t = await page.locator('body').innerText();
  return normPunct(t).includes(normPunct(expected));
}
export const hintTemplate = (n, reasons) => `有 ${n} 张图没能带上:${reasons.join('、')}。消息已照常发出。`;
export const REASON = {
  missing: '文件已不在(上传的图 7 天后会被清理),请重新添加',
  tooLarge: '太大(单张或一条消息合计超过 20MB)',
  tooMany: '一条消息最多带 20 张',
  unsupported: '格式不支持(可用 png、jpg、gif、webp)',
  damaged: '文件已损坏',
};
/** 等页面出现完整提示句。 */
export async function expectHint(page, expected, what) {
  await expect.poll(() => pageHasHint(page, expected), { message: `${what}:页面应出现提示「${expected}」`, timeout: 20_000 }).toBe(true);
}
/** 发出消息之后连续观察 durationMs,页面任何一次出现「没能带上」都算有。返回是否出现过。 */
export async function hintEverShown(page, durationMs = 2_000) {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    if (await pageHasHint(page, HINT_KEY)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

// ───────────────────────── 对话区读数 ─────────────────────────
/** 读对话里文字含 T 的第一条用户消息卡:是否存在、气泡文字长度、里面各图片(alt、是否加载成功)。 */
export function readUserCard(page, T) {
  return page.evaluate((t) => {
    const cards = Array.from(document.querySelectorAll('[data-cgui="message-list"] [data-cgui="message-user"]')).filter((c) => (c.innerText || '').includes(t));
    if (!cards.length) return { cards: 0, imgs: [], textLen: 0, b64Like: false };
    const c = cards[0];
    const bubble = c.querySelector('.chat-user-bubble') || c;
    const text = bubble.innerText || '';
    return {
      cards: cards.length,
      imgs: Array.from(c.querySelectorAll('img')).map((i) => ({ alt: i.getAttribute('alt'), loaded: i.complete && i.naturalWidth > 0 })),
      textLen: text.length,
      b64Like: /[A-Za-z0-9+/]{200,}/.test(text),
    };
  }, T);
}

/** 通过页面同源发请求(经页面所在的 Vite 代理到隔离后端,与应用自己的请求同路)。 */
export function apiFetch(page, method, url, body) {
  return page.evaluate(async ({ m, u, b }) => {
    const r = await fetch(u, { method: m, headers: b === undefined ? {} : { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 留 null */ }
    return { status: r.status, text, json };
  }, { m: method, u: url, b: body });
}
