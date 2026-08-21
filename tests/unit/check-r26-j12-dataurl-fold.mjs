#!/usr/bin/env node
// r26-J12【单测】:chat 协议取图的 data-URL 正则必须吃折行 base64。
// 修前:正则 data 段 [A-Za-z0-9+/]+={0,2} 不含 \s —— 上游把 base64 折行(PEM 风格)
// 输出时整条漏识别,取不到图。
// 哨兵:①带 \n 折行的 data-URL → 识别且解码字节与未折行版逐字相等(等价哨兵);
// ②空格/制表符/\r\n 混合空白同吃;③未折行形态回归不变;④空白剥净(产物无 \s)。
// Run: node tests/unit/check-r26-j12-dataurl-fold.mjs
import assert from 'node:assert/strict';
import { extractImage } from '../../server/utils/image-protocols.js';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

// 1×1 PNG 的 base64,手工切成 4 段模拟折行
const FLAT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FOLDED = [FLAT.slice(0, 24), FLAT.slice(24, 48), FLAT.slice(48, 72), FLAT.slice(72)].join('\n');
const chat = (content) => extractImage('chat', { choices: [{ message: { content } }] });

// ① 折行识别 + 解码等价
{
  const r = chat(`给你：\n![](data:image/png;base64,${FOLDED})`);
  assert.equal(r?.mime, 'image/png', 'J12: 折行 data-URL 必须识别');
  assert.equal(r?.base64, FLAT, 'J12: 剥空白后与未折行版逐字相等');
  assert.deepEqual(Buffer.from(r.base64, 'base64'), Buffer.from(FLAT, 'base64'),
    'J12: 解码字节等价(等价哨兵)');
  n += 3;
}
// ② 空格 / 制表符 / \r\n 混合空白
{
  const mixed = `${FLAT.slice(0, 30)}\r\n${FLAT.slice(30, 60)} ${FLAT.slice(60, 90)}\t${FLAT.slice(90)}`;
  const r = chat(`data:image/webp;base64,${mixed}`);
  assert.equal(r?.base64, FLAT, 'J12: \\r\\n/空格/制表符混合空白同吃');
  assert.equal(r?.mime, 'image/webp');
  n += 2;
}
// ③ 未折行形态回归不变
{
  const r = chat(`![](data:image/png;base64,${FLAT})`);
  assert.equal(r?.base64, FLAT, 'J12: 未折行形态回归');
  n += 1;
}
// ④ 产物无残留空白(剥净哨兵)
{
  const r = chat(`data:image/png;base64,${FOLDED}`);
  assert.ok(!/\s/.test(r.base64), 'J12: 产物不得残留空白');
  n += 1;
}

console.log(`PASS check-r26-j12-dataurl-fold (${n} assertions)`);
