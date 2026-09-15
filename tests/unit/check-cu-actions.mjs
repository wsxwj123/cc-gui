#!/usr/bin/env node
// computer-use 动作登记表单测(批次3/R14):
//   * 相同 actionId 同参数重试 → 返回已有回执,不重新投递;异参 → CU_ACTION_CONFLICT
//   * action_status:从未登记 CU_ACTION_NOT_FOUND;登记过的给状态与回执
//   * 保留窗口:只留最新 100 个终态(超出 = CU_ACTION_EXPIRED,不等于"没执行")
// 全部走"到不了桌面"的路径(幽灵 target + 无截图映射 → CU_SCREENSHOT_REQUIRED),
// 不依赖已授权应用与 python 运行时。
// 跑法:node tests/unit/check-cu-actions.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'server', 'computer-use', 'mcp-server.js');
const GHOST = { bundleId: 'com.example.cu-batch-nonexistent', pid: 999_999, windowId: 999_999_999 };

const child = spawn(process.execPath, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); entry(msg); }
  }
});
let nextId = 1;
function rpc(message, timeoutMs = 30_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`无应答: ${message.method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
  });
}
async function call(name, args) {
  const r = await rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.error, undefined, `${name} 不应回 JSON-RPC error`);
  return {
    isError: r.result.isError === true,
    text: (r.result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    structuredContent: r.result.structuredContent || {},
  };
}

const init = await rpc({ jsonrpc: '2.0', method: 'initialize', params: {} });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

// ── 同 actionId:同参数回已有回执,异参冲突 ─────────────────────────
const first = await call('left_click', { actionId: 'unit_conflict', target: GHOST, foreground: false, x: 1, y: 1 });
assert.equal(first.structuredContent.code, 'CU_SCREENSHOT_REQUIRED', '第一步:无截图映射却带合法参数 → 登记后失败');
const retry = await call('left_click', { actionId: 'unit_conflict', target: GHOST, foreground: false, x: 1, y: 1 });
assert.equal(retry.structuredContent.code, first.structuredContent.code, '同参数重试返回已有回执');
assert.equal(retry.structuredContent.actionId, 'unit_conflict', '重试回执仍带原 actionId');
const conflicting = await call('left_click', { actionId: 'unit_conflict', target: GHOST, foreground: false, x: 2, y: 2 });
assert.equal(conflicting.structuredContent.code, 'CU_ACTION_CONFLICT', '同 actionId 异参 → CU_ACTION_CONFLICT');
assert.equal(conflicting.structuredContent.ok, false, '冲突是失败信封');

// ── action_status ─────────────────────────────────────────────────
const status = await call('action_status', { instanceId: init.result.instanceId, actionId: 'unit_conflict' });
assert.equal(status.isError, false, '查询已登记动作成功');
assert.equal(status.structuredContent.status, 'failed', '失败动作的终态是 failed');
assert.equal(status.structuredContent.receipt.code, 'CU_SCREENSHOT_REQUIRED', '回执里带已有失败原因');
const missing = await call('action_status', { instanceId: init.result.instanceId, actionId: 'unit_never_registered' });
assert.equal(missing.structuredContent.code, 'CU_ACTION_NOT_FOUND', '从未登记 → CU_ACTION_NOT_FOUND');
const wrongInstance = await call('action_status', { instanceId: 'someone-else', actionId: 'unit_conflict' });
assert.equal(wrongInstance.structuredContent.code, 'CU_INSTANCE_CHANGED', 'action_status 也认实例身份');
child.kill('SIGKILL');

// ── 终态保留窗口(直接操作模块状态,避免等 1 小时)───────────────────
const { state, pruneActions } = await import('../../server/computer-use/mcp-server.js');
for (let i = 0; i < 105; i += 1) {
  const id = `retain_${i}`;
  state.actions.set(id, { paramsKey: 'p', status: 'dispatched', at: Date.now(), done: true, receipt: null });
  state.terminalOrder.push(id);
}
pruneActions();
assert.ok(!state.actions.has('retain_0'), '最老的终态被淘汰(只留最新 100 个)');
assert.ok(state.expired.has('retain_0'), '被淘汰的 id 记进 expired(区分 EXPIRED 与 NOT_FOUND)');
assert.ok(state.actions.has('retain_104'), '最新的终态仍保留');
state.actions.clear();
state.terminalOrder.length = 0;
state.expired.clear();

console.log('check-cu-actions: 全部断言通过 ✓');
process.stdin.destroy();
