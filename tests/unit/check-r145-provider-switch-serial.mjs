#!/usr/bin/env node
// r145 F3:provider 切换没有互斥 —— 上游(进程内单一变量)以"后设置"为准、settings.json 以"后写入"为准,
// 两次切换重叠时两者可分属两家:界面显示的是 B,对话实际发往 A 并用 A 的密钥计费;写 settings.json
// 失败时接口回 500,但代理上游已经换了。修好后:
//   · 同一进程内 切换 / 保存后自动重切 / 删除在用 provider 串行执行;
//   · 重叠的两次切换结束后,代理上游、settings.json、active 标记指向同一家(后到者);
//   · 写盘失败时上游保持切换前的值。
// 观测全走真实行为:代理上游 = 向本地 anthropic 代理发 GET /v1/models,看它转发到了哪个假上游(A / B);
// settings.json = 读盘看 env.ANTHROPIC_MODEL;active = 读 ~/.claude-gui/active-provider.json。
// 重叠要确定性地复现,只能拉长第一次切换的写盘:包装 fs/promises.writeFile(syncBuiltinESMExports),
// 仅对 settings.json 的"下一次"写入插 400ms 延迟 —— 时序注入,不替换任何被测逻辑。写盘失败用 chmod 0444 真失败。
// 临时 HOME;代理、假上游、express 全在 6700–6999。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { isolateHome, writeFakeCommand, listenInRange, pickPortInRange, assertPortAllowed, makeChecker } from './r145-helpers/common.mjs';

const { home, bin, cleanup } = isolateHome('f3');
writeFakeCommand(bin, 'security', 'process.exit(1);\n');
const SETTINGS = join(home, '.claude', 'settings.json');
const GUI_DIR = join(home, '.claude-gui');
const ACTIVE = join(GUI_DIR, 'active-provider.json');
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(GUI_DIR, { recursive: true });
writeFileSync(SETTINGS, JSON.stringify({ hooks: { PreToolUse: [] }, permissions: { allow: ['Bash(ls:*)'] } }, null, 2));

// ── 时序注入:只拦 settings.json 的下一次 writeFile ─────────────────────────
const require = createRequire(import.meta.url);
const fsp = require('fs/promises');
const realWriteFile = fsp.writeFile;
let writePlan = null; // { ms, onStart }
fsp.writeFile = async function patchedWriteFile(file, ...rest) {
  if (writePlan && String(file) === SETTINGS) {
    const p = writePlan;
    writePlan = null;
    p.onStart();
    await new Promise((r) => setTimeout(r, p.ms));
  }
  return realWriteFile.call(this, file, ...rest);
};
syncBuiltinESMExports();
const delayNextSettingsWrite = (ms = 400) => new Promise((started) => { writePlan = { ms, onStart: started }; });

// ── 两个假上游 A / B ─────────────────────────────────────────────────────────
const mkUpstream = (who) => createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ who })); });
const upA = mkUpstream('A');
const upB = mkUpstream('B');
const portA = await listenInRange(upA);
const portB = await listenInRange(upB);
const PROVIDERS = {
  A: { id: 'r145-a', name: 'A', type: 'anthropic', baseURL: `http://127.0.0.1:${portA}`, apiKey: 'sk-r145-a', models: ['model-a'] },
  B: { id: 'r145-b', name: 'B', type: 'anthropic', baseURL: `http://127.0.0.1:${portB}`, apiKey: 'sk-r145-b', models: ['model-b'] },
};
writeFileSync(join(GUI_DIR, 'custom-providers.json'), JSON.stringify([PROVIDERS.A, PROVIDERS.B], null, 2));

const anthProxy = await import('../../server/services/anthropic-proxy.js');
const proxyPort = await anthProxy.startAnthropicProxy(await pickPortInRange());
assertPortAllowed(proxyPort, 'anthropic 代理');

const settingsRouter = (await import('../../server/routes/settings.js')).default;
const express = (await import('express')).default;
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', settingsRouter);
const httpServer = createServer(app);
const apiPort = await listenInRange(httpServer);
const BASE = `http://127.0.0.1:${apiPort}`;

async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保持 null */ }
  return { status: r.status, json, text };
}
const switchTo = (k) => call('POST', '/api/provider/switch', { id: PROVIDERS[k].id });
const upstreamWho = async () => {
  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
  if (r.status === 503) return null;
  try { return (await r.json()).who ?? `status-${r.status}`; } catch { return `status-${r.status}`; }
};
const settingsWho = () => {
  const m = JSON.parse(readFileSync(SETTINGS, 'utf8')).env?.ANTHROPIC_MODEL;
  return m === 'model-a' ? 'A' : m === 'model-b' ? 'B' : `model=${m}`;
};
const activeWho = () => {
  if (!existsSync(ACTIVE)) return null;
  const id = JSON.parse(readFileSync(ACTIVE, 'utf8')).id;
  return id === 'r145-a' ? 'A' : id === 'r145-b' ? 'B' : `id=${id}`;
};
const snapshot = async () => ({ upstream: await upstreamWho(), settings: settingsWho(), active: activeWho() });
const resetTo = async (k) => {
  const r = await switchTo(k);
  assert.equal(r.status, 200, `复位到 ${k} 失败:${r.text.slice(0, 200)}`);
  assert.deepEqual(await snapshot(), { upstream: k, settings: k, active: k }, `复位到 ${k} 后三者不一致`);
};

const { check, finish } = makeChecker('check-r145-provider-switch-serial');
let exitCode = 1;
try {
  console.log('F3 · 基线');
  await check('切到 A:上游 / settings.json / active 都是 A', async () => {
    const r = await switchTo('A');
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.deepEqual(await snapshot(), { upstream: 'A', settings: 'A', active: 'A' });
  });

  console.log('F3 · 写 settings.json 失败时上游保持切换前的值');
  await check('当前 A,切 B 时写盘失败 → 报错,上游仍是 A,settings.json 与 active 不变', async () => {
    const before = readFileSync(SETTINGS);
    chmodSync(SETTINGS, 0o444);
    let r;
    try { r = await switchTo('B'); } finally { chmodSync(SETTINGS, 0o644); }
    assert.ok(r.status >= 400, `写盘失败应报错,实际 ${r.status}`);
    assert.ok(readFileSync(SETTINGS).equals(before), 'settings.json 被改了');
    assert.deepEqual(await snapshot(), { upstream: 'A', settings: 'A', active: 'A' }, '写盘失败后代理上游已被换掉(对话会发往没选中的那家)');
  });

  console.log('F3 · 重叠的两次切换:结束后三者指向同一家(后到者)');
  await check('切 B(写盘被拖住)期间又切 A → 最终上游 = settings.json = active = A', async () => {
    await resetTo('A');
    const started = delayNextSettingsWrite(400);
    const p1 = switchTo('B');
    await started; // 第一次切换已经走到写 settings.json
    const p2 = switchTo('A');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepEqual([r1.status, r2.status], [200, 200], `${r1.text.slice(0, 120)} | ${r2.text.slice(0, 120)}`);
    assert.deepEqual(await snapshot(), { upstream: 'A', settings: 'A', active: 'A' });
  });

  console.log('F3 · 保存后自动重切与手动切换串行');
  await check('当前 A,切 B(写盘被拖住)期间保存 A 的配置 → 自动重切不把用户切回 A,三者都是 B', async () => {
    await resetTo('A'); // 每条自己定起点,不依赖上一条(上一条红时会留下不一致的状态)
    const started = delayNextSettingsWrite(400);
    const p1 = switchTo('B');
    await started;
    const p2 = call('PUT', `/api/custom-providers/${PROVIDERS.A.id}`, { name: 'A2', type: 'anthropic', baseURL: PROVIDERS.A.baseURL, models: ['model-a'] });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepEqual([r1.status, r2.status], [200, 200], `${r1.text.slice(0, 120)} | ${r2.text.slice(0, 120)}`);
    assert.deepEqual(await snapshot(), { upstream: 'B', settings: 'B', active: 'B' });
  });

  console.log('F3 · 删除与切换串行');
  await check('当前 B,切 A(写盘被拖住)期间删除 A → 删除排在切换之后,active 不再指向已删的 A', async () => {
    await resetTo('B');
    const started = delayNextSettingsWrite(400);
    const p1 = switchTo('A');
    await started;
    const p2 = call('DELETE', `/api/custom-providers/${PROVIDERS.A.id}`);
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepEqual([r1.status, r2.status], [200, 200], `${r1.text.slice(0, 120)} | ${r2.text.slice(0, 120)}`);
    assert.notEqual(activeWho(), 'A', 'active-provider.json 指向了已被删除的 provider');
  });

  exitCode = finish();
} finally {
  try { chmodSync(SETTINGS, 0o644); } catch { /* 尽力 */ }
  fsp.writeFile = realWriteFile;
  syncBuiltinESMExports();
  cleanup();
}
process.exit(exitCode);
