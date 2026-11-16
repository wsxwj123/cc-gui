#!/usr/bin/env node
// r191-reattach-live-text 的假 claude 命令行:只说 stream-json,不碰实现内部。从 r186 夹具派生,加「慢速正文」剧本(唯一剧本,不读场景文件)。
// 每收到一条用户消息,输出一轮三条助手消息:
//   消息一:正文 P0(10 片,每片 50ms)+ 一次 Bash 工具调用(R191TOOL-1),工具约 1 秒后返回;
//   消息二:正文 P1(160 片,每片 250ms,约 40 秒)+ 一次 Bash 工具调用(R191TOOL-2),工具约 1 秒后返回;
//   消息三:正文 P2(40 片,每片 250ms,约 10 秒),然后这一轮结束。
// 每一片 = `R191-<段名>-<三位编号> `(例 `R191-P1-001 `)。
// 流事件形态:每条消息 stream_event 包着 message_start / content_block_start / content_block_delta... / content_block_stop / message_delta / message_stop;
//   每条消息里内容块 index 从 0 起(正文 0,工具调用 1);每个内容块的 content_block_stop 之后紧跟一条顶层 assistant 事件(message.content 只含这一个块),
//   它的 uuid = 写进会话文件的那条记录的 uuid。
// 写会话文件:每个内容块在它 content_block_stop 发出时才追加记录(与那条 assistant 事件同一时刻);正在写的一段不写文件。
//   P0 / P1 / P2 各自写盘后,在控制目录放标志文件 written-<段名>-<工作目录名>。
// 阶段写进 status-<工作目录名>.json 的 stage:p0-streaming / tool1-sent / tool1-returned / p1-streaming / tool2-sent / tool2-returned / p2-streaming / done / stopped / aborted。
// 收到 interrupt 控制请求:把正在写的那一段已输出的部分作为一条助手记录写进会话文件(不发对应的 assistant 事件),
//   再发用户事件 [Request interrupted by user](同时写进会话文件)和出错的结束事件(error_during_execution),结束这一轮。
// 收场:控制目录里出现 abort-<工作目录名> 文件时,当前回合尽快正常收尾(不写半截、不算打断)。
// 回合开头先写两行 queue-operation + 用户消息(侧栏才会列这条会话)。回合结束后进程不退出,继续等下一条用户消息。
// GUI 起标题的另一次调用(工作目录在 cgui-title 下、或 -p 非流式)立刻回短标题,不落盘。
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
const TOOL_MS = 1000;
const sid = argOf('--session-id') || argOf('--resume') || process.env.SF_SESSION_ID || crypto.randomUUID();
const cwd = process.cwd();
const WS = path.basename(cwd);
const TITLE_GEN = /cgui-title/.test(cwd) || (argv.includes('-p') && !argv.includes('--input-format'));
try { fs.appendFileSync(path.join(path.dirname(CTL), 'fake-claude-spawn.jsonl'), `${JSON.stringify({ argv, sid, cwd, titleGen: TITLE_GEN })}\n`); } catch { /* 忽略 */ }
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.322';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const ABORT_FILE = path.join(CTL, `abort-${WS}`);

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const evt = (event) => out({ type: 'stream_event', event, session_id: sid, parent_tool_use_id: null, uuid: crypto.randomUUID() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: VERSION, gitBranch: '' });
const setStage = (stage) => { try { fs.writeFileSync(path.join(CTL, `status-${WS}.json`), `${JSON.stringify({ stage, t: Date.now() })}\n`); } catch { /* 忽略 */ } };
const setWrittenFlag = (name) => { try { fs.writeFileSync(path.join(CTL, `written-${name}-${WS}`), `${Date.now()}\n`); } catch { /* 忽略 */ } };

let lastUuid = null;
function loadLastUuid() { // 续接已有会话时(种子会话),新行接在原链最后一条后面
  lastUuid = null;
  try {
    const ls = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(Boolean);
    for (let i = ls.length - 1; i >= 0 && lastUuid === null; i -= 1) {
      try { const o = JSON.parse(ls[i]); if (o.uuid) lastUuid = o.uuid; } catch { /* 跳过坏行 */ }
    }
  } catch { /* 文件还没有 */ }
}
function transcriptQueueAndUser(text) {
  append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: sid, content: text });
  append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(), sessionId: sid });
  transcriptUser(text);
}
function transcriptUser(text) {
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r191-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: text }, uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields(),
  });
  lastUuid = uuid;
}
function transcriptAssistant(id, blocks, stopReason, uuid) {
  append({
    parentUuid: lastUuid,
    message: { model: MODEL, id, type: 'message', role: 'assistant', content: blocks, stop_reason: stopReason, stop_sequence: null, stop_details: null, usage: USAGE },
    requestId: `req_${id}`, type: 'assistant', uuid, timestamp: stamp(), effort: 'high', ...baseFields(),
  });
  lastUuid = uuid;
}
function transcriptToolResult(toolUseId, content) {
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r191-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    uuid, timestamp: stamp(), toolUseResult: content, ...baseFields(),
  });
  lastUuid = uuid;
}
const emitAssistant = (id, blocks, stopReason, uuid) => out({ type: 'assistant', session_id: sid, uuid, parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: stopReason, usage: USAGE } });
const emitToolResult = (toolUseId, content) => out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
const emitInit = () => out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

// 被停止 = 收到 interrupt 控制请求;被收场 = 控制目录里有 abort 文件。
let interrupted = false;
class Cut extends Error { constructor(kind) { super(kind); this.kind = kind; } }
/** 可被打断的睡眠:每 25ms 看一眼;被停止 / 被收场就抛 Cut。 */
async function wait(ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (interrupted) throw new Cut('stop');
    if (fs.existsSync(ABORT_FILE)) throw new Cut('abort');
    const left = end - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(25, left));
  }
}

// 正在写的那一段(被停止时把它已输出的部分写进会话文件)。
let live = null;

/** 流式输出一段正文(content_block index 0),结束时发 assistant 事件、写会话文件、放写盘标志。 */
async function streamText(msgId, name, count, intervalMs, stopReason) {
  const uuid = crypto.randomUUID();
  setStage(`${name.toLowerCase()}-streaming`);
  evt({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  live = { msgId, uuid, name, text: '' };
  for (let i = 1; i <= count; i += 1) {
    const piece = `R191-${name}-${String(i).padStart(3, '0')} `;
    live.text += piece;
    evt({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
    await wait(intervalMs);
  }
  const blocks = [{ type: 'text', text: live.text }];
  evt({ type: 'content_block_stop', index: 0 });
  emitAssistant(msgId, blocks, stopReason, uuid);
  transcriptAssistant(msgId, blocks, stopReason, uuid);
  live = null;
  setWrittenFlag(name);
}

/** 输出一次工具调用(content_block index 1),工具约 1 秒后返回。 */
async function toolCall(msgId, n, tag) {
  const toolId = `toolu_r191_${n}_${tag}`;
  const input = { command: `echo r191 ${n}`, description: `R191TOOL-${n}` };
  const uuid = crypto.randomUUID();
  evt({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} } });
  evt({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  evt({ type: 'content_block_stop', index: 1 });
  const blocks = [{ type: 'tool_use', id: toolId, name: 'Bash', input }];
  emitAssistant(msgId, blocks, 'tool_use', uuid);
  transcriptAssistant(msgId, blocks, 'tool_use', uuid);
  evt({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: USAGE });
  evt({ type: 'message_stop' });
  setStage(`tool${n}-sent`);
  await wait(TOOL_MS);
  emitToolResult(toolId, `（假 CLI）R191 输出 ${n}`);
  transcriptToolResult(toolId, `（假 CLI）R191 输出 ${n}`);
  setStage(`tool${n}-returned`);
}

const messageStart = (msgId) => evt({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: USAGE } });

async function runRound(userText) {
  if (TITLE_GEN) {
    emitInit();
    emitAssistant('r191_title', [{ type: 'text', text: '短标题' }], 'end_turn', crypto.randomUUID());
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '短标题', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
    return;
  }
  interrupted = false;
  live = null;
  loadLastUuid();
  transcriptQueueAndUser(userText);
  emitInit();
  const tag = crypto.randomBytes(3).toString('hex');
  try {
    await wait(TURN_DELAY_MS);
    // 消息一:P0 + 工具 1
    messageStart(`r191_m1_${tag}`);
    await streamText(`r191_m1_${tag}`, 'P0', 10, 50, null);
    await toolCall(`r191_m1_${tag}`, 1, tag);
    // 消息二:P1 + 工具 2
    messageStart(`r191_m2_${tag}`);
    await streamText(`r191_m2_${tag}`, 'P1', 160, 250, null);
    await toolCall(`r191_m2_${tag}`, 2, tag);
    // 消息三:P2,然后结束
    messageStart(`r191_m3_${tag}`);
    await streamText(`r191_m3_${tag}`, 'P2', 40, 250, 'end_turn');
    evt({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: USAGE });
    evt({ type: 'message_stop' });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
    setStage('done');
  } catch (e) {
    if (!(e instanceof Cut)) throw e;
    if (e.kind === 'stop') {
      // 半截正文写进会话文件(不发对应的 assistant 事件),末尾加一个空格和 R191-<段名>-STOPPED(只写进文件、流里从不发),再发打断用户事件与出错的结束事件。
      if (live && live.text) transcriptAssistant(live.msgId, [{ type: 'text', text: `${live.text} R191-${live.name}-STOPPED` }], null, live.uuid);
      live = null;
      out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      transcriptUser('[Request interrupted by user]');
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE, errors: [] });
      setStage('stopped');
    } else {
      live = null;
      out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
      setStage('aborted');
    }
  }
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
    if (msg.request && msg.request.subtype === 'interrupt') interrupted = true;
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
