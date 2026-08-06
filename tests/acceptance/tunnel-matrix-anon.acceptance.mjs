// 验收:隧道鉴权 —— 只读端点行为矩阵(INTERFACE-tunnel.md §2 的 auth-status / 受保护API / 页面 / health / HTTP1.0 / CF头枚举)。
// 全部是不需要有效密码的形态;需要密码的 TUNNEL-AUTH 格在 tunnel-login.acceptance.mjs。
// 由 run-tunnel.sh 调用(已起好独立端口的测试 server、已写入占位 tunnelHostname)。

import assert from 'node:assert/strict';
import {
  TUNNEL, LAN_IP, forms, withCookie, FORGED_TOKEN_COOKIE,
  request, http10NoHostAuthStatus, assertAuthStatus, assertUnauthorized, assertHostBlocked,
  check, skip, summary,
} from './tunnel-lib.mjs';

// INTERFACE 指定以 /api/model 为受保护端点样例
const PROTECTED = process.env.CGUI_TEST_PROTECTED_PATH || '/api/model';

console.log(`\n== 只读矩阵 == 隧道域名=${TUNNEL} 受保护端点=${PROTECTED} LAN_IP=${LAN_IP}`);

// ── A 组:GET /api/auth-status(INTERFACE §2 表 1)──────────────
await check('A1 LOCAL: auth-status → 200 required:false authed:true isLocal:true(本机免密)', async () => {
  const r = await request(forms.local(), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: false, authed: true, isLocal: true }, 'A1');
});

await check('A2 TUNNEL-ANON: auth-status → required:true authed:false isLocal:false', async () => {
  const r = await request(forms.tunnelAnon(), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: true, authed: false, isLocal: false }, 'A2');
});

await check('A4 FORGED-EVIL(Host=evil.com): auth-status → 403 DNS-rebinding', async () => {
  assertHostBlocked(await request(forms.forgedEvil(), { path: '/api/auth-status' }), 'A4');
});

await check('A5 FORGED-LOCALHOST(Host=localhost+CF-Ray): 200 但绝不可 isLocal:true', async () => {
  const r = await request(forms.forgedLocalhost(), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: true, authed: false, isLocal: false }, 'A5');
  assert.notEqual(r.json.isLocal, true, 'A5 冒充本机绝不可判 isLocal:true');
});

await check('A6 NO-CF-TUNNEL(Host=隧道域名、无CF头): 不免密(Host非本机集即外部)', async () => {
  const r = await request(forms.noCfTunnel(), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: true, authed: false, isLocal: false }, 'A6');
});

if (!LAN_IP) skip('A7 LAN: auth-status → 不免密', '探测不到 en* 网卡的 LAN IPv4');
else await check('A7 LAN(socket非回环、Host=LAN IP): auth-status → 不免密', async () => {
  const r = await request(forms.lan(), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: true, authed: false, isLocal: false }, 'A7');
});

await check('A8 伪造token(隧道形态): auth-status → 视为无cookie(authed:false)', async () => {
  const r = await request(withCookie(forms.tunnelAnon, FORGED_TOKEN_COOKIE), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: true, authed: false, isLocal: false }, 'A8');
});

await check('A9 伪造token(LOCAL形态): 本机不看token,仍 authed:true isLocal:true', async () => {
  const r = await request(withCookie(forms.local, FORGED_TOKEN_COOKIE), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: false, authed: true, isLocal: true }, 'A9');
});

// ── B 组:GET 受保护 /api/*(INTERFACE §2 表 2)─────────────────
await check(`B1 LOCAL: ${PROTECTED} → 200 业务 JSON`, async () => {
  const r = await request(forms.local(), { path: PROTECTED });
  assert.equal(r.status, 200, 'B1 状态码');
  assert.ok(r.json !== null, 'B1 应是 JSON');
});

await check(`B2 TUNNEL-ANON: ${PROTECTED} → 401 unauthorized+authRequired`, async () => {
  assertUnauthorized(await request(forms.tunnelAnon(), { path: PROTECTED }), 'B2');
});

await check(`B4 FORGED-EVIL: ${PROTECTED} → 403`, async () => {
  assertHostBlocked(await request(forms.forgedEvil(), { path: PROTECTED }), 'B4');
});

await check(`B5 FORGED-LOCALHOST: ${PROTECTED} → 401(不免密)`, async () => {
  assertUnauthorized(await request(forms.forgedLocalhost(), { path: PROTECTED }), 'B5');
});

await check(`B6 NO-CF-TUNNEL: ${PROTECTED} → 401(无CF头也不免密)`, async () => {
  assertUnauthorized(await request(forms.noCfTunnel(), { path: PROTECTED }), 'B6');
});

if (!LAN_IP) skip(`B7 LAN: ${PROTECTED} → 401`, '无 LAN IP');
else await check(`B7 LAN(无cookie): ${PROTECTED} → 401`, async () => {
  assertUnauthorized(await request(forms.lan(), { path: PROTECTED }), 'B7');
});

await check(`B8 伪造token(隧道形态): ${PROTECTED} → 401`, async () => {
  assertUnauthorized(await request(withCookie(forms.tunnelAnon, FORGED_TOKEN_COOKIE), { path: PROTECTED }), 'B8');
});

await check(`B9 伪造token(LOCAL形态): ${PROTECTED} → 200(本机免密与token无关)`, async () => {
  const r = await request(withCookie(forms.local, FORGED_TOKEN_COOKIE), { path: PROTECTED });
  assert.equal(r.status, 200, 'B9 状态码');
  assert.ok(r.json !== null, 'B9 应是 JSON');
});

// ── E 组:GET / 页面(INTERFACE §2 表 5)────────────────────────
const assertHtml = (r, ctx) => {
  assert.equal(r.status, 200, `${ctx} 状态码`);
  assert.match(r.text, /</, `${ctx} 应返回 HTML`);
};
await check('E1 LOCAL: / → 200 HTML', async () => assertHtml(await request(forms.local()), 'E1'));
await check('E2 TUNNEL-ANON: / → 200 HTML(登录页由前端渲染,页面本身不拦)', async () =>
  assertHtml(await request(forms.tunnelAnon()), 'E2'));
await check('E3 FORGED-EVIL: / → 403', async () =>
  assertHostBlocked(await request(forms.forgedEvil()), 'E3'));
await check('E4a FORGED-LOCALHOST: / → 200(页面可加载,受保护数据仍401)', async () =>
  assertHtml(await request(forms.forgedLocalhost()), 'E4a'));
await check('E4b NO-CF-TUNNEL: / → 200', async () =>
  assertHtml(await request(forms.noCfTunnel()), 'E4b'));
if (!LAN_IP) skip('E5 LAN: / → 200', '无 LAN IP');
else await check('E5 LAN: / → 200', async () => assertHtml(await request(forms.lan()), 'E5'));

// ── F 组:GET /api/health 始终免密(INTERFACE §2 表 6)───────────
const assertHealth = (r, ctx) => {
  assert.equal(r.status, 200, `${ctx} 状态码`);
  assert.equal(r.json?.ok, true, `${ctx} ok`);
  assert.equal(r.json?.app, 'claude-gui', `${ctx} app 字段`);
};
await check('F1 LOCAL: /api/health → 200 {ok:true,app:claude-gui}', async () =>
  assertHealth(await request(forms.local(), { path: '/api/health' }), 'F1'));
await check('F2 TUNNEL-ANON: /api/health → 200(隧道也要能探活)', async () =>
  assertHealth(await request(forms.tunnelAnon(), { path: '/api/health' }), 'F2'));
if (!LAN_IP) skip('F3 LAN: /api/health → 200', '无 LAN IP');
else await check('F3 LAN: /api/health → 200', async () =>
  assertHealth(await request(forms.lan(), { path: '/api/health' }), 'F3'));
await check('F4 FORGED-EVIL: /api/health → 403(health 也过 Host 门)', async () =>
  assertHostBlocked(await request(forms.forgedEvil(), { path: '/api/health' }), 'F4'));

// ── G 组:HTTP/1.0 整体缺 Host(INTERFACE §2 末表)───────────────
await check('G1 LOCAL HTTP/1.0 无Host: 过Host门 + 本机免密(authed:true isLocal:true)', async () => {
  const r = await http10NoHostAuthStatus('127.0.0.1');
  assert.equal(r.status, 200, 'G1 状态码');
  assertAuthStatus(r.json, { required: false, authed: true, isLocal: true }, 'G1');
});

if (!LAN_IP) skip('G2 LAN socket HTTP/1.0 无Host: → 外部', '无 LAN IP');
else await check('G2 LAN socket HTTP/1.0 无Host: 本机性两信号缺一 → 外部(authed:false)', async () => {
  const r = await http10NoHostAuthStatus(LAN_IP);
  assert.equal(r.status, 200, 'G2 状态码');
  assertAuthStatus(r.json, { required: true, authed: false, isLocal: false }, 'G2');
});

// ── H 组:CF 四枚举头各自单独破缺(INTERFACE §4 不变量1)─────────
// LOCAL 形态 + 单个枚举头 → 三条件缺一,绝不可免密
for (const [name, header] of [
  ['H1 cf-ray', { 'CF-Ray': 'solo' }],
  ['H2 cf-connecting-ip', { 'CF-Connecting-IP': '203.0.113.9' }],
  ['H3 cf-visitor', { 'CF-Visitor': '{"scheme":"https"}' }],
  ['H4 cf-ipcountry', { 'CF-IPCountry': 'CN' }],
]) {
  await check(`${name} 单独出现在LOCAL请求上 → 不免密(authed:false isLocal:false)`, async () => {
    const r = await request({ target: '127.0.0.1', headers: header }, { path: '/api/auth-status' });
    assert.equal(r.status, 200);
    assertAuthStatus(r.json, { required: true, authed: false, isLocal: false }, name);
  });
}

await check('H5 cdn-loop(非枚举cf-*头)不参与判定: LOCAL+cdn-loop → 仍免密', async () => {
  const r = await request({ target: '127.0.0.1', headers: { 'CDN-Loop': 'cloudflare' } }, { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: false, authed: true, isLocal: true }, 'H5');
});

// ── I3:配置即时生效(本文件在 run-tunnel.sh 写入 tunnelHostname 之后、
//    同一 server 进程下运行;相位1已证明同进程此前对该域名 403)────────
await check('I3 tunnelHostname 每请求现读:server未重启,tunnel域名从403变为可达(非403)', async () => {
  const r = await request(forms.tunnelAnon(), { path: '/api/auth-status' });
  assert.equal(r.status, 200, 'I3 状态码(若仍403说明配置未即时生效)');
});

summary('tunnel-matrix-anon');
