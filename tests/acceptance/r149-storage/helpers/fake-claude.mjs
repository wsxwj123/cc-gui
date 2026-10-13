#!/usr/bin/env node
// r149 假 claude CLI:由 r148-perf 的桩件原样复制而来(**原目录只读**),r149 没有改动任何行为。
// 以下是 r148 原注释:
// r148 假 claude CLI:由 r146-crosstalk 的桩件复制而来(**r146 / r140 / r118 原目录只读**)。原有行为一字不动,
// 只加两段"按会话"的可选片段(没放控制文件时与 r146 桩件逐字等价),都插在第 1 块文字之后:
//   1) <CTL>/<sid>.subagent(JSON:{ deltas, gapMs, burstTail, tail })—— 派一个子代理(Task 工具),子代理的回复
//      以 deltas 条流式增量到达(parent_tool_use_id 指向这次 Task),最后 burstTail 条不留间隔、最后一条的文字是
//      tail,**紧跟着**就是子代理的结果(tool_result)—— 用来数"子代理增量写了几次界面状态"和"最后一段丢没丢"。
//      Task 的 tool_use id 写进 <sid>.subagent-tool。
//   2) <CTL>/<sid>.stream(JSON:{ deltas, gapMs })—— 主回合再吐一条"逐字流式"的回复(deltas 条增量),
//      用来数"流式期间输入框跟着重渲染了几次"。
// 以下是 r146 原注释:
// r146 假 claude CLI:由 r140 的桩件复制而来(**r140 / r118 原目录只读**)。r146 只改了一处:错误注入的
// result 改成真实 CLI 的「API 错误」形态(见下方 errText 处)。以下是 r140 原注释:
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
import { encodeProjectDir, live } from './fixtures.mjs';

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

const assistantMsg = (text) => ({ id: `msg_r118_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL,
  content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: usageNow() });
const say = (text) => { const msg = assistantMsg(text); out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: msg }); append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: msg }); };

// ===================== r148 追加 =====================
const readJson = (p) => { const raw = readRaw(p); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };
const streamEvent = (parent, event) => out({ type: 'stream_event', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: parent, event });

/** 子代理段:Task 工具调用 → 子代理流式增量 → 紧跟子代理结果。 */
async function subagentSegment(cfg) {
  const deltas = Math.max(1, Number(cfg.deltas) || 1);
  const gapMs = Math.max(0, Number(cfg.gapMs) || 0);
  const burstTail = Math.max(0, Number(cfg.burstTail) || 0);
  const tail = String(cfg.tail || 'R148-SUBTAIL');
  const tool = `toolu_r148_${crypto.randomBytes(6).toString('hex')}`;
  const call = { id: `msg_r148_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL,
    content: [{ type: 'tool_use', id: tool, name: 'Task', input: { description: 'R148 子代理', prompt: 'R148 子代理的任务', subagent_type: 'general-purpose' } }],
    stop_reason: 'tool_use', usage: usageNow() };
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: call });
  append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: call });
  writePhase('subagent-tool', tool);
  await sleep(150);   // 让界面先把这次 Task 登记成子代理(之后的增量才有地方落)
  streamEvent(tool, { type: 'message_start', message: { id: `msg_r148_sub_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL, content: [], usage: usageNow() } });
  streamEvent(tool, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < deltas; i += 1) {
    const text = i === deltas - 1 ? tail : `R148D${i} `;
    streamEvent(tool, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    if (gapMs && i < deltas - burstTail) await sleep(gapMs);
  }
  // 子代理的结果紧跟最后一条增量(中间不留任何别的事件、不留间隔)
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: [{ type: 'text', text: 'R148 子代理结果' }] }] };
  out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: result });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: result });
  writePhase('phase', 'subagent-done');
}

/** 主回合流式段:一条逐字到达的回复(增量 + 收尾的整条消息,与真实 CLI 的 partial 输出同形)。 */
async function streamSegment(cfg) {
  const deltas = Math.max(1, Number(cfg.deltas) || 1);
  const gapMs = Math.max(0, Number(cfg.gapMs) || 0);
  const id = `msg_r148_main_${crypto.randomBytes(4).toString('hex')}`;
  let full = '';
  streamEvent(null, { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], usage: usageNow() } });
  streamEvent(null, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  writePhase('phase', 'stream-start');
  for (let i = 0; i < deltas; i += 1) {
    const text = `R148M${i} `;
    full += text;
    streamEvent(null, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    if (gapMs) await sleep(gapMs);
  }
  streamEvent(null, { type: 'content_block_stop', index: 0 });
  const msg = { id, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: full }], stop_reason: 'end_turn', usage: usageNow() };
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: msg });
  append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: msg });
  streamEvent(null, { type: 'message_stop' });
  writePhase('phase', 'stream-done');
}

async function round(userText) {
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: userText } });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

  try { fs.unlinkSync(phaseFile('chunk')); fs.unlinkSync(phaseFile('done')); fs.unlinkSync(phaseFile('go')); } catch { /* 本来就没有 */ }
  say(live.chunk1(sid, userText));
  writePhase('phase', 'chunk1');
  // r148:可选的子代理段 / 主回合流式段(见文件头)
  const subCfg = readJson(phaseFile('subagent'));
  if (subCfg) await subagentSegment(subCfg);
  const streamCfg = readJson(phaseFile('stream'));
  if (streamCfg) await streamSegment(streamCfg);
  await waitFor('chunk');                       // 切走/切回就发生在这段停住里
  say(live.chunk2(sid));
  writePhase('phase', 'chunk2');
  await waitFor('done');
  say(live.final(sid));
  writePhase('phase', 'final');
  // r140:错误注入 —— 有 <sid>.error 就以 error result 收场(文本原样带给宿主,用来探"错误提示挂哪了")
  const errText = readRaw(path.join(CTL, `${sid}.error`));
  if (errText && errText.trim()) {
    // r146:真实 CLI 的 API 错误(签名失效 / 1M 额度被拒等)是 subtype=success + is_error=true + 文案在 result 里
    // (App.jsx 提取 msg 的注释写明了这个形态)。r140 原来的 error_during_execution 形态缺 errors 数组,
    // 服务端 SDK 引擎处理它时自己先崩("reading 'map'"),报错文案根本到不了界面,探不到自动重发。
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, session_id: sid, uuid: crypto.randomUUID(),
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
  queue.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
  void pump();
});
rl.on('close', () => process.exit(0));
