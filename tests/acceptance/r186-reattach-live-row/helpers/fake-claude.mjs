#!/usr/bin/env node
// r186-reattach-live-row 的假 claude 命令行:只说 stream-json,不碰实现内部。
// 场景文件 $CGUI_FAKE_CLAUDE_DIR/scenario-<工作目录名>.json(每收到一条用户消息读一次):{ "mode": "tools" | "idle" }
//   tools 工具轮:收到用户消息后依次调用 3 次 Bash(input.description = R186TOOL-1/2/3);前 2 次很快返回;
//         第 3 次的调用发出并写进会话文件后挂起,直到放行(场景目录里出现 release-<工作目录名>)或被停止(收到 interrupt 控制请求);
//         放行后第 3 次返回,再输出正文 R186DONE,正常结束;被停止则第 3 次以「被用户打断」收场并结束。
//   idle  空等轮:把用户消息写进会话文件后不输出任何助手内容,一直等到放行或被停止,然后结束。
// 会话文件开头先写两行 queue-operation(入队带 content、出队不带),再写用户消息。
// 阶段写进 status-<工作目录名>.json 的 stage 字段(tool1-returned / tool2-returned / tool3-sent / idle-waiting / done / stopped)。
// 回合结束后进程不退出,继续等下一条用户消息。GUI 起标题的另一次调用(工作目录在 cgui-title 下、或 -p 非流式)立刻回短标题,不落盘。
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
const STEP_MS = 700;
const sid = argOf('--session-id') || argOf('--resume') || process.env.SF_SESSION_ID || crypto.randomUUID();
const cwd = process.cwd();
const WS = path.basename(cwd);
// GUI 起标题的另一次调用(命令行 -p 且不是流式输入;工作目录在 cgui-title 下):只回一个短标题,不吃场景、不落盘。
const TITLE_GEN = /cgui-title/.test(cwd) || (argv.includes("-p") && !argv.includes("--input-format"));
try { fs.appendFileSync(path.join(path.dirname(CTL), 'fake-claude-spawn.jsonl'), `${JSON.stringify({ argv, sid, cwd, titleGen: TITLE_GEN })}\n`); } catch { /* 忽略 */ }
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const VERSION = '2.1.322';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const baseFields = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: VERSION, gitBranch: '' });
const setStage = (stage) => { try { fs.writeFileSync(path.join(CTL, `status-${WS}.json`), `${JSON.stringify({ stage, t: Date.now() })}\n`); } catch { /* 忽略 */ } };

function readScenario() {
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(CTL, `scenario-${WS}.json`), 'utf8'));
    if (sc && typeof sc.mode === 'string') return sc;
  } catch { /* 读不到就用默认 */ }
  return { mode: 'tools' };
}

let lastUuid = null;
function loadLastUuid() { // 续接已有会话时(种子会话),新行接在原链最后一条后面
  lastUuid = null;
  try {
    const ls = fs.readFileSync(TRANSCRIPT, 'utf8').split('\n').filter(Boolean);
    for (let i = ls.length - 1; i >= 0 && lastUuid === null; i -= 1) {
      try { const o = JSON.parse(ls[i]); if (o.uuid) lastUuid = o.uuid; } catch { /* 跳过坏行 */ }
    }
  } catch { /* 文件还没有 */ }
}
function transcriptQueueAndUser(text) {
  append({ type: 'queue-operation', operation: 'enqueue', timestamp: stamp(), sessionId: sid, content: text });
  append({ type: 'queue-operation', operation: 'dequeue', timestamp: stamp(), sessionId: sid });
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r186-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: text }, uuid, timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk', ...baseFields(),
  });
  lastUuid = uuid;
}
function transcriptAssistant(id, blocks, stopReason) {
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid,
    message: { model: MODEL, id, type: 'message', role: 'assistant', content: blocks, stop_reason: stopReason, stop_sequence: null, stop_details: null, usage: USAGE },
    requestId: `req_${id}`, type: 'assistant', uuid, timestamp: stamp(), effort: 'high', ...baseFields(),
  });
  lastUuid = uuid;
}
function transcriptToolResult(toolUseId, content, isError) {
  const uuid = crypto.randomUUID();
  append({
    parentUuid: lastUuid, promptId: 'r186-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
    uuid, timestamp: stamp(), toolUseResult: content, ...baseFields(),
  });
  lastUuid = uuid;
}
const emitAssistant = (id, blocks, stopReason) => out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: stopReason, usage: USAGE } });
const emitToolResult = (toolUseId, content, isError) => out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] } });
const emitResult = () => out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
const emitInit = () => out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

// 被停止 = 收到 interrupt 控制请求。等放行文件出现或被停止,返回 'released' | 'stopped'。
let interrupted = false;
async function waitReleaseOrStop() {
  for (;;) {
    if (interrupted) return 'stopped';
    if (fs.existsSync(path.join(CTL, `release-${WS}`))) return 'released';
    await sleep(60);
  }
}

async function runRound(userText) {
  if (TITLE_GEN) {
    emitInit();
    emitAssistant(`r186_title`, [{ type: 'text', text: '短标题' }], 'end_turn');
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: '短标题', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
    return;
  }
  interrupted = false;
  const sc = readScenario();
  loadLastUuid();
  transcriptQueueAndUser(userText);
  emitInit();
  await sleep(TURN_DELAY_MS);

  if (sc.mode === 'idle') {
    setStage('idle-waiting');
    const how = await waitReleaseOrStop();
    emitResult();
    setStage(how === 'stopped' ? 'stopped' : 'done');
    return;
  }

  const tag = crypto.randomBytes(3).toString('hex');
  for (const n of [1, 2, 3]) {
    const id = `r186_${n}_${tag}`;
    const toolId = `toolu_r186_${n}_${tag}`;
    const blocks = [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: `echo r186 ${n}`, description: `R186TOOL-${n}` } }];
    emitAssistant(id, blocks, 'tool_use');
    transcriptAssistant(id, blocks, 'tool_use');
    if (n === 3) {
      setStage('tool3-sent');
      const how = await waitReleaseOrStop();
      if (how === 'stopped') {
        const msg = '[Request interrupted by user for tool use]';
        emitToolResult(toolId, msg, true);
        transcriptToolResult(toolId, msg, true);
        emitResult();
        setStage('stopped');
        return;
      }
    }
    emitToolResult(toolId, `（假 CLI）R186 输出 ${n}`, false);
    transcriptToolResult(toolId, `（假 CLI）R186 输出 ${n}`, false);
    if (n < 3) setStage(`tool${n}-returned`);
    await sleep(STEP_MS);
  }
  const doneBlocks = [{ type: 'text', text: 'R186DONE' }];
  emitAssistant(`r186_done_${tag}`, doneBlocks, 'end_turn');
  transcriptAssistant(`r186_done_${tag}`, doneBlocks, 'end_turn');
  emitResult();
  setStage('done');
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
    if (msg.request && msg.request.subtype === 'interrupt') interrupted = true;
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
