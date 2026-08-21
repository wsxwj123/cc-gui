#!/usr/bin/env node
// r26-H1【复现+错误路径】:permission hook 零鉴权,本机任意进程可仿冒 allow。
// 攻击模型:同机恶意进程(无 WS、无密码)枚举 GET /api/permissions/pending 拿到等待中的
// 请求 id,直接 POST /api/permissions/respond/:id {decision:'allow'} → 挂起的 hook 立刻
// 拿到「用户允许」→ 危险命令被执行。全程不需要任何凭证。
// 修复后期望:dispatch 时下发一次性 secret(nonce 存 slot,经 broadcast 到已认证客户端),
// respond 不携带/携带错误 nonce 必须被拒,挂起请求绝不被 settle 成 allow。
// 端口:6703 临时桩,跑完杀干净。
// Run: node tests/acceptance/r26/h1-permission-respond-nonce.mjs
import assert from 'node:assert/strict';
import { listenWithRetry, stopServer, sleep } from './lib.mjs';

const express = (await import('express')).default;
const permRouter = (await import('../../../server/routes/permissions.js')).default;
const { clients } = await import('../../../server/broadcast.js');

// 伪装成一个已连 WS 客户端,接收 broadcast(合法前端拿 nonce 的通道)
const broadcasts = [];
const fakeWs = { readyState: 1, send: (m) => { try { broadcasts.push(JSON.parse(m)); } catch {} } };
clients.add(fakeWs);

const app = express();
app.use(express.json());
app.use('/api', permRouter);

let server = null;
let failure = null;
try {
  server = await listenWithRetry(6703, (p) => app.listen(p, '127.0.0.1'));
  const BASE = 'http://127.0.0.1:6703';

  // ① hook 打进来一个危险命令的授权请求(挂起等用户)
  const ac = new AbortController();
  let hookResult = null;
  const held = fetch(`${BASE}/api/permissions/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolName: 'Bash', toolInput: { command: 'rm -rf ~' }, sessionId: 'victim-s', cwd: '/tmp' }),
    signal: ac.signal,
  }).then((r) => r.json()).then((j) => { hookResult = j; }).catch(() => {});

  // 等 broadcast 把请求推出来(拿到 id —— 与攻击者枚举 pending 等价)
  let reqMsg = null;
  for (let i = 0; i < 40 && !reqMsg; i++) {
    reqMsg = broadcasts.find((b) => b.type === 'permission:request' && b.request?.sessionId === 'victim-s');
    if (!reqMsg) await sleep(25);
  }
  assert.ok(reqMsg?.request?.id, 'H1 夹具:permission:request 广播应到达');
  const { id } = reqMsg.request;
  // 修复后 nonce 应随 broadcast 下发(记下来,后面验证合法路径)
  const nonce = reqMsg.request.nonce ?? reqMsg.nonce ?? null;

  // ② 攻击者视角:pending 可枚举(修前)——无论修后是否还枚举,都试试直接仿冒 respond
  const attack = await fetch(`${BASE}/api/permissions/respond/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'allow' }),
  });
  const attackJson = await attack.json().catch(() => null);

  await sleep(300); // 给 settle 一个窗口

  // 核心断言(修前必红):无 nonce 的 respond 不得生效 —— 挂起的 hook 绝不允许收到 allow
  assert.ok(!hookResult || hookResult.decision !== 'allow',
    `H1: 无凭证的 respond 把危险命令仿冒成了 allow(挂起方收到 ${JSON.stringify(hookResult)})`);
  const allowBroadcast = broadcasts.find((b) => b.type === 'permission:resolved' && b.id === id && b.decision === 'allow');
  assert.ok(!allowBroadcast, 'H1: 无 nonce 的 respond 不得广播 permission:resolved allow');
  assert.ok(
    attack.status === 401 || attack.status === 403 || attack.status === 409 || attackJson?.ok === false,
    `H1: 无 nonce 的 respond 应被拒(实际 ${attack.status} ${JSON.stringify(attackJson)})`,
  );

  // ③ 错误 nonce 同样必须被拒(若修复经 broadcast 下发了 nonce,才验这条)
  if (nonce) {
    const bad = await fetch(`${BASE}/api/permissions/respond/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', nonce: 'wrong-nonce-000' }),
    });
    await sleep(200);
    assert.ok(!hookResult || hookResult.decision !== 'allow', 'H1: 错误 nonce 同样不得 settle 成 allow');

    // ④ 合法路径:带正确 nonce 的 respond 必须正常生效(防修复把正常流程也锁死)
    const legit = await fetch(`${BASE}/api/permissions/respond/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow', nonce }),
    });
    assert.equal(legit.status, 200, 'H1: 带正确 nonce 的合法 respond 必须照常工作');
    await sleep(200);
    assert.equal(hookResult?.decision, 'allow', 'H1: 合法 respond 后挂起方收到 allow');
  } else {
    console.log('  (i) broadcast 未见 nonce 字段,跳过合法路径验证(若修复走别的下发通道,请补锚)');
  }

  ac.abort();
  await held;
} catch (e) {
  failure = e;
} finally {
  clients.delete(fakeWs);
  await stopServer(server);
}
if (failure) throw failure;

console.log('PASS r26-h1-permission-respond-nonce');
