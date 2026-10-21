#!/usr/bin/env node
// r151c 进程内会话工具:applySessionOptions 在挂 mcpServers 时给本次 CLI spawn 的 env 关掉工具搜索。
// 覆盖:① 没有 sessionOptions 挂接 → 不动 env、不挂 mcpServers;② 挂接返回 null / 只有 autoAllow → 不动 env;
// ③ 挂上 mcpServers → ENABLE_TOOL_SEARCH / MCP_CONNECTION_NONBLOCKING 均为 'false',其它 env 与已有 mcpServers 原样保留;
// ④ options.env 不存在时也只补这两个键;⑤ 形状不合法 → 不挂、env 不变。
// SDK 用 r151b 替身(不真起进程/不连网);临时 HOME,避免读本机偏好。
// node tests/unit/check-r151c-session-tool-env.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151c-tool-env-')));
const HOME = join(TMP, 'home');
mkdirSync(join(HOME, '.claude'), { recursive: true });
mkdirSync(join(HOME, '.claude-gui'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];

registerR151bSdkStub();
const { applySessionOptions, registerSessionRuntimeHooks } = await import('../../server/routes/chat.js');

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };
const hasToolEnv = (env) => Object.hasOwn(env || {}, 'ENABLE_TOOL_SEARCH') || Object.hasOwn(env || {}, 'MCP_CONNECTION_NONBLOCKING');
const assertNoToolEnv = (opts, label) => {
  ok(!hasToolEnv(opts.env), `${label}:没挂会话工具时不写工具搜索 env`);
  if (opts.env) eq(opts.env.KEEP, 'keep-me', `${label}:其它 env 原样保留`);
};

let unhook = null;
try {
  // ① 没挂接
  {
    const slot = {};
    const opts = { env: { KEEP: 'keep-me' } };
    applySessionOptions(slot, opts);
    assertNoToolEnv(opts, '没挂接');
    ok(!('mcpServers' in opts), '没挂接:不挂 mcpServers');
    ok(!('sessionAutoAllow' in slot), '没挂接:不写槽级放行');
  }

  // ② 挂接返回 null / 只有 autoAllow
  for (const [label, ret] of [['返回 null', null], ['只有 autoAllow', { autoAllow: ['mcp__ccgui-sessions__list_sessions'] }]]) {
    unhook = registerSessionRuntimeHooks({ sessionOptions: () => ret });
    const opts = { env: { KEEP: 'keep-me' } };
    applySessionOptions({}, opts);
    assertNoToolEnv(opts, label);
    ok(!('mcpServers' in opts), `${label}:不挂 mcpServers`);
    unhook(); unhook = null;
  }

  // ③ 挂上 mcpServers:只覆盖这两个键,其它 env / 已有 mcpServers 原样保留
  {
    const SERVER = { type: 'sdk', name: 'ccgui-sessions', instance: {} };
    let seenView = null;
    unhook = registerSessionRuntimeHooks({
      sessionOptions: (view) => { seenView = view; return { mcpServers: { 'ccgui-sessions': SERVER } }; },
    });
    const opts = {
      env: { KEEP: 'keep-me', PATH: '/usr/bin:/bin', ENABLE_TOOL_SEARCH: 'true' },
      mcpServers: { external: { type: 'stdio', command: 'x' } },
    };
    const slot = { sessionId: 's-1', runId: 7, turnEpoch: 2, guiMode: 'default', cwd: '/tmp/work' };
    applySessionOptions(slot, opts);
    eq(opts.env.ENABLE_TOOL_SEARCH, 'false', '挂上 mcpServers:ENABLE_TOOL_SEARCH=false');
    eq(opts.env.MCP_CONNECTION_NONBLOCKING, 'false', '挂上 mcpServers:MCP_CONNECTION_NONBLOCKING=false');
    eq(opts.env.KEEP, 'keep-me', '挂上 mcpServers:其它 env 不被覆盖');
    eq(opts.env.PATH, '/usr/bin:/bin', '挂上 mcpServers:PATH 不被覆盖');
    eq(Object.keys(opts.mcpServers).sort(), ['ccgui-sessions', 'external'], '挂上 mcpServers:与已有服务合并');
    eq(opts.mcpServers['ccgui-sessions'], SERVER, '挂上 mcpServers:新服务对象原样写入');
    eq([seenView.sessionId, seenView.runId, seenView.turnEpoch, seenView.guiMode, seenView.cwd], ['s-1', 7, 2, 'default', '/tmp/work'], '视图取自槽');
    unhook(); unhook = null;
  }

  // ④ 连 options.env 都没有(冷启正常路径一定有,这里只锁兜底行为)
  {
    unhook = registerSessionRuntimeHooks({ sessionOptions: () => ({ mcpServers: { s: { type: 'sdk' } } }) });
    const opts = {};
    applySessionOptions({}, opts);
    eq([opts.env.ENABLE_TOOL_SEARCH, opts.env.MCP_CONNECTION_NONBLOCKING], ['false', 'false'], '没有 env:只补这两个键');
    eq(Object.keys(opts.env).sort(), ['ENABLE_TOOL_SEARCH', 'MCP_CONNECTION_NONBLOCKING'], '没有 env:不夹带其它键');
    unhook(); unhook = null;
  }

  // ⑤ 形状不合法:照旧整体不挂,env 一个键都不动
  for (const [label, ret] of [
    ['mcpServers 是数组', { mcpServers: [1] }],
    ['mcpServers 是 null', { mcpServers: null }],
    ['异步返回', Promise.resolve({ mcpServers: { s: { type: 'sdk' } } })],
    ['抛错', () => { throw new Error('boom'); }],
  ]) {
    unhook = registerSessionRuntimeHooks({ sessionOptions: () => (typeof ret === 'function' ? ret() : ret) });
    const opts = { env: { KEEP: 'keep-me' } };
    applySessionOptions({}, opts);
    assertNoToolEnv(opts, label);
    ok(!('mcpServers' in opts), `${label}:不挂 mcpServers`);
    unhook(); unhook = null;
  }

  console.log(`PASS check-r151c-session-tool-env(${checks} 项)`);
} finally {
  if (unhook) unhook();
  rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
}
