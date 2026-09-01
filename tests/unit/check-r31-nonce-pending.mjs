#!/usr/bin/env node
// r31:P2【死循环根治】 —— GET /api/permissions/pending 对所有【已认证】请求一律带 nonce。
//
// 死循环根因(修前):LAN 手机客户端(已有有效 token、经 authMiddleware 放行)刷新页面后
// 从 /permissions/pending 补拉挂起卡;旧实现用 `withNonce = isLocalReq(req)` 把非本机
// (LAN/经隧道)来源的卡片剥掉 nonce → 卡片无 nonce → 该端 respond 必 403 → 前端把 403
// 当终态撤卡 → 25s 对账又把同一张卡补回 → 永久死循环;自动放行路径的卡片根本不出现。
// 安全分析:WS broadcast 已把 nonce 推给所有已认证连接,pending 对已认证请求剥离 nonce
// 没有增加任何安全性(能连上已认证 WS 的本机进程本就看得见 nonce),反而打坏手机合法
// 补拉通道。修法:删掉 isLocalReq 条件,pending 对到达该接口的请求(上游已认证)全部带 nonce。
//
// 断言(修前红):
//   ① LAN 来源(remoteAddress 伪装非回环)pending 必须含 nonce 且与 broadcast 逐字一致,
//     并能据此 respond 200 settle 成 allow —— 旧实现缺 nonce 恒 403,本断言红;
//   ② loopback 来源 pending 仍带 nonce(回归:H1 既有通道不回归);
//   ③ 无 nonce 的 respond 恒 403 防线回归不放松(防剥 nonce 的同时别把 H1 闸门放水)。
// 端口取 OS 临时口(listen(0),真实端口从 server.address() 读回);loopback 与 LAN 伪装各占一个,跑完关干净。
// Run: node tests/unit/check-r31-nonce-pending.mjs
import assert from 'node:assert/strict';

const express = (await import('express')).default;
const permRouter = (await import('../../server/routes/permissions.js')).default;
const { requestPermission } = await import('../../server/routes/permissions.js');
const { clients } = await import('../../server/broadcast.js');

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

// 伪装已连 WS 客户端,收 broadcast(合法前端拿 nonce 的通道)
const broadcasts = [];
const fakeWs = { readyState: 1, send: (m) => { try { broadcasts.push(JSON.parse(m)); } catch {} } };
clients.add(fakeWs);

// LAN 伪装中间件:把 remoteAddress 改写成非回环(模拟手机/*经隧道*客户端)。
const lanApp = express();
lanApp.use(express.json());
lanApp.use((req, _res, next) => {
  Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.50', configurable: true });
  next();
});
lanApp.use('/api', permRouter);

const app = express();
app.use(express.json());
app.use('/api', permRouter);

const server = await new Promise((res, rej) => {
  const s = app.listen(0, '127.0.0.1', () => res(s));
  s.once('error', rej);
});
const lanServer = await new Promise((res, rej) => {
  const s = lanApp.listen(0, '127.0.0.1', () => res(s));
  s.once('error', rej);
});

const BASE = `http://127.0.0.1:${server.address().port}`;
const LAN = `http://127.0.0.1:${lanServer.address().port}`;
const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

let failure = null;
try {
  // 夹具:SDK canUseTool 形态(resolve-backed slot)→ broadcast 推 nonce 给已认证 WS。
  let sdkResult = null;
  const sdkPromise = requestPermission({ toolName: 'Bash', toolInput: { command: 'rm -rf ~' }, sessionId: 'r31-nonce-s1', cwd: '/tmp' })
    .then((j) => { sdkResult = j; });

  let reqMsg = null;
  for (let i = 0; i < 60 && !reqMsg; i++) {
    reqMsg = broadcasts.find((b) => b.type === 'permission:request' && b.request?.sessionId === 'r31-nonce-s1');
    if (!reqMsg) await new Promise((r) => setTimeout(r, 25));
  }
  ok(reqMsg?.request?.id, '夹具:permission:request 广播应到达');
  ok(typeof reqMsg.request.nonce === 'string' && reqMsg.request.nonce.length >= 32, 'broadcast 副本必须带 nonce');
  const { id } = reqMsg.request;
  const nonce = reqMsg.request.nonce;

  // ① LAN 来源 pending:必须含 nonce 且与 broadcast 逐字一致(修前红)。
  const pendLan = await (await fetch(`${LAN}/api/permissions/pending`)).json();
  const lanItem = pendLan.items.find((it) => it.id === id);
  ok(lanItem, 'LAN 来源 GET pending 应列出挂起请求');
  ok(lanItem.nonce === nonce, `修前红:LAN 来源 pending 必须带 nonce(实际 ${JSON.stringify(lanItem)})`);

  // ② LAN 客户端拿该 nonce respond → 200,resolve 成 allow(死循环根治)。
  const lanRespond = await post(LAN, `/api/permissions/respond/${id}`, { decision: 'allow', nonce });
  ok(lanRespond.status === 200, `LAN 客户端带 nonce respond 必须 200(实际 ${lanRespond.status})`);
  await sdkPromise;
  ok(sdkResult?.decision === 'allow', 'LAN 客户端合法 respond 后挂起方收到 allow');

  // ③ 无 nonce 的 respond 恒 403(H1 防线不因本次改动放松)。
  let sdkResult2 = null;
  const sdkPromise2 = requestPermission({ toolName: 'Write', toolInput: { file_path: '/tmp/x' }, sessionId: 'r31-nonce-s2', cwd: '/tmp' })
    .then((j) => { sdkResult2 = j; });
  let reqMsg2 = null;
  for (let i = 0; i < 60 && !reqMsg2; i++) {
    reqMsg2 = broadcasts.find((b) => b.type === 'permission:request' && b.request?.sessionId === 'r31-nonce-s2');
    if (!reqMsg2) await new Promise((r) => setTimeout(r, 25));
  }
  ok(reqMsg2?.request?.id, '夹具2:广播到达');
  const noNonce = await post(LAN, `/api/permissions/respond/${reqMsg2.request.id}`, { decision: 'allow' });
  ok(noNonce.status === 403, `无 nonce respond 必须 403(实际 ${noNonce.status})`);
  await new Promise((r) => setTimeout(r, 150));
  ok(!sdkResult2 || sdkResult2.decision !== 'allow', '无 nonce 不得 settle 成 allow');

  // 回归②:loopback 来源 pending 仍带 nonce(H1 既有通道不回归)。
  let reqMsg3 = null;
  const sdkPromise3 = requestPermission({ toolName: 'Read', toolInput: { file_path: '/tmp/y' }, sessionId: 'r31-nonce-s3', cwd: '/tmp' })
    .then((j) => { reqMsg3 = j; });
  for (let i = 0; i < 60 && !broadcasts.find((b) => b.type === 'permission:request' && b.request?.sessionId === 'r31-nonce-s3'); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const id3 = broadcasts.find((b) => b.type === 'permission:request' && b.request?.sessionId === 'r31-nonce-s3').request.id;
  const pendLocal = await (await fetch(`${BASE}/api/permissions/pending`)).json();
  const localItem = pendLocal.items.find((it) => it.id === id3);
  ok(localItem?.nonce, 'loopback 来源 pending 仍必须带 nonce(回归)');
  ok(localItem.nonce === broadcasts.find((b) => b.type === 'permission:request' && b.request?.sessionId === 'r31-nonce-s3').request.nonce,
    'loopback 来源 pending nonce 与 broadcast 逐字一致');
  await post(BASE, `/api/permissions/respond/${id3}`, { decision: 'deny', nonce: localItem.nonce });
  void sdkPromise3;
} catch (e) {
  failure = e;
} finally {
  clients.delete(fakeWs);
  server.closeAllConnections?.();
  lanServer.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await new Promise((r) => lanServer.close(r));
}
if (failure) throw failure;
console.log(`PASS check-r31-nonce-pending (${n} assertions)`);
