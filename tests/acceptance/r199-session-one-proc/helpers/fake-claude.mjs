#!/usr/bin/env node
// r199 假命令行(只属于本套件,完全离线,不接任何模型)。模拟常驻进程模式下的 claude:stream-json 读写。
// 记录(<CTL> 下,一行一条 JSON,带 t / pid / sid):spawn.jsonl(被拉起)、turns.jsonl(用户回合开始)、turn-ends.jsonl(用户回合结束)、
//   auto.jsonl(命令行自己续跑的那一段 start / end)、inputs.jsonl(从标准输入收到的每条用户消息)、exits.jsonl(退出推迟 / 退出)。
// 回合:消息里带 "R199S:<名字>" 时照 <CTL>/scripts/<名字>.json(步骤数组)演;没有就默认回 "R199-REPLY <前 60 字>"。
//   消息以 "/compact" 开头时:吐 status=compacting、system/compact_boundary,然后 result(不回助手正文)。
// 步骤:{say} {sleep:毫秒} {waitFile:名} {emit:{…}} {bgStart:{taskId,description}}(吐工具调用 + 结果 + task_started,之后永不吐结束)
//   sleep / waitFile 收到 interrupt 控制请求就提前结束,回合以 "[Request interrupted by user]" 收尾。
// 续跑:<CTL>/r199/auto/<会话id> = {pid?, taskId, say?, sleepMs?, toolUseId?}:本进程(pid 不给 = 谁先遇到谁发)吐一条后台任务终态通知
//   (system/task_notification),随后像"命令行自己接着回复"那样吐一条助手正文、停 sleepMs、吐 result;不需要用户消息。一次性。
// 挂着:<CTL>/r199/hold/<pid> = {signals?:true}:stdin 关闭后不退出,直到 <CTL>/r199/release/<pid> 出现(最多 90 秒);signals:true 时无视终止信号。
//   不管有没有 hold,stdin 关闭时手上还有回合 / 续跑,先等它结束再退(真命令行就是这样)。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const R = path.join(CTL, 'r199');
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const p = argv.find((a) => a.startsWith(`${n}=`));
  return p ? p.slice(n.length + 1) : undefined;
};
const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const interactive = argv.includes('--input-format');
let mode = argOf('--permission-mode') || 'default';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomUUID();
const logTo = (file, o) => {
  try { fs.mkdirSync(CTL, { recursive: true }); fs.appendFileSync(path.join(CTL, file), `${JSON.stringify({ t: Date.now(), pid: process.pid, sid, ...o })}\n`); } catch { /* 忽略 */ }
};
logTo('spawn.jsonl', { argv, cwd: process.cwd(), interactive });

if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }
if (['mcp', 'plugin', 'config', 'doctor', 'update', 'auth', 'setup-token'].includes(argv[0])) process.exit(0);

const MODEL = 'r199-chat';
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
const transcript = (line) => { try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(path.join(PROJ, `${sid}.jsonl`), `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ } };
const tbase = () => ({ isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd: process.cwd(), sessionId: sid, version: '2.1.296', gitBranch: '', timestamp: new Date().toISOString() });
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const say = (text) => {
  const message = { id: `msg_r199_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage };
  const uuid = newId();
  out({ type: 'assistant', session_id: sid, uuid, parent_tool_use_id: null, message });
  transcript({ ...tbase(), type: 'assistant', uuid, parentUuid: null, message });
};
const resultEv = (text = 'R199-FINAL') => out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: newId(), result: text, duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage });
const initEv = () => out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: MODEL, tools: ['Bash', 'Read', 'Edit'], mcp_servers: [], permissionMode: mode, uuid: newId() });
const ctlJson = (kind, key) => { try { return JSON.parse(fs.readFileSync(path.join(R, kind, String(key)), 'utf8')); } catch { return null; } };

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (!interactive) {
  // 非交互调用(如标题生成):回一句就退出
  if (printArg !== undefined) {
    out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: MODEL, tools: [], mcp_servers: [], permissionMode: mode, uuid: newId() });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: newId(), result: 'R199 标题', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage });
  }
  process.exit(0);
}

let interrupted = false;
/** 可被 interrupt 提前结束的等待。 */
async function wait(ms) { const t0 = Date.now(); while (!interrupted && Date.now() - t0 < ms) await sleep(Math.min(50, ms)); }

async function play(steps) {
  for (const s of steps) {
    if (interrupted) break;
    if (typeof s.say === 'string') say(s.say);
    else if (s.sleep) await wait(Number(s.sleep) || 0);
    else if (s.waitFile) { const t0 = Date.now(); while (!interrupted && !fs.existsSync(path.join(CTL, s.waitFile)) && Date.now() - t0 < 120_000) await sleep(50); }
    else if (s.emit) out({ session_id: sid, uuid: newId(), ...s.emit });
    else if (s.bgStart) {
      const b = s.bgStart;
      const toolUseId = b.toolUseId || `toolu_r199_${crypto.randomBytes(4).toString('hex')}`;
      const taskId = b.taskId;
      const desc = b.description || 'sleep 120';
      const message = { id: `msg_r199_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: desc, description: desc, run_in_background: true } }], stop_reason: 'tool_use', usage };
      out({ type: 'assistant', session_id: sid, uuid: newId(), parent_tool_use_id: null, message });
      out({ type: 'user', session_id: sid, uuid: newId(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `Command running in background with ID: ${taskId}`, is_error: false }] } });
      out({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: desc, task_type: 'local_bash', is_backgrounded: true, uuid: newId(), session_id: sid });
    }
  }
}

const queue = [];
let running = false;
let autoRunning = false;

async function runTurn(text) {
  running = true; interrupted = false;
  const isCompact = /^\s*\/compact\b/.test(text);
  transcript({ type: 'summary', summary: String(text).slice(0, 40) || '新会话', leafUuid: newId() });
  transcript({ ...tbase(), type: 'user', uuid: newId(), parentUuid: null, message: { role: 'user', content: text } });
  initEv();
  logTo('turns.jsonl', { mode, text: String(text).slice(0, 300) });
  let steps = null;
  const m = /R199S:([A-Za-z0-9_.-]+)/.exec(text);
  if (m) { try { steps = JSON.parse(fs.readFileSync(path.join(CTL, 'scripts', `${m[1]}.json`), 'utf8')); } catch { steps = null; } }
  if (isCompact) steps = [{ emit: { type: 'system', subtype: 'status', status: 'compacting' } }, { emit: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 1234 } } }];
  if (!steps) steps = [{ say: `R199-REPLY ${String(text).slice(0, 60)}` }];
  await play(steps);
  if (interrupted) say('[Request interrupted by user]');
  resultEv();
  logTo('turn-ends.jsonl', { text: String(text).slice(0, 300), interrupted });
  interrupted = false; running = false;
}

async function pump() {
  if (running || autoRunning) return;
  while (queue.length && !autoRunning) await runTurn(queue.shift());
}

async function runAuto(c) {
  autoRunning = true; interrupted = false;
  logTo('auto.jsonl', { ev: 'start', taskId: c.taskId });
  out({ type: 'system', subtype: 'task_notification', task_id: c.taskId, tool_use_id: c.toolUseId || undefined, status: 'completed', summary: 'Background task completed', output_file: `/tmp/r199-${c.taskId}.output`, uuid: newId(), session_id: sid });
  say(c.say || 'R199 后台命令结束,命令行自己接着回复');
  await wait(Number(c.sleepMs) || 0);
  if (interrupted) say('[Request interrupted by user]');
  resultEv('R199-AUTO-FINAL');
  logTo('auto.jsonl', { ev: 'end', taskId: c.taskId, interrupted });
  interrupted = false; autoRunning = false;
  void pump();
}
const autoPoll = setInterval(() => {
  if (autoRunning) return;
  const f = path.join(R, 'auto', sid);
  const c = ctlJson('auto', sid);
  if (!c || (c.pid !== undefined && c.pid !== null && c.pid !== process.pid)) return;
  try { fs.unlinkSync(f); } catch { return; }
  void runAuto(c);
}, 100);
autoPoll.unref();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg = null;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    const req = msg.request || {};
    logTo('control.jsonl', { subtype: req.subtype });
    if (req.subtype === 'set_permission_mode' && typeof req.mode === 'string') mode = req.mode;
    if (req.subtype === 'interrupt') interrupted = true;
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : '');
  logTo('inputs.jsonl', { content: text.slice(0, 400) });
  queue.push(text);
  void pump();
});

const releaseFile = () => path.join(R, 'release', String(process.pid));
const held = () => !fs.existsSync(releaseFile()) && Boolean(ctlJson('hold', process.pid));
let leaving = false;
rl.on('close', () => {
  if (leaving) return;
  leaving = true;
  const t0 = Date.now();
  logTo('exits.jsonl', { ev: 'stdin-closed', running, autoRunning, held: held() });
  const tick = () => {
    const mustWait = running || autoRunning || queue.length > 0 || held();
    if (!mustWait || Date.now() - t0 > 90_000) { logTo('exits.jsonl', { ev: 'exit', waitedMs: Date.now() - t0 }); process.exit(0); }
    setTimeout(tick, 50);
  };
  tick();
});
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    const h = held() ? ctlJson('hold', process.pid) : null;
    if (h && h.signals) { logTo('exits.jsonl', { ev: 'signal-ignored', sig }); return; }
    logTo('exits.jsonl', { ev: 'signal', sig });
    process.exit(0);
  });
}
