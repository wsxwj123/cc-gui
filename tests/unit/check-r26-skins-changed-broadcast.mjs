#!/usr/bin/env node
// r26-D7【单测·服务端半】:DELETE /api/skins/:id 成功后广播(契约 C-D7 逐字)。
//   ①删除成功 → 广播 payload 键集合逐字 {type, deletedId},type==='skins-changed'、
//     deletedId === 被删 id(PKG-2 的 useWebSocket reducer 按此形状消费);
//   ②目录确实被删(真 I/O 哨兵);
//   ③删除不存在的 id → 404 且不广播(误广播哨兵);
//   ④坏客户端不阻断:广播对 throw 的客户端免疫,响应仍 200(broadcast 既有逐客户端
//     catch 语义在删除链路上成立)。
// 隔离口径:makeTmpHome 先于 import 路由;端口取 OS 临时口(listen(0),真实端口从 server.address() 读回);真实 ~/.claude-gui 零触碰。
// Run: node tests/unit/check-r26-skins-changed-broadcast.mjs
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpHome, cleanupDirs, stopServer } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('d7-unit');
process.on('exit', () => { try { cleanupDirs(TMP_HOME); } catch {} });

const { SKINS_DIR } = await import('../../server/routes/skins-packs.js');
const express = (await import('express')).default;
const skinsRouter = (await import('../../server/routes/skins-packs.js')).default;
const { clients } = await import('../../server/broadcast.js');

assert.ok(SKINS_DIR.startsWith(TMP_HOME), 'env: SKINS_DIR 在隔离 HOME 下(真实目录零触碰自证)');

// 假 WS 客户端:readyState=1(OPEN),记录每条消息(JSON.parse 还原)
const received = [];
const fakeClient = { readyState: 1, send(msg) { received.push(JSON.parse(msg)); } };
// 坏客户端:send 抛错且 readyState 变非 OPEN(广播连续性哨兵)
const badClient = { readyState: 1, send() { this.readyState = 3; throw new Error('boom'); } };

// 造两个皮肤目录(合法 id 形态 + skin.json,内容与 DELETE 无关,存在即可)
const ID_A = 'victim-skin-aa11bb';
const ID_B = 'victim-skin-cc22dd';
for (const id of [ID_A, ID_B]) {
  mkdirSync(join(SKINS_DIR, id), { recursive: true });
  writeFileSync(join(SKINS_DIR, id, 'skin.json'), JSON.stringify({ format: 'cgui-skin/1', name: id }));
}

const app = express();
app.use(express.json());
app.use('/api', skinsRouter);
let server = null;
let failure = null;
try {
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const BASE = `http://127.0.0.1:${server.address().port}`;
  clients.add(badClient);
  clients.add(fakeClient);

  // ③ 不存在的 id → 404 不广播(先测,清空基线)
  const nf = await fetch(`${BASE}/api/skins/no-such-skin-zz99`, { method: 'DELETE' });
  assert.equal(nf.status, 404, '③ 不存在 id 应 404');
  assert.equal(received.filter((m) => m.type === 'skins-changed').length, 0, '③ 404 不广播(误广播哨兵)');

  // ①②④ 删除成功 → 200 + 逐字 payload + 目录真删 + 坏客户端不阻断
  const r = await fetch(`${BASE}/api/skins/${ID_A}`, { method: 'DELETE' });
  assert.equal(r.status, 200, `① 删除应 200(实际 ${r.status})`);
  assert.ok(!existsSync(join(SKINS_DIR, ID_A)), '② 目录确实被删');
  const hit = received.find((m) => m.type === 'skins-changed');
  assert.ok(hit, '① 删除成功后必须广播 type=skins-changed(修前无任何广播,本条必红)');
  assert.deepEqual(Object.keys(hit).sort(), ['deletedId', 'type'], '① payload 键集合逐字 {type, deletedId}(C-D7 契约)');
  assert.equal(hit.deletedId, ID_A, '① deletedId === 被删 id');
  assert.ok(existsSync(join(SKINS_DIR, ID_B)), '④ 别的皮肤目录不受影响');

  // ① 再删一个,确认 deletedId 随目标变化(不是常量误报)
  const r2 = await fetch(`${BASE}/api/skins/${ID_B}`, { method: 'DELETE' });
  assert.equal(r2.status, 200, '① 第二次删除 200');
  const hit2 = received.filter((m) => m.type === 'skins-changed').pop();
  assert.equal(hit2.deletedId, ID_B, '① deletedId 随目标变化');
} catch (e) {
  failure = e;
} finally {
  clients.delete(fakeClient);
  clients.delete(badClient);
  await stopServer(server);
}
if (failure) throw failure;

console.log('PASS check-r26-skins-changed-broadcast');
