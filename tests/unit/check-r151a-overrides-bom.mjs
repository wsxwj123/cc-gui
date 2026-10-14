#!/usr/bin/env node
// r151a 复审建议 2:provider-overrides.json 开头带 UTF-8 BOM 时,写入守卫 assertWritable(会先剥 BOM)判它可写,
// 两个写路由必须用守卫读到的那份值做读改写 —— 不能再用不剥 BOM 的 readProviderOverrides 读第二次(解析失败按空表写回,
// 其它 provider 的覆盖设置全丢)。以守卫的判定为准:可写 → 200,且其它 provider 的设置原样保留。
// node tests/unit/check-r151a-overrides-bom.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cgui-r151a-bom-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const GUI = join(home, '.claude-gui');
mkdirSync(GUI, { recursive: true });
mkdirSync(join(home, '.claude'), { recursive: true });
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }));
const prov = (id) => ({ id, name: id, type: 'anthropic', baseURL: `http://127.0.0.1:6997/lane/${id}`, apiKey: 'k', models: ['a', 'b'], defaultModel: 'a' });
writeFileSync(join(GUI, 'custom-providers.json'), JSON.stringify([prov('p0'), prov('p1'), prov('q0')]));
const OV = join(GUI, 'provider-overrides.json');
const BOM_CONTENT = `﻿${JSON.stringify({ p1: { defaultModel: 'b', tierModels: { opus: 'b' } } }, null, 2)}`;
const readOv = () => JSON.parse(readFileSync(OV, 'utf8').replace(/^﻿/, ''));

const { default: express } = await import('express');
const { default: settingsRouter } = await import('../../server/routes/settings.js');
const app = express();
app.use(express.json());
app.use('/api', settingsRouter);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const put = async (p, body) => { const r = await fetch(base + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j }; };

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
};
await check('PUT /api/auto-audit/model:覆盖层带 BOM → 200,其它 provider 的设置不丢', async () => {
  writeFileSync(OV, BOM_CONTENT);
  const r = await put('/api/auto-audit/model', { providerId: 'p0', model: 'b' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ov = readOv();
  assert.deepEqual(ov.p1, { defaultModel: 'b', tierModels: { opus: 'b' } }, 'p1 的覆盖设置应原样保留');
  assert.equal(ov.p0?.tierModels?.sonnet, 'b');
});
await check('PUT /api/provider-overrides/:id:覆盖层带 BOM → 200,其它 provider 的设置不丢', async () => {
  writeFileSync(OV, BOM_CONTENT);
  const r = await put('/api/provider-overrides/q0', { defaultModel: 'b' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ov = readOv();
  assert.deepEqual(ov.p1, { defaultModel: 'b', tierModels: { opus: 'b' } }, 'p1 的覆盖设置应原样保留');
  assert.equal(ov.q0?.defaultModel, 'b');
});

await new Promise((r) => server.close(r));
rmSync(home, { recursive: true, force: true });
if (failed) { console.log(`check-r151a-overrides-bom: ${failed} 项失败`); process.exit(1); }
console.log('check-r151a-overrides-bom: OK');
process.exit(0);
