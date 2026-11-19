#!/usr/bin/env node
// r200-subagent-model-switch 的假 claude 命令行:只说 stream-json。一回合怎么演,由场景文件
// $CGUI_FAKE_CLAUDE_DIR/scenario-<工作目录名>.json 决定(每收到一条用户消息读一次):
//   { "form": "sub-live", "models": ["claude-fable-5-1", ...] }
//        子代理直播轮:子代理每次调用先发 stream_event/message_start,再发整条 assistant,事件都带 parent_tool_use_id;
//        换模型时不发任何专门通知(接口文件数据形态第 1 条)。同时按新版格式把子代理转写写好。
//   { "form": "main-switch", "category": "bio" }
//        主对话换模型轮:claude-opus-5-5 回一段 → system/model_refusal_fallback(接口文件数据形态第 5 条) → claude-opus-5 回完。
//   { "form": "normal", "text": "好的" }
// GUI 起标题用的另一次调用(工作目录名里带 cgui-title-)立刻回一个短标题,不落盘。回合结束后进程不退出,等下一条用户消息。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { subIds, writeSubagentFiles, mainFallbackRecord, fallbackContent } from './transcripts.mjs';

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
const TITLE_GEN = /cgui-title-/.test(cwd);
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.328';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const TAG = path.basename(cwd).replace(/^r200-ws-/, '');

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const newMsgId = () => `r200_${crypto.randomBytes(3).toString('hex')}`;
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
let lastUserUuid = null;
function transcriptUser(text) {
  if (lastUuid === null && !argOf('--resume')) append({ type: 'summary', summary: String(text || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  const uuid = crypto.randomUUID();
  append({ parentUuid: lastUuid, promptId: 'r200-fake', type: 'user', isMeta: false, message: { role: 'user', content: text }, uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields() });
  lastUuid = uuid; lastUserUuid = uuid;
}
function transcriptAssistant(model, id, content, stop = 'end_turn') {
  const uuid = crypto.randomUUID();
  append({ parentUuid: lastUuid, message: { model, id, type: 'message', role: 'assistant', content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: USAGE }, requestId: `req_${id}`, type: 'assistant', uuid, timestamp: stamp(), effort: 'high', ...baseFields() });
  lastUuid = uuid;
}
function emitAssistant(model, id, content, parent = null, stop = 'end_turn') {
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: parent, message: { id, role: 'assistant', model, type: 'message', content, stop_reason: stop, usage: USAGE } });
}
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: text, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });

/** 子代理直播轮。 */
async function runSubLive(sc) {
  const ids = subIds(TAG);
  const T = ids.agentId;
  const U = ids.toolUseId;
  const models = sc.models;
  const gap = () => sleep(150);
  // 子代理转写按新版格式先写好(真实命令行边跑边写;这里提前写,页面从直播数据流看到的内容不受影响)
  if (!TITLE_GEN) writeSubagentFiles({ projectDir: PROJ, sid, tag: TAG, models, format: 'new', metaModel: 'opus' });

  out({ type: 'system', subtype: 'task_started', task_id: T, tool_use_id: U, description: ids.description, subagent_type: 'general-purpose', task_type: 'local_agent', prompt: ids.prompt, session_id: sid, uuid: crypto.randomUUID() });
  await gap();
  const toolUse = { type: 'tool_use', id: U, name: 'Agent', input: { description: ids.description, prompt: ids.prompt, subagent_type: 'general-purpose', run_in_background: false } };
  const mainId = newMsgId();
  emitAssistant(MODEL, mainId, [toolUse], null, 'tool_use');
  transcriptAssistant(MODEL, mainId, [toolUse], 'tool_use');
  await gap();

  for (let k = 0; k < models.length; k += 1) {
    const m = models[k];
    const id = `msg_r200_${TAG}_${k}`;
    out({ type: 'stream_event', parent_tool_use_id: U, session_id: sid, uuid: crypto.randomUUID(), event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: m, content: [], stop_reason: null, usage: { input_tokens: 120, output_tokens: 1 } } } });
    await sleep(150);
    const last = k === models.length - 1;
    const content = last ? [{ type: 'text', text: `R200-SUB-DONE-${k}` }] : [{ type: 'tool_use', id: `toolu_r200_${TAG}_c${k}`, name: 'Read', input: { file_path: '/dev/null' } }];
    out({ type: 'assistant', parent_tool_use_id: U, session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: m, type: 'message', content, stop_reason: last ? 'end_turn' : 'tool_use', usage: USAGE } });
    await sleep(250);
  }
  out({ type: 'system', subtype: 'task_updated', task_id: T, patch: { status: 'completed' }, session_id: sid, uuid: crypto.randomUUID() });
  await gap();
  out({ type: 'system', subtype: 'task_notification', task_id: T, tool_use_id: U, status: 'completed', summary: 'done', session_id: sid, uuid: crypto.randomUUID() });
  await gap();
  const toolResult = [{ type: 'tool_result', tool_use_id: U, content: [{ type: 'text', text: 'R200-SUB-RESULT' }], is_error: false }];
  out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: toolResult } });
  { const uuid = crypto.randomUUID();
    append({ parentUuid: lastUuid, type: 'user', uuid, timestamp: stamp(), message: { role: 'user', content: toolResult }, toolUseResult: { status: 'completed', agentId: T, agentType: 'general-purpose', content: [{ type: 'text', text: 'R200-SUB-RESULT' }], resolvedModel: models[models.length - 1] }, ...baseFields() });
    lastUuid = uuid; }
  await sleep(400);
  const mid = newMsgId();
  emitAssistant(MODEL, mid, [{ type: 'text', text: 'R200-MAIN-DONE' }]);
  transcriptAssistant(MODEL, mid, [{ type: 'text', text: 'R200-MAIN-DONE' }]);
  result('R200-MAIN-DONE');
}

/** 主对话换模型轮:接口文件数据形态第 5 条(直播)与第 6 条(落盘)。 */
async function runMainSwitch(sc) {
  const category = sc.category === undefined ? 'bio' : sc.category;
  const id1 = newMsgId();
  emitAssistant('claude-opus-5-5', id1, [{ type: 'text', text: 'R200-BEFORE' }]);
  transcriptAssistant('claude-opus-5-5', id1, [{ type: 'text', text: 'R200-BEFORE' }]);
  await sleep(1500);
  out({
    type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'session',
    original_model: 'claude-opus-5-5', fallback_model: 'claude-opus-5', request_id: 'req_r200_fallback',
    api_refusal_category: category, api_refusal_explanation: null, refused_user_message_uuid: lastUserUuid,
    content: fallbackContent(category), uuid: crypto.randomUUID(), session_id: sid,
  });
  { const rec = mainFallbackRecord({ sid, cwd, parentUuid: lastUuid, refusedUserMessageUuid: lastUserUuid, category });
    append(rec); lastUuid = rec.uuid; }
  await sleep(1500);
  const id2 = newMsgId();
  emitAssistant('claude-opus-5', id2, [{ type: 'text', text: 'R200-AFTER' }]);
  transcriptAssistant('claude-opus-5', id2, [{ type: 'text', text: 'R200-AFTER' }]);
  await sleep(300);
  result('R200-AFTER');
}

async function runRound(userText) {
  if (TITLE_GEN) {
    out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
    emitAssistant(MODEL, newMsgId(), [{ type: 'text', text: '短标题' }]);
    result('短标题');
    return;
  }
  const sc = readScenario();
  transcriptUser(userText);
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  await sleep(TURN_DELAY_MS);
  if (sc.form === 'sub-live') { await runSubLive(sc); return; }
  if (sc.form === 'main-switch') { await runMainSwitch(sc); return; }
  const id = newMsgId();
  emitAssistant(MODEL, id, [{ type: 'text', text: sc.text }]);
  transcriptAssistant(MODEL, id, [{ type: 'text', text: sc.text }]);
  result(sc.text);
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
