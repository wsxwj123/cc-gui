#!/usr/bin/env node
// r201l 复现用假 claude 命令行(从 r191 夹具派生):只说 stream-json。加「回合中途并入」:
//   回合在跑、还有工具边界时收到的用户消息 = 并入(steer):收到时写 queue-operation{enqueue};
//   在下一个工具结果之后折叠进同一轮(照真实命令行 2.1.327 的写盘顺序:tool_result → queue-operation{remove, absorbed_mid_turn}
//   → attachment{queued_command, prompt, source_uuid, commandMode:'prompt'}),流里不回显这条用户消息。
//   回合已经过了最后一个工具边界才收到的并入:回合结束后另起一轮(dequeue + 真 user 行,uuid = 并入的 uuid,第 2 个 init)。
// 剧本(每个工作区 script-<工作区名>.json,可缺省):
//   tool1Hold:'steer'(默认:工具 1 一直挂着,收到并入后再过 afterSteerMs 返回;最长 holdMaxMs)| 'gate'(等 gate-tool1-<工作区名>)| 数字(毫秒)
//   afterSteerMs(默认 1500)、holdMaxMs(默认 90000)
//   p1Kind:'thinking'(默认)| 'text' —— 工具 1 之后第一段是思考还是正文
//   p1Count / p1Ms(默认 120 片 × 250ms)、p1bCount / p1bMs(默认 40 × 250ms,P1 之后再写一段正文)、p2Count / p2Ms(默认 20 × 250ms)
//   tool2Ms(默认 1000)
// 一轮:消息一 = 正文 P0(10 片)+ 工具 1;消息二 = P1(思考或正文)+ 正文 P1B + 工具 2;消息三 = 正文 P2,结束。
// 每一片 = `R201L-<段名>-<三位编号> `。阶段写进 status-<工作区名>.json;写盘标志 written-<名>-<工作区名>;事件流水 events-<工作区名>.jsonl。
// 收到 interrupt:正在写的那一段写进会话文件,发 [Request interrupted by user] 和出错的结束事件。abort-<工作区名> 出现:尽快正常收尾。
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
const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const cwd = process.cwd();
const WS = path.basename(cwd);
const TITLE_GEN = /cgui-title/.test(cwd) || (argv.includes('-p') && !argv.includes('--input-format'));
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.327';
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
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd, sessionId: sid, version: VERSION, gitBranch: '' });
const setStage = (stage) => { try { fs.writeFileSync(path.join(CTL, `status-${WS}.json`), `${JSON.stringify({ stage, t: Date.now() })}\n`); } catch { /* 忽略 */ } };
const setWrittenFlag = (name) => { try { fs.writeFileSync(path.join(CTL, `written-${name}-${WS}`), `${Date.now()}\n`); } catch { /* 忽略 */ } };
const clog = (o) => { try { fs.appendFileSync(path.join(CTL, `events-${WS}.jsonl`), `${JSON.stringify({ ts: Date.now(), ...o })}\n`); } catch { /* 忽略 */ } };
const readScript = () => { try { return JSON.parse(fs.readFileSync(path.join(CTL, `script-${WS}.json`), 'utf8')); } catch { return {}; } };

let lastUuid = null;
function loadLastUuid() {
  lastUuid = null;
  try {
    const ls = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(Boolean);
    for (let i = ls.length - 1; i >= 0 && lastUuid === null; i -= 1) {
      try { const o = JSON.parse(ls[i]); if (o.uuid) lastUuid = o.uuid; } catch { /* 跳过坏行 */ }
    }
  } catch { /* 文件还没有 */ }
}
function transcriptUser(text, uuid = crypto.randomUUID()) {
  append({
    parentUuid: lastUuid, promptId: 'r201l-fake', type: 'user', isMeta: false,
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
    parentUuid: lastUuid, promptId: 'r201l-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    uuid, timestamp: stamp(), toolUseResult: content, ...baseFields(),
  });
  lastUuid = uuid;
}
const emitAssistant = (id, blocks, stopReason, uuid) => out({ type: 'assistant', session_id: sid, uuid, parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: stopReason, usage: USAGE } });
const emitToolResult = (toolUseId, content) => out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
const emitInit = () => out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

let interrupted = false;
class Cut extends Error { constructor(kind) { super(kind); this.kind = kind; } }
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

// ── 并入 ──
let roundActive = false;      // 本轮在跑
let foldOpen = false;         // 本轮后面还有工具边界(收到的消息可以折进同一轮)
const pendingSteers = [];     // 等着折进本轮的并入 { uuid, content, ts }
const lateSteers = [];        // 过了最后一个工具边界才收到的:回合结束后另起一轮
let steerSeen = null;         // 第一次收到并入的时刻(工具 1 的 'steer' 挂法用)
function foldPending() {
  for (const s of pendingSteers.splice(0)) {
    const deliveryId = crypto.randomUUID();
    append({ type: 'queue-operation', operation: 'remove', timestamp: stamp(), sessionId: sid, content: s.content, reason: 'absorbed_mid_turn', commandUuid: s.uuid, deliveryId });
    const uuid = crypto.randomUUID();
    append({
      parentUuid: lastUuid, isSidechain: false,
      attachment: { type: 'queued_command', prompt: s.content, source_uuid: s.uuid, delivery_id: deliveryId, commandMode: 'prompt', timestamp: s.ts },
      type: 'attachment', uuid, timestamp: s.ts, userType: 'external', entrypoint: 'sdk-ts', cwd, sessionId: sid, version: VERSION, gitBranch: '',
    });
    lastUuid = uuid;
    clog({ ev: 'folded', steerUuid: s.uuid, content: s.content });
  }
  setWrittenFlag('FOLD');
}

let live = null;
async function streamBlock(msgId, index, kind, name, count, intervalMs) {
  const uuid = crypto.randomUUID();
  setStage(`${name.toLowerCase()}-streaming`);
  clog({ ev: 'block-start', name, kind });
  evt({ type: 'content_block_start', index, content_block: kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' } });
  live = { msgId, uuid, name, kind, text: '' };
  for (let i = 1; i <= count; i += 1) {
    const piece = `R201L-${name}-${String(i).padStart(3, '0')} `;
    live.text += piece;
    evt({ type: 'content_block_delta', index, delta: kind === 'thinking' ? { type: 'thinking_delta', thinking: piece } : { type: 'text_delta', text: piece } });
    await wait(intervalMs);
  }
  if (kind === 'thinking') evt({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'r201lsig' } });
  const blocks = kind === 'thinking' ? [{ type: 'thinking', thinking: live.text, signature: 'r201lsig' }] : [{ type: 'text', text: live.text }];
  evt({ type: 'content_block_stop', index });
  emitAssistant(msgId, blocks, null, uuid);
  transcriptAssistant(msgId, blocks, null, uuid);
  live = null;
  setWrittenFlag(name);
  clog({ ev: 'block-written', name });
}

async function holdTool1(sc) {
  const mode = sc.tool1Hold ?? 'steer';
  if (typeof mode === 'number') { await wait(mode); return; }
  const maxEnd = Date.now() + (sc.holdMaxMs ?? 90_000);
  for (;;) {
    if (Date.now() >= maxEnd) return;
    if (mode === 'gate' && fs.existsSync(path.join(CTL, `gate-tool1-${WS}`))) return;
    if (mode === 'steer' && steerSeen !== null && Date.now() - steerSeen >= (sc.afterSteerMs ?? 1500)) return;
    await wait(50);
  }
}

async function toolCall(msgId, index, n, tag, holdFn) {
  const toolId = `toolu_r201l_${n}_${tag}`;
  const input = { command: `echo r201l ${n}`, description: `R201LTOOL-${n}` };
  const uuid = crypto.randomUUID();
  evt({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} } });
  evt({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
  evt({ type: 'content_block_stop', index });
  const blocks = [{ type: 'tool_use', id: toolId, name: 'Bash', input }];
  emitAssistant(msgId, blocks, 'tool_use', uuid);
  transcriptAssistant(msgId, blocks, 'tool_use', uuid);
  evt({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: USAGE });
  evt({ type: 'message_stop' });
  setStage(`tool${n}-sent`);
  setWrittenFlag(`TOOL${n}`);
  clog({ ev: 'tool-sent', n, toolId });
  await holdFn();
  emitToolResult(toolId, `（假 CLI）R201L 输出 ${n}`);
  transcriptToolResult(toolId, `（假 CLI）R201L 输出 ${n}`);
  clog({ ev: 'tool-returned', n });
  foldPending();
  setStage(`tool${n}-returned`);
}

const messageStart = (msgId) => evt({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: USAGE } });
const resultOk = () => out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });

async function steerTurn(s) {
  // 过了最后一个工具边界才收到的并入:回合结束后另起一轮(dequeue + 真 user 行,uuid = 并入的 uuid)
  append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(), sessionId: sid });
  transcriptUser(s.content, s.uuid);
  emitInit();
  clog({ ev: 'steer-turn', steerUuid: s.uuid });
  const tag = crypto.randomBytes(3).toString('hex');
  messageStart(`r201l_s_${tag}`);
  await streamBlock(`r201l_s_${tag}`, 0, 'text', 'S', 20, 250);
  evt({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: USAGE });
  evt({ type: 'message_stop' });
  resultOk();
}

async function runRound(userText) {
  if (TITLE_GEN) {
    emitInit();
    emitAssistant('r201l_title', [{ type: 'text', text: '短标题' }], 'end_turn', crypto.randomUUID());
    resultOk();
    return;
  }
  const sc = readScript();
  interrupted = false;
  live = null;
  steerSeen = null;
  loadLastUuid();
  append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: sid, content: userText });
  append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(), sessionId: sid });
  transcriptUser(userText);
  emitInit();
  roundActive = true;
  foldOpen = true;
  clog({ ev: 'round-start', text: userText });
  const tag = crypto.randomBytes(3).toString('hex');
  try {
    await wait(TURN_DELAY_MS);
    messageStart(`r201l_m1_${tag}`);
    await streamBlock(`r201l_m1_${tag}`, 0, 'text', 'P0', 10, 50);
    await toolCall(`r201l_m1_${tag}`, 1, 1, tag, () => holdTool1(sc));
    messageStart(`r201l_m2_${tag}`);
    await streamBlock(`r201l_m2_${tag}`, 0, sc.p1Kind === 'text' ? 'text' : 'thinking', 'P1', sc.p1Count ?? 120, sc.p1Ms ?? 250);
    await streamBlock(`r201l_m2_${tag}`, 1, 'text', 'P1B', sc.p1bCount ?? 40, sc.p1bMs ?? 250);
    await toolCall(`r201l_m2_${tag}`, 2, 2, tag, () => wait(sc.tool2Ms ?? 1000));
    foldOpen = false;
    messageStart(`r201l_m3_${tag}`);
    await streamBlock(`r201l_m3_${tag}`, 0, 'text', 'P2', sc.p2Count ?? 20, sc.p2Ms ?? 250);
    evt({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: USAGE });
    evt({ type: 'message_stop' });
    resultOk();
    setStage('done');
    clog({ ev: 'round-end' });
    roundActive = false;
    for (const s of lateSteers.splice(0)) await steerTurn(s);
  } catch (e) {
    roundActive = false;
    foldOpen = false;
    if (!(e instanceof Cut)) throw e;
    if (e.kind === 'stop') {
      if (live && live.text) {
        const blocks = live.kind === 'thinking' ? [{ type: 'thinking', thinking: live.text, signature: 'r201lsig' }] : [{ type: 'text', text: live.text }];
        transcriptAssistant(live.msgId, blocks, null, live.uuid);
      }
      live = null;
      out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
      transcriptUser('[Request interrupted by user]');
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE, errors: [] });
      setStage('stopped');
    } else {
      live = null;
      resultOk();
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
    const sub = msg.request && msg.request.subtype;
    if (sub === 'interrupt') interrupted = true;
    if (sub === 'background_tasks') {
      // 本夹具没有可转到后台的命令:如实回错误(不让页面以为命令被转走)
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'r201l 夹具:没有可转到后台的命令' } });
      clog({ ev: 'bg-request' });
      return;
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : '');
  if (roundActive && !TITLE_GEN) {
    const s = { uuid: msg.uuid || crypto.randomUUID(), content: text, ts: stamp() };
    append({ type: 'queue-operation', operation: 'enqueue', timestamp: s.ts, sessionId: sid, content: text });
    if (foldOpen) pendingSteers.push(s); else lateSteers.push(s);
    if (steerSeen === null) steerSeen = Date.now();
    clog({ ev: 'steer-received', steerUuid: s.uuid, content: text, foldOpen });
    setWrittenFlag('STEER');
    return;
  }
  queue.push(text);
  void pump();
});
await new Promise((resolve) => rl.on('close', resolve));
process.exit(0);
