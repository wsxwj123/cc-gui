#!/usr/bin/env node
// r183-error-plain-text 的假 claude 命令行:只说 stream-json,不碰实现内部。
// 一回合怎么收场,由场景文件 $CGUI_FAKE_CLAUDE_DIR/scenario-<工作目录名>.json 决定(每收到一条用户消息读一次):
//   { "form": "result-only" | "api-message" | "normal", "text": "报错文字或正常回复文字", "prelude": "可选:甲形态之前先正常说的一句" }
//   result-only  甲「只有结束事件报错」:不产生助手消息、会话文件里不写这条报错,只输出一个出错的结束事件
//                (type:"result", is_error:true, 报错文字在 result 字段)。
//   api-message  乙「先写一条报错助手消息再结束」:先把一条助手消息追加进会话文件(isApiErrorMessage:true、model:"<synthetic>"、
//                正文 = 报错文字),再输出同内容的 assistant 事件(is_api_error_message:true)和结束事件。
//   normal       一条完整的正常助手回复(同时落盘),result 为同一段文字。
// 每个回合先发 system init、等 TURN_DELAY_MS 再发后面的事件:让页面上的「停止」键先出现一小会儿,
// 用例才能区分「回合还没开始」与「回合已结束」,也让「回合进行中」的观察有时间窗。
// 回合结束后进程不退出,继续等下一条用户消息。
// GUI 起标题用的另一次调用(工作目录名里带 cgui-title-)立刻回一个短标题,不落盘。
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

const TURN_DELAY_MS = 1200;
const sid = argOf('--session-id') || argOf('--resume') || process.env.SF_SESSION_ID || crypto.randomUUID();
const cwd = process.cwd();
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

function readScenario() {
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(CTL, `scenario-${path.basename(cwd)}.json`), 'utf8'));
    if (sc && typeof sc.form === 'string') return sc;
  } catch { /* 读不到就用默认 */ }
  return { form: 'normal', text: '好的' };
}

let lastUuid = null;
function transcriptUser(text) {
  if (lastUuid === null && !argOf('--resume')) append({ type: 'summary', summary: String(text || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r183-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: text },
    uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields(),
  });
  lastUuid = uuid;
}
function transcriptNormalAssistant(id, text) {
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid,
    message: { model: MODEL, id, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE },
    requestId: `req_${id}`, type: 'assistant', uuid, timestamp: stamp(), effort: 'high', ...baseFields(),
  });
  lastUuid = uuid;
}
function transcriptApiError(text) {
  const uuid = crypto.randomUUID();
  const message = {
    diagnostics: null, id: crypto.randomUUID(), container: null, model: '<synthetic>', role: 'assistant', stop_details: null,
    stop_reason: 'stop_sequence', stop_sequence: '',
    usage: {
      output_tokens_details: null, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: null, iterations: null, speed: null, fallback_credit: null,
    },
    type: 'message', content: [{ type: 'text', text }], context_management: null,
  };
  append({
    parentUuid: lastUuid, type: 'assistant', uuid, timestamp: stamp(), message,
    error: 'unknown', isApiErrorMessage: true, apiErrorStatus: 400, perTurnEffort: null, ...baseFields(),
  });
  lastUuid = uuid;
}
function emitNormalAssistant(id, text) {
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: USAGE } });
}
const newMsgId = () => `r183_${crypto.randomBytes(3).toString('hex')}`;

async function runRound(userText) {
  if (TITLE_GEN) {
    out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
    emitNormalAssistant(newMsgId(), '短标题');
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '短标题', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
    return;
  }
  const sc = readScenario();
  transcriptUser(userText);
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  await sleep(TURN_DELAY_MS);

  if (sc.form === 'normal') {
    const id = newMsgId();
    emitNormalAssistant(id, sc.text);
    transcriptNormalAssistant(id, sc.text);
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: sc.text, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
    return;
  }
  if (sc.form === 'api-message') {
    transcriptApiError(sc.text);
    out({
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: sc.text }], stop_reason: 'stop_sequence' },
      error: 'unknown', is_api_error_message: true, api_error_status: 400,
      session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null,
    });
    out({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: sc.text, session_id: sid,
      uuid: crypto.randomUUID(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE,
    });
    return;
  }
  // result-only
  if (sc.prelude) {
    const id = newMsgId();
    emitNormalAssistant(id, sc.prelude);
    transcriptNormalAssistant(id, sc.prelude);
  }
  // 结束事件的写法由场景的 resultShape 决定(默认 'both');见 README 式说明:
  //   result          subtype error_during_execution,报错文字只在 result 字段(接口文件的字面写法)
  //   result-success  subtype success + is_error:true,报错文字在 result 字段
  //   errors          subtype error_during_execution,报错文字只在 errors:[…](r176 预检报错的写法)
  //   both            subtype error_during_execution,result 与 errors 都带报错文字
  const shape = sc.resultShape || 'both';
  const ev = { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID() };
  if (shape === 'result-success') ev.subtype = 'success';
  if (shape !== 'errors') ev.result = sc.text;
  if (shape === 'errors' || shape === 'both') ev.errors = [sc.text];
  out(ev);
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
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  queue.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
  void pump();
});
await new Promise((resolve) => rl.on('close', resolve));
process.exit(0);
