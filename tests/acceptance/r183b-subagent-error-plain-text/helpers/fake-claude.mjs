#!/usr/bin/env node
// r183b-subagent-error-plain-text 的假 claude 命令行:只说 stream-json,不碰实现内部(由 r183 套件的假命令行改来)。
// 一回合怎么收场,由场景文件 $CGUI_FAKE_CLAUDE_DIR/scenario-<工作目录名>.json 决定(每收到一条用户消息读一次):
//   { "form": "sub-error" | "sub-normal" | "api-message" | "normal" | ..., "text": "报错文字或正常回复文字", "blocks": ["可选:乙形态报错消息的多个文字块"] }
//   sub-error    子代理报错轮(接口文件「子代理报错轮」8 步;子代理失败早于主回合结束);text = 报错原文(前面由本文件加 "API Error: 400 ")
//   sub-normal   正常子代理轮(第 4 步换成子代理的普通助手消息,状态 completed)
//   api-message  乙形态(主会话);blocks 给出时 message.content 是这几个文字块,否则单块 text
// 其余形态沿用 r183 的说明:
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
  if (lastUuid === null && !argOf('--resume')) {
    // 真实命令行的会话文件开头:先两行 queue-operation(入队带 content、出队不带)
    append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: sid, content: text });
    append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(), sessionId: sid });
  }
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
function transcriptApiError(text, blocks) {
  const uuid = crypto.randomUUID();
  const message = {
    diagnostics: null, id: crypto.randomUUID(), container: null, model: '<synthetic>', role: 'assistant', stop_details: null,
    stop_reason: 'stop_sequence', stop_sequence: '',
    usage: {
      output_tokens_details: null, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: null, iterations: null, speed: null, fallback_credit: null,
    },
    type: 'message', content: (blocks || [text]).map((t) => ({ type: 'text', text: t })), context_management: null,
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

/** 子代理轮:接口文件「子代理报错轮」1~8 步;sub-normal 是「正常子代理轮」变体。子代理的失败 / 完成早于主回合结束。 */
async function runSubagentRound(sc) {
  const T = 'a1b2c3d4e5f6071b';
  const U = 'toolu_r183b_subagent_1';
  const isErr = sc.form === 'sub-error';
  const subPrompt = '请去查一下 R183B 的事';
  const errBody = `API Error: 400 ${sc.text}`;
  const input = { description: 'R183B 子代理', prompt: subPrompt, subagent_type: 'general-purpose' };
  const gap = () => sleep(150);

  // 1 task_started
  out({ type: 'system', subtype: 'task_started', task_id: T, tool_use_id: U, description: input.description, subagent_type: 'general-purpose', task_type: 'local_agent', prompt: subPrompt, session_id: sid, uuid: crypto.randomUUID() });
  await gap();
  // 2 assistant:Agent 的 tool_use
  const msgId = newMsgId();
  const toolUse = { type: 'tool_use', id: U, name: 'Agent', input };
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id: msgId, role: 'assistant', model: MODEL, type: 'message', content: [toolUse], stop_reason: 'tool_use', usage: USAGE } });
  { const uuid = crypto.randomUUID();
    append({ parentUuid: lastUuid, message: { model: MODEL, id: msgId, type: 'message', role: 'assistant', content: [toolUse], stop_reason: 'tool_use', stop_sequence: null, stop_details: null, usage: USAGE }, requestId: `req_${msgId}`, type: 'assistant', uuid, timestamp: stamp(), effort: 'high', ...baseFields() });
    lastUuid = uuid; }
  await gap();
  // 3 user:tool_result(异步启动)
  out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: U, content: 'Async agent launched successfully.', is_error: false }] } });
  { const uuid = crypto.randomUUID();
    append({ parentUuid: lastUuid, type: 'user', uuid, timestamp: stamp(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: U, content: 'Async agent launched successfully.', is_error: false }] }, toolUseResult: 'Async agent launched successfully.', ...baseFields() });
    lastUuid = uuid; }
  await gap();

  // 子代理记录文件(第 4 步之前写好)
  const subDir = path.join(PROJ, sid, 'subagents');
  const subBase = { isSidechain: true, agentId: T, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: VERSION, gitBranch: '' };
  const subUserUuid = crypto.randomUUID();
  const subMsg = isErr
    ? { diagnostics: null, id: crypto.randomUUID(), container: null, model: '<synthetic>', role: 'assistant', stop_details: null, stop_reason: 'stop_sequence', stop_sequence: '', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, type: 'message', content: [{ type: 'text', text: errBody }] }
    : { model: MODEL, id: newMsgId(), type: 'message', role: 'assistant', content: [{ type: 'text', text: sc.text }], stop_reason: 'end_turn', stop_sequence: null, usage: USAGE };
  if (!TITLE_GEN) {
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, `agent-${T}.meta.json`), JSON.stringify({ toolUseId: U, agentType: 'general-purpose' }));
    const subLines = [
      { ...subBase, parentUuid: null, type: 'user', uuid: subUserUuid, timestamp: stamp(), message: { role: 'user', content: subPrompt } },
      { ...subBase, parentUuid: subUserUuid, type: 'assistant', uuid: crypto.randomUUID(), timestamp: stamp(), message: subMsg, ...(isErr ? { error: 'unknown', isApiErrorMessage: true, apiErrorStatus: 400 } : { requestId: `req_${subMsg.id}` }) },
    ];
    fs.writeFileSync(path.join(subDir, `agent-${T}.jsonl`), `${subLines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
  await sleep(150);

  // 4 子代理的消息(带 parent_tool_use_id)
  if (isErr) {
    out({ type: 'assistant', parent_tool_use_id: U, is_api_error_message: true, error: 'unknown', session_id: sid, uuid: crypto.randomUUID(), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: errBody }], stop_reason: 'stop_sequence' } });
  } else {
    out({ type: 'assistant', parent_tool_use_id: U, session_id: sid, uuid: crypto.randomUUID(), message: { id: subMsg.id, role: 'assistant', model: MODEL, type: 'message', content: [{ type: 'text', text: sc.text }], stop_reason: 'end_turn', usage: USAGE } });
  }
  await gap();
  // 5 task_updated  6 task_notification
  const summaryErr = `Agent terminated early due to an API error: ${errBody}`;
  out({ type: 'system', subtype: 'task_updated', task_id: T, patch: isErr ? { status: 'failed', error: summaryErr } : { status: 'completed' }, session_id: sid, uuid: crypto.randomUUID() });
  await gap();
  out({ type: 'system', subtype: 'task_notification', task_id: T, tool_use_id: U, status: isErr ? 'failed' : 'completed', summary: isErr ? summaryErr : 'done', session_id: sid, uuid: crypto.randomUUID() });
  await sleep(600);
  // 7 主代理正文  8 result
  const mid = newMsgId();
  emitNormalAssistant(mid, 'R183B-MAIN-DONE');
  transcriptNormalAssistant(mid, 'R183B-MAIN-DONE');
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: 'R183B-MAIN-DONE', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}

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
  if (sc.form === 'sub-error' || sc.form === 'sub-normal') { await runSubagentRound(sc); return; }
  if (sc.form === 'api-message') {
    const blocks = Array.isArray(sc.blocks) && sc.blocks.length ? sc.blocks : null;
    transcriptApiError(sc.text, blocks);
    out({
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>', content: (blocks || [sc.text]).map((t) => ({ type: 'text', text: t })), stop_reason: 'stop_sequence' },
      error: 'unknown', is_api_error_message: true, api_error_status: 400,
      session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null,
    });
    out({
      type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: blocks ? blocks.join('\n') : sc.text, session_id: sid,
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
