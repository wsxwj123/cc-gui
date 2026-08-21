#!/usr/bin/env node
// r26-D3【单测】:Finder zip 的 __MACOSX/._ 杂质过滤(PLAN D3 验收点)。
//   ①含 __MACOSX/._skin.json + dir/._skin.json 的条目表 → resolveRootPrefix 命中 dir/;
//   ②41 条条目其中 5 条 junk → 不过 zip_entries_exceeded 闸(上限豁免哨兵);
//   ③junk 里塞 ../ 穿越 → 过滤后不触发 path_traversal(过滤先于安全闸;junk 永不落盘,
//     referenced 白名单兜底,豁免安全);
//   ④端到端:手工 zip 字节(store 法,形态同 check-skin-install.mjs)带 __MACOSX 目录
//     与 ._ AppleDouble 文件 → installSkinPackage 真解包导入成功,杂质零落盘;
//   ⑤反向钉:过滤不放宽——两个真实顶层目录仍 manifest_missing(resolveRootPrefix null)。
// Run: node tests/unit/check-r26-skin-zip-macosx.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import {
  isJunkEntry, stripJunkEntries, resolveRootPrefix, validateZipEntries, ZIP_LIMITS,
} from '../../server/utils/skin-validate.js';
import { installSkinPackage } from '../../server/routes/skins-packs.js';

const scratch = mkdtempSync(join(tmpdir(), 'cgui-r26-d3-'));
const skinsDir = join(scratch, 'skins');
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

// ── ① 过滤后 resolveRootPrefix 命中真实嵌套根 ──
{
  const files = [
    '__MACOSX/', '__MACOSX/myskin/', '__MACOSX/myskin/._skin.json', '__MACOSX/myskin/._bg.png',
    'myskin/', 'myskin/._skin.json', 'myskin/skin.json', 'myskin/bg.png',
  ];
  assert.ok(isJunkEntry('__MACOSX/myskin/._skin.json'), '① __MACOSX 段判 junk');
  assert.ok(isJunkEntry('myskin/._skin.json'), '① ._ 开头段判 junk');
  assert.ok(!isJunkEntry('myskin/skin.json'), '① 正常文件不误判');
  assert.ok(!isJunkEntry('myskin/sub.dir/x.png'), '① 含点目录名不误判(._ 开头才算)');
  const stripped = stripJunkEntries(files);
  assert.deepEqual(stripped, ['myskin/', 'myskin/skin.json', 'myskin/bg.png'], '① 剥离结果只剩真实条目');
  const root = resolveRootPrefix(files);
  assert.ok(root && root.prefix === 'myskin/', '① 带杂质条目表 → 根前缀命中 myskin/(修前 tops.size=2 必败)');
  const direct = resolveRootPrefix(['skin.json', 'bg.png', '__MACOSX/._skin.json']);
  assert.ok(direct && direct.prefix === '', '① 根目录直放(带 ._ 杂质)照常识别');
}

// ── ② junk 不计入 40 条上限(36 真实 + 5 junk = 41 条清单仍合法)──
{
  const entries = [];
  for (let i = 0; i < 36; i++) entries.push({ mode: '-rw-r--r--', type: '-', size: 10, path: `myskin/f${i}.png` });
  entries.push({ mode: '-rw-r--r--', type: '-', size: 10, path: '__MACOSX/myskin/._f0.png' });
  entries.push({ mode: '-rw-r--r--', type: '-', size: 10, path: '__MACOSX/myskin/._f1.png' });
  entries.push({ mode: '-rw-r--r--', type: '-', size: 10, path: 'myskin/._skin.json' });
  entries.push({ mode: 'drwxr-xr-x', type: 'd', size: 0, path: '__MACOSX/' });
  entries.push({ mode: 'drwxr-xr-x', type: 'd', size: 0, path: '__MACOSX/myskin/' });
  assert.equal(entries.length, 41, '② 夹具确为 41 条(超上限)');
  const v = validateZipEntries(entries, ZIP_LIMITS);
  assert.ok(v.ok, '② 36 真实 + 5 junk 应判合法(junk 不计入 40 上限)');
  assert.equal(v.entries.length, 36, '② 返回条目已剥 junk');
  // 反向钉:41 条全真实仍拒(上限闸没失效)
  const all41 = [];
  for (let i = 0; i < 41; i++) all41.push({ mode: '-rw-r--r--', type: '-', size: 10, path: `myskin/g${i}.png` });
  assert.equal(validateZipEntries(all41, ZIP_LIMITS).code, 'zip_entries_exceeded', '② 41 真实条目仍拒(闸未失效)');
}

// ── ③ junk 内的 ../ 穿越不触发 path_traversal(过滤先于安全闸;junk 永不落盘)──
{
  const entries = [
    { mode: '-rw-r--r--', type: '-', size: 10, path: 'skin.json' },
    { mode: '-rw-r--r--', type: '-', size: 10, path: '__MACOSX/../._evil.png' },
  ];
  const v = validateZipEntries(entries, ZIP_LIMITS);
  assert.ok(v.ok, '③ junk 里的穿越形态被剥离后不触发 path_traversal');
  // 反向钉:真实条目里的穿越仍拒(安全闸对非 junk 没松)
  const evil = validateZipEntries([
    { mode: '-rw-r--r--', type: '-', size: 10, path: 'skin.json' },
    { mode: '-rw-r--r--', type: '-', size: 10, path: '../evil.png' },
  ], ZIP_LIMITS);
  assert.equal(evil.code, 'path_traversal', '③ 真实条目的穿越仍拒(闸未失效)');
}

// ── ⑤ 反向钉:两个真实顶层目录仍 manifest_missing ──
{
  assert.equal(resolveRootPrefix(['a/skin.json', 'b/skin.json']), null, '⑤ 两个真实顶层目录仍拒');
}

// ── ④ 端到端:Finder 形态 zip(手工字节)真解包导入成功、杂质零落盘 ──
// makeZip(store 法)与 tinyPng 夹具同 check-skin-install.mjs 既有做法。
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    // 外部属性高 16 位 = unix mode(目录 0o40755,普通文件 0o100644;
    // 目录条目必须标 dir,否则 bsdtar 解包报 "File exists" 类元数据错)
    const mode = e.dir ? 0o40755 : 0o100644;
    ch.writeUInt32LE((mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const tinyPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.from([0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x06, 0x00, 0x00, 0x00]), // 16×16
  Buffer.alloc(16),
]);

{
  // 夹具说明(实测取证):macOS bsdtar 会把与真实文件配对的 __MACOSX/.../._<file>
  // 当 AppleDouble 元数据恢复,假内容必报 "Failed to restore metadata"(真 Finder 包的
  // ._ 是合法 AppleDouble 故能过);且本机 tar 在清单层就不显示 __MACOSX 条目。
  // 因此 e2e 杂质用「无配对文件」的 ._ 条目(合法解包),清单级过滤行为由上面
  // 纯函数测试 ①②③⑤ 钉死(含配对形态);这里只证「带杂质条目的包端到端可导入、
  // 杂质零落盘」。
  const zipPath = join(scratch, 'finder.zip');
  writeFileSync(zipPath, makeZip([
    { name: '__MACOSX/', data: '', dir: true },
    { name: '__MACOSX/myskin/', data: '', dir: true },
    { name: '__MACOSX/myskin/._orphan.png', data: 'junk-not-paired' },
    { name: 'myskin/', data: '', dir: true },
    { name: 'myskin/skin.json', data: JSON.stringify({
      format: 'cgui-skin/1', name: 'finder-zip',
      shared: { vars: { '--color-accent': '#5E81AC' } },
      light: { background: { image: 'bg.png' } },
    }) },
    { name: 'myskin/bg.png', data: tinyPng },
  ]));
  const out = await installSkinPackage(zipPath, { skinsDir });
  assert.equal(out.name, 'finder-zip', '④ Finder 形态包导入成功(修前 manifest_missing 必败)');
  const kept = readdirSync(join(skinsDir, out.id)).sort();
  assert.deepEqual(kept, ['bg.png', 'meta.json', 'skin.json'], '④ 杂质零落盘(只落引用资产 + 两份 json)');
}

console.log('PASS check-r26-skin-zip-macosx');
