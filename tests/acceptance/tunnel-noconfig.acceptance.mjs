// 验收:隧道鉴权 —— 回归零差异(INTERFACE §3 缺省行为 + §4 不变量3)。
// 相位1专用:run-tunnel.sh 在启动测试 server 前已把 tunnelHostname 从 network.json 移除。
// 此时隧道域名必须依旧 403(与改动前逐格一致),其余行为不变。

import assert from 'node:assert/strict';
import {
  TUNNEL, LAN_IP, forms,
  request, assertAuthStatus, assertUnauthorized, assertHostBlocked,
  check, skip, summary,
} from './tunnel-lib.mjs';

console.log(`\n== 相位1:未配置 tunnelHostname(回归零差异)== 隧道域名=${TUNNEL}`);

await check('N1 未配置时隧道域名 auth-status → 403(改动前行为,绝不可放行)', async () => {
  const r = await request(forms.tunnelAnon(), { path: '/api/auth-status' });
  assert.equal(r.status, 403, `N1 状态码(实际${r.status},若200说明缺省值被当配置)`);
});

await check('N2 未配置时隧道域名 受保护/api/* → 403', async () => {
  const r = await request(forms.tunnelAnon(), { path: process.env.CGUI_TEST_PROTECTED_PATH || '/api/model' });
  assert.equal(r.status, 403, `N2 状态码(实际${r.status})`);
});

await check('N3 未配置时 LOCAL 免密不变(authed:true isLocal:true)', async () => {
  const r = await request(forms.local(), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: false, authed: true, isLocal: true }, 'N3');
});

await check('N4 未配置时 FORGED-EVIL → 403 不变', async () => {
  assertHostBlocked(await request(forms.forgedEvil(), { path: '/api/auth-status' }), 'N4');
});

if (!LAN_IP) skip('N5 未配置时 LAN 受保护API → 401 不变', '无 LAN IP');
else await check('N5 未配置时 LAN 受保护API → 401 不变', async () => {
  assertUnauthorized(await request(forms.lan(), { path: process.env.CGUI_TEST_PROTECTED_PATH || '/api/model' }), 'N5');
});

summary('tunnel-noconfig');
