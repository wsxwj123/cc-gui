#!/usr/bin/env node
// r26-H1 单测:permission respond 一次性 nonce。
// 哨兵:①无 nonce respond 必 403;②错 nonce 必 403 且响应体不泄露正确值;
// ③对 nonce(body)通过且挂起方收到 allow;④X-CGUI-Nonce 头通道同样通过;
// ⑤loopback GET pending 含 nonce 且与 broadcast 逐字一致;
// ⑥非 loopback(remoteAddress 伪装成 LAN)GET pending 【换锚 r31】:一律含 nonce 且与
//   broadcast 逐字一致(旧「非 loopback 不含 nonce」锚已废弃,原因见 ⑥ 注释);
// ⑦slot 关闭后旧 nonce 不能二次 settle(无第二条 allow 广播)。
// 端口取 OS 临时口(listen(0),真实端口从 server.address() 读回),跑完关干净。Run: node tests/unit/check-permission-nonce.mjs
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

// LAN 伪装中间件:把 remoteAddress 改写成非回环,验证 GET pending 的 nonce 闸。
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
  // ── 夹具 A:hook bridge 形态(res-backed slot)────────────────────────────
  let hookResult = null;
  const held = post(BASE, '/api/permissions/request', {
    toolName: 'Bash', toolInput: { command: 'rm -rf ~' }, sessionId: 'nonce-s1', cwd: '/tmp',
  }).then((r) => r.json()).then((j) => { hookResult = j; }).catch(() => {});

  let reqMsg = null;
  for (let i = 0; i < 60 && !reqMsg; i++) {
    reqMsg = broadcasts.find((b) => b.type === 'permission:request' && b.request?.sessionId === 'nonce-s1');
    if (!reqMsg) await new Promise((r) => setTimeout(r, 25));
  }
  ok(reqMsg?.request?.id, '夹具:permission:request 广播应到达');
  ok(typeof reqMsg.request.nonce === 'string' && reqMsg.request.nonce.length >= 32,
    'broadcast 的 request 副本必须带 nonce(H1 下发通道)');
  const { id } = reqMsg.request;
  const nonce = reqMsg.request.nonce;

  // ⑤ loopback GET pending:含 nonce 且与 broadcast 逐字一致(重连回补通道)
  const pendLocal = await (await fetch(`${BASE}/api/permissions/pending`)).json();
  const localItem = pendLocal.items.find((it) => it.id === id);
  ok(localItem, 'loopback GET pending 应列出挂起请求');
  ok(localItem.nonce === nonce, 'loopback GET pending 的 nonce 必须与 broadcast 逐字一致');

  // ⑥ 非 loopback(remoteAddress 伪装成 LAN)GET pending:【换锚】r31 起对所有已认证请求
  //    一律带 nonce(见 check-r31-nonce-pending.mjs)。旧实现的「非 loopback 不含 nonce」锚
  //    已废弃:该接口上游经 authMiddleware,能到这里就已认证;broadcast 也早把 nonce 推给
  //    所有已认证连接,剥离只打坏 LAN 客户端刷新后的合法补拉(死循环),不增加安全性。
  const pendLan = await (await fetch(`${LAN}/api/permissions/pending`)).json();
  const lanItem = pendLan.items.find((it) => it.id === id);
  ok(lanItem, '非 loopback GET pending 仍应列出请求本体');
  ok(lanItem.nonce === nonce, '非 loopback(已认证)GET pending 必须带 nonce 且与 broadcast 逐字一致');

  // ① 无 nonce respond → 403,挂起方不得收到 allow
  const noNonce = await post(BASE, `/api/permissions/respond/${id}`, { decision: 'allow' });
  ok(noNonce.status === 403, `无 nonce respond 必须 403(实际 ${noNonce.status})`);
  await new Promise((r) => setTimeout(r, 200));
  ok(!hookResult || hookResult.decision !== 'allow', '无 nonce 不得 settle 成 allow');

  // ② 错 nonce → 403,且响应体不泄露正确值
  const badNonce = await post(BASE, `/api/permissions/respond/${id}`, { decision: 'allow', nonce: 'wrong-nonce-000' });
  ok(badNonce.status === 403, `错 nonce respond 必须 403(实际 ${badNonce.status})`);
  const badBody = await badNonce.text();
  ok(!badBody.includes(nonce), '403 响应体不得泄露正确 nonce');
  await new Promise((r) => setTimeout(r, 200));
  ok(!hookResult || hookResult.decision !== 'allow', '错 nonce 不得 settle 成 allow');

  // ③ 对 nonce(body)→ 200,挂起方收到 allow
  const legit = await post(BASE, `/api/permissions/respond/${id}`, { decision: 'allow', nonce });
  ok(legit.status === 200, `对 nonce 必须通过(实际 ${legit.status})`);
  await held;
  ok(hookResult?.decision === 'allow', '合法 respond 后挂起方应收到 allow');

  // ⑦ slot 已关闭:旧 nonce 不能再造成第二次 settle(幂等语义:无第二条 allow 广播)
  const resolvedAllows = () =>
    broadcasts.filter((b) => b.type === 'permission:resolved' && b.id === id && b.decision === 'allow').length;
  const before = resolvedAllows();
  await post(BASE, `/api/permissions/respond/${id}`, { decision: 'allow', nonce });
  await new Promise((r) => setTimeout(r, 150));
  ok(resolvedAllows() === before, 'slot 关闭后旧 nonce 不得二次 settle(幂等)');

  // ── 夹具 B:SDK canUseTool 形态(resolve-backed slot)+ ④ 头通道 ──────────
  let sdkResult = null;
  const sdkPromise = requestPermission({ toolName: 'Write', toolInput: { file_path: '/tmp/x' }, sessionId: 'nonce-s2', cwd: '/tmp' })
    .then((j) => { sdkResult = j; });
  let reqMsg2 = null;
  for (let i = 0; i < 60 && !reqMsg2; i++) {
    reqMsg2 = broadcasts.find((b) => b.type === 'permission:request' && b.request?.sessionId === 'nonce-s2');
    if (!reqMsg2) await new Promise((r) => setTimeout(r, 25));
  }
  ok(reqMsg2?.request?.nonce, 'SDK canUseTool 形态的 broadcast 同样带 nonce');
  const id2 = reqMsg2.request.id;
  const noNonce2 = await post(BASE, `/api/permissions/respond/${id2}`, { decision: 'allow' });
  ok(noNonce2.status === 403, 'SDK 形态:无 nonce 同样 403(两通道同闸)');
  // ④ X-CGUI-Nonce 头通道(头优先于 body)
  const headerOk = await post(BASE, `/api/permissions/respond/${id2}`,
    { decision: 'allow', nonce: 'body-should-be-ignored' },
    { 'X-CGUI-Nonce': reqMsg2.request.nonce });
  ok(headerOk.status === 200, 'X-CGUI-Nonce 头通道必须通过(头优先,body 错值被忽略)');
  await sdkPromise;
  ok(sdkResult?.decision === 'allow', 'SDK 形态合法 respond 后 resolve allow');
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
console.log(`PASS check-permission-nonce (${n} assertions)`);
