#!/usr/bin/env node
// r26-H4②【单测】:quota 探测走 assertPublicBaseURL 同口径 https 强制(复用 settings.js 导出)。
// 接线现状(PKG-10 已合):routes/provider-quota.js 探测前调 assertPublicBaseURL,
// 该守卫已强制「公网必须 https,http 仅回环豁免」。本测试钉住 quota 链路上的这层口径:
// 哨兵:①http 公网(8.8.8.8,IP 字面量不触 DNS)→ 拒,零上游请求;
// ②http://127.0.0.1 → 豁免放行,探测真打到本地假上游;
// ③https 回环(https://127.0.0.1)过了守卫(失败原因只能是 network 而非 blocked,
//   证明拦截点不在守卫);④quota 路由用的就是 settings.js 同一个导出(源码钉,防各自实现)。
// 隔离 HOME,假上游在 6703,绝不打真实第三方。跑完杀干净。
// Run: node tests/unit/check-r26-h4-quota-https-guard.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cgui-h4b-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const express = (await import('express')).default;
const quotaRouter = (await import('../../server/routes/provider-quota.js')).default;

const GUI = join(HOME, '.claude-gui');
await mkdir(GUI, { recursive: true });

let upstreamHits = 0;
const app = express();
app.use('/api', quotaRouter);
for (const ep of ['subscription', 'usage']) {
  app.get(`/relay/v1/dashboard/billing/${ep}`, (_req, res) => {
    upstreamHits++;
    res.json(ep === 'subscription'
      ? { object: 'billing_subscription', hard_limit_usd: 100 }
      : { object: 'list', total_usage: 5000 });
  });
}
const server = await new Promise((resolve, reject) => {
  const s = app.listen(6703, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});

await writeFile(join(GUI, 'custom-providers.json'), JSON.stringify([
  // http 公网 IP:守卫必须拦(https 强制),IP 字面量不触发真实 DNS
  { id: 'http-pub', name: 'http公网', type: 'openai', baseURL: 'http://8.8.8.8/v1', apiKey: 'dummy-h4', models: ['m'] },
  // http 回环:刻意豁免(本机中转是合法场景)
  { id: 'http-lo', name: 'http回环', type: 'openai', baseURL: 'http://127.0.0.1:6703/relay/v1', apiKey: 'dummy-h4', models: ['m'] },
  // https 回环:守卫放行,但 6703 是 http 服务 → 只会倒在网络上
  { id: 'https-lo', name: 'https回环', type: 'openai', baseURL: 'https://127.0.0.1:6703/relay/v1', apiKey: 'dummy-h4', models: ['m'] },
]));
const activate = (id) => writeFile(join(GUI, 'active-provider.json'), JSON.stringify({ id }));
const get = async () => (await fetch('http://127.0.0.1:6703/api/provider-quota')).json();

let n = 0;
let failure = null;
try {
  // ① http 公网 → 拒,零上游请求(https 强制哨兵)
  await activate('http-pub');
  const r1 = await get();
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'blocked', 'H4②: http 公网必须在探测前被守卫拦下');
  assert.equal(upstreamHits, 0, 'H4②: 被拦时一个请求都不许发');
  n += 3;

  // ② http://127.0.0.1 → 豁免放行(回环哨兵),探测真打到本地假上游
  await activate('http-lo');
  const r2 = await get();
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.ok(upstreamHits >= 2, 'H4②: http 回环豁免,探测正常打本地中转');
  n += 2;

  // ③ https 回环过守卫(失败也只能是 network:6703 说的是 http,TLS 握手必败)
  await activate('https-lo');
  const r3 = await get();
  assert.equal(r3.ok, false);
  assert.notEqual(r3.reason, 'blocked', 'H4②: https 回环不该被守卫拦(拦截点不在守卫)');
  assert.equal(r3.reason, 'network', 'H4②: 过了守卫,倒在协议不匹配(network)');
  n += 3;

  // ④ 源码钉:quota 路由复用 settings.js 的同一个 assertPublicBaseURL,不各自实现
  const src = readFileSync(new URL('../../server/routes/provider-quota.js', import.meta.url), 'utf8');
  assert.ok(/import \{[^}]*assertPublicBaseURL[^}]*\} from '\.\/settings\.js'/.test(src),
    'H4②: 必须复用 settings.js 导出的 assertPublicBaseURL');
  assert.ok(/await assertPublicBaseURL\(provider\.baseURL\)/.test(src), 'H4②: 探测前必须过守卫');
  n += 2;
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(HOME, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`PASS check-r26-h4-quota-https-guard (${n} assertions)`);
