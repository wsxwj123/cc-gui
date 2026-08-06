// 验收:隧道鉴权 —— POST /api/login 全矩阵 + 限速约定 + 登录态(TUNNEL-AUTH) + 幂等。
// 依据:INTERFACE-tunnel.md §2 表 3(含限速约定)。
// 需要真实密码:CGUI_TEST_PASSWORD 环境变量(密码是用户秘密,测试不写死、不打印)。
// 无密码时整组 SKIP(与 tests/acceptance 既有分层风格一致),退出码仍为 0。

import assert from 'node:assert/strict';
import {
  LAN_IP, forms, withCookie, PASSWORD,
  request, login, assertAuthStatus, assertLoginOk, assertLoginRejected, assertHostBlocked, assertTooMany,
  check, skip, summary, sleep,
} from './tunnel-lib.mjs';

const WRONG = `${PASSWORD}-definitely-wrong`;

console.log(`\n== login / 限速 / 幂等 ==`);

if (!PASSWORD) {
  skip('C组 login 矩阵 + 限速 + 幂等(共16条)',
    '缺 CGUI_TEST_PASSWORD(真实登录密码)。正确密码是成功路径/限速清桶/带cookie访问的前提,'
    + '测试不猜密码。重跑:CGUI_TEST_PASSWORD=<你的密码> bash tests/acceptance/run-tunnel.sh');
  summary('tunnel-login');
}

// ── C 组:POST /api/login(INTERFACE §2 表 3)───────────────────
await check('C1 LOCAL 正确密码 → 200 {ok:true} + Set-Cookie(HttpOnly/Path=/SameSite=Lax/Max-Age=2592000)', async () => {
  assertLoginOk(await login(forms.local(), PASSWORD), 'C1');
});

await check('C2 LOCAL 错误密码 → 401 {error:"密码错误"},绝不应发 Set-Cookie', async () => {
  assertLoginRejected(await login(forms.local(), WRONG), 'C2');
});

await check('C3 TUNNEL-ANON 正确密码 → 200 + Set-Cookie', async () => {
  assertLoginOk(await login(forms.tunnelAnon(), PASSWORD), 'C3');
});

await check('C4 TUNNEL-ANON 错误密码 → 401,不发 Set-Cookie', async () => {
  assertLoginRejected(await login(forms.tunnelAnon(), WRONG), 'C4');
});

await check('C5 FORGED-EVIL 正确密码 → 403(Host门在login之前,根本到不了)', async () => {
  assertHostBlocked(await login(forms.forgedEvil(), PASSWORD), 'C5');
});

await check('C6 FORGED-LOCALHOST 正确密码 → 200 + Set-Cookie(login正常到达)', async () => {
  assertLoginOk(await login(forms.forgedLocalhost(), PASSWORD), 'C6');
});

await check('C7 NO-CF-TUNNEL 正确密码 → 200 + Set-Cookie', async () => {
  assertLoginOk(await login(forms.noCfTunnel(), PASSWORD), 'C7');
});

if (!LAN_IP) {
  skip('C8 LAN 正确密码 → 200 + cookie', '无 LAN IP');
  skip('C9 LAN 错误密码 → 401 密码错误', '无 LAN IP');
} else {
  await check('C8 LAN 正确密码 → 200 + cookie(维持现状)', async () => {
    assertLoginOk(await login(forms.lan(), PASSWORD), 'C8');
  });
  await check('C9 LAN 错误密码 → 401 密码错误', async () => {
    assertLoginRejected(await login(forms.lan(), WRONG), 'C9');
  });
}

// ── 登录态(TUNNEL-AUTH)回填 auth-status / 受保护API 两格 ────────
let tunnelCookie = null;
{
  const r = await login(forms.tunnelAnon(), PASSWORD);
  if (r.token) tunnelCookie = `cgui_token=${r.token}`;
}
await check('A3 TUNNEL-AUTH: auth-status → required:true authed:true isLocal:false', async () => {
  assert.ok(tunnelCookie, '前置:隧道登录拿 cookie 失败');
  const r = await request(withCookie(forms.tunnelAnon, tunnelCookie), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: true, authed: true, isLocal: false }, 'A3');
});

await check('B3 TUNNEL-AUTH: 受保护 /api/* → 200 业务 JSON', async () => {
  assert.ok(tunnelCookie, '前置:隧道登录拿 cookie 失败');
  const r = await request(withCookie(forms.tunnelAnon, tunnelCookie), { path: process.env.CGUI_TEST_PROTECTED_PATH || '/api/model' });
  assert.equal(r.status, 200, 'B3 状态码');
  assert.ok(r.json !== null, 'B3 应是 JSON');
});

// ── 限速约定(429)──────────────────────────────────────────────
// 桶是纯内存、按形态分桶;每个限速用例用独占 CF-Connecting-IP,互不污染。
await check('C10 限速分桶:两个不同 CF-Connecting-IP 的隧道桶互不相坐(A锁了B还能试)', async () => {
  const A = '198.51.100.11';
  const B = '198.51.100.22';
  // A 桶连错 5 次 → 全部 401(第5次失败后才起锁)
  for (let i = 1; i <= 5; i++) {
    const r = await login(forms.tunnelAnon(A), WRONG);
    assert.equal(r.status, 401, `C10 A桶第${i}次应401而非${r.status}`);
  }
  // A 锁了(1s窗口),B 桶第一次尝试必须不受连坐:401 而非 429
  const rb = await login(forms.tunnelAnon(B), WRONG);
  assert.equal(rb.status, 401, `C10 B桶应401不连坐,实际${rb.status}`);
  assert.equal(rb.json?.error, '密码错误', 'C10 B桶 error');
  // A 桶锁定期间第 6 次 → 429
  assertTooMany(await login(forms.tunnelAnon(A), WRONG), 'C10 A桶第6次');
});

if (!LAN_IP) skip('C11 LAN伪造CF头连错5次,第6次必429', '无 LAN IP');
else await check('C11 LAN形态伪造CF-Ray+随机CF-Connecting-IP:伪造头不得换桶,连错5次后第6次必429', async () => {
  // 先成功登录清空 LAN 桶(隔离 C8/C9 留下的计数)
  assertLoginOk(await login(forms.lan(), PASSWORD), 'C11 清桶');
  for (let i = 1; i <= 5; i++) {
    // socket 非回环 → 前置条件不成立 → 按 socket(LAN IP)单桶计,随机 CF-Connecting-IP 不得换桶
    const f = { target: LAN_IP, headers: { 'CF-Ray': `forged-${i}`, 'CF-Connecting-IP': `203.0.113.${100 + i}` } };
    const r = await login(f, WRONG);
    assert.equal(r.status, 401, `C11 第${i}次应401,实际${r.status}(伪造头换桶会导致永远到不了阈值)`);
  }
  const f6 = { target: LAN_IP, headers: { 'CF-Ray': 'forged-6', 'CF-Connecting-IP': '203.0.113.200' } };
  assertTooMany(await login(f6, WRONG), 'C11 第6次');
  // 收尾:等出 1s 锁定窗口并清桶,避免影响后续用例
  await sleep(1200);
  await login(forms.lan(), PASSWORD);
});

await check('C12 登录成功立即清空该桶(锁定过后成功登录,再错3次不429)', async () => {
  const IP = '198.51.100.33';
  for (let i = 1; i <= 5; i++) {
    assert.equal((await login(forms.tunnelAnon(IP), WRONG)).status, 401, `C12 第${i}次`);
  }
  assertTooMany(await login(forms.tunnelAnon(IP), WRONG), 'C12 锁定期间');
  await sleep(1200); // 只等第一档 1s 锁,不等指数退避
  assertLoginOk(await login(forms.tunnelAnon(IP), PASSWORD), 'C12 锁过后正确密码应能登录');
  // 桶已清:再错 3 次,若没清会接着旧计数(≥6)直接429
  for (let i = 1; i <= 3; i++) {
    const r = await login(forms.tunnelAnon(IP), WRONG);
    assert.equal(r.status, 401, `C12 清桶后第${i}次应401(若429说明桶没清)`);
  }
});

// ── 幂等 / 重复 ───────────────────────────────────────────────
await check('J1 同一正确密码重复登录:两次都200,两个token都可用', async () => {
  const r1 = await login(forms.tunnelAnon('203.0.113.41'), PASSWORD);
  const r2 = await login(forms.tunnelAnon('203.0.113.41'), PASSWORD);
  assertLoginOk(r1, 'J1 第1次');
  assertLoginOk(r2, 'J1 第2次');
  const p = process.env.CGUI_TEST_PROTECTED_PATH || '/api/model';
  assert.equal((await request(withCookie(forms.tunnelAnon, `cgui_token=${r1.token}`), { path: p })).status, 200, 'J1 token1 可用');
  assert.equal((await request(withCookie(forms.tunnelAnon, `cgui_token=${r2.token}`), { path: p })).status, 200, 'J1 token2 可用');
});

await check('J2 同一cookie重复访问受保护API:连续3次都200,行为一致', async () => {
  assert.ok(tunnelCookie, '前置:隧道登录拿 cookie 失败');
  const p = process.env.CGUI_TEST_PROTECTED_PATH || '/api/model';
  for (let i = 1; i <= 3; i++) {
    const r = await request(withCookie(forms.tunnelAnon, tunnelCookie), { path: p });
    assert.equal(r.status, 200, `J2 第${i}次`);
  }
});

summary('tunnel-login');
