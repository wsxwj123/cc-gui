#!/usr/bin/env node
// r151a T-Y9:服务端对 auto 的门控(INTERFACE Y.3.1 末)。
//   规则表(gateAutoPermissionMode);POST /api/chat/permission-mode 在"第三方 + 总开关没开 + auto"时回 409、
//   其它情况与改动前相同(隔离 HOME,直接挂 chat 路由,不起会话进程)。/api/chat 的降级由验收 D 组覆盖。
// node tests/unit/check-r151a-server-gate.mjs
import assert from 'node:assert/strict';
import { listenInRange } from './helpers/listen-in-range.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cgui-r151a-gate-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, '.claude-gui'), { recursive: true });

const { gateAutoPermissionMode, THIRD_PARTY_AUTO_DISABLED } = await import('../../server/services/auto-audit.js');

// ── 1. 规则表 ──
const DOWN = { requested: 'auto', effective: 'default', reason: 'third-party-auto-disabled' };
assert.equal(THIRD_PARTY_AUTO_DISABLED, 'third-party-auto-disabled');
assert.deepEqual(gateAutoPermissionMode('auto', { official: false, enabled: false }), { mode: 'default', downgraded: DOWN });
assert.deepEqual(gateAutoPermissionMode('auto', { official: false, enabled: undefined }), { mode: 'default', downgraded: DOWN }, '开关读不到 = 关');
assert.deepEqual(gateAutoPermissionMode('auto', { official: false, enabled: true }), { mode: 'auto', downgraded: null });
assert.deepEqual(gateAutoPermissionMode('auto', { official: true, enabled: false }), { mode: 'auto', downgraded: null }, '官方不受影响');
for (const m of ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', undefined, 'bogus']) {
  assert.deepEqual(gateAutoPermissionMode(m, { official: false, enabled: false }), { mode: m, downgraded: null }, `${m} 不受门控`);
}

// ── 2. POST /api/chat/permission-mode(没有存活进程:放行时 attempted 0 → 200)──
const { default: express } = await import('express');
const { default: chatRouter } = await import('../../server/routes/chat.js');
const app = express();
app.use(express.json());
app.use('/api', chatRouter);
const server = await listenInRange(app); // 端口在 6900–6999 里挑空闲的,被占就换(不用系统分配的随机口)
const base = `http://127.0.0.1:${server.address().port}`;
const SETTINGS = join(home, '.claude', 'settings.json');
const PREFS = join(home, '.claude-gui', 'prefs.json');
const post = async (body) => { const r = await fetch(`${base}/api/chat/permission-mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

try {
  writeFileSync(SETTINGS, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789' } }));
  writeFileSync(PREFS, JSON.stringify({}));
  let r = await post({ sessionId: 's1', mode: 'auto' });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { ok: false, code: 'THIRD_PARTY_AUTO_DISABLED', error: '第三方 provider 的「自动」档未开启' });
  r = await post({ sessionId: 's1', mode: 'plan' });
  assert.equal(r.status, 200, '其它档不受门控');
  writeFileSync(PREFS, JSON.stringify({ thirdPartyAuto: true }));
  r = await post({ sessionId: 's1', mode: 'auto' });
  assert.equal(r.status, 200, '开关开:与改动前相同');
  writeFileSync(PREFS, JSON.stringify({}));
  writeFileSync(SETTINGS, JSON.stringify({ env: {} }));
  r = await post({ sessionId: 's1', mode: 'auto' });
  assert.equal(r.status, 200, '官方:与改动前相同');
  writeFileSync(SETTINGS, '{ 损坏');
  r = await post({ sessionId: 's1', mode: 'auto' });
  assert.equal(r.status, 200, 'settings.json 读不出 = 官方(与服务端其它判据同口径)');
  r = await post({ sessionId: '', mode: 'auto' });
  assert.equal(r.status, 400, '参数校验仍先于门控');
} finally {
  await new Promise((r) => server.close(r));
  rmSync(home, { recursive: true, force: true });
}
console.log('check-r151a-server-gate: OK');
process.exit(0);
