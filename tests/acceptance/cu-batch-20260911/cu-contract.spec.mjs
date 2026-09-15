// CU-A*: MCP surface, envelope, instance/actionId identity, HTTP status/doctor.
// Contract: .devflow/INTERFACE.md「桌面操控与Codex对齐（R14–R19）」第 9、11、13 段.
import { test, expect } from '@playwright/test';
import {
  CuMcp,
  EnvironmentBlocked,
  SIDE_EFFECT_TOOLS,
  assertCursorUnchanged,
  assertFrontUnchanged,
  cuDoctor,
  cuStatus,
  cursorBaseline,
  expectToolError,
  frontAppBaseline,
  withInstance,
  requireActionTool,
  uniqueId,
} from './helpers/cu-mcp.mjs';

const LEGACY_TOOLS = [
  'screenshot',
  'window_list',
  'cursor_position',
  'doctor',
  'left_click',
  'double_click',
  'right_click',
  'drag',
  'scroll',
  'type',
  'key',
];

const LOCKSREEN_STATES = ['disabled', 'unverified', 'ready', 'active', 'interrupted', 'error'];

test('CU-A01 缺 method 的 JSON-RPC 请求 → -32600，且不执行任何工具', async () => {
  await withInstance(async client => {
    const reply = await client.rpcLine('{"jsonrpc":"2.0","id":null,"params":{}}', { timeoutMs: 3_000 });
    expect(reply.error, 'a request without a method is rejected as invalid').toBeTruthy();
    expect(reply.error.code, 'JSON-RPC invalid request code').toBe(-32600);
    expect(reply.result, 'no tool result is returned').toBeUndefined();
  });
});

test('CU-A02 调用不存在的工具名 → -32601', async () => {
  await withInstance(async client => {
    const reply = await client.rpc({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'cu_batch_no_such_tool', arguments: {} },
    });
    expect(reply.error, 'an unknown tool name is a JSON-RPC error').toBeTruthy();
    expect(reply.error.code, 'unknown tool/method code').toBe(-32601);
  });
});

test('CU-A03 调用不存在的方法 → -32601', async () => {
  await withInstance(async client => {
    const reply = await client.rpc({ jsonrpc: '2.0', method: 'tools/no_such_method', params: {} });
    expect(reply.error, 'an unknown method is a JSON-RPC error').toBeTruthy();
    expect(reply.error.code, 'method not found code').toBe(-32601);
  });
});

test('CU-A04 tools/call 缺 name → -32602', async () => {
  await withInstance(async client => {
    const reply = await client.rpc({ jsonrpc: '2.0', method: 'tools/call', params: {} });
    expect(reply.error, 'a call without a tool name is invalid').toBeTruthy();
    expect(reply.error.code, 'invalid params code').toBe(-32602);
  });
});

test('CU-A05 tools/call 的 arguments 不是对象 → -32602（用只读工具观察，零副作用）', async () => {
  await withInstance(async client => {
    const reply = await client.rpc({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'window_list', arguments: 'not-an-object' },
    });
    expect(reply.error, 'a non-object arguments payload is invalid').toBeTruthy();
    expect(reply.error.code, 'invalid params code').toBe(-32602);
  });
});

test('CU-A06 截断的 JSON 行 → JSON-RPC 解析错误（合同未点名，按标准记录）', async () => {
  await withInstance(async client => {
    const reply = await client.rpcLine('{"jsonrpc":"2.0","id":1,', { timeoutMs: 3_000 });
    expect(reply.error, 'malformed JSON must be answered with an error').toBeTruthy();
    expect([-32700, -32600], 'JSON-RPC parse error (-32700) or invalid request (-32600)').toContain(reply.error.code);
  });
});

test('CU-A07 工具清单：11 个既有工具按名称保留 + 新增只读 action_status', async () => {
  await withInstance(async client => {
    // 合同要求"新列工具验收按名称/schema 而非硬断言 11"，所以只查身份，不锁数量。
    for (const name of LEGACY_TOOLS) {
      expect(client.tool(name), `${name} must stay registered`).toBeTruthy();
    }
    expect(client.tool('action_status'), 'the read-only action_status tool must be added').toBeTruthy();
  });
});

test('CU-A08 副作用工具 schema 必须声明 actionId/target/snapshotId/foreground，actionId 必填', async () => {
  await withInstance(async client => {
    for (const name of SIDE_EFFECT_TOOLS) {
      const tool = client.tool(name);
      expect(tool, `${name} must be registered`).toBeTruthy();
      const props = client.toolProps(name);
      for (const field of ['actionId', 'target', 'snapshotId', 'foreground']) {
        expect(props, `${name} must declare ${field}`).toContain(field);
      }
      const required = tool.inputSchema?.required || [];
      expect(required, `${name} must require actionId (no default generation)`).toContain('actionId');
      expect(required, `${name} must require target`).toContain('target');
      const targetSchema = JSON.stringify(tool.inputSchema?.properties?.target || {});
      for (const field of ['bundleId', 'pid', 'windowId']) {
        expect(targetSchema, `${name}.target must spell out ${field}`).toContain(field);
      }
    }
  });
});

test('CU-A09 MCP 实例初始化返回 instanceId', async () => {
  await withInstance(async client => {
    expect(client.instanceId, 'initialize must publish the instance identity used by side-effect calls').toBeTruthy();
  });
});

test('CU-A10 instanceId 不匹配 → CU_INSTANCE_CHANGED 且零投递', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const res = await client.call('left_click', {
      actionId: uniqueId('cu_a10'),
      target: { bundleId: 'com.example.cu-batch-nonexistent', pid: 999999, windowId: 999999999 },
      snapshotId: uniqueId('cu_snap'),
      foreground: false,
      x: 1,
      y: 1,
      instanceId: `not-${client.instanceId}`,
    });
    expectToolError(res, { code: 'CU_INSTANCE_CHANGED' });
  });
});

test('CU-A11 非法 actionId（空串 / 超 64 位 / 含非法字符）→ CU_INVALID_ARGUMENT', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const target = { bundleId: 'com.example.cu-batch-nonexistent', pid: 999999, windowId: 999999999 };
    for (const actionId of ['', 'a'.repeat(65), 'bad id with spaces', 'bad/id']) {
      const res = await client.call('left_click', {
        actionId,
        target,
        snapshotId: uniqueId('cu_snap'),
        foreground: false,
        x: 1,
        y: 1,
      });
      expectToolError(res, { code: 'CU_INVALID_ARGUMENT' });
    }
  });
});

test('CU-A12 失败信封形状：isError + content 文本 + structuredContent{ok:false,code,state}', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const actionId = uniqueId('cu_a12');
    const res = await client.call('left_click', {
      actionId,
      target: { bundleId: 'com.example.cu-batch-nonexistent', pid: 999999, windowId: 999999999 },
      snapshotId: uniqueId('cu_snap'),
      foreground: 'yes please',
      x: 1,
      y: 1,
    });
    expectToolError(res, { code: 'CU_INVALID_ARGUMENT', actionId });
  });
});

test('CU-A13 相同 actionId 不同参数 → CU_ACTION_CONFLICT', async () => {
  await withInstance(async client => {
    requireActionTool(client, 'left_click');
    const actionId = uniqueId('cu_a13');
    const target = { bundleId: 'com.example.cu-batch-nonexistent', pid: 999999, windowId: 999999999 };
    const snapshotId = uniqueId('cu_snap');
    const first = await client.call('left_click', { actionId, target, snapshotId, foreground: false, x: 1, y: 1 });
    expectNoDispatch(first);
    const second = await client.call('left_click', { actionId, target, snapshotId, foreground: false, x: 2, y: 2 });
    expectToolError(second, { code: 'CU_ACTION_CONFLICT', actionId });
  });
});

test('CU-A14 action_status：从未登记 → CU_ACTION_NOT_FOUND，不推断已执行', async () => {
  await withInstance(async client => {
    const tool = client.tool('action_status');
    if (!tool) throw new EnvironmentBlocked('this build has no action_status tool yet (CU-A07 records that)');
    const res = await client.call('action_status', {
      instanceId: client.instanceId,
      actionId: uniqueId('cu_never_registered'),
    });
    expectToolError(res, { code: 'CU_ACTION_NOT_FOUND' });
  });
});

test('CU-A15 只读查询不动焦点与鼠标（反向）：window_list / cursor_position / action_status 前后不变', async () => {
  await withInstance(async client => {
    const frontBefore = await frontAppBaseline();
    const cursorBefore = await cursorBaseline();
    await client.call('window_list', {}, { timeoutMs: 15_000 });
    const cursorProbe = await client.call('cursor_position', {}, { timeoutMs: 15_000 });
    expect(cursorProbe.rpcError, 'cursor_position must answer').toBeNull();
    if (client.tool('action_status')) {
      await client.call('action_status', { instanceId: client.instanceId, actionId: uniqueId('cu_a15') });
    }
    await assertFrontUnchanged(frontBefore, 'passive queries');
    await assertCursorUnchanged(cursorBefore, 'passive queries');
  });
});

test('CU-B01 /status 保留既有字段并新增 capabilities 与 lockscreen', async ({ request }) => {
  const { baseURL } = getBase();
  const { status, body } = await cuStatus(request, baseURL);
  expect(status, 'status stays HTTP 200').toBe(200);
  for (const field of ['platform', 'supported', 'registered', 'runtimeReady', 'path']) {
    expect(Object.keys(body || {}), `status keeps ${field}`).toContain(field);
  }
  expect(Object.keys(body || {}), 'status adds capabilities').toContain('capabilities');
  expect(Object.keys(body || {}), 'status adds lockscreen').toContain('lockscreen');
});

test('CU-B02 capabilities 每项为 available/unsupported/unverified，非 available 必须给出 reason', async ({ request }) => {
  const { baseURL } = getBase();
  const { body } = await cuStatus(request, baseURL);
  const capabilities = body?.capabilities;
  expect(capabilities, 'capabilities must be published').toBeTruthy();
  const entries = Array.isArray(capabilities) ? capabilities : Object.values(capabilities || {});
  expect(entries.length, 'capabilities must enumerate the primitives').toBeGreaterThan(0);
  for (const entry of entries) {
    const value = typeof entry === 'string' ? entry : entry?.status ?? entry?.state;
    expect(['available', 'unsupported', 'unverified'], 'capability status enum').toContain(value);
    if (value !== 'available') {
      expect(typeof entry?.reason, `capability ${JSON.stringify(entry?.id || entry?.name)} needs a reason`).toBe('string');
      expect(entry.reason.length, 'reason must not be empty').toBeGreaterThan(0);
    }
  }
});

test('CU-B03 lockscreen 状态在枚举内；未证明路径只能是 disabled/unverified', async ({ request }) => {
  const { baseURL } = getBase();
  const { body } = await cuStatus(request, baseURL);
  const lock = body?.lockscreen;
  expect(lock, 'lockscreen must be published').toBeTruthy();
  expect(LOCKSREEN_STATES, 'lockscreen.state enum').toContain(lock.state);
  if (lock.state !== 'disabled') {
    expect(typeof lock.reason, 'any non-disabled lockscreen state needs a reason').toBe('string');
    expect(lock.reason.length, 'reason must not be empty').toBeGreaterThan(0);
  }
});

test('CU-B04 doctor 返回 HTTP200 {ok,...}，运行时/权限问题各自给稳定 code', async ({ request }) => {
  const { baseURL } = getBase();
  const { status, body } = await cuDoctor(request, baseURL);
  expect(status, 'doctor keeps HTTP 200 (it reports, it does not fail the request)').toBe(200);
  expect(body, 'doctor must return a JSON body').toBeTruthy();
  expect(typeof body.ok, 'doctor publishes ok').toBe('boolean');
  if (body.ok === false) {
    expect(['CU_RUNTIME_UNAVAILABLE', 'CU_PERMISSION_REQUIRED', 'CU_TIMEOUT', 'CU_TARGET_LOOKUP_FAILED'], 'a failing doctor names a contract code').toContain(body.code);
  }
});

test('CU-B05 doctor 不得激活窗口或输入（反向）：调用前后前台应用与光标不变', async ({ request }) => {
  const { baseURL } = getBase();
  const frontBefore = await frontAppBaseline();
  const cursorBefore = await cursorBaseline();
  await cuDoctor(request, baseURL);
  await assertFrontUnchanged(frontBefore, 'doctor');
  await assertCursorUnchanged(cursorBefore, 'doctor');
});

function expectNoDispatch(res) {
  // 这条前提断言把"A13 的第一步本身没成功"和"冲突码判错"分开，避免把环境问题写成产品结论。
  if (res.isError) {
    expect(
      res.structuredContent?.code,
      'the first call in CU-A13 must not act (no authorised target exists), so it errors with a known code',
    ).toMatch(/^CU_/);
  }
}

function getBase() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance');
  return { baseURL };
}
