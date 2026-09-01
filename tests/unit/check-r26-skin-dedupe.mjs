#!/usr/bin/env node
// r26-D6【单测】:同 slug 重复导入覆盖式去重(PLAN D6 验收点)。
//   ①import-inline 同名导入两次 → skinsDir 只有一个目录、id 相同、内容是第二次的(覆盖哨兵);
//   ②zip 通道同名导入两次 → 同口径覆盖;
//   ③不同名 → 各自独立目录(不串);
//   ④slug 撞名("My Skin" vs "my-skin" 归一同 slug)→ 互相覆盖(同名=同皮肤语义钉死);
//   ⑤CJK 名(slug 为空)→ 不去重,各导各的(无归属语义不做猜测);
//   ⑥覆盖后被覆盖皮肤目录内容完整可读(皮肤资产路径同 id,激活中覆盖不 404)。
// 隔离口径:makeTmpHome 先于 import 路由;端口取 OS 临时口(listen(0),真实端口从 server.address() 读回);手工
// zip 字节(store 法,同 check-skin-install.mjs)。真实 ~/.claude-gui 零触碰。
// Run: node tests/unit/check-r26-skin-dedupe.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32 } from 'node:zlib';
import { makeTmpHome, cleanupDirs, stopServer } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('d6-unit');
const scratch = mkdtempSync(join(tmpdir(), 'cgui-r26-d6-'));
process.on('exit', () => { try { cleanupDirs(TMP_HOME, scratch); } catch {} });

const { SKINS_DIR, findExistingSkinId } = await import('../../server/routes/skins-packs.js');
const { slugOf } = await import('../../server/utils/skin-validate.js');
const express = (await import('express')).default;
const skinsRouter = (await import('../../server/routes/skins-packs.js')).default;

assert.ok(SKINS_DIR.startsWith(TMP_HOME), 'env: SKINS_DIR 在隔离 HOME 下(真实目录零触碰自证)');

// 手工 zip(store 法,同 check-skin-install.mjs 既有做法)
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
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const zipFor = (name, accent) => makeZip([
  { name: 'skin.json', data: JSON.stringify({
    format: 'cgui-skin/1', name, shared: { vars: { '--color-accent': accent } },
  }) },
]);
const readAccent = (id) => JSON.parse(readFileSync(join(SKINS_DIR, id, 'skin.json'), 'utf8')).shared.vars['--color-accent'];

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', skinsRouter);
let server = null;
let failure = null;
try {
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const postInline = (body) => fetch(`${BASE}/api/skins/import-inline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const postZip = (buf) => fetch(`${BASE}/api/skins/import`, {
    method: 'POST', headers: { 'x-upload-name': encodeURIComponent('skin.zip'), 'Content-Type': 'application/octet-stream' }, body: buf,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  // ① import-inline 同名两次 → 同 id 覆盖
  {
    const a = await postInline({ kind: 'dsw', name: 'dup-inline', dswJson: { '--dsw-accent': '#111111' } });
    assert.equal(a.status, 201, `① 第一次导入 201(实际 ${a.status}:${JSON.stringify(a.body)})`);
    const b = await postInline({ kind: 'dsw', name: 'dup-inline', dswJson: { '--dsw-accent': '#222222' } });
    assert.equal(b.status, 201, '① 第二次导入 201');
    assert.equal(a.body.id, b.body.id, '① 同名导入复用同一 id');
    assert.equal(readAccent(a.body.id), '#222222', '① 内容是第二次的(覆盖哨兵)');
    const dirs = readdirSync(SKINS_DIR).filter((d) => d.startsWith('dup-inline'));
    assert.equal(dirs.length, 1, '① skinsDir 只有一个 dup-inline 目录(修前双胞胎)');
  }

  // ② zip 通道同名两次 → 同口径覆盖
  {
    const a = await postZip(zipFor('dup-zip', '#aaaaaa'));
    assert.equal(a.status, 201, `② zip 第一次 201(实际 ${a.status}:${JSON.stringify(a.body)})`);
    const b = await postZip(zipFor('dup-zip', '#bbbbbb'));
    assert.equal(b.status, 201, '② zip 第二次 201');
    assert.equal(a.body.id, b.body.id, '② zip 同名复用 id');
    assert.equal(readAccent(a.body.id), '#bbbbbb', '② 内容是第二次的');
  }

  // ③ 不同名 → 各自独立
  {
    const a = await postInline({ kind: 'dsw', name: 'indep-a', dswJson: { '--dsw-accent': '#101010' } });
    const b = await postInline({ kind: 'dsw', name: 'indep-b', dswJson: { '--dsw-accent': '#202020' } });
    assert.notEqual(a.body.id, b.body.id, '③ 不同名各自独立 id');
    assert.ok(existsSync(join(SKINS_DIR, a.body.id)) && existsSync(join(SKINS_DIR, b.body.id)), '③ 两目录俱在');
  }

  // ④ slug 撞名:"My Skin" 与 "my-skin" 归一同 slug → 互相覆盖(语义钉死)
  {
    assert.equal(slugOf('My Skin'), slugOf('my-skin'), '④ 夹具前提:两名归一同 slug');
    const a = await postInline({ kind: 'dsw', name: 'My Skin', dswJson: { '--dsw-accent': '#333333' } });
    const b = await postInline({ kind: 'dsw', name: 'my-skin', dswJson: { '--dsw-accent': '#444444' } });
    assert.equal(a.body.id, b.body.id, '④ 撞 slug 互相覆盖(同名=同一皮肤的语义声明)');
    assert.equal(readAccent(a.body.id), '#444444', '④ 后者覆盖前者');
    assert.equal(JSON.parse(readFileSync(join(SKINS_DIR, a.body.id, 'skin.json'), 'utf8')).name, 'my-skin', '④ manifest name 以最后一次导入为准');
  }

  // ⑤ CJK 名(slug 空)→ 不去重
  {
    const a = await postInline({ kind: 'dsw', name: '晨雾', dswJson: { '--dsw-accent': '#555555' } });
    const b = await postInline({ kind: 'dsw', name: '晨雾', dswJson: { '--dsw-accent': '#666666' } });
    assert.equal(a.status, 201, '⑤ CJK 第一次 201');
    assert.equal(b.status, 201, '⑤ CJK 第二次 201');
    assert.notEqual(a.body.id, b.body.id, '⑤ slug 为空不做归属猜测(各导各的)');
  }

  // ⑥ 覆盖后目录完整可读(激活中覆盖不 404:资产路径同 id)
  {
    const id = await findExistingSkinId('dup-inline', SKINS_DIR);
    assert.ok(id, '⑥ findExistingSkinId 命中既有目录');
    const files = readdirSync(join(SKINS_DIR, id)).sort();
    assert.deepEqual(files, ['meta.json', 'skin.json'], '⑥ 覆盖后目录内容完整(dsw 形态两文件)');
    assert.equal(await findExistingSkinId('', SKINS_DIR), null, '⑥ 空 slug 永不命中(CJK 保护)');
    assert.equal(await findExistingSkinId('nonexistent', SKINS_DIR), null, '⑥ 未命中回 null');
  }
} catch (e) {
  failure = e;
} finally {
  await stopServer(server);
}
if (failure) throw failure;

console.log('PASS check-r26-skin-dedupe');
