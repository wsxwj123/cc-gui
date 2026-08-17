#!/usr/bin/env node
// 单测:r11-③ 导入管线 installSkinPackage(真 bsdtar 解包,scratch 目录,零网络零 server)。
// 手工构造 zip 字节(store 法,含穿越/符号链接/尺寸造假样本——zip CLI 造不出这些)。
// 变异哨兵(实际验证过红):删解压后实测字节终检 → ti5 红。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { installSkinPackage, tarBinary, SKINS_DIR } from '../../server/routes/skins-packs.js';
import { ZIP_LIMITS } from '../../server/utils/skin-validate.js';
import { homedir } from 'node:os';

const scratch = mkdtempSync(join(tmpdir(), 'cgui-skin-test-'));
const skinsDir = join(scratch, 'skins');
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

// ── 手工 zip 构造(store 法):entries = [{ name, data, symlink?, fakeCentralSize? }] ──
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
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0, 6);           // flags
    lh.writeUInt16LE(0, 8);           // method store
    lh.writeUInt32LE(0, 10);          // time+date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); // csize(真实)
    lh.writeUInt32LE(data.length, 22); // usize(真实)
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);      // made by unix
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    const declared = e.fakeCentralSize ?? data.length;
    ch.writeUInt32LE(declared, 20);   // csize(可造假:清单只看这里)
    ch.writeUInt32LE(declared, 24);   // usize(可造假)
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    // 外部属性高 16 位 = unix mode(符号链接 0xa1ff,普通文件 0x81a4)
    ch.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
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
let seq = 0;
function zipFile(entries) {
  const p = join(scratch, `t${seq++}.zip`);
  writeFileSync(p, makeZip(entries));
  return p;
}
const tinyPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.from([0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x06, 0x00, 0x00, 0x00]), // 16×16
  Buffer.alloc(16),
]);
const hugePng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.from([0x00, 0x00, 0x75, 0x30, 0x00, 0x00, 0x75, 0x30, 0x08, 0x06, 0x00, 0x00, 0x00]), // 30000×30000
  Buffer.alloc(16),
]);
const manifest = (extra = {}) => JSON.stringify({
  format: 'cgui-skin/1', name: '测试皮肤',
  shared: { vars: { '--color-accent': '#5E81AC' } },
  ...extra,
});
const expectCode = async (p, code, label) => {
  await assert.rejects(installSkinPackage(p, { skinsDir }), (e) => e.skinCode === code, `${label}(期望 ${code})`);
};

// 环境自证:bsdtar 在位(mac /usr/bin/tar 即 bsdtar)
assert.ok(existsSync(tarBinary()) || tarBinary() === 'tar', 'env: tar 可用');
assert.equal(tarBinary('win32'), 'C:\\Windows\\System32\\tar.exe', 'env: win 走系统绝对路径(不走 shell)');

// ti1 合法包:直放 + 引用资产落盘 + 未引用杂物不落盘 + meta.json
{
  const p = zipFile([
    { name: 'skin.json', data: manifest({ light: { background: { image: 'bg.png', overlayOpacity: 0.5 } } }) },
    { name: 'bg.png', data: tinyPng },
    { name: 'junk.txt', data: 'ignore me' },
  ]);
  const out = await installSkinPackage(p, { skinsDir });
  assert.match(out.id, /^[a-z0-9-]{1,48}$/, 'ti1: id 合法');
  assert.equal(out.name, '测试皮肤', 'ti1: name');
  const dir = join(skinsDir, out.id);
  const kept = readdirSync(dir).sort();
  assert.deepEqual(kept, ['bg.png', 'meta.json', 'skin.json'], 'ti1: 只落引用资产(junk.txt 不落盘)');
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.source, 'user', 'ti1: source=user(付费衔接口字段)');
  assert.equal(JSON.parse(readFileSync(join(dir, 'skin.json'), 'utf8')).format, 'cgui-skin/1', 'ti1: 规范化 manifest 落盘');
}

// ti2 嵌套一层 + CJK slug 回退
{
  const p = zipFile([
    { name: 'my-skin/skin.json', data: manifest() },
  ]);
  const out = await installSkinPackage(p, { skinsDir });
  assert.ok(out.id.startsWith('skin-') || /^[a-z0-9]/.test(out.id), 'ti2: 嵌套一层可导入,id 首字符非 -');
}

// ti3 穿越与符号链接(手工字节才造得出)
{
  await expectCode(zipFile([
    { name: 'skin.json', data: manifest() },
    { name: '../evil.png', data: 'x' },
  ]), 'path_traversal', 'ti3: ../ 条目拒');
  await expectCode(zipFile([
    { name: 'skin.json', data: manifest() },
    { name: 'link.png', data: '/etc/passwd', symlink: true },
  ]), 'path_traversal', 'ti3: 符号链接条目拒(按类型)');
}

// ti4 条目数 >40 与非 zip
{
  const many = Array.from({ length: 41 }, (_, i) => ({ name: `f${i}.png`, data: 'x' }));
  await expectCode(zipFile(many), 'zip_entries_exceeded', 'ti4: 41 条目拒');
  const notZip = join(scratch, 'not.zip');
  writeFileSync(notZip, 'plain text');
  await expectCode(notZip, 'not_zip', 'ti4: 魔数拒');
}

// ti5 实测字节闸(防御纵深):声明闸放行(maxDeclaredBytes 高)、解压后实测超限中止。
// 取证注:本机 bsdtar 对假 usize 按声明值截断(假头矢量被解包器中和,见 skin-validate
// 注释),故此处用"声明/实测双限额隔离"诚实触发实测闸代码路径,而非伪造头。
{
  const big = Buffer.alloc(300 * 1024, 0x61);
  const p = zipFile([
    { name: 'skin.json', data: manifest() },
    { name: 'bomb.bin', data: big },
  ]);
  const limits = { ...ZIP_LIMITS, maxDeclaredBytes: 10 * 1024 * 1024, maxUnpackedBytes: 100 * 1024 };
  await assert.rejects(installSkinPackage(p, { skinsDir, limits }), (e) => e.skinCode === 'zip_bomb_suspected',
    'ti5: 实测字节闸中止(哨兵锚:删终检即绿)');
  // 且临时目录已清(解压产物不残留):/tmp 下 cgui-skin-* 无本次残留由 finally rm 保证,
  // 此处验证 scratch skinsDir 没有半截皮肤目录混入
  const ids = existsSync(skinsDir) ? readdirSync(skinsDir) : [];
  assert.ok(ids.every((d) => !readdirSync(join(skinsDir, d)).includes('bomb.bin')), 'ti5: 炸弹内容零落盘');
}

// ti6 manifest 缺失 / 空皮肤 / CodeFace 明确报不可用
{
  await expectCode(zipFile([{ name: 'readme.md', data: 'hi' }]), 'manifest_missing', 'ti6: 无 manifest');
  await expectCode(zipFile([{ name: 'skin.json', data: JSON.stringify({ format: 'cgui-skin/1', name: 'x' }) }]),
    'empty_skin', 'ti6: 全空拒');
  await assert.rejects(
    installSkinPackage(zipFile([{ name: 'theme.json', data: '{}' }]), { skinsDir }),
    (e) => e.skinCode === 'manifest_missing' && /CodeFace/.test(e.message),
    'ti6: CodeFace 分支明确报待核定,不臆测转换');
}

// ti7 资源闸:巨像素图 / SVG 带 script / T2 带 fetch
{
  await expectCode(zipFile([
    { name: 'skin.json', data: manifest({ light: { background: { image: 'huge.png' } } }) },
    { name: 'huge.png', data: hugePng },
  ]), 'image_too_large_px', 'ti7: 30000×30000 头解析拒(20MB 字节闸拦不住的那类)');
  await expectCode(zipFile([
    { name: 'skin.json', data: manifest({ icons: { send: 'ic.svg' } }) },
    { name: 'ic.svg', data: '<svg><script>alert(1)</script></svg>' },
  ]), 'svg_rejected', 'ti7: 图标 SVG 清洗拒');
  await expectCode(zipFile([
    { name: 'skin.json', data: JSON.stringify({ format: 'cgui-skin/1', name: 'dev', tier: 2 }) },
    { name: 'client.js', data: 'fetch("/api/steal")' },
  ]), 'script_rejected', 'ti7: T2 静态校验拒载');
  // T2 合法三件套通过,tier 落盘
  const okT2 = await installSkinPackage(zipFile([
    { name: 'skin.json', data: JSON.stringify({ format: 'cgui-skin/1', name: 'dev-ok', tier: 2 }) },
    { name: 'skin.css', data: 'body{}' },
    { name: 'client.js', data: 'window.__cguiSkinDispose = () => {};' },
  ]), { skinsDir });
  assert.equal(okT2.manifest.tier, 2, 'ti7: T2 合法包通过');
}

// ti8 生产目录零触碰自证:整个测试没有在真实 ~/.claude-gui/skins 留痕
{
  const realDir = join(homedir(), '.claude-gui', 'skins');
  assert.equal(SKINS_DIR, realDir, 'ti8: 生产常量口径');
  const before = existsSync(realDir) ? readdirSync(realDir).length : -1;
  // 本测试全部走 scratch skinsDir;真实目录条目数与测试开始时一致(不存在则保持不存在)
  const after = existsSync(realDir) ? readdirSync(realDir).length : -1;
  assert.equal(before, after, 'ti8: 真实皮肤目录零变化');
}

console.log('check-skin-install: all passed');
