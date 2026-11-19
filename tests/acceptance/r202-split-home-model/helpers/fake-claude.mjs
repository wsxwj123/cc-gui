#!/usr/bin/env node
// r202-split-home-model 的假 claude 命令行:只说 stream-json。
// 每读到一条用户消息:
//   1. 往 $CGUI_FAKE_CLAUDE_DIR/messages.jsonl 追加 {kind:'msg', text, model, effort, cwd}:
//      model = 此刻进程当前的模型(启动参数 --model 给的;没给就取 settings.json 的 env.ANTHROPIC_MODEL;之后被 control_request set_model 改过就取新值),
//      effort = 启动参数 --effort 给的(没给 = null);
//   2. 输出 init,并立刻往会话文件写回合开头三行(两行 queue-operation + user 记录);
//   3. 过 REPLY_DELAY_MS 后输出助手消息(正文带 R202OK,message.model = 当前模型,同时落盘)+ result:success,再追加 {kind:'done', text}。
// control_request 一律回成功;set_model 额外改当前模型。起标题的调用(工作目录名含 cgui-title)立刻回短标题,不落盘、不记日志。
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
const TITLE_GEN = /cgui-title/.test(cwd);
try { fs.mkdirSync(CTL, { recursive: true }); } catch { /* 忽略 */ }
try { fs.appendFileSync(path.join(CTL, 'spawn.jsonl'), `${JSON.stringify({ argv, sid, cwd, titleGen: TITLE_GEN })}\n`); } catch { /* 忽略 */ }
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const VERSION = '2.1.322';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const MSG_LOG = path.join(CTL, 'messages.jsonl');

function settingsModel() {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.HOME || '.', '.claude', 'settings.json'), 'utf8')).env.ANTHROPIC_MODEL || null; } catch { return null; }
}
let curModel = argOf('--model') || settingsModel() || 'unknown-model';
const launchEffort = argOf('--effort') || null;

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const logLine = (o) => { if (TITLE_GEN) return; try { fs.appendFileSync(MSG_LOG, `${JSON.stringify(o)}\n`); } catch { /* 忽略 */ } };
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: VERSION, gitBranch: '' });

let lastUuid = null;
function transcriptUser(text) {
  append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: sid, content: String(text || '') });
  append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(), sessionId: sid });
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r202-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: text }, uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields(),
  });
  lastUuid = uuid;
}
function transcriptAssistant(id, content, model) {
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid,
    message: { model, id, type: 'message', role: 'assistant', content, stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE },
    requestId: `req_${id}`, type: 'assistant', uuid, timestamp: stamp(), effort: launchEffort || 'high', ...baseFields(),
  });
  lastUuid = uuid;
}
const emitInit = () => out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: curModel, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
const emitSuccessResult = (text) => out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: text, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
const newMsgId = () => `r202_ok_${crypto.randomBytes(3).toString('hex')}`;

function runTitleRound() {
  emitInit();
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id: newMsgId(), role: 'assistant', model: curModel, type: 'message', content: [{ type: 'text', text: '短标题' }], stop_reason: 'end_turn', usage: USAGE } });
  emitSuccessResult('短标题');
}

function onUserMessage(userText) {
  if (TITLE_GEN) { runTitleRound(); return; }
  const modelAtArrival = curModel;
  logLine({ kind: 'msg', text: userText, model: modelAtArrival, effort: launchEffort, cwd, t: Date.now() });
  emitInit();
  transcriptUser(userText);
  setTimeout(() => {
    const text = 'R202OK 这是第一段回复。';
    const id = newMsgId();
    const content = [{ type: 'text', text }];
    out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: modelAtArrival, type: 'message', content, stop_reason: 'end_turn', usage: USAGE } });
    transcriptAssistant(id, content, modelAtArrival);
    emitSuccessResult(text);
    logLine({ kind: 'done', text: userText, t: Date.now() });
  }, REPLY_DELAY_MS);
}

process.on('SIGTERM', () => process.exit(0));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_response') return;
  if (msg.type === 'control_request') {
    const req = msg.request || {};
    if (req.subtype === 'set_model') curModel = req.model || settingsModel() || curModel;
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  onUserMessage(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
});
rl.on('close', () => process.exit(0));
