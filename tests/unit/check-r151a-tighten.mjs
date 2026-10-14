#!/usr/bin/env node
// r151a T-Y10:第三方 provider 的「自动」档下两条收紧(方案 Y.1、INTERFACE Y.3.3),官方不变。
//   ① CLI 交给 GUI 裁决的调用(canUseTool / 切档重裁)一律弹卡,不走"MCP 自动执行"名单(autoDecide 的 thirdParty 分支);
//   ② 命中既有危险命令规则的 Bash 由 PreToolUse 回调返回 ask(thirdPartyAutoPreToolUse / makePreToolUseHook);
//      判定出错时第三方按询问处理、官方照旧 continue(R-Y13)。
// 真实 CLI 下"返回 ask 后交给 canUseTool、审核请求 0 次"另见 check-r151a-tighten-e2e.mjs。
// node tests/unit/check-r151a-tighten.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cgui-r151a-tighten-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, '.claude', 'gui'), { recursive: true });
mkdirSync(join(home, '.claude-gui'), { recursive: true });
// GUI 里勾了"自动执行"的 MCP server
writeFileSync(join(home, '.claude', 'gui', 'mcp-autoapprove.json'), JSON.stringify(['r151srv']));

const { thirdPartyAutoPreToolUse, thirdPartyAutoAskOutput, THIRD_PARTY_AUTO_ASK_REASON } = await import('../../server/services/auto-audit.js');
const { autoDecide, makePreToolUseHook } = await import('../../server/routes/chat.js');

const ASK = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: THIRD_PARTY_AUTO_ASK_REASON } };
assert.equal(THIRD_PARTY_AUTO_ASK_REASON, '第三方 provider 的「自动」档下，这类命令需要你确认后才执行。');
assert.deepEqual(thirdPartyAutoAskOutput(), ASK);

// ── 1. PreToolUse 判定规则表 ──
assert.deepEqual(thirdPartyAutoPreToolUse({ thirdParty: true, mode: 'auto', dangerous: true }), ASK);
for (const c of [
  { thirdParty: false, mode: 'auto', dangerous: true },
  { thirdParty: true, mode: 'default', dangerous: true },
  { thirdParty: true, mode: 'acceptEdits', dangerous: true },
  { thirdParty: true, mode: 'bypassPermissions', dangerous: true },
  { thirdParty: true, mode: 'auto', dangerous: false },
  { thirdParty: 'yes', mode: 'auto', dangerous: true },
]) assert.equal(thirdPartyAutoPreToolUse(c), null, JSON.stringify(c));

// ── 2. autoDecide:第三方 auto 一律弹卡;官方 auto 与其它档不变 ──
const MCP = 'mcp__r151srv__write_note';
assert.deepEqual(autoDecide('auto', MCP, {}, null), { decision: 'allow' }, '官方 auto:勾了自动执行的 MCP 仍直接放行(与改动前相同)');
assert.equal(autoDecide('auto', MCP, {}, null, { thirdParty: true }), null, '第三方 auto:同一工具改为弹卡');
assert.equal(autoDecide('auto', 'Read', { file_path: '/x' }, null, { thirdParty: true }), null);
assert.equal(autoDecide('auto', 'Bash', { command: 'rm -rf build' }, null, { thirdParty: true }), null);
assert.equal(autoDecide('auto', 'AskUserQuestion', {}, null, { thirdParty: true }), null);
assert.equal(autoDecide('auto', 'ExitPlanMode', {}, null, { thirdParty: true }).decision, 'deny', '切出规划的 ExitPlanMode 仍直接拒绝');
for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']) {
  for (const [tool, input, boundary] of [[MCP, {}, null], ['Read', { file_path: '/x' }, null], ['Edit', { file_path: '/x/a.js' }, null], ['Bash', { command: 'rm -rf build' }, null], ['Bash', { command: 'ls' }, '/outside']]) {
    assert.deepEqual(autoDecide(mode, tool, input, boundary, { thirdParty: true }), autoDecide(mode, tool, input, boundary),
      `${mode} / ${tool}:thirdParty 只影响 auto 档`);
  }
}

// ── 3. makePreToolUseHook:读槽上的第三方标记与当前档位 ──
const hookOf = (slot) => makePreToolUseHook(slot);
const rm = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./victim' }, tool_use_id: 't1' };
const ls = { ...rm, tool_input: { command: 'ls -la' } };
assert.deepEqual(await hookOf({ thirdPartyProvider: true, guiMode: 'auto' })(rm), ASK);
assert.deepEqual(await hookOf({ thirdPartyProvider: true, guiMode: 'auto' })(ls), { continue: true });
assert.deepEqual(await hookOf({ thirdPartyProvider: true, guiMode: 'auto' })({ ...rm, tool_name: 'Read' }), { continue: true });
assert.deepEqual(await hookOf({ thirdPartyProvider: true, guiMode: 'default' })(rm), { continue: true }, '非 auto 档不干预(canUseTool 自有危险命令弹卡)');
assert.deepEqual(await hookOf({ thirdPartyProvider: false, guiMode: 'auto' })(rm), { continue: true }, '官方与改动前相同');
assert.deepEqual(await hookOf({ thirdPartyProvider: true, guiMode: 'auto' })(null), { continue: true }, '畸形输入不抛');
// 档位中途被切成 auto:回调按调用当时的 slot.guiMode 判
const live = { thirdPartyProvider: true, guiMode: 'default' };
const h = hookOf(live);
assert.deepEqual(await h(rm), { continue: true });
live.guiMode = 'auto';
assert.deepEqual(await h(rm), ASK);
// 判定出错:第三方按询问处理,官方照旧 continue
const boom = (tp) => { const s = { thirdPartyProvider: tp }; Object.defineProperty(s, 'guiMode', { get() { throw new Error('r151a boom'); } }); return s; };
const warn = console.warn; console.warn = () => {};
try {
  assert.deepEqual(await hookOf(boom(true))(rm), ASK);
  assert.deepEqual(await hookOf(boom(false))(rm), { continue: true });
} finally { console.warn = warn; }

rmSync(home, { recursive: true, force: true });
console.log('check-r151a-tighten: OK');
process.exit(0);
