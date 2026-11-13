#!/usr/bin/env node
// r177-stream-reattach 的假 claude 命令行:只说 stream-json,不碰实现内部。
// 行为由场景文件 $CGUI_FAKE_CLAUDE_DIR/scenario.json 控制(每收到一条用户消息读一次):
//   startDelayMs     收到用户消息后先静默多久(这期间不输出任何事件,也不往会话文件写任何东西,连用户消息也不写)
//   chunkIntervalMs  正文相邻两个片段之间的间隔
//   chunkCount       正文片段总数(片段文字 `片段0001。` `片段0002。`……)
//   mode             'normal'(默认) | 'startfail'(不输出任何事件,stderr 写 `fake start failure`,退出码 3)
// 状态文件 $CGUI_FAKE_CLAUDE_DIR/status-<工作目录名>.json(每次变化原子替换;按工作目录名分开,上一回合遗留的进程不会写乱下一个用例):
//   openedAt(开口时刻 = 延迟结束、写完用户消息、输出初始化事件时的 Date.now())、chunksEmitted(已输出片段数)、
//   interruptedAtChunks(被打断时已输出片段数;未被打断为 null)、ended(本回合已收尾)。
//
// 一回合(normal):延迟 → 用户消息写进会话文件 → 输出 init → 思考块(结束后写进会话文件) → 正文逐片段流式输出
//   → 全部输出完才把整段正文作为一条助手消息写进会话文件 → 回合结束事件。
// 被打断(control_request / interrupt):立刻停,回成功应答;输出完整助手消息(已流出的半截正文)+ 用户消息
//   `[Request interrupted by user]` + 回合结束事件(error_during_execution / is_error:true),前两条同时写进会话文件。
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
// GUI 会另起一个 CLI(cwd 形如 /tmp/cgui-title-*)只为给新会话起标题:立刻回一个短标题,不延迟、不落盘、不碰状态文件。
const TITLE_GEN = /cgui-title-/.test(cwd);
try { fs.appendFileSync(path.join(path.dirname(CTL), 'fake-claude-spawn.jsonl'), `${JSON.stringify({ argv, sid, cwd, titleGen: TITLE_GEN })}\n`); } catch { /* 忽略 */ }
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.322';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const THINK_TEXT = '先想一想。';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: VERSION, gitBranch: '' });
const evt = (event) => out({ type: 'stream_event', event, session_id: sid, parent_tool_use_id: null, uuid: crypto.randomUUID() });

function readScenario() {
  const d = { startDelayMs: 8000, chunkIntervalMs: 50, chunkCount: 1200, mode: 'normal' };
  try { return { ...d, ...JSON.parse(fs.readFileSync(path.join(CTL, 'scenario.json'), 'utf8')) }; } catch { return d; }
}

const status = { openedAt: null, chunksEmitted: 0, interruptedAtChunks: null, ended: false, exitedAt: null };
function writeStatus() {
  if (TITLE_GEN) return;
  try {
    const tmp = path.join(CTL, `status.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp, `${JSON.stringify(status)}\n`);
    fs.renameSync(tmp, path.join(CTL, `status-${path.basename(cwd)}.json`));
  } catch { /* 忽略 */ }
}

// 本进程里上一条落盘行的 uuid:下一行的 parentUuid 接着它(真实转写是一条链)。
let lastUuid = null;
let interruptRequested = false;

function transcriptUser(text) {
  // 新会话(不是 --resume 起的)第一次落盘时,先写一行 summary(照 r176 假命令行的做法)。
  if (lastUuid === null && !argOf('--resume')) append({ type: 'summary', summary: String(text || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r177-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: text },
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

// 收场用:用例结束时往 $CGUI_FAKE_CLAUDE_DIR/abort-<工作目录名> 放一个文件,假命令行就把当前回合尽快正常收尾(不算打断),免得遗留的长回合占着后端、拖慢下一个用例。
const ABORT_FILE = path.join(CTL, `abort-${path.basename(cwd)}`);
const aborted = () => fs.existsSync(ABORT_FILE);

/** 可被打断的睡眠:每 25ms 看一眼打断标志。返回 true = 被打断。 */
async function sleepInterruptible(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (interruptRequested) return true;
    if (aborted()) return false;
    await sleep(Math.min(25, Math.max(1, end - Date.now())));
  }
  return interruptRequested;
}


async function runTitleRound() {
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  emitAssistant(`r177_title_${crypto.randomBytes(3).toString('hex')}`, [{ type: 'text', text: '短标题' }], 'end_turn');
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '短标题', duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}

async function runRound(userText) {
  if (TITLE_GEN) { await runTitleRound(); return; }
  const sc = readScenario();
  interruptRequested = false;
  status.openedAt = null; status.chunksEmitted = 0; status.interruptedAtChunks = null; status.ended = false;
  writeStatus();

  if (sc.mode === 'startfail') {
    // 启动失败:先等满启动延迟(期间不输出任何事件、不写会话文件),再 stderr 一行 + 退出码 3;退出前把退出时刻写进状态文件。
    await sleepInterruptible(sc.startDelayMs);
    status.exitedAt = Date.now();
    writeStatus();
    fs.writeSync(2, 'fake start failure\n');
    process.exit(3);
  }

  const interruptedEarly = await sleepInterruptible(sc.startDelayMs);

  transcriptUser(userText);
  status.openedAt = Date.now();
  writeStatus();
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

  const id = `r177_fake_${crypto.randomBytes(3).toString('hex')}`;
  const finishInterrupted = (partialText) => {
    status.interruptedAtChunks = status.chunksEmitted;
    const content = [{ type: 'text', text: partialText }];
    emitAssistant(id, content, null);
    if (partialText) transcriptAssistant(id, content, null);
    out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    transcriptUser('[Request interrupted by user]');
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE, errors: [] });
    status.ended = true;
    writeStatus();
  };
  if (interruptedEarly) { finishInterrupted(''); return; }

  evt({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: USAGE } });
  // 思考块:流式输出,结束后落盘。
  evt({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  evt({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINK_TEXT } });
  evt({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'r177sig' } });
  evt({ type: 'content_block_stop', index: 0 });
  const thinkContent = [{ type: 'thinking', thinking: THINK_TEXT, signature: 'r177sig' }];
  emitAssistant(id, thinkContent, null);
  transcriptAssistant(id, thinkContent, null);

  // 正文:逐片段流式输出。
  evt({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  let body = '';
  for (let i = 1; i <= sc.chunkCount; i += 1) {
    if (interruptRequested || aborted()) break;
    const piece = `片段${String(i).padStart(4, '0')}。`;
    body += piece;
    evt({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: piece } });
    status.chunksEmitted = i;
    writeStatus();
    if (i < sc.chunkCount && (await sleepInterruptible(sc.chunkIntervalMs))) break;
    if (aborted()) break;
  }
  if (interruptRequested) { finishInterrupted(body); return; }

  evt({ type: 'content_block_stop', index: 1 });
  const textContent = [{ type: 'text', text: body }];
  emitAssistant(id, textContent, 'end_turn');
  transcriptAssistant(id, textContent, 'end_turn'); // 整段写完才落盘
  evt({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: USAGE });
  evt({ type: 'message_stop' });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: body, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  status.ended = true;
  writeStatus();
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
    if (msg.request && msg.request.subtype === 'interrupt') interruptRequested = true;
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
