#!/usr/bin/env node
// r26-J11【单测】:inflight 按槽位分槽,快速切换 provider 不互踩。
// 修前:inflight 单槽 —— A 在飞时切到 B 顶掉槽位,立刻切回 A 又起一份新探测
// (A 的上游被打两次,且 B 的并发订阅者合并不上)。
// 哨兵:A(慢上游 300ms)在飞时,切 B 打一发、切回 A 再打一发 ——
//   A 上游只被打【一轮】(req3 合并进 req1 的在飞探测),B 独立一轮;
//   三份响应都 ok 且数据各自正确。
// 隔离 HOME,假上游全在同一个临时口。跑完杀干净。
// Run: node tests/unit/check-r26-j11-inflight-per-slot.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cgui-j11-'));
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
// A:慢上游(300ms 才回),制造"在飞"窗口
for (const ep of ['subscription', 'usage']) {
  app.get(`/slow-a/v1/dashboard/billing/${ep}`, (_req, res) => {
    hitsA++;
    setTimeout(() => {
      res.json(ep === 'subscription'
        ? { object: 'billing_subscription', hard_limit_usd: 100 }
        : { object: 'list', total_usage: 5000 });
    }, 300);
  });
}
// B:快上游,立即回
for (const ep of ['subscription', 'usage']) {
  app.get(`/fast-b/v1/dashboard/billing/${ep}`, (_req, res) => {
    hitsB++;
    res.json(ep === 'subscription'
      ? { object: 'billing_subscription', hard_limit_usd: 200 }
      : { object: 'list', total_usage: 10000 });
  });
}
const server = await new Promise((resolve, reject) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
  s.once('error', reject);
});

await writeFile(join(GUI, 'custom-providers.json'), JSON.stringify([
  { id: 'pa', name: 'A慢', type: 'openai', baseURL: `http://127.0.0.1:${server.address().port}/slow-a/v1`, apiKey: 'dummy-a', models: ['m'] },
  { id: 'pb', name: 'B快', type: 'openai', baseURL: `http://127.0.0.1:${server.address().port}/fast-b/v1`, apiKey: 'dummy-b', models: ['m'] },
]));
const activate = (id) => writeFile(join(GUI, 'active-provider.json'), JSON.stringify({ id }));
const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/provider-quota`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
let failure = null;
try {
  await activate('pa');
  let r1Settled = false;
  const req1 = get().then((d) => { r1Settled = true; return d; }); // A 在飞(300ms)
  await sleep(50);          // 确保 req1 已进入探测
  await activate('pb');
  const r2 = await get();   // B 并发(快)—— 等它完成再切回,防测试夹具自己竞态
  assert.equal(r1Settled, false, '夹具:B 完成时 A 必须仍在飞(否则窗口没造出来)');
  n += 1;
  await activate('pa');
  const req3 = get();       // 切回 A:必须合并进 req1 的在飞探测,不得再起一份
  const [r1, r3] = await Promise.all([req1, req3]);

  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r3.ok, true, JSON.stringify(r3));
  n += 3;
  assert.equal(r1.providerId, 'pa');
  assert.equal(r2.providerId, 'pb');
  assert.equal(r3.providerId, 'pa', 'J11: 切回 A 拿到的是 A 的数据(不是 B 顶槽后的错配)');
  n += 3;
  assert.equal(hitsA, 2, `J11: A 两条端点各一次(req3 合并进在飞探测)—— 实际 ${hitsA},>2 说明互踩重探`);
  assert.equal(hitsB, 2, `J11: B 两条端点各一次(不被 A 的在飞阻塞/顶掉)—— 实际 ${hitsB}`);
  n += 2;
  assert.equal(r1.items[0].value, 50, 'J11: A 数据正确(100 − 5000/100)');
  assert.equal(r2.items[0].value, 100, 'J11: B 数据正确(200 − 10000/100)');
  assert.deepEqual(r3.items, r1.items, 'J11: req3 与 req1 同一份结果(合并哨兵)');
  n += 3;
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(HOME, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`PASS check-r26-j11-inflight-per-slot (${n} assertions)`);
