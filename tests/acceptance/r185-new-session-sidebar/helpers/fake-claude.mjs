#!/usr/bin/env node
// r185-new-session-sidebar 的假 claude 命令行:只说 stream-json,不碰实现内部。
// 行为由场景文件 $CGUI_FAKE_CLAUDE_DIR/scenario.json 控制(每收到一条用户消息读一次):
//   { "shapes": ["hold:30", "normal", ...] }   同一个工作区的第 N 条用户消息用第 N 个形态,超出列表用最后一个。
// 形态:
//   hold:<秒>       收到用户消息 → 先输出初始化事件(新会话号),随即把这条用户消息写进会话文件(会话文件在回合一开始就出现),
//                   然后保持这一轮不结束 <秒> 秒;到时输出一条正常助手消息(同时落盘)+ result:success。
//                   期间收到停止(control_request interrupt)→ 输出 result:success(空)结束这一轮,进程继续等下一条消息。
//   hold-die:<秒>   同 hold,但收到停止后不输出任何结束事件,直接退出进程(退出码 0)。
//   crash           输出初始化事件后立刻异常退出(退出码 1),不写会话文件。
//   normal          一条完整助手消息(文字带 R185OK,同时落盘)+ result:success。
// 「第几条」的计数记在状态文件里:$CGUI_FAKE_CLAUDE_DIR/status-<工作目录名>.json
//   { received: 已收到的用户消息条数, processed: 已处理完(回合结束事件已输出)的用户消息条数 }
// 夹具里每个用例一个独立工作区,所以按工作目录名计数 = 按用例计数。
// GUI 起标题用的另一次调用(工作目录名里带 cgui-title-)立刻回一个短标题,不落盘、不碰状态文件。
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
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: VERSION, gitBranch: '' });

function readScenario() {
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(CTL, 'scenario.json'), 'utf8'));
    if (Array.isArray(sc.shapes) && sc.shapes.length) return sc;
  } catch { /* 读不到就用默认 */ }
  return { shapes: ['normal'] };
}

const STATUS_FILE = path.join(CTL, `status-${path.basename(cwd)}.json`);
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

let lastUuid = null;
function transcriptUser(text) {
  if (lastUuid === null && !argOf('--resume')) append({ type: 'summary', summary: String(text || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r185-fake', type: 'user', isMeta: false,
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
const newMsgId = () => `r185_ok_${crypto.randomBytes(3).toString('hex')}`;

function finishNormally() {
  const text = 'R185OK 这是一条正常回复。';
  const id = newMsgId();
  const content = [{ type: 'text', text }];
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content, stop_reason: 'end_turn', usage: USAGE } });
  transcriptAssistant(id, content, 'end_turn');
  emitSuccessResult(text);
  writeStatusFile({ processed: readStatusFile().received });
}

let hold = null; // { kind, timer } 保持中的一轮
function runTitleRound() {
  emitInit();
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id: newMsgId(), role: 'assistant', model: MODEL, type: 'message', content: [{ type: 'text', text: '短标题' }], stop_reason: 'end_turn', usage: USAGE } });
  emitSuccessResult('短标题');
}

function runRound(userText, shape) {
  const [kind, arg] = String(shape).split(':');
  if (kind === 'crash') {
    emitInit();
    setTimeout(() => process.exit(1), 100);
    return;
  }
  emitInit();
  transcriptUser(userText); // 真实命令行:会话文件在回合一开始就出现
  if (kind === 'hold' || kind === 'hold-die') {
    hold = { kind, timer: setTimeout(() => { hold = null; finishNormally(); }, Number(arg || 30) * 1000) };
    return;
  }
  finishNormally();
}

function onUserMessage(userText) {
  if (TITLE_GEN) { runTitleRound(); return; }
  const received = (readStatusFile().received || 0) + 1;
  writeStatusFile({ received });
  const { shapes } = readScenario();
  runRound(userText, shapes[Math.min(received, shapes.length) - 1]);
}

function onInterrupt(requestId) {
  if (hold && hold.kind === 'hold-die') process.exit(0); // 收到停止:不输出结束事件,直接退出
  if (hold) {
    clearTimeout(hold.timer);
    hold = null;
    out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
    emitSuccessResult('');
    writeStatusFile({ processed: readStatusFile().received });
    return;
  }
  out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
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
