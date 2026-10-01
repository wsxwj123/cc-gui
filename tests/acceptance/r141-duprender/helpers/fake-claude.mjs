#!/usr/bin/env node
// r140 假 claude CLI(由 r118 的桩件复制而来,**r118 原目录只读**)。
// 原有行为一字不动,只加三样 r140 需要的"按会话"控制能力(契约 §2 要求):
//   1) 按会话的慢启动/闸门:<CTL>/<sid>.slow-ms 覆盖全局 slow-ms;<CTL>/<sid>.go 可提前放行。
//      —— "A 先不产出(憋住)、B 保持连接中" 必须能分别控制,全局 slow-ms 做不到。
//   2) 按会话的用量注入:<CTL>/<sid>.usage(JSON)覆盖上报的 token 用量(探超窗横幅)。
//   3) 按会话的错误注入:<CTL>/<sid>.error(文本)让本回合以 error result 收场(探错误提示)。
// 没放这些控制文件时,与 r118 桩件逐字等价。
//
// 回合切三段:init → assistant(第 1 块)【等 <sid>.chunk】→ assistant(第 2 块)【等 <sid>.done】→ 收尾 + result
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { encodeProjectDir, live, dup, DUP_PROMPT_MARK } from './fixtures.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }
// 子命令(mcp list / plugin list):不是回合,立刻空手退出,别挂在 stdin 上
if (['mcp', 'plugin', 'config', 'doctor', 'update'].includes(argv[0])) process.exit(0);

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
// 实测宿主两种写法都会用:`--resume <sid>` 与 `--resume=<sid>`
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
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const base = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '', timestamp: stamp() });
const append = (line) => { try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ } };
const phaseFile = (suffix) => path.join(CTL, `${sid}.${suffix}`);
const readRaw = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readNum = (p) => { const t = readRaw(p); return t === null ? null : (Number(t.trim()) || 0); };
// 慢启动开关:控制文件 <CTL>/slow-ms 里写着毫秒数(测试在发消息前放/删)。
// 真实用户机器上挂了很多 MCP,会话进程要十几秒才吐第一条事件 —— 这段"已收到请求但界面上什么都还没吐"
// 的窗口在秒开的桩上不存在,靠这个开关造出来。只作用于交互式回合(不含标题生成那类 -p 调用)。
// r140:先看 <sid>.slow-ms(按会话),没有再退回全局 slow-ms。
const slowMsFor = (s) => {
  const per = readNum(path.join(CTL, `${s}.slow-ms`));
  return per === null ? (readNum(path.join(CTL, 'slow-ms')) || 0) : per;
};
// r140:闸门。慢启动毫秒数没到之前,只要出现 <sid>.go 就立刻放行(可以无限期憋住再精确放行)。
const waitGate = async (s) => {
  const limit = slowMsFor(s);
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(path.join(CTL, `${s}.go`))) return;
    if (Date.now() - t0 >= limit) return;
    await sleep(60);
  }
};
const usageNow = () => { const raw = readRaw(path.join(CTL, `${sid}.usage`)); if (!raw) return USAGE; try { return { ...USAGE, ...JSON.parse(raw) }; } catch { return USAGE; } };
const writePhase = (suffix, value) => { try { fs.mkdirSync(CTL, { recursive: true }); fs.writeFileSync(phaseFile(suffix), value || String(Date.now())); } catch { /* 忽略 */ } };
const waitFor = async (suffix) => { while (!fs.existsSync(phaseFile(suffix))) await sleep(60); };
try {
  fs.mkdirSync(CTL, { recursive: true });
  fs.appendFileSync(path.join(CTL, 'argv.log'), `${stamp()} pid=${process.pid} argv=${JSON.stringify(argv)}\n`);
  fs.writeFileSync(path.join(CTL, `${sid}.started`), `${stamp()} pid=${process.pid}`);
} catch { /* 忽略 */ }

// ===================== r141 追加:落盘闸门 / 空回合 / 吸收 =====================
// r141-duprender 验收的夹具约束(PLAN-r141-duprender.md §5.0)在这里落地:
//   C1  writeTranscript() 绝不 await 阻塞回合主流程 —— gatedAppend 是同步推队列,放行由
//       独立 setInterval 完成;回合该发的 SSE(assistant/result)一行不晚发。
//   C2  user 记录是否同受闸门:显式表态 —— 【默认不同闸】(user 记录即时写盘,复刻
//       "CLI 已把用户消息写进 jsonl、回复还没落盘"的真实窗口);要单独闸住某一轮时才开
//       <sid>.hold-user(放行文件 <sid>.land-user)。选择理由写在 r141-duprender-invariants.spec.mjs。
//   C3  记录 timestamp 按【消息产生时刻】戳 —— 被闸住的记录在产生那一刻就用 base() 构造好
//       (timestamp 此时已定),放行时原样写盘,绝不按写盘时刻重新戳。
// 另外两样 r141 专用控制:
//   · 空回合:prompt 里含 R141QUIET ⇒ 只发 init + result,不写 user/assistant 记录(抢 token 用);
//   · 吸收开关:<sid>.absorb 存在时,回合在飞期间收到的 stdin user 行只当被吸收(不落盘、不另起一轮)。
const relCtl = (s) => path.join(CTL, s);
const ctlExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const GATE_PAIRS = [['hold', 'land'], ['hold-user', 'land-user']];
const releaseOf = (gate) => (GATE_PAIRS.find(([g]) => g === gate) || [gate, `${gate}.land`])[1];
const gateQueues = new Map();
let gateTimer = null;
const flushGate = (gate) => {
  const q = gateQueues.get(gate);
  if (!q || !q.length) { gateQueues.delete(gate); return; }
  while (q.length) append(q.shift());
  gateQueues.delete(gate);
};
const gateTick = () => {
  let alive = false;
  for (const gate of [...gateQueues.keys()]) {
    if (ctlExists(relCtl(`${sid}.${releaseOf(gate)}`))) flushGate(gate); else alive = true;
  }
  if (!alive && gateTimer) { clearInterval(gateTimer); gateTimer = null; }
};
/** 带闸门的落盘:门没开就排队(同步返回,不 await),开了就立刻写。 */
const gatedAppend = (gate, line) => {
  if (!ctlExists(relCtl(`${sid}.${gate}`))) { append(line); return; }
  if (ctlExists(relCtl(`${sid}.${releaseOf(gate)}`))) { append(line); return; }
  if (!gateQueues.has(gate)) gateQueues.set(gate, []);
  gateQueues.get(gate).push(line);   // line 的 timestamp 是【产生时刻】,放行时不再重戳(C3)
  if (!gateTimer) { gateTimer = setInterval(gateTick, 40); if (gateTimer.unref) gateTimer.unref(); }
};

const assistantMsg = (text) => ({ id: `msg_r118_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL,
  content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: usageNow() });
/**
 * SSE 侧照旧(闸门绝不碰它),jsonl 侧走闸门。
 * r141-P2 追加的两样控制(默认关闭 ⇒ 与 r118 行为逐字等价):
 *   · <sid>.sameuuid —— 同一条消息在【流侧事件】与【jsonl 记录】上用【同一个 uuid】
 *     (复刻真 CLI 实测形态,见 TEST-PLAN §4.9 的 P-2 结论);不开时两侧各一个随机 uuid,
 *     用来做"判据① 不能成立"的对照组。
 *   · <sid>.trimhist —— jsonl 记录只写正文前 60%(历史那份更短)⇒ 判据③ 的覆盖下限
 *     (`len(hist) >= len(local)`)必然不成立,用来构造"只有判据① 能解释隐藏"的场景。
 * 每条流侧 assistant 事件都记进 <sid>.stream.jsonl(供 spec 逐条对账)。
 */
const say = (text) => {
  const msg = assistantMsg(text);
  const one = ctlExists(relCtl(`${sid}.sameuuid`)) ? crypto.randomUUID() : null;
  const streamUuid = one || crypto.randomUUID();
  const fileUuid = one || crypto.randomUUID();
  out({ type: 'assistant', session_id: sid, uuid: streamUuid, parent_tool_use_id: null, message: msg });
  const short = ctlExists(relCtl(`${sid}.trimhist`));
  const fileMsg = short
    ? { ...msg, content: [{ type: 'text', text: text.slice(0, Math.max(8, Math.floor(text.length * 0.6))) }] }
    : msg;
  gatedAppend('hold', { ...base(), type: 'assistant', uuid: fileUuid, parentUuid: null, message: fileMsg });
  try {
    fs.appendFileSync(relCtl(`${sid}.stream.jsonl`),
      `${JSON.stringify({ at: stamp(), uuid: streamUuid, fileUuid, messageId: msg.id, text, fileText: fileMsg.content[0].text })}\n`);
  } catch { /* 忽略 */ }
};

const QUIET_MARK = 'R141QUIET';
/** 空回合:不出任何 assistant 文本、不写任何 jsonl 记录,等 <sid>.land 放行后直接 result。
 *  用途见 spec:它的收尾走 App.jsx `!producedReply` 分支(保留全部 turn 类本地条目 + 拉历史)。 */
async function quietRound() {
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  writePhase('phase', 'quiet');
  await waitFor('land');
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(),
    result: 'R141-QUIET', duration_ms: 10, num_turns: 0, total_cost_usd: 0, usage: usageNow() });
  writePhase('phase', 'quiet-done');
}

async function round(userText) {
  if (String(userText || '').includes(QUIET_MARK)) { await quietRound(); return; }
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  gatedAppend('hold-user', { ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: userText } });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

  try { fs.unlinkSync(phaseFile('chunk')); fs.unlinkSync(phaseFile('done')); fs.unlinkSync(phaseFile('go')); } catch { /* 本来就没有 */ }
  // r141:prompt 里带 DUP 回合标记 ⇒ 用短块文案(mark 必须落在弱键 80 字窗口内,见 fixtures 注释)。
  const T = String(userText || '').includes(DUP_PROMPT_MARK) ? dup : live;
  say(T.chunk1(sid, userText));
  writePhase('phase', 'chunk1');
  await waitFor('chunk');                       // 切走/切回就发生在这段停住里
  say(T.chunk2(sid));
  writePhase('phase', 'chunk2');
  await waitFor('done');
  say(T.final(sid));
  writePhase('phase', 'final');
  // r140:错误注入 —— 有 <sid>.error 就以 error result 收场(文本原样带给宿主,用来探"错误提示挂哪了")
  const errText = readRaw(path.join(CTL, `${sid}.error`));
  if (errText && errText.trim()) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(),
      result: errText.trim(), duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: usageNow() });
    writePhase('phase', 'error');
    return;
  }
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(),
    result: 'R118-FINAL', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: usageNow() });
  writePhase('phase', 'final');
}

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) { await round(printArg); process.exit(0); }

// stdin 不能挡在回合里(控制请求要随时能答),用"回调 + 队列"
const queue = [];
let running = false;
const pump = async () => { if (running) return; running = true; while (queue.length) { await waitGate(sid); await round(queue.shift()); } running = false; };
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }); return; }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  const txt = typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : '');
  // r141 吸收开关(§5.0 第 2 条):回合在飞时收到的 stdin user 行只当被吸收 ——
  // 不写 transcript 记录、不另起一整轮(真机形态 = queue-operation absorbed_mid_turn,取证 §2.2)。
  if (running && ctlExists(relCtl(`${sid}.absorb`))) {
    try { fs.appendFileSync(relCtl(`${sid}.absorbed`), `${stamp()} ${String(txt).slice(0, 40)}\n`); } catch { /* 忽略 */ }
    return;
  }
  queue.push(txt);
  void pump();
});
rl.on('close', () => process.exit(0));
