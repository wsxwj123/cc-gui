#!/usr/bin/env node
// r190-send-leave-stall 的假 claude 命令行:只说 stream-json,不碰实现内部。
// 每读到一条用户消息:
//   1. 往 $CGUI_FAKE_CLAUDE_DIR/messages-<工作目录名>.jsonl 追加一行 {"text": 消息原文, "t": 时刻};
//   2. 输出初始化事件,并立刻往会话文件写回合开头三行(两行 queue-operation + 这条用户消息的 user 记录;真实命令行就是这样,少于 3 行侧栏不列);
//   3. 过 REPLY_DELAY_MS 毫秒后输出一条助手消息(文字带 R190OK,同时落盘)+ result:success,并在状态文件里记 processed。
// 状态文件 $CGUI_FAKE_CLAUDE_DIR/status-<工作目录名>.json:{ received, processed }。
// GUI 起标题用的另一次调用(工作目录名里带 cgui-title-)立刻回一个短标题,不落盘、不碰状态文件、不记收信日志。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const REPLY_DELAY_MS = 1500;
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
const TITLE_GEN = /cgui-title-/.test(cwd);
try { fs.appendFileSync(path.join(path.dirname(CTL), 'fake-claude-spawn.jsonl'), `${JSON.stringify({ argv, sid, cwd, titleGen: TITLE_GEN })}\n`); } catch { /* 忽略 */ }
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.322';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: VERSION, gitBranch: '' });

const WS_NAME = path.basename(cwd);
const STATUS_FILE = path.join(CTL, `status-${WS_NAME}.json`);
const MSG_LOG = path.join(CTL, `messages-${WS_NAME}.jsonl`);
function readStatusFile() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return { received: 0, processed: 0 }; }
}
function writeStatusFile(patch) {
  if (TITLE_GEN) return;
  try {
    const next = { ...readStatusFile(), ...patch };
    const tmp = path.join(CTL, `status.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`);
    fs.renameSync(tmp, STATUS_FILE);
  } catch { /* 忽略 */ }
}
function logReceived(text) {
  if (TITLE_GEN) return;
  try { fs.appendFileSync(MSG_LOG, `${JSON.stringify({ text, t: Date.now() })}\n`); } catch { /* 忽略 */ }
}

let lastUuid = null;
function transcriptUser(text) {
  // 照真实命令行:回合一开始先写两行 queue-operation(入队带 content、出队不带),再写 user 记录,开头至少 3 行。
  append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: sid, content: String(text || '') });
  append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(), sessionId: sid });
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r190-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: text }, uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields(),
  });
  lastUuid = uuid;
}
function transcriptAssistant(id, content, stopReason) {
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid,
    message: { model: MODEL, id, type: 'message', role: 'assistant', content, stop_reason: stopReason, stop_sequence: null, stop_details: null, usage: USAGE },
    requestId: `req_${id}`, type: 'assistant', uuid, timestamp: stamp(), effort: 'high', ...baseFields(),
  });
  lastUuid = uuid;
}
const emitInit = () => out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
const emitSuccessResult = (text) => out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: text, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
const newMsgId = () => `r190_ok_${crypto.randomBytes(3).toString('hex')}`;

function runTitleRound() {
  emitInit();
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id: newMsgId(), role: 'assistant', model: MODEL, type: 'message', content: [{ type: 'text', text: '短标题' }], stop_reason: 'end_turn', usage: USAGE } });
  emitSuccessResult('短标题');
}

function onUserMessage(userText) {
  if (TITLE_GEN) { runTitleRound(); return; }
  logReceived(userText);
  const received = (readStatusFile().received || 0) + 1;
  writeStatusFile({ received });
  emitInit();
  transcriptUser(userText); // 回合一开始就写够 3 行
  setTimeout(() => {
    const text = 'R190OK 这是第一段回复。';
    const id = newMsgId();
    const content = [{ type: 'text', text }];
    out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content, stop_reason: 'end_turn', usage: USAGE } });
    transcriptAssistant(id, content, 'end_turn');
    emitSuccessResult(text);
    writeStatusFile({ processed: received });
  }, REPLY_DELAY_MS);
}

process.on('SIGTERM', () => process.exit(0));
if (!fs.existsSync(CTL)) { try { fs.mkdirSync(CTL, { recursive: true }); } catch { /* 忽略 */ } }

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
  onUserMessage(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
});
rl.on('close', () => process.exit(0));
