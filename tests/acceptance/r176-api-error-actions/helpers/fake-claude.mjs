#!/usr/bin/env node
// r176-api-error-actions 的假 claude 命令行：只说 stream-json，不碰实现内部。
//
// 一回合怎么收场，看用户消息里的标记词（没有标记词 = 正常回复「好的」）：
//   R176AUTH  接口报错 401  authentication_failed
//   R176RISK  接口报错 400  unknown        「Content Exists Risk」
//   R176EMPTY 接口报错 400  unknown        「text content blocks must be non-empty」
//   R176PRE   预检报错（只输出一个出错的结束事件，不产生助手消息，会话文件里不新增助手行）
//
// 「接口报错」形态（接口文件「测试环境约定」，2026-11-12 真实命令行 2.1.322 实录）：
//   1. 先把那条助手消息追加进会话文件（与本回合用户消息同一个文件），再依次输出两个事件：
//   2. assistant 事件（model "<synthetic>"，error / is_api_error_message / api_error_status）+ result 事件（success 但 is_error:true）。
//
// 每个回合先发 system init、等 TURN_DELAY_MS，再发后面的事件：让页面上的「停止」键先出现一小会儿，
// 用例才能可靠地区分「回合还没开始」与「回合已结束」。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${n}=`));
  return eq === undefined ? undefined : eq.slice(n.length + 1);
};

if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }

const TURN_DELAY_MS = 700;
const MODES = {
  R176AUTH: {
    form: 'api', status: 401, error: 'authentication_failed',
    text: 'Failed to authenticate. API Error: 401 Authentication Fails, Your api key: ****0000 is invalid (request_id: 5f6f636d-abcf-4556-bf90-77a1e0402acc)',
  },
  R176RISK: { form: 'api', status: 400, error: 'unknown', text: 'API Error: 400 Content Exists Risk' },
  R176EMPTY: { form: 'api', status: 400, error: 'unknown', text: 'API Error: 400 messages.1.content.0.text: text content blocks must be non-empty' },
  R176PRE: { form: 'pre', text: 'API Error: 401 Unauthorized' },
};
const modeOf = (userText) => {
  const t = String(userText || '');
  for (const k of Object.keys(MODES)) if (t.includes(k)) return MODES[k];
  return null;
};

const sid = argOf('--session-id') || argOf('--resume') || process.env.SF_SESSION_ID || crypto.randomUUID();
const cwd = process.cwd();
// GUI 会另起一个 CLI（cwd 形如 /tmp/cgui-title-*）只为给新会话起标题：它不吃标记词、也不往会话文件里落盘。
const TITLE_GEN = /cgui-title-/.test(cwd);
try { fs.appendFileSync(path.join(path.dirname(CTL), 'fake-claude-spawn.jsonl'), `${JSON.stringify({ argv, sid, cwd, titleGen: TITLE_GEN })}\n`); } catch { /* 忽略 */ }
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.322';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: VERSION, gitBranch: '' });

// 本进程里上一条落盘行的 uuid：下一行的 parentUuid 接着它（真实转写是一条链）。
let lastUuid = null;

function normalAssistantLine(id, text) {
  const uuid = crypto.randomUUID();
  const line = {
    parentUuid: lastUuid,
    message: { model: MODEL, id, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE },
    requestId: `req_${id}`, type: 'assistant', uuid, timestamp: stamp(), effort: 'high', ...baseFields(),
  };
  lastUuid = uuid;
  return line;
}

// 接口报错时真实命令行追加的那一行（形态取自 r151b 假命令行的 apiErrorLine，按接口文件改成 2.1.322 的字段）。
function apiErrorTranscriptLine(mode) {
  const uuid = crypto.randomUUID();
  const message = {
    diagnostics: null, id: crypto.randomUUID(), container: null, model: '<synthetic>', role: 'assistant', stop_details: null,
    stop_reason: 'stop_sequence', stop_sequence: '', type: 'message',
    usage: {
      output_tokens_details: null, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: null, iterations: null, speed: null, fallback_credit: null,
    },
    content: [{ type: 'text', text: mode.text }],
    context_management: null,
  };
  const line = {
    parentUuid: lastUuid, type: 'assistant', uuid, timestamp: stamp(), message,
    error: mode.error, isApiErrorMessage: true, apiErrorStatus: mode.status, perTurnEffort: null, ...baseFields(),
  };
  lastUuid = uuid;
  return line;
}

async function runRound(userText) {
  const mode = TITLE_GEN ? null : modeOf(userText);
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  const userUuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r176-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: userText },
    uuid: userUuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields(),
  });
  lastUuid = userUuid;
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  await sleep(TURN_DELAY_MS);

  if (mode && mode.form === 'pre') {
    // 严格按接口文件:只有 type / subtype / is_error / errors / session_id(外加 uuid)。
    // 2026-11-12 试过再加 result / duration_ms / num_turns / usage:页面照样不画「❌」块(见报告「问题」第 1 条),所以不加。
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [mode.text], session_id: sid, uuid: crypto.randomUUID() });
    return;
  }
  if (mode && mode.form === 'api') {
    // 先落盘，再输出两个事件（接口文件：在输出结束事件之前把助手消息追加进会话文件）。
    append(apiErrorTranscriptLine(mode));
    out({
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: mode.text }], stop_reason: 'stop_sequence' },
      error: mode.error, is_api_error_message: true, api_error_status: mode.status,
      session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null,
    });
    out({
      type: 'result', subtype: 'success', is_error: true, api_error_status: mode.status, result: mode.text, session_id: sid,
      uuid: crypto.randomUUID(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE,
    });
    return;
  }
  const id = `r176_fake_${crypto.randomBytes(3).toString('hex')}`;
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: MODEL, type: 'message', content: [{ type: 'text', text: '好的' }], stop_reason: 'end_turn', usage: USAGE } });
  append(normalAssistantLine(id, '好的'));
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '好的', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}

if (!fs.existsSync(CTL)) { try { fs.mkdirSync(CTL, { recursive: true }); } catch { /* 忽略 */ } }

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) { await runRound(printArg); process.exit(0); }

const queue = [];
let running = false;
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) await runRound(queue.shift());
  running = false;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_response') return;
  if (msg.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  queue.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
  void pump();
});
await new Promise((resolve) => rl.on('close', resolve));
process.exit(0);
