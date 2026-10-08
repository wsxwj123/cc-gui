#!/usr/bin/env node
// r145 F7:剥 BOM 的正则里直接写着不可见字符 U+FEFF(字节 EF BB BF)——编辑器格式化、复制粘贴、某些
// 工具链都会悄悄丢掉它,正则就变成 /^/,剥 BOM 成了空操作,而肉眼完全看不出来。修好后改成转义写法
// \uFEFF,行为不变。
// 为什么红只能来自源码断言:"字面字符"和"转义写法"在运行时是同一个正则,行为上无从区分 —— 所以
// ① 源码级:两个文件里不再含 EF BB BF 字节,对应位置是 \uFEFF 转义;② 行为级(修前修后都应绿,
// 守"行为不变"):readJsonGuarded 仍能读带 BOM 的合法 JSON,sanitizeSvg 仍剥掉开头 BOM。
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateHome, makeChecker } from './r145-helpers/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { home, cleanup } = isolateHome('f7');
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);
const FILES = ['server/utils/guarded-json.js', 'server/utils/skin-validate.js'];

const { check, finish } = makeChecker('check-r145-bom-regex-escaped');
let exitCode = 1;
try {
  console.log('F7 · 源码:不再含字面 U+FEFF,剥 BOM 处是 \\uFEFF 转义');
  for (const f of FILES) {
    await check(`${f}:无 EF BB BF 字节,且剥 BOM 的正则写成 /^\\uFEFF/`, () => {
      const buf = readFileSync(join(root, f));
      assert.equal(buf.indexOf(BOM_BYTES), -1, `${f} 里仍有字面 U+FEFF(第 ${buf.subarray(0, Math.max(0, buf.indexOf(BOM_BYTES))).toString('utf8').split('\n').length} 行)`);
      assert.match(buf.toString('utf8'), /\.replace\(\/\^\\uFEFF\/, ''\)/, `${f} 里找不到 .replace(/^\\uFEFF/, '')`);
    });
  }

  console.log('F7 · 行为不变');
  const { readJsonGuarded } = await import('../../server/utils/guarded-json.js');
  const { sanitizeSvg } = await import('../../server/utils/skin-validate.js');
  await check('readJsonGuarded:开头带 BOM 的合法 JSON 照常读出(不判损坏)', async () => {
    const p = join(home, 'bom.json');
    writeFileSync(p, Buffer.concat([BOM_BYTES, Buffer.from('{"a":1}')]));
    const r = await readJsonGuarded(p);
    assert.deepEqual([r.corrupt, r.value], [false, { a: 1 }]);
  });
  await check('sanitizeSvg:开头 BOM 被剥掉', () => {
    const r = sanitizeSvg('\uFEFF<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.svg.startsWith('<svg'), `svg 开头仍带 BOM:${JSON.stringify(r.svg.slice(0, 6))}`);
  });
  exitCode = finish();
} finally {
  cleanup();
}
process.exit(exitCode);
