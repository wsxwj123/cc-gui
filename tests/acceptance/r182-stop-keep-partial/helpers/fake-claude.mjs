#!/usr/bin/env node
// r182-stop-keep-partial 的假 claude 命令行:只说 stream-json,不碰实现内部。
// 行为由场景文件 $CGUI_FAKE_CLAUDE_DIR/scenario.json 控制(每收到一条用户消息读一次;没写的字段取默认值):
//   startDelayMs                提示词写盘之后、开始输出之前等多久(默认 0)
//   chunkIntervalMs             相邻两个正文片段的间隔(默认 50)
//   chunkCount                  正文片段总数,到数就自然结束(默认 1200)
//   textPrefix                  加在第一个片段前面的字(默认空)
//   persistThinking             思考记录是否写进会话文件(默认 true)
//   persistPartialOnInterrupt   被打断时,半截正文记录与「[Request interrupted by user]」用户行是否写进会话文件(默认 true)
//   persistFinal                自然结束时,正文记录是否写进会话文件(默认 true)
//   persistFinalVariant         'same' 原样(默认);'longer' 写进文件的正文末尾多一句「规整补句。」,流里输出的不变
//   stallAfterChunks            输出到这么多片段后不再输出任何东西,也不结束,直到被打断 / 收场 / 进程被结束(默认不启用)
// 三种写盘形态:打断形(全默认)、半写形(persistThinking:true + 另两项 false)、强杀形(三项全 false)。
// 状态文件 $CGUI_FAKE_CLAUDE_DIR/status-<工作目录名>.json(每次变化原子替换;按工作目录名分开):
//   openedAt、chunksEmitted(已输出片段数)、interruptedAtChunks(被打断时已输出片段数;未被打断为 null)、ended(本回合已收尾)。
//
// 一回合:收到用户消息 → 立刻把提示词作为用户行写进会话文件(不受任何开关影响) → 等 startDelayMs → 输出 init
//   → 思考块(流式 `先想一想。` + 只含思考块的助手快照;persistThinking 为真时此刻写盘) → 正文逐片段流式输出
//   → 自然结束(只含正文块的助手快照 + 成功的结束事件;persistFinal 为真时写盘) / 被打断(见下) / 永久静默。
//   被打断(control_request / interrupt):立刻停,回成功应答;发只含已输出正文的助手快照、用户事件 `[Request interrupted by user]`、
//   出错的结束事件(error_during_execution / is_error:true);persistPartialOnInterrupt 为真时,半截正文记录和打断用户行写进会话文件。
// 流里每条助手快照事件的 uuid = 它对应的会话文件记录的 uuid(没写盘时事件照样带这个编号)。
// 一回合结束后进程不退出,继续等下一条用户消息。
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
// GUI 会另起一个 CLI(工作目录在系统临时目录的 cgui-title 目录下面)只为给新会话起标题:立刻回一个短标题,不延迟、不落盘、不读场景、不碰状态文件。
const TITLE_GEN = /cgui-title/.test(cwd);
try { fs.appendFileSync(path.join(path.dirname(CTL), 'fake-claude-spawn.jsonl'), `${JSON.stringify({ argv, sid, cwd, titleGen: TITLE_GEN })}\n`); } catch { /* 忽略 */ }
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.322';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const THINK_TEXT = '先想一想。';
const EXTRA_SENTENCE = '规整补句。';

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
  const d = {
    startDelayMs: 0, chunkIntervalMs: 50, chunkCount: 1200, textPrefix: '',
    persistThinking: true, persistPartialOnInterrupt: true, persistFinal: true, persistFinalVariant: 'same', stallAfterChunks: null,
  };
  try { return { ...d, ...JSON.parse(fs.readFileSync(path.join(CTL, 'scenario.json'), 'utf8')) }; } catch { return d; }
}

const status = { openedAt: null, chunksEmitted: 0, interruptedAtChunks: null, ended: false };
function writeStatus() {
  if (TITLE_GEN) return;
  try {
    const tmp = path.join(CTL, `status.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp, `${JSON.stringify(status)}\n`);
    fs.renameSync(tmp, path.join(CTL, `status-${path.basename(cwd)}.json`));
  } catch { /* 忽略 */ }
}

// 本进程里上一条【落盘】行的 uuid:下一行的 parentUuid 接着它(真实转写是一条链;没写盘的记录不进链)。
let lastUuid = null;
let interruptRequested = false;

function transcriptUser(text) {
  // 新会话(不是 --resume 起的)第一次落盘时,先写一行 summary。
  if (lastUuid === null && !argOf('--resume')) append({ type: 'summary', summary: String(text || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r182-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: text },
    uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields(),
  });
  lastUuid = uuid;
}
function transcriptAssistant(id, content, stopReason, uuid) {
  append({
    parentUuid: lastUuid,
    message: { model: MODEL, id, type: 'message', role: 'assistant', content, stop_reason: stopReason, stop_sequence: null, stop_details: null, usage: USAGE },
    requestId: `req_${id}`, type: 'assistant', uuid, timestamp: stamp(), effort: 'high', ...baseFields(),
  });
  lastUuid = uuid;
}
function emitAssistant(id, content, stopReason, uuid) {
  out({ type: 'assistant', session_id: sid, uuid, parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content, stop_reason: stopReason, usage: USAGE } });
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
  emitAssistant(`r182_title_${crypto.randomBytes(3).toString('hex')}`, [{ type: 'text', text: '短标题' }], 'end_turn', crypto.randomUUID());
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '短标题', duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}

async function runRound(userText) {
  if (TITLE_GEN) { await runTitleRound(); return; }
  const sc = readScenario();
  interruptRequested = false;
  status.openedAt = null; status.chunksEmitted = 0; status.interruptedAtChunks = null; status.ended = false;
  writeStatus();

  // 收到用户消息立刻把提示词写进会话文件(不受任何开关影响)。
  transcriptUser(userText);

  const interruptedEarly = await sleepInterruptible(sc.startDelayMs);
  status.openedAt = Date.now();
  writeStatus();
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

  const id = `r182_fake_${crypto.randomBytes(3).toString('hex')}`;
  const thinkUuid = crypto.randomUUID();
  const textUuid = crypto.randomUUID();
  const finishInterrupted = (partialText) => {
    status.interruptedAtChunks = status.chunksEmitted;
    const content = [{ type: 'text', text: partialText }];
    emitAssistant(id, content, null, textUuid);
    if (sc.persistPartialOnInterrupt && partialText) transcriptAssistant(id, content, null, textUuid);
    out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    if (sc.persistPartialOnInterrupt) transcriptUser('[Request interrupted by user]');
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE, errors: [] });
    status.ended = true;
    writeStatus();
  };
  if (interruptedEarly) { finishInterrupted(''); return; }

  evt({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: USAGE } });
  // 思考块:流式输出;只含思考块的助手快照;persistThinking 为真时此刻写盘。
  evt({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  evt({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINK_TEXT } });
  evt({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'r182sig' } });
  evt({ type: 'content_block_stop', index: 0 });
  const thinkContent = [{ type: 'thinking', thinking: THINK_TEXT, signature: 'r182sig' }];
  emitAssistant(id, thinkContent, null, thinkUuid);
  if (sc.persistThinking) transcriptAssistant(id, thinkContent, null, thinkUuid);

  // 正文:逐片段流式输出。
  evt({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  let body = '';
  for (let i = 1; i <= sc.chunkCount; i += 1) {
    if (interruptRequested || aborted()) break;
    const piece = `${i === 1 ? (sc.textPrefix || '') : ''}片段${String(i).padStart(4, '0')}。`;
    body += piece;
    evt({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: piece } });
    status.chunksEmitted = i;
    writeStatus();
    if (sc.stallAfterChunks != null && i >= sc.stallAfterChunks) {
      // 永久静默:不再输出任何东西、也不结束,直到被打断 / 收场 / 进程被结束。
      // 与接口文件的偏差(实测):纯文字流停在半截时,后端的静默超时根本不触发(等 60 秒都没有「⏸」提示、停止键一直在);
      // 只有「已流出一条带未返回工具调用的助手快照」之后再静默,4 秒就会被后端结束(与 r178c 的 subagent-silent 同理)。
      // 所以进入静默前补发一条助手快照:已输出的全部正文 + 一个不会返回的 Agent 工具调用(不写会话文件;页面上的片段数不变)。
      emitAssistant(id, [{ type: 'text', text: body }, { type: 'tool_use', id: `toolu_r182_${crypto.randomBytes(6).toString('hex')}`, name: 'Agent', input: { description: '子任务', prompt: '只回答 ok', subagent_type: 'general-purpose' } }], 'tool_use', textUuid);
      while (!interruptRequested && !aborted()) await sleep(50);
      break;
    }
    if (i < sc.chunkCount && (await sleepInterruptible(sc.chunkIntervalMs))) break;
    if (aborted()) break;
  }
  if (interruptRequested) { finishInterrupted(body); return; }

  evt({ type: 'content_block_stop', index: 1 });
  const textContent = [{ type: 'text', text: body }];
  emitAssistant(id, textContent, 'end_turn', textUuid);
  if (sc.persistFinal) {
    const persisted = sc.persistFinalVariant === 'longer' ? [{ type: 'text', text: `${body}${EXTRA_SENTENCE}` }] : textContent;
    transcriptAssistant(id, persisted, 'end_turn', textUuid);
  }
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
