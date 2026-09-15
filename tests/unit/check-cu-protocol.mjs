#!/usr/bin/env node
// computer-use MCP 协议层单测(批次3/R14–R18 通用):
//   * 工具清单:11 个既有工具 + 只读 action_status;副作用工具 schema 必须声明
//     actionId/target/snapshotId/foreground,且 actionId 与 target 必填、target 含三字段
//   * initialize 发布 instanceId;instanceId 不匹配 → CU_INSTANCE_CHANGED(零投递)
//   * JSON-RPC 错误码:非法消息 -32600、解析错误 -32700、未知工具/方法 -32601、参数错 -32602
//   * 失败信封:{isError:true, content:[文本], structuredContent:{ok:false,code,state}}
// 只跑"到不了桌面"的路径(不需要授权应用、不需要 python 运行时)。
// 跑法:node tests/unit/check-cu-protocol.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'server', 'computer-use', 'mcp-server.js');

function startClient() {
  const child = spawn(process.execPath, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  const unsolicited = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { unsolicited.push({ unparsable: line.slice(0, 80) }); continue; }
      const entry = pending.get(msg.id ?? null);
      if (entry) { pending.delete(msg.id ?? null); entry(msg); } else unsolicited.push(msg);
    }
  });
  let nextId = 1;
  return {
    child,
    unsolicited,
    rpc(message, timeoutMs = 10_000) {
      const id = message.id ?? nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`无应答: ${message.method}`)); }, timeoutMs);
        pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
      });
    },
    raw(line) { child.stdin.write(`${line}\n`); },
    async waitForReply(from) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (unsolicited.length > from) return unsolicited[unsolicited.length - 1];
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('非法消息没有回包(3 秒)');
    },
    async call(name, args) {
      const r = await this.rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args } }, 30_000);
      const sc = r.result?.structuredContent || {};
      const text = (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { error: r.error, isError: r.result?.isError === true, structuredContent: sc, text };
    },
  };
}

const client = startClient();
const init = await client.rpc({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'unit', version: '0' } } });
const instanceId = init.result?.instanceId;
assert.equal(typeof instanceId, 'string', 'initialize 必须发布 instanceId(result.instanceId)');
assert.ok(instanceId.length >= 4, 'instanceId 非空');
client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

// ── 工具清单与 schema ──────────────────────────────────────────────
const list = await client.rpc({ jsonrpc: '2.0', method: 'tools/list', params: {} });
const tools = list.result.tools;
const names = tools.map((t) => t.name);
for (const name of ['screenshot', 'window_list', 'cursor_position', 'doctor',
  'left_click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key']) {
  assert.ok(names.includes(name), `既有工具 ${name} 必须保留`);
}
assert.ok(names.includes('action_status'), '新增只读 action_status');
for (const name of ['left_click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key']) {
  const tool = tools.find((t) => t.name === name);
  const props = Object.keys(tool.inputSchema.properties || {});
  for (const field of ['actionId', 'target', 'snapshotId', 'foreground']) {
    assert.ok(props.includes(field), `${name} 必须声明 ${field}`);
  }
  assert.ok((tool.inputSchema.required || []).includes('actionId'), `${name}.actionId 必填`);
  assert.ok((tool.inputSchema.required || []).includes('target'), `${name}.target 必填`);
  const targetJson = JSON.stringify(tool.inputSchema.properties.target);
  for (const field of ['bundleId', 'pid', 'windowId']) {
    assert.ok(targetJson.includes(field), `${name}.target 必须写清 ${field}`);
  }
}

// ── JSON-RPC 错误码 ────────────────────────────────────────────────
let seen = client.unsolicited.length;
client.raw('{"jsonrpc":"2.0","id":null,"params":{}}');
let reply = await client.waitForReply(seen);
assert.equal(reply.error?.code, -32600, '缺 method 的请求 → -32600');
assert.equal(reply.result, undefined, '非法请求不能返回 result');

seen = client.unsolicited.length;
client.raw('{"jsonrpc":"2.0","id":1,');
reply = await client.waitForReply(seen);
assert.ok([-32700, -32600].includes(reply.error?.code), '截断 JSON → 解析错误');

assert.equal((await client.rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })).error?.code,
  -32601, '未知工具名 → -32601');
assert.equal((await client.rpc({ jsonrpc: '2.0', method: 'tools/no_such_method', params: {} })).error?.code,
  -32601, '未知方法 → -32601');
assert.equal((await client.rpc({ jsonrpc: '2.0', method: 'tools/call', params: {} })).error?.code,
  -32602, '缺 name → -32602');
assert.equal((await client.rpc({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'window_list', arguments: 'not-an-object' } })).error?.code,
  -32602, 'arguments 非对象 → -32602');

// ── 失败信封 + instanceId 不匹配 ───────────────────────────────────
const GHOST = { bundleId: 'com.example.cu-batch-nonexistent', pid: 999_999, windowId: 999_999_999 };
const mismatch = await client.call('left_click', {
  actionId: 'unit_instance_1', target: GHOST, foreground: false, x: 1, y: 1, instanceId: 'not-this-instance',
});
assert.equal(mismatch.error, undefined, '工具失败走 result 信封,不是 JSON-RPC error');
assert.equal(mismatch.isError, true, 'isError:true');
assert.ok(mismatch.text.length > 0, 'content 带可读文本');
assert.equal(mismatch.structuredContent.ok, false, 'structuredContent.ok=false');
assert.equal(mismatch.structuredContent.code, 'CU_INSTANCE_CHANGED', 'instanceId 不匹配 → CU_INSTANCE_CHANGED');
assert.equal(mismatch.structuredContent.actionId, 'unit_instance_1', '回执带 actionId');
assert.equal(typeof mismatch.structuredContent.state, 'string', '回执带 state');
assert.ok(!/\n\s+at\s+\S+\s*\(/.test(mismatch.text), '失败文本不含堆栈');

const badArgs = await client.call('left_click', {
  actionId: 'bad id', target: GHOST, foreground: false, x: 1, y: 1,
});
assert.equal(badArgs.structuredContent.code, 'CU_INVALID_ARGUMENT', '非法 actionId → CU_INVALID_ARGUMENT');
const badTarget = await client.call('left_click', { actionId: 'unit_t2', target: { pid: 1 }, foreground: false, x: 1, y: 1 });
assert.equal(badTarget.structuredContent.code, 'CU_INVALID_ARGUMENT', 'target 缺字段 → CU_INVALID_ARGUMENT');
const badForeground = await client.call('left_click', { actionId: 'unit_t3', target: GHOST, foreground: 'true', x: 1, y: 1 });
assert.equal(badForeground.structuredContent.code, 'CU_INVALID_ARGUMENT', '非布尔 foreground → CU_INVALID_ARGUMENT');

client.child.kill('SIGKILL');
console.log('check-cu-protocol: 全部断言通过 ✓');
