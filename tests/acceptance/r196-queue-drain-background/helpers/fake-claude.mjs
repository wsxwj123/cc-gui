#!/usr/bin/env node
// r196 假命令行(由 r140 的"按住 / 放开 / 阶段"桩件与 r198 的"前台命令转后台 / 停止 / 通知回合"桩件合并而来;
// 不 import 别的套件的文件)。控制文件都在 <CTL>/ 下,<sid> = 会话编号:
//   <sid>.slow-ms      这一条会话的回合"开始前"静默多少毫秒(按住);可随时改写,每 60ms 重读一次;写 0 = 放行。没有则看全局 slow-ms
//   <sid>.auto-ms      有它(或全局 auto-ms)时,两段停住改为各睡这么多毫秒自动走完,不用测试手动放行
//   <sid>.chunk / .done   默认回合的两道闸:第一块文字之后等 .chunk,第二块之后等 .done;放行后桩件删掉文件(每轮要放一次)
//   <sid>.scenario.json   下一个回合的前置步骤(读到就删):{steps:[{t:'bash-fg',toolId,taskId,command,description,registerMs}]}
//   <sid>.taskdone     让这个进程里在后台跑的任务"跑完":发完成通知并自动起一轮通知回合
//   <sid>.kill         让本进程退出
// 桩件写出的观察文件:
//   <CTL>/spawns.jsonl    每个交互式进程一行 {t,pid,sid,resume,model,permissionMode}
//   <CTL>/received.jsonl  每收到一条用户消息一行 {t,pid,sid,text,images}
//   <sid>.rounds.jsonl    {ev:'start'|'end',n,text,t,why?}   <sid>.phase:init|chunk1|chunk2|final   <sid>.started:pid
// 后台起标题的调用(参数带 -p 与 --no-session-persistence,或提示里有 cgui-title):回一句标题就退出,不读放行文件、不写会话文件。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { encodeProjectDir } from './fixtures.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }
if (['mcp', 'plugin', 'config', 'doctor', 'update'].includes(argv[0])) process.exit(0);

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const p = argv.find((a) => a.startsWith(`${n}=`));
  return p ? p.slice(n.length + 1) : undefined;
};
const cwd = process.cwd();
const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const MODEL = argOf('--model') || 'claude-sonnet-4-6';
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const out = (o) => process.stdout.write(`${JSON.stringify({ session_id: sid, uuid: crypto.randomUUID(), ...o })}\n`);
const f = (suffix) => path.join(CTL, `${sid}.${suffix}`);
const rmQuiet = (p) => { try { fs.unlinkSync(p); } catch { /* 本来就没有 */ } };
const readRaw = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readNum = (p) => { const t = readRaw(p); return t === null ? null : (Number(t.trim()) || 0); };
const jl = (file, o) => { try { fs.mkdirSync(CTL, { recursive: true }); fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...o })}\n`); } catch { /* 忽略 */ } };
const textOf = (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('') : ''));

// ---------------- 后台起标题的调用:回一句标题就退出
const joined = argv.join(' ');
if ((argv.includes('-p') && argv.includes('--no-session-persistence')) || /cgui-title/.test(joined) || /cgui-title/.test(cwd)) {
  // 主会话修订(锁定后):服务端起标题时提示经标准输入喂入、写完即关(不在参数里),
  // 只在参数里找标记会回「短标题」,侧栏那一行就不再带标记、按标记找不回会话。参数与标准输入都找。
  let stdinText = '';
  try { stdinText = fs.readFileSync(0, 'utf8'); } catch { /* 没有标准输入 */ }
  const mark = (/R196[A-Za-z0-9]*MARK|R196V\d+[A-Za-z0-9]*/.exec(`${joined}\n${stdinText}`) || [''])[0];
  const title = mark ? `${mark} 标题` : '短标题';
  if (/stream-json/.test(joined)) {
    out({ type: 'system', subtype: 'init', cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default' });
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_title_${crypto.randomBytes(3).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: title }], stop_reason: 'end_turn', usage: USAGE } });
    out({ type: 'result', subtype: 'success', is_error: false, result: title, duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  } else process.stdout.write(`${title}\n`);
  process.exit(0);
}

const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', encodeProjectDir(cwd));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const base = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.327', gitBranch: '', timestamp: stamp() });
const append = (line) => { try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ } };
const oneShotArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
const oneShot = Boolean(oneShotArg) && !argv.includes('--input-format');
try {
  fs.mkdirSync(CTL, { recursive: true });
  if (!oneShot) {
    fs.writeFileSync(f('started'), `${stamp()} pid=${process.pid}`);
    jl(path.join(CTL, 'spawns.jsonl'), { pid: process.pid, sid, resume: Boolean(argOf('--resume')), model: argOf('--model') || null, permissionMode: argOf('--permission-mode') || null });
  }
} catch { /* 忽略 */ }

// ---------------- 状态与事件
const tasks = new Map(); const fgs = new Map(); const injected = [];
let busy = false; let turnNo = 0; let intr = null; let stdinClosed = false; let tail = Promise.resolve();
const chain = (fn) => { tail = tail.then(fn).catch((e) => { process.stderr.write(`${String((e && e.stack) || e)}\n`); }); return tail; };
const assistantBlocks = (blocks, stop) => {
  const id = `msg_r196_${crypto.randomBytes(4).toString('hex')}`;
  const msg = { id, type: 'message', role: 'assistant', model: MODEL, content: blocks, stop_reason: stop, usage: USAGE };
  out({ type: 'assistant', parent_tool_use_id: null, message: msg });
  append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, requestId: `req_${id}`, message: { ...msg, stop_sequence: null } });
};
const say = (text) => assistantBlocks([{ type: 'text', text }], 'end_turn');
const toolResult = (toolId, content, isError, toolUseResult) => {
  const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError, content }] };
  out({ type: 'user', parent_tool_use_id: null, message, ...(toolUseResult ? { tool_use_result: toolUseResult } : {}) });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, isMeta: false, message, ...(toolUseResult ? { toolUseResult } : {}) });
};
const sysEvent = (subtype, extra) => out({ type: 'system', subtype, ...extra });
const runningBgList = () => [...tasks.values()].filter((t) => t.status === 'running').map((t) => ({ task_id: t.taskId, task_type: 'local_bash', description: t.description }));
const respond = (requestId, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
const phase = (v) => { try { fs.writeFileSync(f('phase'), v); } catch { /* 忽略 */ } };
const race = (p) => Promise.race([p, intr.p]);
const autoMs = () => { const per = readNum(f('auto-ms')); return per === null ? readNum(path.join(CTL, 'auto-ms')) : per; };
const startHoldMs = () => { const per = readNum(f('slow-ms')); return per === null ? (readNum(path.join(CTL, 'slow-ms')) || 0) : per; };

// ---------------- 前台命令转后台(r198 桩件的精简版:只留 bash-fg)
function moveTask(fg) {
  if (!fg.registered || fg.moved || fg.done) return false;
  fg.moved = true;
  tasks.get(fg.taskId).status = 'running';
  sysEvent('background_tasks_changed', { tasks: runningBgList() });
  sysEvent('task_updated', { task_id: fg.taskId, patch: { is_backgrounded: true } });
  setTimeout(() => {
    toolResult(fg.toolId, `Command was manually backgrounded by user with ID: ${fg.taskId}. Output is being written to: ${fg.outFile}`, false,
      { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: fg.taskId, backgroundedByUser: true });
    fg.resolveMoved();
  }, 1000);
  return true;
}
function handleBackground(msg) {
  const tid = msg.request && msg.request.tool_use_id;
  if (tid) { const fg = fgs.get(tid); respond(msg.request_id, { backgrounded: Boolean(fg) && moveTask(fg) }); return; }
  for (const fg of fgs.values()) moveTask(fg);
  respond(msg.request_id, {});
}
async function runStep(st) {
  if (st.t !== 'bash-fg') return;
  const outFile = path.join(CTL, 'tasks', `${sid}-${st.taskId}.output`);
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, `R196-OUT-${st.taskId}\n`); } catch { /* 忽略 */ }
  tasks.set(st.taskId, { taskId: st.taskId, toolId: st.toolId, description: st.description || '', status: 'foreground', outFile });
  const fg = { toolId: st.toolId, taskId: st.taskId, outFile, registered: false, moved: false, done: false };
  fg.movedP = new Promise((r) => { fg.resolveMoved = r; });
  fgs.set(st.toolId, fg);
  assistantBlocks([{ type: 'tool_use', id: st.toolId, name: 'Bash', input: { command: st.command, description: st.description || '' } }], 'tool_use');
  setTimeout(() => {
    if (fg.done || fg.moved || (intr && intr.flag)) return;
    fg.registered = true;
    sysEvent('task_started', { task_id: st.taskId, tool_use_id: st.toolId, description: st.description || '', is_backgrounded: false, task_type: 'local_bash' });
  }, Number(st.registerMs ?? 3000));
  await race(fg.movedP);
}

// ---------------- 停止
function handleInterrupt(msg) {
  respond(msg.request_id, {});
  if (!busy || !intr) return;
  intr.requested = true;
  setTimeout(() => { intr.flag = true; intr.resolve(); }, Number((readRaw(f('interrupt-delay-ms')) || '0').trim()) || 0);
}
process.on('SIGINT', () => handleInterrupt({ request_id: 'sigint' }));
function finishInterrupted() {
  for (const fg of fgs.values()) if (!fg.moved && !fg.done) { fg.done = true; toolResult(fg.toolId, '[Request interrupted by user for tool use]', true, null); }
  const m = { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] };
  out({ type: 'user', parent_tool_use_id: null, message: m });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: m });
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'], result: '', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}

// ---------------- 回合
const waitFile = async (suffix) => {
  const auto = autoMs();
  if (auto !== null) { await race(sleep(auto)); return; }
  while (!intr.flag && !fs.existsSync(f(suffix))) await race(sleep(60));
  rmQuiet(f(suffix));
};
async function userTurn(content) {
  busy = true; turnNo += 1;
  const n = turnNo; const text = textOf(content);
  intr = { flag: false, requested: false, resolve: null, p: null };
  intr.p = new Promise((r) => { intr.resolve = r; });
  jl(f('rounds.jsonl'), { ev: 'start', n, text });
  phase('init');
  // 开始前的按住:每 60ms 重读一次(写 0 或删文件即放行)
  const t0 = Date.now();
  while (Date.now() - t0 < startHoldMs() && !intr.flag) await sleep(60);
  if (!fs.existsSync(TRANSCRIPT)) append({ type: 'summary', summary: text.slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content } });
  sysEvent('init', { cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: argOf('--permission-mode') || 'default' });
  const raw = readRaw(f('scenario.json'));
  if (raw !== null) { rmQuiet(f('scenario.json')); let sc = { steps: [] }; try { sc = JSON.parse(raw); } catch { /* 用空的 */ } for (const st of (sc.steps || [])) { if (!intr.flag) await runStep(st); } }
  if (!intr.flag) { say(`R196-CHUNK1 ${sid.slice(0, 8)} 收到:${text}`); phase('chunk1'); await waitFile('chunk'); }
  if (!intr.flag) { say(`R196-CHUNK2 ${sid.slice(0, 8)} 第二块。`); phase('chunk2'); await waitFile('done'); }
  if (intr.flag) {
    finishInterrupted(); busy = false; phase('final'); jl(f('rounds.jsonl'), { ev: 'end', n, text, why: 'interrupted' });
    for (const m of injected.splice(0)) chain(() => userTurn(m));
    return;
  }
  say(`R196-FINAL ${sid.slice(0, 8)} 这一轮结束了。`);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'R196-FINAL', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  phase('final'); jl(f('rounds.jsonl'), { ev: 'end', n, text, why: 'result' });
  busy = false;
}
async function notifyTurn(t) {
  busy = true; turnNo += 1;
  intr = { flag: false, requested: false, resolve: null, p: null };
  intr.p = new Promise((r) => { intr.resolve = r; });
  const body = `<task-notification>\n<task-id>${t.taskId}</task-id>\n<status>completed</status>\n<summary>Background command "${t.description}" completed (exit code 0)</summary>\n</task-notification>`;
  jl(f('rounds.jsonl'), { ev: 'start', n: turnNo, text: body, notify: true });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: body } });
  sysEvent('init', { cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default' });
  say(`R196-NOTIFY-REPLY ${t.taskId}`);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'R196-NOTIFY', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  jl(f('rounds.jsonl'), { ev: 'end', n: turnNo, text: body, notify: true, why: 'result' });
  busy = false;
}
function completeTask(t) {
  t.status = 'completed';
  sysEvent('task_updated', { task_id: t.taskId, patch: { status: 'completed' } });
  sysEvent('task_notification', { task_id: t.taskId, tool_use_id: t.toolId, status: 'completed', output_file: t.outFile, summary: `Background command "${t.description}" completed (exit code 0)` });
  sysEvent('background_tasks_changed', { tasks: runningBgList() });
  chain(() => notifyTurn(t));
}

if (oneShot) { say(`R196-FINAL one-shot ${oneShotArg}`); out({ type: 'result', subtype: 'success', is_error: false, result: 'R196-FINAL', duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: USAGE }); process.exit(0); }

setInterval(() => {
  if (fs.existsSync(f('kill'))) process.exit(0);
  if (fs.existsSync(f('taskdone'))) { rmQuiet(f('taskdone')); for (const t of tasks.values()) if (t.status === 'running') completeTask(t); }
  if (stdinClosed && !busy && ![...tasks.values()].some((t) => t.status === 'running')) process.exit(0);
}, 100);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    const sub = msg.request && msg.request.subtype;
    if (sub === 'background_tasks') { handleBackground(msg); return; }
    if (sub === 'interrupt') { handleInterrupt(msg); return; }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  jl(path.join(CTL, 'received.jsonl'), { pid: process.pid, sid, text: textOf(c), images: Array.isArray(c) ? c.filter((b) => b && b.type === 'image').length : 0 });
  if (busy) { injected.push(c); return; }
  chain(() => userTurn(c));
});
rl.on('close', () => { stdinClosed = true; });
