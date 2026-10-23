#!/usr/bin/env node
// r151t 假命令行(只属于本套件,完全离线,不接任何模型)。模拟常驻进程模式下的 claude:stream-json 读写、一个"回合队列"。
// 控制:<CTL>/scripts/<名字>.json 是回合脚本;用户消息(含引导)的正文里带 "T151:<名字>" 就按那份脚本演,没有就默认只回一句。
// 脚本 = 步骤数组,或 { steps, post, follow, completedInPost, followNoResult, gapMs }:
//   steps   回合内步骤,演完吐 result(subtype success);post  result 之后的步骤;follow  post 之后"自己续跑"的步骤(不收用户消息),
//   followNoResult:true 时续跑不吐 result(造"续跑一句后静默");completedInPost:true 时 completed 不在 result 后立刻吐,由 post 里的 {completed:true} 吐;
//   gapMs  一个回合 result 之后另起下一回合(乙)前的间隔,默认 120。
// 步骤:{say} 主 agent 正文 · {sub:{parent,say}} 子代理消息(parent_tool_use_id 非空) · {toolUse:{id,name,input}} 主 agent 的工具调用(派子代理用 name:"Agent"/"Task")
//   · {sleep:毫秒} · {waitFile:名} 等 <CTL>/<名> 出现(最多 60 秒) · {mergeSteer:{say?,timeoutMs?}} 等队列里有带 uuid 的引导,吐 started 并入本回合(甲)
//   · {completed:true} 对本回合并入的引导(乙:引导本身)吐 completed · {info:"tool_use_summary"|"auth_status"|"rate_limit_event"|"unknown"|"system"} · {emit:{…}} 原样吐一条。
// 带 uuid 的用户消息:收到即吐 command_lifecycle queued;被并入(甲)时吐 started、本回合 result 后吐 completed;没被并入(乙)就在当前回合 result 后另起一回合:
//   started → 脚本 → result → completed。不带 uuid 的是普通回合:system init → 脚本 → result。
// 记录(<CTL> 下,一行一条 JSON,带 t(毫秒时间戳)/pid/sid):spawn.jsonl(被拉起)、stdin.jsonl(从标准输入收到的每一行原文)、emit.jsonl(吐出的每个事件摘要)、turns.jsonl。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-cli');
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

const MODEL = 'r151t-chat';
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
const transcript = (line) => {
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(path.join(PROJ, `${sid}.jsonl`), `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const tbase = () => ({ isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd: process.cwd(), sessionId: sid, version: '2.1.296', gitBranch: '', timestamp: new Date().toISOString() });

// 出站:先记 emit.jsonl(时间戳早于对端能收到的时刻),再写标准输出
function summarize(o) {
  const s = { ev: o.type, sub: o.subtype || o.state || null, parent: o.parent_tool_use_id === undefined ? undefined : o.parent_tool_use_id };
  if (o.type === 'command_lifecycle') s.cu = o.command_uuid;
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    const tx = o.message.content.find((b) => b && b.type === 'text');
    if (tx) s.text = tx.text;
    const tu = o.message.content.find((b) => b && b.type === 'tool_use');
    if (tu) { s.toolUse = tu.name; s.toolUseId = tu.id; }
  }
  return s;
}
const out = (o) => { logTo('emit.jsonl', summarize(o)); process.stdout.write(`${JSON.stringify(o)}\n`); };
function assistantMsg(content, parent = null) {
  const message = { id: `msg_r151t_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL, content, stop_reason: 'end_turn', usage };
  const uuid = newId();
  out({ type: 'assistant', session_id: sid, uuid, parent_tool_use_id: parent, message });
  if (!parent) transcript({ ...tbase(), type: 'assistant', uuid, parentUuid: null, message });
}
const say = (text, parent = null) => assistantMsg([{ type: 'text', text }], parent);
const toolUse = (t) => assistantMsg([{ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} }], null);
const lifecycle = (state, commandUuid) => out({ type: 'command_lifecycle', command_uuid: commandUuid, state, uuid: newId(), session_id: sid });
const resultEv = (text = 'T151-FINAL') => out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: newId(), result: text, duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage });
const initEv = () => out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: MODEL, tools: ['Bash', 'Read', 'Edit'], mcp_servers: [], permissionMode: mode, uuid: newId() });
const INFO = {
  tool_use_summary: () => ({ type: 'tool_use_summary', summary: 'T151 工具调用摘要', preceding_tool_use_ids: [], uuid: newId(), session_id: sid }),
  auth_status: () => ({ type: 'auth_status', isAuthenticating: false, output: [], uuid: newId(), session_id: sid }),
  rate_limit_event: () => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: newId(), session_id: sid }),
  unknown: () => ({ type: 'x_unknown_event', note: 'T151 未知类型事件', uuid: newId(), session_id: sid }),
  system: () => ({ type: 'system', subtype: 'status', status: null, uuid: newId(), session_id: sid }),
};

// 非交互调用(如标题生成):回一句就退出
const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (!interactive) {
  if (printArg !== undefined) {
    out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: MODEL, tools: [], mcp_servers: [], permissionMode: mode, uuid: newId() });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: newId(), result: 'T151 标题', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage });
  }
  process.exit(0);
}

function loadScript(text) {
  const m = /T151:([A-Za-z0-9_.-]+)/.exec(String(text));
  let def = null;
  if (m) { try { def = JSON.parse(fs.readFileSync(path.join(CTL, 'scripts', `${m[1]}.json`), 'utf8')); } catch { def = null; } }
  if (!def) def = [{ say: `T151-REPLY ${String(text).slice(0, 60)}` }];
  return Array.isArray(def) ? { steps: def } : def;
}

const queue = [];   // 收到、还没处理的用户消息 { text, uuid|null, steer }

async function play(steps, ctx) {
  for (const s of steps || []) {
    if (typeof s.say === 'string') say(s.say);
    else if (s.sub) say(s.sub.say, s.sub.parent);
    else if (s.toolUse) toolUse(s.toolUse);
    else if (s.sleep) await sleep(Number(s.sleep) || 0);
    else if (s.waitFile) { const t0 = Date.now(); while (!fs.existsSync(path.join(CTL, s.waitFile)) && Date.now() - t0 < 60_000) await sleep(40); }
    else if (s.mergeSteer) {
      const t0 = Date.now();
      const lim = Number(s.mergeSteer.timeoutMs) || 30_000;
      for (;;) {
        const i = queue.findIndex((q) => q.steer);
        if (i >= 0) {
          const [st] = queue.splice(i, 1);
          lifecycle('started', st.uuid);
          ctx.merged.push(st);
          if (s.mergeSteer.say) say(s.mergeSteer.say);
          break;
        }
        if (Date.now() - t0 > lim) { logTo('warn.jsonl', { what: 'mergeSteer 等不到引导', lim }); break; }
        await sleep(30);
      }
    } else if (s.completed) ctx.doneUuids.forEach((u) => lifecycle('completed', u));
    else if (s.info) out(INFO[s.info]());
    else if (s.emit) out({ session_id: sid, uuid: newId(), ...s.emit });
  }
}

let turnNo = 0;
async function runTurn(m) {
  turnNo += 1;
  const script = loadScript(m.text);
  const ctx = { merged: [], doneUuids: [] };
  logTo('turns.jsonl', { turn: turnNo, steer: m.steer, uuid: m.uuid, text: String(m.text).slice(0, 200) });
  if (m.steer) lifecycle('started', m.uuid);
  else {
    transcript({ type: 'summary', summary: String(m.text).slice(0, 40) || '新会话', leafUuid: newId() });
    transcript({ ...tbase(), type: 'user', uuid: newId(), parentUuid: null, message: { role: 'user', content: m.text } });
    initEv();
  }
  await play(script.steps, ctx);
  resultEv();
  ctx.doneUuids = [...(m.steer ? [m.uuid] : []), ...ctx.merged.map((x) => x.uuid)];
  if (!script.completedInPost) ctx.doneUuids.forEach((u) => lifecycle('completed', u));
  await play(script.post, ctx);
  if (Array.isArray(script.follow) && !queue.length) {
    await play(script.follow, ctx);
    if (!script.followNoResult) resultEv('T151-FOLLOW-FINAL');
  }
  if (queue.length) await sleep(Number.isFinite(Number(script.gapMs)) ? Number(script.gapMs) : 120);
}

let running = false;
async function pump() {
  if (running) return;
  running = true;
  try { while (queue.length) await runTurn(queue.shift()); } finally { running = false; }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  logTo('stdin.jsonl', { line: line.slice(0, 4000) });
  let msg = null;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    const req = msg.request || {};
    if (req.subtype === 'set_permission_mode' && typeof req.mode === 'string') mode = req.mode;
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : '');
  const u = typeof msg.uuid === 'string' && msg.uuid ? msg.uuid : null;
  if (u) lifecycle('queued', u);
  queue.push({ text, uuid: u, steer: Boolean(u) });
  void pump();
});
rl.on('close', () => process.exit(0));
