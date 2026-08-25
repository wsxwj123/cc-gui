#!/usr/bin/env node
// r43【单测】:① AI 提示词页面内全文展示(源码哨兵)+ ② 皮肤文件夹导入
// (/api/skins/import-dir)。服务端全部跑真函数(isSafeSkinRelPath / installSkinDirectory /
// installSkinPackage),落盘一律注入 scratch skinsDir —— 绝不写真实 ~/.claude-gui(末尾
// 有零触碰自证);前端半只能走源码哨兵(JSX 在 node 里渲染不了)。
// 变异哨兵(实际验证过红):
//   ① isSafeSkinRelPath 删 `s !== '..'` → m2 红;
//   ② installUnpacked 删 validateT2Script 接线 → d7 红。
// Run: node tests/unit/check-r43-skin-import-dir.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { crc32 } from 'node:zlib';
import {
  installSkinDirectory, installSkinPackage, isSafeSkinRelPath, DIR_LIMITS, SKINS_DIR,
} from '../../server/routes/skins-packs.js';
import { ZIP_LIMITS } from '../../server/utils/skin-validate.js';

const scratch = mkdtempSync(join(tmpdir(), 'cgui-r43-'));
const dirSkins = join(scratch, 'skins-dir');
const zipSkins = join(scratch, 'skins-zip');
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
// n 字节的合法 base64(不实际构造二进制:'AAAA' 解码即 3 字节)
const b64OfBytes = (n) => 'A'.repeat(Math.ceil(n / 3) * 4);
const FOUR = [ // 合法 T2 四件套
  { path: 'skin.json', dataB64: b64(JSON.stringify({ format: 'cgui-skin/1', name: 'r43 dir skin', tier: 2 })) },
  { path: 'skin.css', dataB64: b64('[data-cgui="app"]{--x:1}') },
  { path: 'client.js', dataB64: b64('window.__cguiSkinDispose = () => {};') },
  { path: 'a11y.css', dataB64: b64('[data-cgui="app"]{outline:0}') },
];
const rejects = (files, code, label, opts = {}) =>
  assert.rejects(() => installSkinDirectory(files, { skinsDir: dirSkins, ...opts }),
    (e) => e.skinCode === code, `${label}(期望 ${code})`);

// ── ② 路径校验矩阵(纯函数,逐条独立断言)────────────────────────
{
  assert.equal(isSafeSkinRelPath('skin.json'), true, 'm1: 根文件放行');
  assert.equal(isSafeSkinRelPath('assets/bg.png'), true, 'm1: 一层子目录放行');
  assert.equal(isSafeSkinRelPath('a/b/c.png'), true, 'm1: 深度 3 放行(上限)');
  assert.equal(isSafeSkinRelPath('../evil.png'), false, 'm2: `..` 起手拒(哨兵锚)');
  assert.equal(isSafeSkinRelPath('a/../../evil.png'), false, 'm2: 中段 `..` 拒(哨兵锚)');
  assert.equal(isSafeSkinRelPath('/etc/passwd'), false, 'm3: 绝对路径拒');
  assert.equal(isSafeSkinRelPath('C:/Windows/x.png'), false, 'm3: 盘符拒');
  assert.equal(isSafeSkinRelPath('a\\b.png'), false, 'm4: 反斜杠拒');
  assert.equal(isSafeSkinRelPath('..\\evil.png'), false, 'm4: 反斜杠穿越形态拒');
  assert.equal(isSafeSkinRelPath('a/b/c/d.png'), false, 'm5: 深度 4 拒');
  assert.equal(isSafeSkinRelPath(`${'x'.repeat(129)}.png`), false, 'm6: 路径超 128 字符拒');
  assert.equal(isSafeSkinRelPath(`bad${String.fromCharCode(0)}.png`), false, 'm7: NUL 控制字符拒');
  assert.equal(isSafeSkinRelPath(`bad${String.fromCharCode(10)}.png`), false, 'm7: 换行控制字符拒');
  assert.equal(isSafeSkinRelPath(`bad${String.fromCharCode(127)}.png`), false, 'm7: DEL 控制字符拒');
  assert.equal(isSafeSkinRelPath('a//b.png'), false, 'm8: 空段拒');
  assert.equal(isSafeSkinRelPath('assets/'), false, 'm8: 末尾斜杠(空段)拒');
  assert.equal(isSafeSkinRelPath('./skin.json'), false, 'm8: `.` 段拒');
  assert.equal(isSafeSkinRelPath(''), false, 'm8: 空串拒');
  assert.equal(isSafeSkinRelPath(null), false, 'm8: 非字符串拒');
  // 生产限额口径(客户端下限文案与服务端同源,见下方前端哨兵)
  assert.deepEqual(DIR_LIMITS, {
    maxFiles: 40, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 30 * 1024 * 1024,
    maxDepth: 3, maxPathLen: 128,
  }, 'm9: DIR_LIMITS 生产值');
  // r49a-⑤:文件夹通道与 zip 通道同一条数闸(两条通道跑同一段 installUnpacked,
  // 上限不同 = 同一个包换个导入方式一个过一个拒)。
  assert.equal(DIR_LIMITS.maxFiles, ZIP_LIMITS.maxEntries, 'm9: 文件夹条数闸与 zip 对齐');
}

// ── ② 导入通道:合法四件套成功,产物结构与 zip 通道一致 ──────────
{
  const out = await installSkinDirectory(FOUR, { skinsDir: dirSkins });
  assert.equal(out.name, 'r43 dir skin', 'd1: 名称取自 skin.json(与 zip 同口径)');
  assert.equal(out.manifest.tier, 2, 'd1: tier 落盘');
  const dirFiles = readdirSync(join(dirSkins, out.id)).sort();

  // 同一份内容打成 zip 走 installSkinPackage(store 法手工构造,零外部工具)
  const zipPath = join(scratch, 'same.zip');
  writeFileSync(zipPath, makeZip(FOUR.map((f) => ({ name: f.path, data: Buffer.from(f.dataB64, 'base64') }))));
  const zipOut = await installSkinPackage(zipPath, { skinsDir: zipSkins });
  const zipFiles = readdirSync(join(zipSkins, zipOut.id)).sort();

  assert.deepEqual(dirFiles, ['a11y.css', 'client.js', 'meta.json', 'skin.css', 'skin.json'], 'd1: 四件套 + meta 落盘');
  assert.deepEqual(dirFiles, zipFiles, 'd2: 文件夹通道产物文件集 = zip 通道');
  assert.deepEqual(
    JSON.parse(readFileSync(join(dirSkins, out.id, 'skin.json'), 'utf8')),
    JSON.parse(readFileSync(join(zipSkins, zipOut.id, 'skin.json'), 'utf8')),
    'd2: 规范化 manifest 逐字一致');
  assert.equal(JSON.parse(readFileSync(join(dirSkins, out.id, 'meta.json'), 'utf8')).source, 'user', 'd2: source=user');
  assert.deepEqual(out.warnings, zipOut.warnings, 'd2: warnings 口径一致');
  assert.equal(out.id.replace(/-[a-z0-9]{6}$/, ''), zipOut.id.replace(/-[a-z0-9]{6}$/, ''), 'd2: id slug 段一致');
}

// ── ② 嵌套一层(用户选了皮肤文件夹的父目录)仍可定位 manifest ──────
{
  const nested = FOUR.map((f) => ({ ...f, path: `pack/${f.path}` }));
  const out = await installSkinDirectory(nested, { skinsDir: dirSkins });
  assert.equal(out.name, 'r43 dir skin', 'd3: 嵌套一层可导入(resolveRootPrefix 共用)');
}

// ── ② 服务端硬校验:缺 skin.json / 三型超量 / 非法路径 / 空 body ──
{
  await rejects([{ path: 'readme.md', dataB64: b64('hi') }], 'manifest_missing', 'd4: 缺 skin.json 拒');
  await rejects(
    Array.from({ length: DIR_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `f${i}.png`, dataB64: b64('x') })),
    'dir_entries_exceeded', 'd5: 65 个文件拒(数量型)');
  await rejects(
    [FOUR[0], { path: 'big.bin', dataB64: b64OfBytes(DIR_LIMITS.maxFileBytes + 1) }],
    'asset_too_large', 'd5: 单文件超 20MB 拒(单文件型)');
  await rejects(
    [{ path: 'a.bin', dataB64: b64OfBytes(16 * 1024 * 1024) }, { path: 'b.bin', dataB64: b64OfBytes(16 * 1024 * 1024) }],
    'zip_too_large', 'd5: 总量超 30MB 拒(总量型)');
  await rejects([FOUR[0], { path: '../evil.png', dataB64: b64('x') }], 'path_traversal', 'd6: 穿越路径整包拒(端到端接线)');
  await rejects([FOUR[0], { path: 'a\\b.png', dataB64: b64('x') }], 'path_traversal', 'd6: 反斜杠整包拒(端到端接线)');
  await rejects([], 'dir_invalid', 'd6: 空数组拒');
  await rejects(undefined, 'dir_invalid', 'd6: files 缺失拒');
}

// ── ② 共享管线接线:三道校验(脚本/SVG/图片)对文件夹通道同样生效 ──
{
  await rejects(
    [FOUR[0], { path: 'client.js', dataB64: b64('fetch("/api/steal")') }],
    'script_rejected', 'd7: client.js 静态校验拒(哨兵锚:删共享管线 js 分支即绿)');
  await rejects([
    { path: 'skin.json', dataB64: b64(JSON.stringify({ format: 'cgui-skin/1', name: 'ic', icons: { send: 'ic.svg' } })) },
    { path: 'ic.svg', dataB64: b64('<svg><script>alert(1)</script></svg>') },
  ], 'svg_rejected', 'd7: 图标 SVG 清洗拒(共享管线)');
  await rejects([
    { path: 'skin.json', dataB64: b64(JSON.stringify({ format: 'cgui-skin/1', name: 'bg', light: { background: { image: 'bg.png' } } })) },
    { path: 'bg.png', dataB64: b64('not a png') },
  ], 'image_invalid', 'd7: 图片头解析拒(共享管线)');
}

// ── ② 端点接线(源码哨兵:解析器大限只挂本路由,全局限额未改)────
{
  const routes = readFileSync(new URL('../../server/routes/skins-packs.js', import.meta.url), 'utf8');
  assert.match(routes, /router\.post\('\/skins\/import-dir', express\.json\(\{ limit: '45mb' \}\)/,
    'd8: import-dir 单独挂 45mb 解析器');
  assert.match(routes, /return await installUnpacked\(tmp, fileEntries/,
    'd8: zip 通道也走共享管线(两条通道不会各自漂移)');
  const index = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8');
  assert.match(index, /express\.json\(\{ limit: '25mb' \}\)/, 'd8: 全局 body 限额未改');
  assert.match(index, /req\.path === '\/api\/skins\/import-dir' \? next\(\)/, 'd8: 全局解析器对该路由让路');
}

// ── ① 提示词全文页面内展示 + ② 前端文件夹入口(源码哨兵)────────
{
  const src = readFileSync(new URL('../../client/src/components/SkinPanel.jsx', import.meta.url), 'utf8');
  const promptBlock = src.slice(src.indexOf("tab === 'prompt' && ("), src.indexOf('{notice && ('));
  assert.ok(promptBlock, 'p0: prompt 块定位');
  assert.match(promptBlock, /<pre className="[^"]*overflow-y-auto[^"]*"/, 'p1①: 展示区是可滚动 <pre>');
  assert.match(promptBlock, /whitespace-pre-wrap break-words/, 'p1①: 长行折行不撑破模态');
  assert.match(promptBlock, /\{promptText\}/, 'p1①: 渲染的是提示词全文');
  assert.match(src, /const promptText = useMemo\(\(\) => buildSkinPrompt\(\), \[\]\);/, 'p1①: 全文 useMemo 一次');
  assert.equal((src.match(/buildSkinPrompt\(\)/g) || []).length, 1,
    'p1①: buildSkinPrompt 只在渲染路径算一次(复制按钮复用同一份)');
  assert.match(src, /'webkitdirectory' in document\.createElement\('input'\)/, 'p2②: 特性检测(老 iOS 不渲染入口)');
  assert.match(src, /\{CAN_PICK_DIR && \(/, 'p2②: 入口按特性检测门控');
  assert.match(src, /webkitdirectory="" directory="" multiple/, 'p2②: 目录选择 input');
  assert.match(src, /fetch\('\/api\/skins\/import-dir'/, 'p2②: 走新端点');
  assert.match(src, /webkitRelativePath\.split\('\/'\)\.slice\(1\)\.join\('\/'\)/, 'p2②: 剥掉顶层目录名');
  assert.ok(src.includes('T1/T2 皮肤包(zip/.cguiskin/文件夹,≤30MB)'), 'p2②: 说明文字含文件夹通道');
  // 客户端下限与服务端 DIR_LIMITS 同口径(改一边不改另一边 → 这里红)
  const num = (re, mul = 1) => Number(src.match(re)[1]) * mul;
  assert.equal(num(/const DIR_MAX_FILES = (\d+);/), DIR_LIMITS.maxFiles, 'p3②: 文件数上限双端一致');
  assert.equal(num(/const DIR_MAX_FILE_BYTES = (\d+) \* 1024 \* 1024;/, 1024 * 1024), DIR_LIMITS.maxFileBytes, 'p3②: 单文件上限双端一致');
  assert.equal(num(/const DIR_MAX_TOTAL_BYTES = (\d+) \* 1024 \* 1024;/, 1024 * 1024), DIR_LIMITS.maxTotalBytes, 'p3②: 总量上限双端一致');
}

// ── 生产目录零触碰自证 ──────────────────────────────────────
{
  const realDir = join(homedir(), '.claude-gui', 'skins');
  assert.equal(SKINS_DIR, realDir, 'z1: 生产常量口径');
  const ids = existsSync(realDir) ? readdirSync(realDir) : [];
  assert.ok(!ids.some((d) => d.startsWith('r43-dir-skin')), 'z1: 真实皮肤目录无本测试产物');
}

// ── 手工 zip(store 法,普通文件即可;穿越/符号链接矢量在 check-skin-install)──
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const crc = crc32(buf) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(buf.length, 18);
    lh.writeUInt32LE(buf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, buf);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(buf.length, 20);
    ch.writeUInt32LE(buf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + buf.length;
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

console.log('PASS check-r43-skin-import-dir');
