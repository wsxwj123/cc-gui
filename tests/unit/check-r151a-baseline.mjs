#!/usr/bin/env node
// r151a T-Y0 官方 / 开关关 基线:功能 Y 的改动不得改变这些输出。
//   ① openai 协议代理 buildOpenAIRequest:流式输入(stream === true)与 stream:false 输入的输出,
//      与改动前(0.2.421,未改动的工作树上录下)逐字节相同。
//   ② cleanChildEnv():官方 / 没有 settings.json / 第三方但总开关关 时,输出的键集合与值
//      与改动前的规则逐项相同(参照规则在本文件里照改动前的源码写死,不 import 被测函数的零件)。
// 基线字符串是改动前录的,实现落地后不要重录。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL_HOME = process.env.HOME;
const REAL_PROFILE = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), 'cgui-r151a-baseline-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, '.claude-gui'), { recursive: true });

const { buildOpenAIRequest } = await import('../../server/services/openai-proxy.js');
const { cleanChildEnv } = await import('../../server/routes/chat.js');

try {
  // ── ① 代理转换基线 ──────────────────────────────────────────────────────────
  const TOOLS = [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }];
  const CASES = {
    's-basic': { model: 'm-chat', max_tokens: 256, stream: true, system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
    's-tools': {
      model: 'm-chat', max_tokens: 1024, stream: true, temperature: 0.3, top_p: 0.9, metadata: { user_id: 'u' },
      system: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'b' }],
      tools: TOOLS, tool_choice: { type: 'tool', name: 'Bash' },
      messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }],
    },
    's-stop': { model: 'm-chat', max_tokens: 64, stream: true, stop_sequences: ['</block>', 'X', 'Y', 'Z', 'W'], messages: [{ role: 'user', content: 'x' }] },
    's-effort': { model: 'm-reasoner', max_tokens: 4096, stream: true, effort: 'high', thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'think' }] },
    'n-false': { model: 'm-chat', max_tokens: 100, stream: false, tools: TOOLS, tool_choice: { type: 'any' }, messages: [{ role: 'user', content: 'x' }] },
  };
  const BASELINE = {
    's-basic': '{"model":"m-chat","messages":[{"role":"system","content":"sys"},{"role":"user","content":"hi"}],"stream":true,"max_tokens":256,"stream_options":{"include_usage":true}}',
    's-tools': '{"model":"m-chat","messages":[{"role":"system","content":"a\\nb"},{"role":"user","content":"x"},{"role":"assistant","tool_calls":[{"id":"t1","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},{"role":"tool","tool_call_id":"t1","content":"ok"}],"stream":true,"max_tokens":1024,"temperature":0.3,"top_p":0.9,"tools":[{"type":"function","function":{"name":"Bash","description":"run","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}],"tool_choice":{"type":"function","function":{"name":"Bash"}},"stream_options":{"include_usage":true}}',
    's-stop': '{"model":"m-chat","messages":[{"role":"user","content":"x"}],"stream":true,"max_tokens":64,"stream_options":{"include_usage":true}}',
    's-effort': '{"model":"m-reasoner","messages":[{"role":"user","content":"think"}],"stream":true,"max_tokens":4096,"reasoning_effort":"high","stream_options":{"include_usage":true}}',
    'n-false': '{"model":"m-chat","messages":[{"role":"user","content":"x"}],"stream":false,"max_tokens":100,"tools":[{"type":"function","function":{"name":"Bash","description":"run","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}],"tool_choice":"required"}',
  };
  for (const [name, input] of Object.entries(CASES)) {
    assert.equal(JSON.stringify(buildOpenAIRequest(structuredClone(input))), BASELINE[name], `buildOpenAIRequest ${name}:与改动前逐字节相同`);
  }

  // ── ② cleanChildEnv 基线 ────────────────────────────────────────────────────
  // 改动前的规则(照 0.2.421 源码写死):复制宿主 env → 删 provider 路由键 → 删 CLAUDE_CODE_* / CLAUDE_AGENT_*
  // 与 8 个宿主标识键 → settings.json 有 ANTHROPIC_BASE_URL 且没设 CLAUDE_CODE_ATTRIBUTION_HEADER 时补 '0'。
  const ROUTING = [
    'ANTHROPIC_MODEL', 'CLAUDE_MODEL',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_PERMISSION_MODE', 'CLAUDE_PERMISSION_MODE', 'CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS',
  ];
  const HOST = ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_EFFORT', 'API_TIMEOUT_MS', 'ENABLE_TOOL_SEARCH', 'MCP_CONNECTION_NONBLOCKING', 'DISABLE_MICROCOMPACT', 'DISABLE_AUTOUPDATER'];
  const referenceEnv = (settingsEnv) => {
    const e = { ...process.env };
    for (const k of ROUTING) delete e[k];
    for (const k of Object.keys(e)) if (/^CLAUDE_CODE_/.test(k) || /^CLAUDE_AGENT_/.test(k)) delete e[k];
    for (const k of HOST) delete e[k];
    if (settingsEnv && settingsEnv.ANTHROPIC_BASE_URL && settingsEnv.CLAUDE_CODE_ATTRIBUTION_HEADER === undefined) e.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    return e;
  };
  const SETTINGS = join(home, '.claude', 'settings.json');
  const PREFS = join(home, '.claude-gui', 'prefs.json');
  const setSettings = (obj) => { if (obj === null) rmSync(SETTINGS, { force: true }); else writeFileSync(SETTINGS, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  const setPrefs = (obj) => { if (obj === null) rmSync(PREFS, { force: true }); else writeFileSync(PREFS, JSON.stringify(obj)); };

  // 宿主环境里故意带着会被剥掉的键(含 CLAUDE_CODE_AUTO_MODE_SERVER)
  const savedHost = {};
  const HOST_INJECT = { CLAUDE_CODE_AUTO_MODE_SERVER: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_BASE_URL: 'http://host.invalid', CLAUDECODE: '1', R151A_KEEP_ME: 'yes' };
  for (const [k, v] of Object.entries(HOST_INJECT)) { savedHost[k] = process.env[k]; process.env[k] = v; }
  try {
    const scenes = [
      ['没有 settings.json + 开关关', null, null],
      ['settings.json 损坏 + 开关关', '{bad json', null],
      ['官方(没有 BASE_URL)+ 开关关', { env: {} }, null],
      ['官方(没有 BASE_URL)+ 开关开', { env: {} }, { thirdPartyAuto: true }],
      ['官方地址 BASE_URL + 开关开', { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, { thirdPartyAuto: true }],
      ['第三方 + 没有 prefs.json', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' } }, null],
      ['第三方 + 开关键缺失', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' } }, { releaseNotesSeen: 'x' }],
      ['第三方 + 开关 false', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' } }, { thirdPartyAuto: false }],
      ['第三方 + 开关值不是布尔', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' } }, { thirdPartyAuto: 'true' }],
      ['第三方 + 已显式设归因头 + 开关关', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788', CLAUDE_CODE_ATTRIBUTION_HEADER: '1' } }, null],
    ];
    for (const [label, settings, prefs] of scenes) {
      setSettings(settings);
      setPrefs(prefs);
      const settingsEnv = settings && typeof settings === 'object' ? settings.env : null;
      const got = cleanChildEnv();
      const want = referenceEnv(settingsEnv);
      assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `cleanChildEnv 键集合:${label}`);
      assert.deepEqual(got, want, `cleanChildEnv 取值:${label}`);
      assert.ok(!('CLAUDE_CODE_AUTO_MODE_SERVER' in got), `${label}:不应有 CLAUDE_CODE_AUTO_MODE_SERVER`);
      assert.equal(got.R151A_KEEP_ME, 'yes', `${label}:与 provider 无关的宿主键原样保留`);
    }
  } finally {
    for (const [k, v] of Object.entries(savedHost)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }

  console.log('PASS check-r151a-baseline');
} finally {
  process.env.HOME = REAL_HOME;
  if (REAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_PROFILE;
  rmSync(home, { recursive: true, force: true });
}
