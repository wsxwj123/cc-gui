#!/usr/bin/env node
// r198 假命令行:按真实命令行 2.1.327 的 stream-json 行为模仿"前台 Bash 转后台"(接口文件第四节)。
// 所有控制文件放在 <CTL>/ 下,<sid> = 会话编号:
//   <sid>.scenario.json     下一个由用户消息起的回合的剧本(读到就删):{ steps: [...] }
//        步骤:{t:'text', text}
//              {t:'bash-done', toolId, command, result}                         一条立刻结束的 Bash
//              {t:'bash-modelbg', toolId, taskId, command, description}         模型用 run_in_background 起的 Bash(立刻在后台)
//              {t:'bash-fg', toolId, taskId, command, description, timeout?, registerMs?(默认 3000), bgLimit?(默认 '30m')}
//                                                                               前台 Bash:约 3 秒后登记(task_started);被转走前一直"在跑"
//              {t:'gate', name}                                                 等 <sid>.gate-<name> 出现(或被停止)才往下走
//        剧本走完后:先回复回合中途并入的消息(R198-STEER-REPLY <原文>),再出本回合的最终正文(R198-REPLY <本回合用户原文>),最后 result。
//   <sid>.bg-mode           转后台控制请求的应答方式:空/ok = 正常;reject:<原话> = 回 error 应答;silent = 不回执
//   <sid>.interrupt-delay-ms  收到停止(interrupt)后再拖这么久才真正收尾(默认 0)
//   <sid>.taskdone          出现就让这个会话里所有在后台跑的任务"跑完"(读到就删):发完成通知,并自动起一轮通知回合
//   <sid>.kill              出现就让本进程退出(用例收尾用)
//   <sid>.gate-<name>       放行 gate 步骤
// 假命令行写出的观察文件:
//   <sid>.started           pid
//   <sid>.control.jsonl     收到 / 发生的事件流水(每行一个 JSON,含毫秒时间戳 ts)
//   <sid>.task-<taskId>     任务状态:foreground | running(已在后台) | completed | stopped | interrupted
// 命令"跑很久"一律用定时器/文件模拟,不真起长 sleep。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { encodeProjectDir } from './fixtures.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('2.1.327 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }
if (['mcp', 'plugin', 'config', 'doctor', 'update'].includes(argv[0])) process.exit(0);

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const prefixed = argv.find((a) => a.startsWith(`${n}=`));
  return prefixed ? prefixed.slice(n.length + 1) : undefined;
};
const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const cwd = process.cwd();
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', encodeProjectDir(cwd));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const out = (o) => process.stdout.write(`${JSON.stringify({ session_id: sid, uuid: crypto.randomUUID(), ...o })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const base = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.327', gitBranch: '', timestamp: stamp() });
const append = (line) => { try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ } };
const f = (suffix) => path.join(CTL, `${sid}.${suffix}`);
const rmQuiet = (p) => { try { fs.unlinkSync(p); } catch { /* 本来就没有 */ } };
const readRaw = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const clog = (o) => { try { fs.mkdirSync(CTL, { recursive: true }); fs.appendFileSync(f('control.jsonl'), `${JSON.stringify({ ts: Date.now(), ...o })}\n`); } catch { /* 忽略 */ } };
const writeTask = (taskId, status) => { try { fs.writeFileSync(f(`task-${taskId}`), status); } catch { /* 忽略 */ } };

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
const oneShot = Boolean(printArg) && !argv.includes('--input-format');

try {
  fs.mkdirSync(CTL, { recursive: true });
  fs.appendFileSync(path.join(CTL, 'argv.log'), `${stamp()} pid=${process.pid} argv=${JSON.stringify(argv)}\n`);
  if (!oneShot) fs.writeFileSync(f('started'), `${stamp()} pid=${process.pid}`);
} catch { /* 忽略 */ }

// ---------------------------------------------------------------- 状态
const tasks = new Map();   // taskId → { taskId, toolId, description, command, status, outFile, bgLimit }
const fgs = new Map();     // toolId → fg 条目(本回合里的前台命令)
const injected = [];       // 回合进行中经标准输入收到的用户消息(并入)
let busy = false;
let turnNo = 0;
let intr = null;           // { flag, p, resolve }:当前回合的"被停止"信号
let stdinClosed = false;
let tail = Promise.resolve();
const chain = (fn) => { tail = tail.then(fn).catch((e) => { process.stderr.write(`${String((e && e.stack) || e)}\n`); }); return tail; };

// ---------------------------------------------------------------- 事件构造
const assistantBlocks = (blocks, stop) => {
  const id = `msg_r198_${crypto.randomBytes(4).toString('hex')}`;
  const msg = { id, type: 'message', role: 'assistant', model: MODEL, content: blocks, stop_reason: stop, usage: USAGE };
  out({ type: 'assistant', parent_tool_use_id: null, message: msg });
  append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, requestId: `req_${id}`, message: { ...msg, stop_sequence: null } });
};
const say = (text) => assistantBlocks([{ type: 'text', text }], 'end_turn');
const toolUse = (toolId, input) => assistantBlocks([{ type: 'tool_use', id: toolId, name: 'Bash', input }], 'tool_use');
const toolResult = (toolId, content, isError, toolUseResult) => {
  out({ type: 'user', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError, content }] },
    ...(toolUseResult ? { tool_use_result: toolUseResult } : {}) });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError, content }] },
    ...(toolUseResult ? { toolUseResult } : {}) });
};
const sysEvent = (subtype, extra) => out({ type: 'system', subtype, ...extra });
const runningBgList = () => [...tasks.values()].filter((t) => t.status === 'running')
  .map((t) => ({ task_id: t.taskId, task_type: 'local_bash', description: t.description }));
const respond = (requestId, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
const respondError = (requestId, error) => out({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
const outFileOf = (taskId) => path.join(CTL, 'tasks', `${sid}-${taskId}.output`);
const writeOut = (taskId) => { try { fs.mkdirSync(path.join(CTL, 'tasks'), { recursive: true }); fs.writeFileSync(outFileOf(taskId), `R198-OUT-${taskId}\n`); } catch { /* 忽略 */ } };

// ---------------------------------------------------------------- 转后台
function moveTask(fg) {
  if (!fg.registered || fg.moved || fg.done) return false;
  fg.moved = true;
  const t = tasks.get(fg.taskId);
  t.status = 'running';
  writeTask(fg.taskId, 'running');
  sysEvent('background_tasks_changed', { tasks: runningBgList() });
  sysEvent('task_updated', { task_id: fg.taskId, patch: { is_backgrounded: true } });
  clog({ ev: 'moved', toolId: fg.toolId, taskId: fg.taskId });
  // 约 1 秒后顶层工具结果,这一轮接着走
  setTimeout(() => {
    const content = `Command was manually backgrounded by user with ID: ${fg.taskId}. Output is being written to: ${t.outFile} If it is still running after ${fg.bgLimit} in the background, it will be stopped and you will be notified.`;
    toolResult(fg.toolId, content, false, { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: fg.taskId, backgroundedByUser: true });
    fg.resolveMoved();
  }, 1000);
  return true;
}

function handleBackground(msg) {
  const rid = msg.request_id;
  const tid = msg.request && msg.request.tool_use_id;
  const mode = (readRaw(f('bg-mode')) || 'ok').trim();
  const afterInterrupt = Boolean(intr && intr.requested);
  if (mode === 'silent') { clog({ ev: 'bg-request', toolUseId: tid || null, result: 'silent', afterInterrupt }); return; }
  if (mode.startsWith('reject:')) {
    clog({ ev: 'bg-request', toolUseId: tid || null, result: 'rejected', afterInterrupt });
    respondError(rid, mode.slice('reject:'.length));
    return;
  }
  if (tid) {
    const fg = fgs.get(tid);
    const ok = Boolean(fg) && moveTask(fg);
    clog({ ev: 'bg-request', toolUseId: tid, result: ok ? 'moved' : 'not-foreground', afterInterrupt });
    respond(rid, { backgrounded: ok });
    return;
  }
  let n = 0;
  for (const fg of fgs.values()) if (moveTask(fg)) n += 1;
  clog({ ev: 'bg-request', toolUseId: null, result: `all-moved:${n}`, afterInterrupt });
  respond(rid, {});
}

// ---------------------------------------------------------------- 停止
function handleInterrupt(msg) {
  respond(msg.request_id, {});
  clog({ ev: 'interrupt', busy });
  if (!busy || !intr) return;
  intr.requested = true;
  const delay = Number((readRaw(f('interrupt-delay-ms')) || '0').trim()) || 0;
  setTimeout(() => { intr.flag = true; intr.resolve(); }, delay);
}
process.on('SIGINT', () => handleInterrupt({ request_id: 'sigint' }));

function handleStopTask(msg) {
  const taskId = msg.request && msg.request.task_id;
  clog({ ev: 'stop-task', taskId });
  const t = tasks.get(taskId);
  if (t && t.status === 'running') {
    t.status = 'stopped';
    writeTask(taskId, 'stopped');
    sysEvent('task_updated', { task_id: taskId, patch: { status: 'killed' } });
    sysEvent('task_notification', { task_id: taskId, tool_use_id: t.toolId, status: 'stopped', output_file: t.outFile, summary: `Background command "${t.description}" was stopped` });
    sysEvent('background_tasks_changed', { tasks: runningBgList() });
  }
  respond(msg.request_id, {});
}

// ---------------------------------------------------------------- 回合
const readScenario = () => {
  const raw = readRaw(f('scenario.json'));
  if (raw === null) return { steps: [] };
  rmQuiet(f('scenario.json'));
  try { return JSON.parse(raw); } catch { return { steps: [] }; }
};
const race = (p) => Promise.race([p, intr.p]);

async function runStep(st) {
  if (st.t === 'text') { say(st.text); return; }
  if (st.t === 'gate') {
    for (;;) {
      if (intr.flag || fs.existsSync(f(`gate-${st.name}`))) return;
      await race(sleep(60));
    }
  }
  const input = { command: st.command, description: st.description || '', ...(st.timeout != null ? { timeout: st.timeout } : {}), ...(st.t === 'bash-modelbg' ? { run_in_background: true } : {}) };
  if (st.t === 'bash-done') {
    toolUse(st.toolId, input);
    toolResult(st.toolId, st.result || 'R198-DONE-OUTPUT', false, { stdout: st.result || 'R198-DONE-OUTPUT', stderr: '', interrupted: false, isImage: false, noOutputExpected: false });
    return;
  }
  const t = { taskId: st.taskId, toolId: st.toolId, description: st.description || '', command: st.command, status: 'foreground', outFile: outFileOf(st.taskId), bgLimit: st.bgLimit || '30m' };
  tasks.set(st.taskId, t);
  if (st.t === 'bash-modelbg') {
    toolUse(st.toolId, input);
    t.status = 'running';
    writeTask(st.taskId, 'running');
    writeOut(st.taskId);
    sysEvent('task_started', { task_id: st.taskId, tool_use_id: st.toolId, description: t.description, is_backgrounded: true, task_type: 'local_bash' });
    sysEvent('background_tasks_changed', { tasks: runningBgList() });
    toolResult(st.toolId, `Command running in background with ID: ${st.taskId}. Output is being written to: ${t.outFile}`, false,
      { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: st.taskId });
    return;
  }
  // bash-fg
  const fg = { toolId: st.toolId, taskId: st.taskId, bgLimit: t.bgLimit, registered: false, moved: false, done: false };
  fg.movedP = new Promise((r) => { fg.resolveMoved = r; });
  fgs.set(st.toolId, fg);
  toolUse(st.toolId, input);
  writeTask(st.taskId, 'foreground');
  clog({ ev: 'tool-use', toolId: st.toolId, taskId: st.taskId });
  setTimeout(() => {
    if (fg.done || fg.moved || (intr && intr.flag)) return;
    fg.registered = true;
    writeOut(st.taskId);
    sysEvent('task_started', { task_id: st.taskId, tool_use_id: st.toolId, description: t.description, is_backgrounded: false, task_type: 'local_bash' });
    clog({ ev: 'registered', toolId: st.toolId, taskId: st.taskId });
  }, Number(st.registerMs ?? 3000));
  await race(fg.movedP);
}

/** 被停止时:还在前台的命令随这一轮一起结束;被转走的命令不受影响。 */
function finishInterrupted() {
  for (const fg of fgs.values()) {
    if (fg.moved || fg.done) continue;
    fg.done = true;
    writeTask(fg.taskId, 'interrupted');
    toolResult(fg.toolId, '[Request interrupted by user for tool use]', true, null);
  }
  out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}

async function userTurn(userText) {
  busy = true; turnNo += 1;
  const myTurn = turnNo;
  fgs.clear();
  intr = { flag: false, requested: false, resolve: null, p: null };
  intr.p = new Promise((r) => { intr.resolve = r; });
  clog({ ev: 'turn-start', turn: myTurn, text: userText });
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: userText } });
  sysEvent('init', { cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default' });
  const scen = readScenario();
  for (const st of (scen.steps || [])) {
    if (intr.flag) break;
    await runStep(st);
  }
  if (intr.flag) {
    finishInterrupted(); busy = false;
    // 真实命令行:停止之后,停止期间收到的消息按普通消息各起一轮
    for (const m of injected.splice(0)) chain(() => userTurn(m));
    return;
  }
  // 模型"下一次请求":把回合中途并入的消息一并交给模型,同一轮回复
  while (injected.length) {
    const m = injected.shift();
    clog({ ev: 'steer-reply', turn: myTurn, text: m });
    say(`R198-STEER-REPLY ${m}`);
  }
  say(`R198-REPLY ${userText}`);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'R198-FINAL', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  clog({ ev: 'turn-end', turn: myTurn });
  busy = false;
}

async function notifyTurn(t) {
  busy = true; turnNo += 1;
  intr = { flag: false, requested: false, resolve: null, p: null };
  intr.p = new Promise((r) => { intr.resolve = r; });
  clog({ ev: 'notify-turn', turn: turnNo, taskId: t.taskId });
  const body = `<task-notification>\n<task-id>${t.taskId}</task-id>\n<status>completed</status>\n<summary>Background command "${t.description}" completed (exit code 0)</summary>\n</task-notification>`;
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: body } });
  sysEvent('init', { cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default' });
  say(`R198-NOTIFY-REPLY ${t.taskId}`);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'R198-NOTIFY', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  busy = false;
}

function completeTask(t) {
  t.status = 'completed';
  writeTask(t.taskId, 'completed');
  sysEvent('task_updated', { task_id: t.taskId, patch: { status: 'completed' } });
  sysEvent('task_notification', { task_id: t.taskId, tool_use_id: t.toolId, status: 'completed', output_file: t.outFile, summary: `Background command "${t.description}" completed (exit code 0)` });
  sysEvent('background_tasks_changed', { tasks: runningBgList() });
  clog({ ev: 'task-completed', taskId: t.taskId });
  chain(() => notifyTurn(t));
}

if (oneShot) {
  say(`R198-REPLY ${printArg}`);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'R198-FINAL', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  process.exit(0);
}

setInterval(() => {
  if (fs.existsSync(f('kill'))) process.exit(0);
  if (fs.existsSync(f('taskdone'))) {
    rmQuiet(f('taskdone'));
    for (const t of tasks.values()) if (t.status === 'running') completeTask(t);
  }
  // 标准输入关闭后,要等后台任务跑完、通知那一轮结束才退出
  if (stdinClosed && !busy && ![...tasks.values()].some((t) => t.status === 'running')) process.exit(0);
}, 100);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    const sub = msg.request && msg.request.subtype;
    if (sub === 'background_tasks') { clog({ ev: 'bg-recv', toolUseId: (msg.request && msg.request.tool_use_id) || null }); handleBackground(msg); return; }
    if (sub === 'interrupt') { handleInterrupt(msg); return; }
    if (sub === 'stop_task') { handleStopTask(msg); return; }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : '');
  if (busy) { clog({ ev: 'user-while-busy', text }); injected.push(text); return; }
  chain(() => userTurn(text));
});
rl.on('close', () => { stdinClosed = true; });
