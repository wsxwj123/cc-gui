// 验收:隧道 http→https 301 跳转(修复"http 下 Secure cookie 拒存 → 登录死循环")。
// 约定(INTERFACE 级):Host===tunnelHostname 且 CF-Visitor 的 JSON 里 scheme==="http"
//   → 301,Location === https://<Host><原始路径>;其余一切请求行为不变。
// 修前这些请求返回 200,复现测试(R1-R3)必失败 —— 正中 bug。

import assert from 'node:assert/strict';
import {
  TUNNEL, forms, request, assertAuthStatus, check, summary,
} from './tunnel-lib.mjs';

// 隧道形态 + CF-Visitor
const tunnelWithVisitor = (scheme) => ({
  target: '127.0.0.1',
  headers: {
    Host: TUNNEL,
    'CF-Ray': 'test-ray-abc',
    'CF-Connecting-IP': '203.0.113.9',
    'CF-Visitor': JSON.stringify({ scheme }),
  },
});

const assertRedirect = (r, path, ctx) => {
  assert.equal(r.status, 301, `${ctx} 状态码(修前是200)`);
  assert.equal(r.headers.location, `https://${TUNNEL}${path}`, `${ctx} Location 头`);
};

console.log(`\n== 隧道 http→https 301 == 隧道域名=${TUNNEL}`);

// ── 复现测试:修前必失败 ──────────────────────────────────────
await check('R1 隧道+CF-Visitor{scheme:http}: GET / → 301 到 https://<域名>/', async () => {
  assertRedirect(await request(tunnelWithVisitor('http'), { path: '/' }), '/', 'R1');
});

await check('R2 隧道+CF-Visitor{scheme:http}: GET /api/auth-status → 301', async () => {
  assertRedirect(await request(tunnelWithVisitor('http'), { path: '/api/auth-status' }), '/api/auth-status', 'R2');
});

await check('R3 隧道+CF-Visitor{scheme:http}: POST /api/login → 301(让流量上https)', async () => {
  const r = await request(tunnelWithVisitor('http'), { method: 'POST', path: '/api/login', body: { password: 'whatever' } });
  assertRedirect(r, '/api/login', 'R3');
});

// ── 相邻回归:不该跳的一律不跳 ────────────────────────────────
await check('R4a 隧道+CF-Visitor{scheme:https}: GET / → 200,不301', async () => {
  const r = await request(tunnelWithVisitor('https'), { path: '/' });
  assert.equal(r.status, 200, 'R4a 状态码');
});

await check('R4b 隧道+CF-Visitor{scheme:https}: auth-status 按矩阵原行为(required:true authed:false)', async () => {
  const r = await request(tunnelWithVisitor('https'), { path: '/api/auth-status' });
  assert.equal(r.status, 200, 'R4b 状态码');
  assertAuthStatus(r.json, { required: true, authed: false, isLocal: false }, 'R4b');
});

await check('R5 隧道域名但完全不带CF-Visitor: GET / → 200,不301(NO-CF语义不变)', async () => {
  const r = await request(forms.noCfTunnel(), { path: '/' });
  assert.equal(r.status, 200, 'R5 状态码');
});

await check('R6 LOCAL伪造CF-Visitor{scheme:http}: GET / → 200,不301(本机行为绝不受影响)', async () => {
  const r = await request({ target: '127.0.0.1', headers: { 'CF-Visitor': '{"scheme":"http"}' } }, { path: '/' });
  assert.equal(r.status, 200, 'R6 状态码');
});

await check('R7 隧道+CF-Visitor畸形JSON: GET / → 不301、不500(按原逻辑处理)', async () => {
  const r = await request({
    target: '127.0.0.1',
    headers: { Host: TUNNEL, 'CF-Ray': 'test-ray-abc', 'CF-Connecting-IP': '203.0.113.9', 'CF-Visitor': 'not-json{' },
  }, { path: '/' });
  assert.notEqual(r.status, 301, 'R7 畸形JSON绝不可触发301');
  assert.ok(r.status < 500, `R7 不可5xx(实际${r.status})`);
  assert.equal(r.status, 200, 'R7 按原逻辑应200');
});

summary('tunnel-http-redirect');
