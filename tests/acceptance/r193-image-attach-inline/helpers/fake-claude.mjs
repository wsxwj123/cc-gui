#!/usr/bin/env node
// r193-image-attach-inline 的假 claude 命令行:只说 stream-json,不碰实现内部。从 r192 的假命令行派生,新增:
//   (一) 收信日志:每从标准输入读到一条用户消息(含回合进行中读到的并入消息),往 $CGUI_FAKE_CLAUDE_DIR/received-<工作目录名>.jsonl 追加一行摘要:
//        { t, steer, uuid, kind: 'string'|'array'|'other', text?(字符串时全文), blocks?(数组时各块摘要) };
//        文字块 { type:'text', text 全文 };图片块 { type:'image', sourceType, mediaType, b64Len, sha256(解码后字节)};图片数据本身不写日志。
//   (二) 会话记录文件照真实命令行(2026-11-16 取样):
//        普通发送、内容为数组:用户行 message.content 就是收到的数组(图片数据也写进去),该行多一个 imagePasteIds(数字数组,每张图一个编号),
//        紧跟每张图一条 isMeta:true 的用户行,内容是字符串 `[Image: source: <路径>/images/<编号>.png]`;内容为字符串时一切照旧。
//        回合进行中的并入(真机取样):不写用户行,连写两行 —— { type:'queue-operation', operation:'remove', content:<并入的内容> },
//        再 { type:'attachment', attachment:{ type:'queued_command', prompt:<收到的内容(字符串或数组)>, source_uuid:<标准输入那条消息的 uuid>, commandMode:'prompt' } }。
//   (三) 并入:带 uuid 的用户消息在回合进行中到达 → 立刻吐 command_lifecycle queued、写 queued_command 行、吐 started(并入本回合),本回合 result 之后吐 completed。
//        没有回合在进行时到达的消息,按普通新回合处理(带 uuid 时同样吐 queued / started / completed)。
//   (四) 场景 apiError:{ status, error, text } —— 本回合对上游报错(形态取自 r176 假命令行:助手消息先落盘,再吐 assistant(synthetic) + result(is_error:true))。
//   (五) 新会话第一次落盘时,回合开头写够 3 行(summary + 两行 queue-operation + 用户行),侧栏才会列出它(取自 r190)。
// 行为由场景文件 $CGUI_FAKE_CLAUDE_DIR/scenario.json 控制(每开一回合读一次;没写的字段取默认值):
//   startDelayMs(默认 0)、chunkIntervalMs(默认 50)、chunkCount(默认 1200)、apiError(默认不启用)。
// 状态文件 $CGUI_FAKE_CLAUDE_DIR/status-<工作目录名>.json:openedAt、chunksEmitted、interruptedAtChunks、ended。
// 收场:往 $CGUI_FAKE_CLAUDE_DIR/abort-<工作目录名> 放一个文件,当前回合(以及之后的回合)立刻正常收尾。
// 流里每条助手快照事件的 uuid = 它对应的会话文件记录的 uuid。一回合结束后进程不退出,继续等下一条用户消息。
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
// GUI 会另起一个 CLI(工作目录在系统临时目录的 cgui-title 目录下面)只为给新会话起标题:立刻回一个短标题,不延迟、不落盘、不读场景、不记收信日志、不碰状态文件。
const TITLE_GEN = /cgui-title/.test(cwd);
try { fs.appendFileSync(path.join(path.dirname(CTL), 'fake-claude-spawn.jsonl'), `${JSON.stringify({ argv, sid, cwd, titleGen: TITLE_GEN })}\n`); } catch { /* 忽略 */ }
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const WS_NAME = path.basename(cwd);
const RECEIVED = path.join(CTL, `received-${WS_NAME}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.322';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const THINK_TEXT = '先想一想。';
const API_ERR_DEFAULT = { status: 400, error: 'unknown', text: 'API Error: 400 Content Exists Risk' };

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: VERSION, gitBranch: '' });
const evt = (event) => out({ type: 'stream_event', event, session_id: sid, parent_tool_use_id: null, uuid: crypto.randomUUID() });
const lifecycle = (state, commandUuid) => out({ type: 'command_lifecycle', command_uuid: commandUuid, state, uuid: crypto.randomUUID(), session_id: sid });

function readScenario() {
  const d = { startDelayMs: 0, chunkIntervalMs: 50, chunkCount: 1200, apiError: null };
  try { return { ...d, ...JSON.parse(fs.readFileSync(path.join(CTL, 'scenario.json'), 'utf8')) }; } catch { return d; }
}

const status = { openedAt: null, chunksEmitted: 0, interruptedAtChunks: null, ended: false };
function writeStatus() {
  if (TITLE_GEN) return;
  try {
    const tmp = path.join(CTL, `status.json.tmp-${process.pid}`);
    fs.writeFileSync(tmp, `${JSON.stringify(status)}\n`);
    fs.renameSync(tmp, path.join(CTL, `status-${WS_NAME}.json`));
  } catch { /* 忽略 */ }
}

/** 收信日志的一行摘要(图片数据不进日志,只记媒体类型、base64 长度、解码后字节的 sha256)。 */
function summarizeContent(c) {
  if (typeof c === 'string') return { kind: 'string', text: c };
  if (Array.isArray(c)) {
    const blocks = c.map((b) => {
      if (b && b.type === 'text') return { type: 'text', text: b.text };
      if (b && b.type === 'image') {
        const src = b.source || {};
        const data = typeof src.data === 'string' ? src.data : '';
        return {
          type: 'image', sourceType: src.type || null, mediaType: src.media_type || null, b64Len: data.length,
          sha256: crypto.createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex'),
        };
      }
      return { type: (b && b.type) || 'unknown' };
    });
    return { kind: 'array', blocks };
  }
  return { kind: 'other' };
}
function logReceived(content, uuid, steer) {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(CTL, { recursive: true }); fs.appendFileSync(RECEIVED, `${JSON.stringify({ t: Date.now(), steer, uuid: uuid || null, ...summarizeContent(content) })}\n`); } catch { /* 忽略 */ }
}
const textOf = (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : ''));

// 本进程里上一条【落盘】行的 uuid:下一行的 parentUuid 接着它(真实转写是一条链)。
let lastUuid = null;
let interruptRequested = false;
let roundActive = false;
const mergedSteers = []; // 本回合里并入的 uuid,result 之后吐 completed

function transcriptUser(content) {
  // 新会话(不是 --resume 起的)第一次落盘:先写 summary 与两行 queue-operation,使回合开头至少 3 行(侧栏才会列出;取自 r190)。
  if (lastUuid === null && !argOf('--resume')) {
    append({ type: 'summary', summary: textOf(content).slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
    append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: sid, content: textOf(content) });
    append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(), sessionId: sid });
  }
  const uuid = crypto.randomUUID();
  const images = Array.isArray(content) ? content.filter((b) => b && b.type === 'image').length : 0;
  append({
    parentUuid: lastUuid, promptId: 'r193-fake', type: 'user', isMeta: false,
    message: { role: 'user', content },
    ...(images > 0 ? { imagePasteIds: Array.from({ length: images }, (_, i) => i + 1) } : {}),
    uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields(),
  });
  lastUuid = uuid;
  for (let i = 1; i <= images; i += 1) {
    const mu = crypto.randomUUID();
    append({
      parentUuid: lastUuid, promptId: 'r193-fake', type: 'user', isMeta: true,
      message: { role: 'user', content: `[Image: source: ${path.join(PROJ, 'images', `${i}.png`)}]` },
      uuid: mu, timestamp: stamp(), ...baseFields(),
    });
    lastUuid = mu;
  }
}
/** 并入的落盘(真机取样):先一行 queue-operation(remove,带并入的内容),再一行 attachment(queued_command,source_uuid = 页面并入时给的 uuid)。 */
function transcriptQueuedCommand(prompt, sourceUuid) {
  append({ type: 'queue-operation', operation: 'remove', timestamp: stamp(), sessionId: sid, content: prompt });
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, type: 'attachment',
    attachment: { type: 'queued_command', prompt, source_uuid: sourceUuid, commandMode: 'prompt', timestamp: stamp() },
    uuid, timestamp: stamp(), ...baseFields(),
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
function apiErrorTranscriptLine(err) {
  const uuid = crypto.randomUUID();
  const message = {
    diagnostics: null, id: crypto.randomUUID(), container: null, model: '<synthetic>', role: 'assistant', stop_details: null,
    stop_reason: 'stop_sequence', stop_sequence: '', type: 'message',
    usage: {
      output_tokens_details: null, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: null,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: null, iterations: null, speed: null, fallback_credit: null,
    },
    content: [{ type: 'text', text: err.text }],
    context_management: null,
  };
  append({
    parentUuid: lastUuid, type: 'assistant', uuid, timestamp: stamp(), message,
    error: err.error, isApiErrorMessage: true, apiErrorStatus: err.status, perTurnEffort: null, ...baseFields(),
  });
  lastUuid = uuid;
}

const ABORT_FILE = path.join(CTL, `abort-${WS_NAME}`);
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
  emitAssistant(`r193_title_${crypto.randomBytes(3).toString('hex')}`, [{ type: 'text', text: '短标题' }], 'end_turn', crypto.randomUUID());
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '短标题', duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}

async function runRound(item) {
  if (TITLE_GEN) { await runTitleRound(); return; }
  roundActive = true;
  try { await runRoundInner(item); } finally {
    roundActive = false;
    // result 已吐出:对本回合并入的消息(以及本回合自己若带 uuid)吐 completed。
    const done = [...(item.uuid ? [item.uuid] : []), ...mergedSteers.splice(0)];
    for (const u of done) lifecycle('completed', u);
  }
}

async function runRoundInner({ content, uuid }) {
  const sc = readScenario();
  interruptRequested = false;
  status.openedAt = null; status.chunksEmitted = 0; status.interruptedAtChunks = null; status.ended = false;
  writeStatus();

  if (uuid) lifecycle('started', uuid);
  // 收到用户消息立刻把提示词写进会话文件。
  transcriptUser(content);

  const interruptedEarly = await sleepInterruptible(sc.startDelayMs);
  status.openedAt = Date.now();
  writeStatus();
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

  const id = `r193_fake_${crypto.randomBytes(3).toString('hex')}`;

  // 上游报错:先让页面看到「回合已开始」(停止键出现一小会儿),再按 r176 的形态报错。
  if (sc.apiError) {
    const err = { ...API_ERR_DEFAULT, ...(typeof sc.apiError === 'object' ? sc.apiError : {}) };
    await sleep(700);
    apiErrorTranscriptLine(err);
    out({
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: err.text }], stop_reason: 'stop_sequence' },
      error: err.error, is_api_error_message: true, api_error_status: err.status,
      session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null,
    });
    out({
      type: 'result', subtype: 'success', is_error: true, api_error_status: err.status, result: err.text, session_id: sid,
      uuid: crypto.randomUUID(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE,
    });
    status.ended = true;
    writeStatus();
    return;
  }

  const thinkUuid = crypto.randomUUID();
  const textUuid = crypto.randomUUID();
  const finishInterrupted = (partialText) => {
    status.interruptedAtChunks = status.chunksEmitted;
    const c = [{ type: 'text', text: partialText }];
    emitAssistant(id, c, null, textUuid);
    if (partialText) transcriptAssistant(id, c, null, textUuid);
    out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE, errors: [] });
    status.ended = true;
    writeStatus();
  };
  if (interruptedEarly) { finishInterrupted(''); return; }

  evt({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: USAGE } });
  evt({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  evt({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINK_TEXT } });
  evt({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'r193sig' } });
  evt({ type: 'content_block_stop', index: 0 });
  const thinkContent = [{ type: 'thinking', thinking: THINK_TEXT, signature: 'r193sig' }];
  emitAssistant(id, thinkContent, null, thinkUuid);
  transcriptAssistant(id, thinkContent, null, thinkUuid);

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
  emitAssistant(id, textContent, 'end_turn', textUuid);
  transcriptAssistant(id, textContent, 'end_turn', textUuid);
  evt({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: USAGE });
  evt({ type: 'message_stop' });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: body, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  status.ended = true;
  writeStatus();
}

if (!fs.existsSync(CTL)) { try { fs.mkdirSync(CTL, { recursive: true }); } catch { /* 忽略 */ } }

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) { await runRound({ content: printArg, uuid: null }); process.exit(0); }

const queue = [];
let running = false;
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) await runRound(queue.shift());
  running = false;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
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
  const uuid = typeof msg.uuid === 'string' && msg.uuid ? msg.uuid : null;
  if (TITLE_GEN) { queue.push({ content: c, uuid: null }); void pump(); return; }
  // 回合进行中读到的带 uuid 的消息 = 并入。
  const steer = Boolean(uuid) && roundActive;
  logReceived(c, uuid, steer);
  if (uuid) lifecycle('queued', uuid);
  if (steer) {
    transcriptQueuedCommand(c, uuid);
    lifecycle('started', uuid);
    mergedSteers.push(uuid);
    return;
  }
  queue.push({ content: c, uuid });
  void pump();
});
await new Promise((resolve) => rl.on('close', resolve));
process.exit(0);
