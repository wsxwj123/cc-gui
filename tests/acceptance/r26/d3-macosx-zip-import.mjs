#!/usr/bin/env node
// r26-D3【复现+边界】:Finder 压的 zip 带 __MACOSX 条目 → 皮肤导入必败。
// 场景:macOS 用户右键压缩皮肤目录,zip 里必有 __MACOSX/ 元数据目录与 ._ 开头的
// AppleDouble 文件。resolveRootPrefix 要求顶层条目 tops.size===1 → '__MACOSX' 顶上来
// 变成 2 → 返回 null → 导入报 manifest_missing,用户对一个完全合法的皮肤包束手无策。
// 修复后期望:__MACOSX/ 与 ._ 开头条目被过滤(且不计入 40 条上限),合法包照常导入。
// Run: node tests/acceptance/r26/d3-macosx-zip-import.mjs
import assert from 'node:assert/strict';
import { resolveRootPrefix, validateZipEntries, ZIP_LIMITS } from '../../../server/utils/skin-validate.js';

// ① Finder zip 的典型条目形态:__MACOSX 目录 + ._ AppleDouble + 真正的皮肤目录
{
  const files = [
    '__MACOSX/',
    '__MACOSX/myskin/',
    '__MACOSX/myskin/._skin.json',
    '__MACOSX/myskin/._bg.png',
    'myskin/',
    'myskin/skin.json',
    'myskin/bg.png',
  ];
  const root = resolveRootPrefix(files);
  assert.ok(root && root.prefix === 'myskin/',
    `D3: 带 __MACOSX 条目的合法皮肤包解析根前缀失败(实际 ${JSON.stringify(root)})—— Finder 压的包导入必败`);
}

// ② 反向钉:过滤不能放宽到「两个真顶层目录也放行」(超一层嵌套仍必须拒)
{
  const evil = resolveRootPrefix(['a/skin.json', 'b/skin.json']);
  assert.equal(evil, null, 'D3: 两个真实顶层目录仍必须 manifest_missing(过滤只针对 __MACOSX/._)');
  const direct = resolveRootPrefix(['skin.json', 'bg.png', '__MACOSX/._skin.json']);
  assert.ok(direct && direct.prefix === '', 'D3: 根目录直放的包(带 ._ 杂质)照常识别');
}

// ③ __MACOSX/._ 条目不计入 40 条上限:40 个真实条目 + 若干杂质 = 合法
{
  const entries = [];
  for (let i = 0; i < 40; i++) entries.push({ mode: '-rw-r--r--', type: '-', size: 10, path: `myskin/f${i}.png` });
  entries.push({ mode: '-rw-r--r--', type: '-', size: 10, path: '__MACOSX/myskin/._f0.png' });
  entries.push({ mode: '-rw-r--r--', type: '-', size: 10, path: '__MACOSX/myskin/._f1.png' });
  entries.push({ mode: 'drwxr-xr-x', type: 'd', size: 0, path: '__MACOSX/' });
  const v = validateZipEntries(entries, ZIP_LIMITS);
  assert.ok(v.ok, `D3: 40 真实条目 + __MACOSX 杂质应判合法(实际 ${v.code})—— 杂质被计入了 40 条上限`);
}

console.log('PASS r26-d3-macosx-zip-import');
