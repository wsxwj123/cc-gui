#!/usr/bin/env node
// r151b T-X0:跨会话通信「总开关关 = 零影响」基线(界面那一项在 check-r151b-baseline-ui.mjs)。
// 改动前(master 960965f6,工作树尚未改任何产品代码)录制;实现落地后不得重录 —— 这里红了说明总开关关着时行为变了。
//   ① 冷启会话时传给 SDK query() 的 options:三种请求下的键集合、各非函数键的取值(临时路径归一化)、hooks 形态、
//      没有 mcpServers、env 与同一时刻的 cleanChildEnv() 相同;总开关关的几种写法(没有 prefs.json / 没有键 / false /
//      非法值)下 options 完全相同。
//   ② 复用兼容键:chatCompatKey 在固定输入下逐字相同;同会话第二条消息照常复用常驻进程(reused:true、不新起 query、
//      推进输入流的消息形态不变)。
//   ③ PreToolUse 回调:经 options 真正接上的那个回调,以及 makePreToolUseHook 直调,在总开关关时,对 SendMessage 的
//      各种收件人写法(含指向一个本 GUI 正在跑的会话的名字与套接字地址,登记表里确有其条目)、其它工具、畸形输入
//      一律返回 { continue: true }。(第三方 auto 档 + 危险 Bash 的 ask 是 r151a 的规则,不在本基线范围内。)
// SDK 用 helpers/r151b-sdk-stub.mjs 替身(只替换 chat.js 的那一处 import),不起任何 claude 进程;HOME 指向临时目录;
// PATH 最前面放一个只会回答 --version / --help 的假 claude(让 pathToClaudeCodeExecutable 稳定出现)。
// 端口在 6900–6999 里挑(跳过 6710)。
// node tests/unit/check-r151b-baseline.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-baseline-')));
const HOME = join(TMP, 'home');
const BIN = join(TMP, 'bin');
const WORK = join(TMP, 'work');
const WORK2 = join(TMP, 'work2');
for (const d of [join(HOME, '.claude', 'sessions'), join(HOME, '.claude-gui'), BIN, WORK, WORK2]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;

registerR151bSdkStub();
const calls = (globalThis.__r151bSdkCalls ||= []);
const { default: express } = await import('express');
const chat = await import('../../server/routes/chat.js');
const { chatCompatKey, cleanChildEnv, makePreToolUseHook, getActiveChatProcesses, closeAllPersistentProcesses } = chat;

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const norm = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' ? x.split(TMP).join('<TMP>') : x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FN_KEYS = new Set(['canUseTool', 'onElicitation', 'onUserDialog', 'stderr']);
const OPAQUE_KEYS = new Set(['env', 'abortController', 'hooks']);

/** options 的可比快照:键集合、函数键的类型、其余键的取值(systemPrompt.append 只记长度与摘要)。 */
function snapshotOptions(options) {
  const keys = Object.keys(options).sort();
  const data = {};
  for (const k of keys) {
    if (FN_KEYS.has(k)) { data[k] = typeof options[k]; continue; }
    if (OPAQUE_KEYS.has(k)) continue;
    data[k] = options[k];
  }
  if (data.systemPrompt && typeof data.systemPrompt.append === 'string') {
    data.systemPrompt = { ...data.systemPrompt, append: `len=${data.systemPrompt.append.length} sha=${sha(data.systemPrompt.append)}` };
  }
  return { keys, data: norm(data) };
}
function hookShape(hooks) {
  return {
    events: Object.keys(hooks || {}).sort(),
    preToolUse: (hooks?.PreToolUse || []).map((m) => ({ keys: Object.keys(m).sort(), n: (m.hooks || []).length, types: (m.hooks || []).map((h) => typeof h) })),
  };
}

async function freePort() {
  for (let p = 6990; p >= 6900; p--) {
    if (p === 6710) continue;
    const ok = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (ok) return p;
  }
  throw new Error('6900-6990 没有空闲端口');
}

const app = express();
app.use(express.json());
app.use('/api', chat.default);
const port = await freePort();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
const postChat = async (body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
async function waitIdle(pid) {
  for (let i = 0; i < 200; i++) {
    const p = getActiveChatProcesses().find((x) => x.pid === pid);
    if (p && p.idle) return p;
    await sleep(25);
  }
  throw new Error(`进程槽 ${pid} 没有转入空闲`);
}
/** 关掉全部常驻进程并等它们收尾(下一轮同会话请求才会冷启而不是复用)。 */
async function closeAllAndWait() {
  closeAllPersistentProcesses();
  for (let i = 0; i < 200; i++) {
    if (getActiveChatProcesses().every((x) => x.exitCode !== null)) return;
    await sleep(25);
  }
  throw new Error('常驻进程没有收尾');
}

const PREFS = join(HOME, '.claude-gui', 'prefs.json');
const setPrefs = (v) => { if (v === null) rmSync(PREFS, { force: true }); else writeFileSync(PREFS, typeof v === 'string' ? v : JSON.stringify(v)); };

// ── 改动前录下的基线 ──────────────────────────────────────────────────────────────
const BASE_KEYS = ['abortController', 'additionalDirectories', 'agentProgressSummaries', 'canUseTool', 'cwd', 'env', 'forwardSubagentText', 'hooks',
  'includePartialMessages', 'model', 'onElicitation', 'onUserDialog', 'pathToClaudeCodeExecutable', 'perTaskStopAffordance', 'permissionMode',
  'settingSources', 'stderr', 'supportedDialogKinds', 'systemPrompt', 'thinking'];
const EXPECTED = {
  S1: {
    keys: [...BASE_KEYS, 'effort', 'maxBudgetUsd'].sort(),
    data: {"additionalDirectories":["/","<TMP>/home"],"agentProgressSummaries":true,"canUseTool":"function","cwd":"<TMP>/work","effort":"high","forwardSubagentText":true,"includePartialMessages":true,"maxBudgetUsd":3,"model":"r151b-model","onElicitation":"function","onUserDialog":"function","pathToClaudeCodeExecutable":"<TMP>/bin/claude","perTaskStopAffordance":true,"permissionMode":"default","settingSources":["user","project","local"],"stderr":"function","supportedDialogKinds":["refusal_fallback_prompt"],"systemPrompt":{"type":"preset","preset":"claude_code","append":"len=4127 sha=2bd7bc4a45b1975e"},"thinking":{"type":"adaptive","display":"summarized"}},
  },
  S2: {
    keys: [...BASE_KEYS, 'promptSuggestions', 'resume'].sort(), // promptSuggestions 没传 = 'auto',官方端点下为开
    data: {"additionalDirectories":["<TMP>/work"],"agentProgressSummaries":true,"canUseTool":"function","cwd":"<TMP>/work2","forwardSubagentText":true,"includePartialMessages":true,"model":"r151b-model-2","onElicitation":"function","onUserDialog":"function","pathToClaudeCodeExecutable":"<TMP>/bin/claude","perTaskStopAffordance":true,"permissionMode":"default","promptSuggestions":true,"resume":"b0b0b0b0-0000-4000-8000-0000000000b2","settingSources":["user","project","local"],"stderr":"function","supportedDialogKinds":["refusal_fallback_prompt"],"systemPrompt":{"type":"preset","preset":"claude_code","append":"len=238 sha=cf6343ca0109ef5c"},"thinking":{"type":"adaptive","display":"summarized"}},
  },
  S3: {
    keys: [...BASE_KEYS, 'agent', 'promptSuggestions'].sort(),
    data: {"additionalDirectories":[],"agent":"r151b-agent","agentProgressSummaries":true,"canUseTool":"function","cwd":"<TMP>/work","forwardSubagentText":true,"includePartialMessages":true,"model":"r151b-model","onElicitation":"function","onUserDialog":"function","pathToClaudeCodeExecutable":"<TMP>/bin/claude","perTaskStopAffordance":true,"permissionMode":"plan","promptSuggestions":true,"settingSources":["user","project","local"],"stderr":"function","supportedDialogKinds":["refusal_fallback_prompt"],"systemPrompt":{"type":"preset","preset":"claude_code","append":"len=4139 sha=92fd3cfbf9ba3f9e"},"thinking":{"type":"adaptive","display":"summarized"}},
  },
};
const HOOK_SHAPE = { events: ['PreToolUse'], preToolUse: [{ keys: ['hooks'], n: 1, types: ['function'] }] };
const REUSE_PUSH_KEYS = {"keys":["message","type"],"messageKeys":["content","role"],"type":"user","role":"user","contentType":"string"};
const COMPAT = {
  a: "{\"cwd\":\"/r151b/proj\",\"effort\":\"high\",\"append\":\"\",\"suggest\":false,\"gr\":true,\"dirs\":[\"/\",\"/r151b/home\"],\"settingsFp\":\"unreadable:0\",\"permEpoch\":0,\"disToolsMtime\":0,\"projSettingsMtime\":0,\"mcpStampMtime\":0,\"budget\":3,\"acw\":null,\"genui\":true}",
  b: "{\"cwd\":\"/r151b/proj2\",\"effort\":null,\"append\":\"附加\",\"suggest\":true,\"gr\":false,\"dirs\":[],\"settingsFp\":\"unreadable:0\",\"permEpoch\":0,\"disToolsMtime\":0,\"projSettingsMtime\":0,\"mcpStampMtime\":0,\"budget\":null,\"acw\":null,\"genui\":false}",
  c: "{\"cwd\":\"/r151b/proj\",\"effort\":\"low\",\"append\":\"\",\"suggest\":true,\"gr\":true,\"dirs\":[\"/\"],\"settingsFp\":\"unreadable:0\",\"permEpoch\":0,\"disToolsMtime\":0,\"projSettingsMtime\":0,\"mcpStampMtime\":0,\"budget\":null,\"acw\":\"200000\",\"genui\":true,\"ams\":\"1\"}",
};
// 只在首次录制时用:R151B_PRINT_OBSERVED=1 打印观测值、跳过取值比较。基线录完已写死在上面,之后不要再用它重录。
const RECORD = process.env.R151B_PRINT_OBSERVED === '1';

const S1_BODY = { prompt: 'r151b baseline S1', cwd: WORK, model: 'r151b-model', permissionMode: 'default', effort: 'high', maxBudgetUsd: 3, globalRead: true, promptSuggestions: false, keepAlive: true };
const S2_BODY = { prompt: 'r151b baseline S2', cwd: WORK2, sessionId: 'b0b0b0b0-0000-4000-8000-0000000000b2', model: 'r151b-model-2', permissionMode: 'bypassPermissions', globalRead: false, addDirs: [WORK], keepAlive: true, genui: false };
const S3_BODY = { prompt: 'r151b baseline S3', cwd: WORK, model: 'r151b-model', permissionMode: 'plan', agent: 'r151b-agent', promptSuggestions: true, appendSystemPrompt: 'R151B 附加提示', keepAlive: true };

const observed = {};
try {
  // ── ① 冷启 options:三种请求 × 总开关关的几种写法 ────────────────────────────────
  const OFF_VARIANTS = [
    ['没有 prefs.json', null],
    ['prefs 没有 xsEnabled 键', {}],
    ['xsEnabled:false', { xsEnabled: false }],
    ['xsEnabled 是字符串 "true"', { xsEnabled: 'true' }],
    ['xsEnabled 是数字 1', { xsEnabled: 1 }],
    ['prefs.json 损坏', '{ 坏的 json'],
  ];
  const hooksSeen = [];
  for (const [label, prefs] of OFF_VARIANTS) {
    setPrefs(prefs);
    for (const [name, body] of [['S1', S1_BODY], ['S2', S2_BODY], ['S3', S3_BODY]]) {
      const before = calls.length;
      const r = await postChat(body);
      assert.equal(r.status, 200, `${label} ${name}:POST /api/chat 应 200,实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.ok, true, `${label} ${name}:ok`);
      assert.equal(calls.length, before + 1, `${label} ${name}:冷启一次 query()`);
      const { options } = calls[calls.length - 1];
      const snap = snapshotOptions(options);
      if (!observed[name]) observed[name] = snap;
      assert.deepEqual(snap, observed[name], `${label} ${name}:总开关关的各种写法下 options 必须完全相同`);
      assert.deepEqual(snap.keys, EXPECTED[name].keys, `${label} ${name}:options 键集合与改动前相同`);
      if (!RECORD) assert.deepEqual(snap.data, EXPECTED[name].data, `${label} ${name}:options 取值与改动前相同`);
      assert.ok(!('mcpServers' in options), `${label} ${name}:没有 mcpServers`);
      assert.deepEqual(hookShape(options.hooks), HOOK_SHAPE, `${label} ${name}:hooks 只有一个 PreToolUse 回调`);
      assert.deepEqual(Object.keys(options.env).sort(), Object.keys(cleanChildEnv()).sort(), `${label} ${name}:env 键集合 = cleanChildEnv()`);
      assert.deepEqual(options.env, cleanChildEnv(), `${label} ${name}:env 取值 = cleanChildEnv()`);
      hooksSeen.push([`${label}/${name}`, options.hooks.PreToolUse[0].hooks[0]]);
      await waitIdle(r.body.pid);
    }
    await closeAllAndWait();
  }

  // ── ② 复用兼容键 ────────────────────────────────────────────────────────────────
  const compatInputs = {
    a: { workingDir: '/r151b/proj', effort: 'high', appendSystemPrompt: '', promptSuggestions: false, globalRead: true, dirs: ['/', '/r151b/home'], maxBudgetUsd: 3, acw: null, ams: null, genui: true },
    b: { workingDir: '/r151b/proj2', effort: undefined, appendSystemPrompt: '  附加  ', promptSuggestions: 'auto', globalRead: false, dirs: [], maxBudgetUsd: null, acw: null, ams: null, genui: false },
    c: { workingDir: '/r151b/proj', effort: 'low', appendSystemPrompt: '', promptSuggestions: true, globalRead: true, dirs: ['/'], maxBudgetUsd: null, acw: '200000', ams: '1', genui: undefined },
  };
  observed.compat = {};
  for (const [k, input] of Object.entries(compatInputs)) {
    observed.compat[k] = chatCompatKey(input);
    if (!RECORD) assert.equal(observed.compat[k], COMPAT[k], `chatCompatKey(${k}) 与改动前逐字相同`);
  }
  // 同会话第二条消息:复用常驻进程,不新起 query;推进输入流的消息形态不变
  setPrefs(null);
  const r1 = await postChat(S1_BODY);
  assert.equal(r1.status, 200, `S1 冷启:${JSON.stringify(r1.body)}`);
  const s1Live = await waitIdle(r1.body.pid);
  assert.ok(s1Live.sessionId, 'S1 有会话 id');
  const reuseBefore = calls.length;
  const r2 = await postChat({ ...S1_BODY, prompt: 'r151b baseline S1 第二条', sessionId: s1Live.sessionId });
  assert.equal(r2.status, 200, `复用:${JSON.stringify(r2.body)}`);
  assert.equal(r2.body.reused, true, '同会话、同参数的第二条消息复用常驻进程');
  assert.equal(calls.length, reuseBefore, '复用时不新起 query()');
  await waitIdle(r2.body.pid);
  const reusedRec = calls.find((c) => c.inputs.some((m) => m?.message?.content === 'r151b baseline S1 第二条'));
  assert.ok(reusedRec, '第二条消息推进了某个已存在进程的输入流');
  const pushed = reusedRec.inputs.find((m) => m?.message?.content === 'r151b baseline S1 第二条');
  observed.reusePush = { keys: Object.keys(pushed).sort(), messageKeys: Object.keys(pushed.message).sort(), type: pushed.type, role: pushed.message.role, contentType: typeof pushed.message.content };
  if (!RECORD) assert.deepEqual(observed.reusePush, REUSE_PUSH_KEYS, '复用时推进输入流的消息形态与改动前相同');

  // ── ③ PreToolUse 回调对任何输入放行 ───────────────────────────────────────────────
  // 登记表里放一条"本 GUI 正在跑的 S1 会话"的条目:总开关开着时引导会认出它;关着时必须照旧放行。
  writeFileSync(join(HOME, '.claude', 'sessions', '424242.json'), JSON.stringify({
    pid: 424242, sessionId: s1Live.sessionId, cwd: WORK, startedAt: Date.now(), version: '2.1.296', peerProtocol: 1, kind: 'interactive',
    entrypoint: 'sdk-ts', messagingSocketPath: '/tmp/cc-socks/424242.sock', name: '会话B', status: 'idle', updatedAt: Date.now(),
  }));
  const ctx = { session_id: 'c0c0c0c0-0000-4000-8000-0000000000c3', transcript_path: join(TMP, 't.jsonl'), cwd: WORK, permission_mode: 'default', hook_event_name: 'PreToolUse' };
  const sm = (to, kind, extra = {}) => ({ ...ctx, tool_name: 'SendMessage', tool_use_id: 'toolu_r151b', tool_input: { to, summary: 'hi', message: 'hi', type: 'message', recipient: to, recipient_kind: kind, content: 'hi', ...extra } });
  const INPUTS = [
    sm('会话B', 'name'),
    sm('会话B [ab12cd34]', 'name'),
    sm('uds:/tmp/cc-socks/424242.sock', 'session'),
    sm('/tmp/cc-socks/424242.sock', 'session'),
    sm('uds:/private/tmp/cc-socks/424242.sock', 'session'),
    sm('/private/tmp/cc-socks/424242.sock', 'session'),
    sm('main', 'main'),
    sm('abd52c2264178efc3', 'agent'),
    sm('bridge:session_01abc', 'bridge'),
    sm('did:example:123', 'did'),
    sm('no-such-session', 'name'),
    { ...sm('会话B', 'name'), agent_id: 'acac1fb66788588c2', agent_type: 'general-purpose' },
    { ...ctx, tool_name: 'SendMessage', tool_input: null },
    { ...ctx, tool_name: 'SendMessage', tool_input: 'not-an-object' },
    { ...ctx, tool_name: 'SendMessage', tool_input: { to: 42, recipient_kind: 7 } },
    { ...ctx, tool_name: 'Bash', tool_input: { command: 'ls -la' } },
    { ...ctx, tool_name: 'Bash', tool_input: { command: 'rm -rf ../victim' } },
    { ...ctx, tool_name: 'Write', tool_input: { file_path: join(WORK, 'a.txt'), content: 'x' } },
    { ...ctx, tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } },
    { ...ctx, tool_name: 'mcp__ccgui-sessions__send_message', tool_input: { to: '会话B', message: 'hi' } },
    { ...ctx, tool_name: 'mcp__ccgui-sessions__list_sessions', tool_input: {} },
    { ...ctx, tool_name: 'AskUserQuestion', tool_input: { questions: [] } },
    { ...ctx, tool_name: 'Agent', tool_input: { prompt: 'x', subagent_type: 'general-purpose' } },
    {},
    { tool_name: 123 },
    null,
    undefined,
  ];
  const CONTINUE = { continue: true };
  for (const [label, prefs] of OFF_VARIANTS) {
    setPrefs(prefs);
    for (const [where, hook] of hooksSeen) {
      for (const [i, input] of INPUTS.entries()) {
        const out = await hook(input, 'toolu_r151b', { signal: new AbortController().signal });
        assert.deepEqual(out, CONTINUE, `${label} · ${where} · 输入 #${i}:总开关关时 PreToolUse 一律放行`);
      }
    }
    // makePreToolUseHook 直调:官方会话六档全放行;第三方会话五个非 auto 档全放行;第三方 auto 档非 Bash 放行
    const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
    for (const mode of MODES) {
      for (const thirdPartyProvider of [false, true]) {
        const slot = { guiMode: mode, thirdPartyProvider, sessionId: s1Live.sessionId, cwd: WORK };
        const hook = makePreToolUseHook(slot);
        for (const [i, input] of INPUTS.entries()) {
          if (thirdPartyProvider && mode === 'auto' && input?.tool_name === 'Bash') continue; // r151a 的规则域
          const out = await hook(input, 'toolu_r151b', { signal: new AbortController().signal });
          assert.deepEqual(out, CONTINUE, `${label} · makePreToolUseHook(${mode}, 第三方=${thirdPartyProvider}) · 输入 #${i}:放行`);
        }
      }
    }
  }

  // ── 总开关关时不产生 ~/.claude-gui/xsession/ ─────────────────────────────────────────
  const { existsSync } = await import('node:fs');
  assert.ok(!existsSync(join(HOME, '.claude-gui', 'xsession')), '总开关关时不产生 ~/.claude-gui/xsession/');

  if (RECORD) {
    console.log(JSON.stringify({ S1: observed.S1.data, S2: observed.S2.data, S3: observed.S3.data, compat: observed.compat, reusePush: observed.reusePush }, null, 1));
    console.log('R151B_PRINT_OBSERVED:以上为观测值(未与基线比较取值项)');
  } else {
    console.log('PASS check-r151b-baseline');
  }
} finally {
  try { closeAllPersistentProcesses(); } catch { /* */ }
  await new Promise((r) => server.close(r));
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);
