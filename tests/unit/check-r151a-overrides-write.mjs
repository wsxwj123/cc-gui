#!/usr/bin/env node
// r151a 审查建议 1、2:provider-overrides.json 的两个写入口
//   PUT /api/auto-audit/model 与既有 PUT /api/provider-overrides/:id。
//   建议 1:文件损坏时写入前用 assertWritable 拦下 → 500 STORAGE_WRITE_FAILED、文件原样、留 .corrupt-<时间戳> 备份
//          (此前按空表整份写回,其它 provider 的覆盖设置全丢且不留备份)。
//   建议 2:两个入口并发写互不吞掉(都在 provider 切换的串行队列里做读改写)。
// 隔离 HOME,直接挂 settings 路由;provider 都不在用,不触发重切。
// node tests/unit/check-r151a-overrides-write.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cgui-r151a-ovw-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const GUI = join(home, '.claude-gui');
mkdirSync(GUI, { recursive: true });
mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }));
const N = 8;
const prov = (id) => ({ id, name: id, type: 'anthropic', baseURL: `http://127.0.0.1:6997/lane/${id}`, apiKey: 'k', models: ['a', 'b'], defaultModel: 'a' });
writeFileSync(join(GUI, 'custom-providers.json'), JSON.stringify([
  ...Array.from({ length: N }, (_, i) => prov(`p${i}`)), ...Array.from({ length: N }, (_, i) => prov(`q${i}`)),
]));
const OV = join(GUI, 'provider-overrides.json');

const { default: express } = await import('express');
const { default: settingsRouter } = await import('../../server/routes/settings.js');
const app = express();
app.use(express.json());
app.use('/api', settingsRouter);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const put = async (p, body) => { const r = await fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j }; };
const STORAGE = { ok: false, code: 'STORAGE_WRITE_FAILED', error: '保存失败，请重试' };

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
};
const backups = () => readdirSync(GUI).filter((n) => /^provider-overrides\.json\.corrupt-\d+$/.test(n));

// ── 建议 1:损坏时不写回 ──
const BROKEN = '{ "p1": { "defaultModel": "b" }, 损坏';
await check('PUT /api/auto-audit/model:覆盖层损坏 → 500 STORAGE_WRITE_FAILED、文件原样、留备份', async () => {
  writeFileSync(OV, BROKEN);
  const r = await put('/api/auto-audit/model', { providerId: 'p0', model: 'b' });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.deepEqual(r.body, STORAGE);
  assert.equal(readFileSync(OV, 'utf8'), BROKEN, '损坏的文件一个字不动');
  assert.ok(backups().length >= 1, '应留 provider-overrides.json.corrupt-<时间戳> 备份');
});
await check('PUT /api/provider-overrides/:id:覆盖层损坏 → 500 STORAGE_WRITE_FAILED、文件原样', async () => {
  writeFileSync(OV, BROKEN);
  const r = await put('/api/provider-overrides/q0', { defaultModel: 'b' });
  assert.equal(r.status, 500, JSON.stringify(r.body));
  assert.deepEqual(r.body, STORAGE);
  assert.equal(readFileSync(OV, 'utf8'), BROKEN);
  assert.ok(backups().length >= 1);
});

// ── 建议 2:并发写互不吞掉 ──
await check(`两个入口并发写 ${N}+${N} 次:每一笔都留在覆盖层里(重复 3 轮)`, async () => {
  for (let round = 0; round < 3; round++) {
    writeFileSync(OV, '{}');
    const reqs = [];
    for (let i = 0; i < N; i++) {
      reqs.push(put('/api/auto-audit/model', { providerId: `p${i}`, model: 'b' }));
      reqs.push(put(`/api/provider-overrides/q${i}`, { defaultModel: 'b' }));
    }
    const res = await Promise.all(reqs);
    assert.ok(res.every((r) => r.status === 200), `第 ${round + 1} 轮:都应 200(${JSON.stringify(res.filter((r) => r.status !== 200).slice(0, 2))})`);
    const ov = JSON.parse(readFileSync(OV, 'utf8'));
    const lostP = Array.from({ length: N }, (_, i) => `p${i}`).filter((id) => ov[id]?.tierModels?.sonnet !== 'b');
    const lostQ = Array.from({ length: N }, (_, i) => `q${i}`).filter((id) => ov[id]?.defaultModel !== 'b');
    assert.deepEqual([...lostP, ...lostQ], [], `第 ${round + 1} 轮被吞掉的写入`);
  }
});

await new Promise((r) => server.close(r));
rmSync(home, { recursive: true, force: true });
if (failed) { console.log(`check-r151a-overrides-write: ${failed} 项失败`); process.exit(1); }
console.log('check-r151a-overrides-write: OK');
process.exit(0);
