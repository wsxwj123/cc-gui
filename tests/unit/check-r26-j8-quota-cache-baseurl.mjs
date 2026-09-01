#!/usr/bin/env node
// r26-J8【单测】:额度缓存/冷却/端点 memo 的键必须含 baseURL 指纹。
// 修前:键只按 providerId(+key 指纹)—— 编辑 baseURL(换端点)后同 id 同 key,
// 仍回放旧端点的缓存/吃旧端点的冷却。
// 哨兵:①同 providerId 换 baseURL → 重新探测(串缓存哨兵:hitsB 从 0 涨);
// ②改回原 baseURL → 命中旧缓存,零新请求(指纹稳定哨兵:hitsA 不涨);
// ③keyTag 既有语义不回退(换 key 仍失效,回归由 check-provider-quota-probe 覆盖)。
// 隔离 HOME,假上游全在同一个临时口,绝不打真实第三方。跑完杀干净。
// Run: node tests/unit/check-r26-j8-quota-cache-baseurl.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cgui-j8-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const express = (await import('express')).default;
const quotaRouter = (await import('../../server/routes/provider-quota.js')).default;

const GUI = join(HOME, '.claude-gui');
await mkdir(GUI, { recursive: true });

let hitsA = 0;
let hitsB = 0;
const app = express();
app.use('/api', quotaRouter);
// 两套 One-API 系端点(A/B 各一),hash 键之外的差异只有 baseURL
for (const [tag, bump] of [['a', () => hitsA++], ['b', () => hitsB++]]) {
  app.get(`/relay-${tag}/v1/dashboard/billing/subscription`, (_req, res) => {
    bump();
    res.json({ object: 'billing_subscription', hard_limit_usd: 100 });
  });
  app.get(`/relay-${tag}/v1/dashboard/billing/usage`, (_req, res) => {
    bump();
    res.json({ object: 'list', total_usage: 9500 });
  });
}
const server = await new Promise((resolve, reject) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});

const setBaseURL = async (base) => {
  await writeFile(join(GUI, 'custom-providers.json'), JSON.stringify([
    { id: 'p1', name: '同 id 换端点', type: 'openai', baseURL: base, apiKey: 'dummy-j8', models: ['m'] },
  ]));
  await writeFile(join(GUI, 'active-provider.json'), JSON.stringify({ id: 'p1' }));
};
const get = async () => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/provider-quota`);
  return r.json();
};

let n = 0;
let failure = null;
try {
  const A = `http://127.0.0.1:${server.address().port}/relay-a/v1`;
  const B = `http://127.0.0.1:${server.address().port}/relay-b/v1`;

  // 端点 A 首查:真探测(两条端点各一次)
  await setBaseURL(A);
  const r1 = await get();
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(hitsA, 2, '夹具:A 首查打两条端点');
  n += 2;

  // ① 同 providerId 同 key,只换 baseURL → 必须重新探测(不吃 A 的缓存)
  await setBaseURL(B);
  const r2 = await get();
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(hitsB, 2, 'J8: 换 baseURL 必须重新探测(串缓存哨兵)');
  assert.equal(hitsA, 2, 'J8: 换 baseURL 后 A 不再被打');
  n += 3;

  // ② 改回 A → 命中旧缓存(60s 内),零新请求(指纹稳定哨兵)
  await setBaseURL(A);
  const r3 = await get();
  assert.equal(r3.ok, true);
  assert.equal(hitsA, 2, 'J8: 改回原 baseURL 命中旧缓存,不重复探测');
  assert.deepEqual(r3.items, r1.items, 'J8: 回放的是 A 的那份数据');
  n += 3;
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(HOME, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`PASS check-r26-j8-quota-cache-baseurl (${n} assertions)`);
