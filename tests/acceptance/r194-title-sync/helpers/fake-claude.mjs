#!/usr/bin/env node
// r194-title-sync 的假 claude 命令行:只说 stream-json。
// 场景文件 $CGUI_FAKE_CLAUDE_DIR/scenario.json:{ "<工作目录名>": { "holdSec": N } }
//   有 holdSec:收到用户消息 → 初始化事件 + 立刻把回合开头(两行 queue-operation + user 记录)追加进会话记录,
//               保持 holdSec 秒不结束;到时输出一条助手消息(同时落盘)+ result:success。收到停止则立刻以空 result 结束这一轮。
//   没有:立刻一条助手消息 + result:success。
// GUI 起标题的那次调用(工作目录名里带 cgui-title)立刻回短标题,不落盘、不碰状态。
// 状态文件 $CGUI_FAKE_CLAUDE_DIR/status-<工作目录名>.json:{ received, processed }。
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

const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const cwd = process.cwd();
const TITLE_GEN = /cgui-title/.test(cwd);
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.322', gitBranch: '' });

const WS = path.basename(cwd);
const STATUS_FILE = path.join(CTL, `status-${WS}.json`);
const readStatus = () => { try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return { received: 0, processed: 0 }; } };
function writeStatus(patch) {
  if (TITLE_GEN) return;
  try {
    const tmp = path.join(CTL, `status.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp, `${JSON.stringify({ ...readStatus(), ...patch })}\n`);
    fs.renameSync(tmp, STATUS_FILE);
  } catch { /* 忽略 */ }
}
function holdSecFor() {
  try { const v = JSON.parse(fs.readFileSync(path.join(CTL, 'scenario.json'), 'utf8'))[WS]; return v && Number(v.holdSec) > 0 ? Number(v.holdSec) : 0; } catch { return 0; }
}

let lastUuid = null;
function transcriptUser(text) {
  append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: sid, content: String(text || '') });
  append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(), sessionId: sid });
  const uuid = crypto.randomUUID();
  append({ parentUuid: lastUuid, promptId: 'r194-fake', type: 'user', isMeta: false, message: { role: 'user', content: text }, uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields() });
  lastUuid = uuid;
}
const emitInit = () => out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
const emitResult = (text) => out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: text, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
const newMsgId = () => `r194_${crypto.randomBytes(3).toString('hex')}`;

function finishNormally() {
  const text = 'R194OK 这是一条正常回复。';
  const id = newMsgId();
  const content = [{ type: 'text', text }];
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content, stop_reason: 'end_turn', usage: USAGE } });
  const uuid = crypto.randomUUID();
  append({ parentUuid: lastUuid, message: { model: MODEL, id, type: 'message', role: 'assistant', content, stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE }, requestId: `req_${id}`, type: 'assistant', uuid, timestamp: stamp(), effort: 'high', ...baseFields() });
  lastUuid = uuid;
  emitResult(text);
  writeStatus({ processed: readStatus().received, finishedAt: Date.now() });
}

let hold = null;
function onUserMessage(userText) {
  emitInit();
  if (TITLE_GEN) {
    out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id: newMsgId(), role: 'assistant', model: MODEL, type: 'message', content: [{ type: 'text', text: '短标题' }], stop_reason: 'end_turn', usage: USAGE } });
    emitResult('短标题');
    return;
  }
  writeStatus({ received: (readStatus().received || 0) + 1 });
  transcriptUser(userText);
  const sec = holdSecFor();
  if (sec > 0) hold = { timer: setTimeout(() => { hold = null; finishNormally(); }, sec * 1000) };
  else finishNormally();
}
function onInterrupt(requestId) {
  out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
  if (hold) { clearTimeout(hold.timer); hold = null; emitResult(''); writeStatus({ processed: readStatus().received, finishedAt: Date.now() }); }
}

process.on('SIGTERM', () => process.exit(0));
if (!fs.existsSync(CTL)) { try { fs.mkdirSync(CTL, { recursive: true }); } catch { /* 忽略 */ } }
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_response') return;
  if (msg.type === 'control_request') {
    if (msg.request && msg.request.subtype === 'interrupt') { onInterrupt(msg.request_id); return; }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  onUserMessage(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
});
rl.on('close', () => process.exit(0));
