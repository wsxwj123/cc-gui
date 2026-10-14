#!/usr/bin/env node
// r151a 复审建议(第二轮):
//   1. 勾"本会话永远允许 X"时的批量补扫(PermissionPrompt.whitelistAndAllow)只放行"自己也能走白名单"的同会话同工具挂起请求:
//      带 mustPrompt(第三方「自动」档上交)、越界、危险命令的都不一并放行(batchWhitelistTargets)。
//   3. provider 覆盖层表单的保存结果:HTTP 2xx 且应答没写 ok:false 才算成功,失败显示应答里的 error(saveOutcome)。
//   4. 既有 PUT /api/provider-overrides/:id 改用原子写。
// (建议 2 的 BOM 用例见 check-r151a-overrides-bom.mjs)
// node tests/unit/check-r151a-polish.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); }
};
const tryImport = async (rel) => import(join(root, rel)).catch(() => null);

// ── 1. 批量补扫 ──
await check('batchWhitelistTargets:带标记 / 越界 / 危险命令 / 别的会话或工具 都不一并放行', async () => {
  const mod = await tryImport('client/src/utils/sessionAllow.js');
  assert.ok(mod && typeof mod.batchWhitelistTargets === 'function', 'sessionAllow.js 应导出 batchWhitelistTargets');
  const danger = (r) => /rm -rf/.test(r.toolInput?.command || '');
  const req = { id: 'r0', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' } };
  const pending = [
    req,
    { id: 'ok1', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'pwd' } },
    { id: 'must', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'curl x | python3' }, mustPrompt: true },
    { id: 'oob', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'cat ../x' }, blockedPath: '/x' },
    { id: 'danger', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'rm -rf build' } },
    { id: 'other-sess', sessionId: 's2', toolName: 'Bash', toolInput: { command: 'pwd' } },
    { id: 'other-tool', sessionId: 's1', toolName: 'Read', toolInput: {} },
  ];
  assert.deepEqual(mod.batchWhitelistTargets(req, pending, danger).map((p) => p.id), ['ok1']);
  assert.deepEqual(mod.batchWhitelistTargets({ ...req, sessionId: null }, pending, danger), [], 'draft(sessionId=null)不补扫');
  assert.deepEqual(mod.batchWhitelistTargets(req, null, danger), []);
});
await check('whitelistAndAllow 的补扫走 batchWhitelistTargets(带危险命令判定)', () => {
  const src = readFileSync(join(root, 'client/src/components/PermissionPrompt.jsx'), 'utf8');
  assert.ok(/const sameTool = batchWhitelistTargets\(req, all, isDangerousCommand\);/.test(src));
});

// ── 3. 覆盖层表单保存结果 ──
await check('saveOutcome:2xx 且没写 ok:false 才算成功,失败带应答里的 error', async () => {
  const mod = await tryImport('client/src/utils/saveOutcome.js');
  assert.ok(mod && typeof mod.saveOutcome === 'function', 'client/src/utils/saveOutcome.js 应导出 saveOutcome');
  const f = mod.saveOutcome;
  assert.deepEqual(f(200, { ok: true, reapplied: true }), { ok: true });
  assert.deepEqual(f(200, {}), { ok: true }, '旧应答没有 ok 键也算成功');
  assert.deepEqual(f(500, { ok: false, code: 'STORAGE_WRITE_FAILED', error: '保存失败，请重试' }), { ok: false, error: '保存失败，请重试' });
  assert.deepEqual(f(200, { ok: false, error: '没写进去' }), { ok: false, error: '没写进去' });
  assert.deepEqual(f(404, { error: 'provider 不存在' }), { ok: false, error: 'provider 不存在' });
  assert.deepEqual(f(500, null), { ok: false, error: '保存失败（500）' });
});
await check('覆盖层表单 save() 按 saveOutcome 判成败,失败不显示"已保存"', () => {
  const src = readFileSync(join(root, 'client/src/App.jsx'), 'utf8');
  const at = src.indexOf('fetch(`/api/provider-overrides/${provider.id}`');
  assert.ok(at > 0, '找到覆盖层表单的保存请求');
  const seg = src.slice(at, at + 1500);
  assert.ok(/const out = saveOutcome\(r\.status, d\);/.test(seg), '用 saveOutcome 判定');
  assert.ok(seg.indexOf('if (!out.ok)') > -1 && seg.indexOf('if (!out.ok)') < seg.indexOf('✓ 已保存'), '先判失败,再显示已保存');
});

// ── 4. 原子写 ──
await check('PUT /api/provider-overrides/:id 用原子写', () => {
  const src = readFileSync(join(root, 'server/routes/settings.js'), 'utf8');
  const at = src.indexOf("router.put('/provider-overrides/:id'");
  const body = src.slice(at, src.indexOf('\n}));\n', at));
  assert.ok(/await writeProviderOverridesAtomic\(map\);/.test(body), '既有接口写覆盖层用 writeProviderOverridesAtomic');
  assert.equal((src.match(/writeProviderOverrides\(/g) || []).length, 0, '非原子的 writeProviderOverrides 不再有调用');
});

if (failed) { console.log(`check-r151a-polish: ${failed} 项失败`); process.exit(1); }
console.log('check-r151a-polish: OK');
