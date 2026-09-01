#!/usr/bin/env node
// r26-D10【单测·服务端半】:import-inline 新 kind:'skinjson'(契约 C-D10 逐字)。
// 请求体 {kind, name, skinJson}(skinJson 为 cgui-skin/1 文本或已 parse 对象):
//   ①纯 vars 形态文本 → 201,tier:1,变量进 manifest(通过哨兵);
//   ②纯 home.greeting 形态 → 201(通过哨兵);
//   ③background.image 引用 → 422 asset_missing(无资产通道哨兵);
//   ④icons 引用包内 svg(文本通道无文件)→ 422 asset_missing;
//   ⑤非法 JSON → 422 manifest_invalid;
//   ⑥skinJson 为已 parse 对象(非字符串)同可走通(契约「文本或已 parse 对象」);
//   ⑦tier:2 → 422(空壳 T2 拒;T2 请走 trio 通道);
//   ⑧format 非 cgui-skin/1 → 400 unsupported_format(全量校验复用哨兵);
//   ⑨落盘内容与 zip 通道同构(skin.json + meta.json,响应 {id,name,warnings,manifest})。
// 隔离口径:makeTmpHome 先于 import 路由;端口取 OS 临时口(listen(0),真实端口从 server.address() 读回);真实 ~/.claude-gui 零触碰。
// Run: node tests/unit/check-r26-import-inline-skinjson.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpHome, cleanupDirs, stopServer } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('d10-unit');
process.on('exit', () => { try { cleanupDirs(TMP_HOME); } catch {} });

const { SKINS_DIR } = await import('../../server/routes/skins-packs.js');
const express = (await import('express')).default;
const skinsRouter = (await import('../../server/routes/skins-packs.js')).default;

assert.ok(SKINS_DIR.startsWith(TMP_HOME), 'env: SKINS_DIR 在隔离 HOME 下(真实目录零触碰自证)');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', skinsRouter);
let server = null;
let failure = null;
try {
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${BASE}/api/skins/import-inline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  // ① 纯 vars 文本 → 201 tier:1
  {
    const skinJson = JSON.stringify({
      format: 'cgui-skin/1', name: '任意名(body 权威覆盖)',
      shared: { vars: { '--color-accent': '#5E81AC' } },
    });
    const r = await post({ kind: 'skinjson', name: 'sj-vars', skinJson });
    assert.equal(r.status, 201, `① 纯 vars 应 201(实际 ${r.status}:${JSON.stringify(r.body)})`);
    assert.equal(r.body.manifest.tier, 1, '① tier:1');
    assert.equal(r.body.manifest.shared.vars['--color-accent'], '#5E81AC', '① 变量进 manifest');
    assert.equal(r.body.name, 'sj-vars', '① name 以请求体为准(body 权威)');
    assert.equal(r.body.manifest.name, 'sj-vars', '① manifest.name 同步 body 名');
    // ⑨ 落盘同构
    const files = readdirSync(join(SKINS_DIR, r.body.id)).sort();
    assert.deepEqual(files, ['meta.json', 'skin.json'], '⑨ 落盘 skin.json + meta.json(无资产通道零文件)');
    assert.equal(JSON.parse(readFileSync(join(SKINS_DIR, r.body.id, 'skin.json'), 'utf8')).format, 'cgui-skin/1', '⑨ 规范化 manifest 落盘');
  }

  // ② 纯 home.greeting 形态 → 201
  {
    const r = await post({ kind: 'skinjson', name: 'sj-greeting', skinJson: JSON.stringify({
      format: 'cgui-skin/1', name: 'x', home: { greeting: '晚上好,{name}' },
    }) });
    assert.equal(r.status, 201, `② 纯 home.greeting 应 201(实际 ${r.status}:${JSON.stringify(r.body)})`);
    assert.equal(r.body.manifest.home.greeting, '晚上好,{name}', '② greeting 进 manifest');
  }

  // ③ background.image 引用 → asset_missing(无资产通道)
  {
    const r = await post({ kind: 'skinjson', name: 'sj-bg', skinJson: JSON.stringify({
      format: 'cgui-skin/1', name: 'x',
      shared: { vars: { '--color-accent': '#111111' } },
      dark: { background: { image: 'bg.png' } },
    }) });
    assert.equal(r.status, 422, '③ 引用背景图应 422');
    assert.equal(r.body.error, 'asset_missing', '③ asset_missing(契约:引用资产必 asset_missing)');
  }

  // ④ icons 引用(文本通道无文件)→ asset_missing
  {
    const r = await post({ kind: 'skinjson', name: 'sj-icons', skinJson: JSON.stringify({
      format: 'cgui-skin/1', name: 'x',
      shared: { vars: { '--color-accent': '#111111' } },
      icons: { send: 'icon-send.svg' },
    }) });
    assert.equal(r.status, 422, '④ 引用图标应 422');
    assert.equal(r.body.error, 'asset_missing', '④ icons 引用必 asset_missing');
  }

  // ⑤ 非法 JSON → manifest_invalid
  {
    const r = await post({ kind: 'skinjson', name: 'sj-bad', skinJson: '{not json' });
    assert.equal(r.status, 422, '⑤ 非法 JSON 应 422');
    assert.equal(r.body.error, 'manifest_invalid', '⑤ manifest_invalid');
  }

  // ⑥ skinJson 为已 parse 对象(契约:「文本或已 parse 对象」)
  {
    const r = await post({ kind: 'skinjson', name: 'sj-obj', skinJson: {
      format: 'cgui-skin/1', name: 'x', shared: { vars: { '--radius-lg': '9px' } },
    } });
    assert.equal(r.status, 201, `⑥ 已 parse 对象应 201(实际 ${r.status})`);
    assert.equal(r.body.manifest.shared.vars['--radius-lg'], '9px', '⑥ 对象形态变量进 manifest');
  }

  // ⑦ tier:2 → 拒(空壳 T2;T2 走 trio 通道)
  {
    const r = await post({ kind: 'skinjson', name: 'sj-t2', skinJson: JSON.stringify({
      format: 'cgui-skin/1', name: 'x', tier: 2,
    }) });
    assert.equal(r.status, 422, '⑦ tier:2 应 422');
    assert.equal(r.body.error, 'manifest_invalid', '⑦ skinjson 通道只收 T1');
  }

  // ⑧ format 非 cgui-skin/1 → unsupported_format(validateManifest 全量校验复用)
  {
    const r = await post({ kind: 'skinjson', name: 'sj-fmt', skinJson: JSON.stringify({
      format: 'cgui-skin/2', name: 'x', shared: { vars: { '--color-accent': '#111111' } },
    }) });
    assert.equal(r.status, 400, '⑧ 未知 format 应 400');
    assert.equal(r.body.error, 'unsupported_format', '⑧ unsupported_format');
  }

  // 反向钉:旧 kind 错误文案更新(不误伤 trio/dsw 原有行为,冒烟)
  {
    const r = await post({ kind: 'bogus', name: 'x' });
    assert.equal(r.status, 400, '未知 kind 仍 400');
    assert.match(r.body.message, /skinjson/, '错误文案含新 kind');
  }
} catch (e) {
  failure = e;
} finally {
  await stopServer(server);
}
if (failure) throw failure;

console.log('PASS check-r26-import-inline-skinjson');
