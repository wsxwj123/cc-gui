#!/usr/bin/env node
// r26-I2【单测·服务端半】:PUT /prefs/hidden-projects 成功后补 WS 广播。
// 验收点(PLAN I2 + 契约 C-I2):
//   ①PUT 成功后广播 payload 逐字 {type:'hidden-projects', hidden} —— 事件类型名与
//     字段名是 PKG-2(WS reducer → store.hiddenProjects)/PKG-11(只读 store)的消费
//     契约,逐字钉死;
//   ②hidden 字段内容与 PUT 的数组逐字相等(含顺序);
//   ③400 拒绝(非法 body)不广播(误广播哨兵);
//   ④GET 不广播(读路径无副作用哨兵);
//   ⑤广播失败不影响响应(广播在 try/catch 内,照 pinned 同款 —— 用坏客户端验证不炸)。
// Run: node tests/unit/check-r26-i2-hidden-projects-broadcast.mjs
import assert from 'node:assert/strict';
import { makeTmpHome, cleanupDirs, listenWithRetry, stopServer } from '../acceptance/r26/lib.mjs';

const TMP_HOME = makeTmpHome('i2-unit'); // prefs.js 顶层固化 PREFS_PATH,先隔离 HOME

const express = (await import('express')).default;
const prefsRouter = (await import('../../server/routes/prefs.js')).default;
const { clients } = await import('../../server/broadcast.js');

// 假 WS 客户端:readyState=1(OPEN),记录每条收到的消息(JSON.parse 还原)
const received = [];
const fakeClient = {
  readyState: 1,
  send(msg) { received.push(JSON.parse(msg)); },
};

const app = express();
app.use(express.json());
app.use('/api', prefsRouter);

let server = null;
let failure = null;
try {
  server = await listenWithRetry(6704, (p) => app.listen(p, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6704';
  clients.add(fakeClient);

  // ①②契约哨兵:PUT 成功 → 收到逐字 {type:'hidden-projects', hidden}
  const hidden = ['hashA', 'hashB', 'hashC'];
  const r = await fetch(`${BASE}/api/prefs/hidden-projects`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden }),
  });
  assert.equal(r.status, 200, 'I2: PUT 应成功');
  const hit = received.find((m) => m.type === 'hidden-projects');
  assert.ok(hit, 'I2: PUT 成功后必须广播 type=hidden-projects(修前无任何广播,本条必红)');
  assert.deepEqual(Object.keys(hit).sort(), ['hidden', 'type'], 'I2: payload 键集合逐字 {type, hidden}(C-I2 契约)');
  assert.deepEqual(hit.hidden, hidden, 'I2: hidden 字段与 PUT 数组逐字相等(含顺序)');

  // 更新一次再验证广播跟随最新值
  received.length = 0;
  const hidden2 = ['hashB'];
  await fetch(`${BASE}/api/prefs/hidden-projects`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: hidden2 }),
  });
  const hit2 = received.find((m) => m.type === 'hidden-projects');
  assert.ok(hit2 && hit2.hidden.length === 1 && hit2.hidden[0] === 'hashB',
    'I2: 第二次 PUT 广播应携带最新 hidden');

  // ③误广播哨兵:非法 body 400,不得广播
  received.length = 0;
  const bad = await fetch(`${BASE}/api/prefs/hidden-projects`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: 'not-an-array' }),
  });
  assert.equal(bad.status, 400, 'I2 夹具:非法 body 应 400');
  assert.equal(received.filter((m) => m.type === 'hidden-projects').length, 0,
    'I2: 400 拒绝不得广播 hidden-projects');

  // ④读路径哨兵:GET 不得广播
  received.length = 0;
  const g = await fetch(`${BASE}/api/prefs/hidden-projects`);
  assert.equal(g.status, 200, 'I2 夹具:GET 应 200');
  assert.equal(received.filter((m) => m.type === 'hidden-projects').length, 0,
    'I2: GET 不得广播 hidden-projects');

  // ⑤坏客户端不炸:send 抛错的客户端不得让 PUT 失败(照 pinned 同款 try/catch)
  const badClient = { readyState: 1, send() { throw new Error('ws boom'); } };
  clients.add(badClient);
  const r5 = await fetch(`${BASE}/api/prefs/hidden-projects`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: [] }),
  });
  clients.delete(badClient);
  assert.equal(r5.status, 200, 'I2: 个别客户端广播失败不得影响 PUT 响应');
} catch (e) {
  failure = e;
} finally {
  clients.delete(fakeClient);
  await stopServer(server);
  cleanupDirs(TMP_HOME);
}
if (failure) throw failure;

console.log('PASS check-r26-i2-hidden-projects-broadcast');
