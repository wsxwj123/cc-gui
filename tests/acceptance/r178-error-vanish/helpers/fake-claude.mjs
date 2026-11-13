#!/usr/bin/env node
// r178-error-vanish 的假 claude 命令行:只说 stream-json,不碰实现内部。
// 行为由场景文件 $CGUI_FAKE_CLAUDE_DIR/scenario.json 控制(每收到一条用户消息读一次):
//   { "shapes": ["empty-error", "normal", ...] }   同一个会话的第 N 条用户消息用第 N 个形态,超出列表用最后一个。
// 形态:
//   empty-error         空内容报错:无助手消息;一条 user 事件(文字块「[Your previous response had no visible output...」)+ 带 isMeta 的用户行;
//                       result:error_during_execution / is_error:true / stop_reason end_turn / terminal_reason completed /
//                       errors:["[ede_diagnostic] result_type=assistant last_content_type=none stop_reason=end_turn"],没有 result 字段
//   unknown-type        同上,errors 里是 last_content_type=reasoning
//   empty-success       规范的空回复:同样的 user 事件与 isMeta 行;result:success / is_error:false / result:""
//   partial-then-error  先输出一条完整助手消息(文字带 R178PARTIAL,同时落盘),再同 empty-error 的 user 事件、isMeta 行与 result
//   normal              一条完整助手消息(文字带 R178OK,同时落盘),result:success / is_error:false / result 为那段文字
// 「第几条」的计数记在状态文件里(跨进程保持):$CGUI_FAKE_CLAUDE_DIR/status-<工作目录名>.json
//   { received: 已收到的用户消息条数, processed: 已处理完(回合结束事件已输出)的用户消息条数 }
// 夹具里每个用例一个独立工作区、一个会话,所以按工作目录名计数 = 按会话计数。
// 回合结束后进程不退出,继续等下一条用户消息。
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
const META_TEXT = '[Your previous response had no visible output. Please continue and produce a user-visible response.]';
const ERR_NONE = '[ede_diagnostic] result_type=assistant last_content_type=none stop_reason=end_turn';
const ERR_REASONING = '[ede_diagnostic] result_type=assistant last_content_type=reasoning stop_reason=end_turn';

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

// 状态文件:每次变化原子替换。「received」在收到消息时先落盘(应用可能在两条消息之间重启命令行,新进程要接着数)。
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
function transcriptUser(text, isMeta) {
  if (lastUuid === null && !argOf('--resume') && !isMeta) append({ type: 'summary', summary: String(text || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r178-fake', type: 'user', isMeta: Boolean(isMeta),
    message: { role: 'user', content: isMeta ? [{ type: 'text', text }] : text },
    uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields(),
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
function emitAssistant(id, content, stopReason) {
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content, stop_reason: stopReason, usage: USAGE } });
}
const emitInit = () => out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
function emitMetaUser() {
  out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: META_TEXT }] } });
  transcriptUser(META_TEXT, true);
}
function emitErrorResult(errText) {
  out({
    type: 'result', subtype: 'error_during_execution', is_error: true, stop_reason: 'end_turn', terminal_reason: 'completed',
    session_id: sid, uuid: crypto.randomUUID(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE, errors: [errText],
  });
}
function emitSuccessResult(text) {
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: text, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}
const newMsgId = (tag) => `r178_${tag}_${crypto.randomBytes(3).toString('hex')}`;

function runTitleRound() {
  emitInit();
  emitAssistant(newMsgId('title'), [{ type: 'text', text: '短标题' }], 'end_turn');
  emitSuccessResult('短标题');
}

function runRound(userText, shape) {
  if (TITLE_GEN) { runTitleRound(); return; }
  transcriptUser(userText, false);
  emitInit();
  if (shape === 'normal') {
    const text = 'R178OK 这是一条正常回复。';
    const id = newMsgId('ok');
    const content = [{ type: 'text', text }];
    emitAssistant(id, content, 'end_turn');
    transcriptAssistant(id, content, 'end_turn');
    emitSuccessResult(text);
  } else if (shape === 'partial-then-error') {
    const id = newMsgId('part');
    const content = [{ type: 'text', text: 'R178PARTIAL 先说了一半。' }];
    emitAssistant(id, content, 'end_turn');
    transcriptAssistant(id, content, 'end_turn');
    emitMetaUser();
    emitErrorResult(ERR_NONE);
  } else if (shape === 'empty-success') {
    emitMetaUser();
    emitSuccessResult('');
  } else if (shape === 'unknown-type') {
    emitMetaUser();
    emitErrorResult(ERR_REASONING);
  } else {
    emitMetaUser();
    emitErrorResult(ERR_NONE);
  }
  writeStatusFile({ processed: readStatusFile().received });
}

function onUserMessage(userText) {
  if (TITLE_GEN) { runTitleRound(); return; }
  const received = (readStatusFile().received || 0) + 1;
  writeStatusFile({ received });
  const { shapes } = readScenario();
  const shape = shapes[Math.min(received, shapes.length) - 1];
  runRound(userText, shape);
}

if (!fs.existsSync(CTL)) { try { fs.mkdirSync(CTL, { recursive: true }); } catch { /* 忽略 */ } }

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) { onUserMessage(printArg); process.exit(0); }

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
await new Promise((resolve) => rl.on('close', resolve));
process.exit(0);
