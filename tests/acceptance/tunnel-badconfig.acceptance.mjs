// 验收:隧道鉴权 —— 非法 tunnelHostname 值(INTERFACE §3:写错不炸,只表现为隧道域名依旧403)。
// 相位3专用:run-tunnel.sh 每次写入一种非法值后调用本文件(非法值打印在 run.sh 输出里)。
// 覆盖两类非法形态:带 scheme("https://...")、带端口("...:443")。

import assert from 'node:assert/strict';
import {
  LAN_IP, forms,
  request, assertAuthStatus, assertUnauthorized,
  check, skip, summary,
} from './tunnel-lib.mjs';

console.log('\n== 相位3:非法 tunnelHostname 值 ==');

await check('V1 非法值不产生任何放行:隧道域名 auth-status → 依旧403', async () => {
  const r = await request(forms.tunnelAnon(), { path: '/api/auth-status' });
  assert.equal(r.status, 403, `V1 状态码(实际${r.status},非法值被当成合法配置=放行事故)`);
});

await check('V2 非法值下 LOCAL 免密不受影响', async () => {
  const r = await request(forms.local(), { path: '/api/auth-status' });
  assert.equal(r.status, 200);
  assertAuthStatus(r.json, { required: false, authed: true, isLocal: true }, 'V2');
});

if (!LAN_IP) skip('V3 非法值下 LAN → 401 不受影响', '无 LAN IP');
else await check('V3 非法值下 LAN 受保护API → 401 不受影响', async () => {
  assertUnauthorized(await request(forms.lan(), { path: process.env.CGUI_TEST_PROTECTED_PATH || '/api/model' }), 'V3');
});

summary('tunnel-badconfig');
