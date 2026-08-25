#!/usr/bin/env node
// r49b①(B1)守卫:热切权限档【失败必须如实回传】。
//
// 背景(audit-sdk,CLI 2.1.240 已核):CLI 的 guardPermissionModeChange 会拒绝一部分切换
// —— auto 档受模型门控(opus-4-5/sonnet-4-5/haiku-4-5 等被排除)、bypass 未带
// dangerously-skip 启动时也拒。原实现把每个 slot 的 setPermissionMode 包在 `catch {}` 里
// 吞掉,再无条件 `res.json({ ok: true, delivered })` —— 全部被拒时仍回 200 ok:true,
// 界面档位照旧显示新档,而 CLI 跑的是旧档(UI 与真相分叉,用户无从察觉)。
//
// 这里锁真函数 applyPermissionModeToSlots(mock slot.query,不打真实 CLI):
//   ① 全拒 → delivered 0 / failed 带 CLI 原文;被拒 slot 的档位字段一个都不许改;
//   ② 部分成功 → 成功的 slot 字段落位、失败的进 failed;
//   ③ 无匹配 slot(会话闲置)→ attempted 0(与"被拒"区分:它不是失败);
//   ④ 已退出 / 无 query 的 slot 跳过;
//   ⑤ sdkMode 映射仍只特判 plan/auto(dontAsk/bypass 不透传,批O 红线)。
// 外加路由层源码锚:全拒必须回 409 + CLI 原文,且失败时不得按新档重裁 pending。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyPermissionModeToSlots } from '../../server/routes/chat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const chatSrc = readFileSync(join(ROOT, 'server', 'routes', 'chat.js'), 'utf8');

// CLI 2.1.240 guard 的真实拒绝形态:SDK 把 CLI 的拒绝理由原样抛出来。
const GUARD_ERROR = 'Cannot set permission mode to auto: not supported for model claude-opus-4-5';
const slot = (over = {}) => ({
  sessionId: 'sid-a', exitCode: null, guiMode: 'default', permissionMode: 'default', sdkMode: 'default',
  query: { setPermissionMode: async () => {} },
  ...over,
});
const rejecting = (over = {}) => slot({
  query: { setPermissionMode: async () => { throw new Error(GUARD_ERROR); } },
  ...over,
});

// ① 全部被拒:不许谎报送达,也不许把档位字段改成没生效的新档
{
  const s = rejecting();
  const procs = new Map([[1, s]]);
  const r = await applyPermissionModeToSlots(procs, 'sid-a', 'auto');
  assert.equal(r.attempted, 1, '①有匹配 slot 就算尝试过');
  assert.equal(r.delivered, 0, '①被 guard 拒 → 送达数为 0');
  assert.deepEqual(r.failed, [{ sessionId: 'sid-a', error: GUARD_ERROR }], '①失败要带会话与 CLI 原文');
  assert.equal(s.guiMode, 'default', '①没生效的档位不得写进 slot.guiMode(否则 canUseTool 按幻觉档裁决)');
  assert.equal(s.sdkMode, 'default', '①sdkMode 同样不得改');
  assert.equal(s.permissionMode, 'default', '①permissionMode 同样不得改');
}

// ② 部分成功:成功的落位、失败的进 failed
{
  const okSlot = slot();
  const badSlot = rejecting({ sessionId: 'sid-a' });
  const procs = new Map([[1, okSlot], [2, badSlot], [3, slot({ sessionId: 'other' })]]);
  const r = await applyPermissionModeToSlots(procs, 'sid-a', 'plan');
  assert.equal(r.attempted, 2, '②只统计本会话的 slot');
  assert.equal(r.delivered, 1, '②成功一个');
  assert.equal(r.failed.length, 1, '②失败一个');
  assert.equal(okSlot.guiMode, 'plan', '②成功的 slot 写 GUI 档位');
  assert.equal(okSlot.sdkMode, 'plan', '②成功的 slot 写 SDK 档位');
  assert.equal(badSlot.guiMode, 'default', '②失败的 slot 保持旧档');
}

// ③ 会话没有在跑的进程:attempted 0 —— 这是"无需送达",不是失败(前端据此收敛,不许重试)
{
  const r = await applyPermissionModeToSlots(new Map([[1, slot({ sessionId: 'other' })]]), 'sid-a', 'default');
  assert.deepEqual(r, { attempted: 0, delivered: 0, failed: [] }, '③无匹配 slot 时三项全零');
}

// ④ 已退出 / 无 query 的 slot 不参与
{
  const procs = new Map([
    [1, slot({ exitCode: 0 })],
    [2, slot({ query: null })],
  ]);
  const r = await applyPermissionModeToSlots(procs, 'sid-a', 'plan');
  assert.equal(r.attempted, 0, '④已退出与无 query 的 slot 一律跳过');
}

// ⑤ sdkMode 映射:六档→三值,只特判 plan/auto(dontAsk/bypass 绝不透传给 SDK)
{
  const seen = [];
  const procs = new Map([[1, slot({ query: { setPermissionMode: async (v) => { seen.push(v); } } })]]);
  for (const m of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
    await applyPermissionModeToSlots(procs, 'sid-a', m);
  }
  assert.deepEqual(seen, ['default', 'default', 'plan', 'auto', 'default', 'default'],
    '⑤只有 plan/auto 原样透传,其余一律 default');
}

// ── 路由层源码锚(恰好一处,防重复分支与被悄悄删掉)────────────────────────────
const count = (re) => (chatSrc.match(re) || []).length;
assert.equal(count(/res\.status\(409\)\.json\(\{\s*ok: false, attempted, delivered: 0, failed,/g), 1,
  '全拒必须回 409(前端据此回滚档位),且恰好一处');
assert.equal(count(/error: failed\[0\]\?\.error/g), 1, '409 必须带 CLI 错误原文(failed[0].error),恰好一处');
assert.equal(count(/res\.json\(\{ ok: true, attempted, delivered, failed \}\)/g), 1,
  '部分成功回 200 并带 failed 明细,恰好一处');
assert.ok(!/await slot\.query\.setPermissionMode\(sdkMode\);[\s\S]{0,200}\} catch \{\}/.test(chatSrc),
  '切档不得再有吞异常的空 catch');
assert.ok(/if \(delivered > 0 \|\| attempted === 0\) \{\s*\n\s*try \{\s*\n\s*resolvePendingForSession/.test(chatSrc),
  '全部被拒时不得按新档重裁 pending(档位根本没生效,重裁=按幻觉档放行/拒绝)');

console.log('✓ check-mode-switch-failure: 全拒不谎报 / 部分成功明细 / 闲置不算失败 / 映射红线 全部通过');
