#!/usr/bin/env node
// r132 · 工具结果图片提取(客户端纯函数层 client/src/utils/toolResult.js)。
// 契约:字符串里夹带的图片载荷(data URL / JSON 内嵌 base64)要抽成 images 并从正文摘掉;
// **不含载荷的字符串一字不改**。服务端同口径由 check-r116-tool-result-shape.mjs 的 U9–U11 守。
// Run: node tests/unit/check-r132-tool-result-images.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  extractToolResultText, extractToolResultImages, splitImagePayloadsInString, sniffMimeFromB64,
} from '../../client/src/utils/toolResult.js';

let n = 0;
const ok = (c, msg) => { n += 1; assert.ok(c, msg); };
const eq = (a, b, msg) => { n += 1; assert.deepEqual(a, b, msg); };

const BIG = randomBytes(2000).toString('base64');        // ≥512:算载荷
const SMALL = randomBytes(100).toString('base64');       // <512:不算

// ── 1. data URL 形态 ────────────────────────────────────────────────
{
  const r = splitImagePayloadsInString(`截图已保存:/private/tmp/shot.png\ndata:image/png;base64,${BIG}\n(完)`);
  eq(r.images, [{ mime: 'image/png', data: BIG }], 'data URL → 一张图,mime 取下 URL 里的');
  ok(r.rest.includes('截图已保存') && r.rest.includes('(完)'), `散文要留着,实得 ${JSON.stringify(r.rest)}`);
  ok(!r.rest.includes(BIG), '正文里不许再出现 base64');
  ok(!r.rest.includes('data:image'), '不留孤儿 data URL 前缀');
}

// ── 2. JSON 内嵌(file.base64 —— 实测抓到的真实形态)──────────────────
{
  const r = splitImagePayloadsInString(JSON.stringify({ type: 'image', file: { base64: BIG }, dimensions: { originalWidth: 10 }, file_path: '/private/tmp/a.png' }));
  eq(r.images.map((i) => i.mime), ['image/png'], 'file.base64 认成图(mime 按 magic bytes)');
  eq(r.images[0].data, BIG, '载荷逐字一致');
  eq(r.rest, '', 'JSON 脚手架不留文字');
}

// ── 3. Anthropic source.data + media_type ───────────────────────────
{
  const r = splitImagePayloadsInString(JSON.stringify({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BIG } }));
  eq(r.images, [{ mime: 'image/jpeg', data: BIG }], 'media_type 优先');
}

// ── 4. 双层转义(工具把 JSON 又序列化了一次)────────────────────────
{
  const one = JSON.stringify({ type: 'image', file: { base64: BIG } });
  const doubled = one.replace(/"/g, '\\"');
  eq(splitImagePayloadsInString(doubled).images.length, 1, '双层转义也认');
}

// ── 5. MCP 形态 {mimeType,data} 写在 JSON 文本里 ────────────────────
{
  const r = splitImagePayloadsInString(JSON.stringify({ type: 'image', mimeType: 'image/webp', data: BIG }));
  eq(r.images, [{ mime: 'image/webp', data: BIG }], 'mimeType 生效');
}

// ── 6. 文本块里夹带载荷(数组形态)──────────────────────────────────
{
  const content = [{ type: 'text', text: `图在这:\ndata:image/png;base64,${BIG}` }];
  eq(extractToolResultImages(content).length, 1, '数组里的文本块也要能出图');
  ok(!extractToolResultText(content).includes(BIG), '文本块里的载荷同样摘掉');
  eq(extractToolResultImages([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG } }]).length, 1, '原有 image 块形态不受影响');
}

// ── 7. 反向:纯文本长字符串一字不改、不长出 images ─────────────────
{
  const plain = '这是普通输出:提到 image/png 与 base64 两个字,但没有任何载荷。'.repeat(20);
  const r = splitImagePayloadsInString(plain);
  eq(r.images, [], '没有载荷 → 不出图');
  eq(r.rest, plain, '纯文本逐字不变');
  eq(extractToolResultText(plain), plain, 'extractToolResultText 逐字不变');
  eq(extractToolResultImages(plain), [], 'extractToolResultImages 为空');
}

// ── 8. 反向:短串 / 短 base64 不当图 ────────────────────────────────
{
  const shortStr = `data:image/png;base64,${SMALL}`;
  eq(splitImagePayloadsInString(shortStr).images, [], '短于阈值不认(避免把示例串当真图)');
  eq(splitImagePayloadsInString(shortStr).rest, shortStr, '短串逐字不变');
  const jsonSmall = JSON.stringify({ type: 'image', file: { base64: SMALL } });
  eq(splitImagePayloadsInString(jsonSmall).images, [], 'JSON 里的短 base64 也不认');
}

// ── 9. 非字符串 / 空值不炸 ─────────────────────────────────────────
{
  eq(extractToolResultImages(null), [], 'null → []');
  eq(extractToolResultImages({ type: 'image', source: { data: BIG } }), [{ mime: 'image/png', data: BIG }], '单个对象形态也收');
  eq(extractToolResultText(null), '', 'null → 空串');
  eq(sniffMimeFromB64('iVBORw0KGgoAAA'), 'image/png', 'magic bytes:PNG');
  eq(sniffMimeFromB64('/9j/4AAQ'), 'image/jpeg', 'magic bytes:JPEG');
  eq(sniffMimeFromB64('不是base64'), null, '认不出 → null');
}

console.log(`check-r132-tool-result-images: PASS(${n} 条断言)`);
