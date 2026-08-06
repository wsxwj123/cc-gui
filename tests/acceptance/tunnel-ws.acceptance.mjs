// 验收:隧道鉴权 —— WebSocket /ws 握手判定(INTERFACE-tunnel.md §2 表 4 + §4 不变量4)。
// 判定与 REST 同一套:同形态不允许"REST 401 但 WS 101"。
// 用项目已有依赖 ws 发升级请求;拒绝 = 非 101(握手失败)。

import assert from 'node:assert/strict';
import {
  LAN_IP, forms, withCookie, FORGED_TOKEN_COOKIE, PASSWORD,
  login, wsAttempt, check, skip, summary,
} from './tunnel-lib.mjs';

console.log('\n== WebSocket /ws ==');

const assertRejected = (r, ctx) => {
  assert.equal(r.upgraded, false, `${ctx} 绝不可 101 升级成功${r.error ? `(实际:${r.error})` : ''}`);
};

await check('D1 LOCAL: WS 握手 → 101 升级成功(本机免密)', async () => {
  const r = await wsAttempt(forms.local());
  assert.equal(r.upgraded, true, `D1 应升级成功${r.error ? `(实际:${r.error})` : ''}`);
});

await check('D2 TUNNEL-ANON(无cookie): WS → 拒绝(与REST的401同判定)', async () => {
  assertRejected(await wsAttempt(forms.tunnelAnon()), 'D2');
});

await check('D4 伪造token(隧道形态): WS → 拒绝', async () => {
  assertRejected(await wsAttempt(withCookie(forms.tunnelAnon, FORGED_TOKEN_COOKIE)), 'D4');
});

await check('D5 FORGED-EVIL: WS → 拒绝(Host门)', async () => {
  assertRejected(await wsAttempt(forms.forgedEvil()), 'D5');
});

await check('D6 FORGED-LOCALHOST(无cookie): WS → 拒绝,绝不可101', async () => {
  assertRejected(await wsAttempt(forms.forgedLocalhost()), 'D6');
});

await check('D7 NO-CF-TUNNEL(无cookie): WS → 拒绝', async () => {
  assertRejected(await wsAttempt(forms.noCfTunnel()), 'D7');
});

if (!LAN_IP) skip('D8a LAN(无cookie): WS → 拒绝', '无 LAN IP');
else await check('D8a LAN(无cookie): WS → 拒绝', async () => {
  assertRejected(await wsAttempt(forms.lan()), 'D8a');
});

// 需要真实密码的两格:带有效 cookie → 101
if (!PASSWORD) {
  skip('D3 TUNNEL-AUTH: WS 带有效cookie → 101', '缺 CGUI_TEST_PASSWORD');
  skip('D8b LAN 带有效cookie: WS → 101', '缺 CGUI_TEST_PASSWORD');
} else {
  const lr = await login(forms.tunnelAnon(), PASSWORD);
  const cookie = lr.token ? `cgui_token=${lr.token}` : null;

  if (!cookie) skip('D3 TUNNEL-AUTH: WS 带有效cookie → 101', '前置登录未拿到 token');
  else await check('D3 TUNNEL-AUTH: WS 带有效 cgui_token → 101 升级成功', async () => {
    const r = await wsAttempt(withCookie(forms.tunnelAnon, cookie));
    assert.equal(r.upgraded, true, `D3 应升级成功${r.error ? `(实际:${r.error})` : ''}`);
  });

  if (!LAN_IP) skip('D8b LAN 带有效cookie: WS → 101', '无 LAN IP');
  else if (!cookie) skip('D8b LAN 带有效cookie: WS → 101', '前置登录未拿到 token');
  else await check('D8b LAN 带有效cookie: WS → 101(维持现状)', async () => {
    const r = await wsAttempt(withCookie(forms.lan, cookie));
    assert.equal(r.upgraded, true, `D8b 应升级成功${r.error ? `(实际:${r.error})` : ''}`);
  });
}

summary('tunnel-ws');
