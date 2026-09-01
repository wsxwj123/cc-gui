#!/usr/bin/env node
// r26-H4① 单测:PUT custom-providers 改 baseURL 的同源闸 —— quotaKey 随端点变更清除。
// 隔离 HOME(mkdtemp),回环 baseURL 过 SSRF 闸且永不真连。端口取 OS 临时口(listen(0),真实端口从 server.address() 读回)。
// 哨兵:①改 baseURL 未给新 quotaKey → 落盘 quotaKey 消失 + 响应 quotaKeyCleared:true;
// ②baseURL 不变 → quotaKey 保留且无标记;③改 baseURL 同时显式给新 quotaKey → 新值保留
// (用户同一次保存里显式重新配对,不算"旧 key 错配端点");④GET 永不回传明文(顺带钉)。
// Run: node tests/unit/check-quota-key-origin-guard.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };

const home = await mkdtemp(join(tmpdir(), 'cgui-h4-'));
process.env.HOME = home; // 必须先于 import
process.env.USERPROFILE = home; // Windows 上 homedir() 读 %USERPROFILE%,不同设沙箱失效

const express = (await import('express')).default;
const settingsRoutes = (await import('../../server/routes/settings.js')).default;

const FILE = join(home, '.claude-gui', 'custom-providers.json');
const disk = async () => JSON.parse(await readFile(FILE, 'utf8'));

const app = express();
app.use(express.json());
app.use('/api', settingsRoutes);
const server = await new Promise((res, rej) => {
  const s = app.listen(0, '127.0.0.1', () => res(s));
  s.once('error', rej);
});
const BASE = `http://127.0.0.1:${server.address().port}/api/custom-providers`;
const post = (body) => fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (id, body) => fetch(`${BASE}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let failure = null;
try {
  // 夹具:带 quotaKey 的 provider
  const created = await (await post({
    name: 'h4-a', type: 'openai', baseURL: 'http://127.0.0.1:9',
    apiKey: 'sk-dummy-a', quotaKey: 'qk-dummy-a', models: ['m1'],
  })).json();
  ok(created.id, '夹具:创建带 quotaKey 的 provider');
  ok((await disk())[0].quotaKey === 'qk-dummy-a', '夹具:quotaKey 已落盘');

  // ② baseURL 不变 → quotaKey 保留、无标记(防误清哨兵)
  const same = await (await put(created.id, {
    name: 'h4-a', type: 'openai', baseURL: 'http://127.0.0.1:9', models: ['m1'],
  })).json();
  ok(same.quotaKeyCleared !== true, 'baseURL 不变不得打 quotaKeyCleared 标记');
  ok((await disk())[0].quotaKey === 'qk-dummy-a', 'baseURL 不变 quotaKey 必须保留');

  // ① 改 baseURL 未给新 quotaKey → 清除 + 标记(同源闸哨兵)
  const changed = await (await put(created.id, {
    name: 'h4-a', type: 'openai', baseURL: 'http://127.0.0.1:10', models: ['m1'],
  })).json();
  ok(changed.quotaKeyCleared === true, '改 baseURL 必须打 quotaKeyCleared 标记(前端据此提示)');
  ok(!('quotaKey' in (await disk())[0]), '改 baseURL 后落盘 quotaKey 必须消失');

  // ③ 改 baseURL 同时显式给新 quotaKey → 新值保留(显式重新配对,不算错配)
  const repaired = await (await put(created.id, {
    name: 'h4-a', type: 'openai', baseURL: 'http://127.0.0.1:11', quotaKey: 'qk-dummy-new', models: ['m1'],
  })).json();
  ok(repaired.quotaKeyCleared !== true, '同次保存显式给新 quotaKey 不算"被清除"');
  ok((await disk())[0].quotaKey === 'qk-dummy-new', '显式给的新 quotaKey 落盘');

  // ④ GET 列表永不回传明文(既有口径顺带钉住:quotaKey 只能以 hasQuotaKey 布尔出现)
  const list = await (await fetch(BASE)).json();
  const row = (list.providers || list.items || list).find?.((p) => p.id === created.id) || null;
  ok(row && !('quotaKey' in row) && !('apiKey' in row), 'GET 列表绝不含明文 key');
  ok(row.hasQuotaKey === true, 'GET 以 hasQuotaKey 布尔表达');
} catch (e) {
  failure = e;
} finally {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}
if (failure) throw failure;
console.log(`PASS check-quota-key-origin-guard (${n} assertions)`);
