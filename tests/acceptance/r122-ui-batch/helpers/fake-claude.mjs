#!/usr/bin/env node
// r122 假 claude CLI(stub):只讲 stream-json,不碰产品实现,不联网,不读任何真实凭据。
// 用途:造 INTERFACE A9 要的"可控的正在生成"回合 —— 桩按场景吐出 思考/工具/正文,
//       然后**停在 result 之前**,直到测试放行;放行后正常收尾(或按场景报错收尾)。
//
// 控制文件(都在 CGUI_FAKE_CLAUDE_DIR 下):
//   scenario.json   这一轮长什么样(每轮开始时读一次):
//       { "events":[ {"kind":"thinking","text":"…"},
//                    {"kind":"tool","name":"Bash","input":{…},"result":"…"},
//                    {"kind":"text","text":"…"} ],
//         "holdBeforeResult": true,     // 发完事件后停住,等 <CTL>/release 出现(= 一直"正在生成")
//         "stepDelayMs": 120,
//         "end": "ok" | "error", "errorText": "…" }
//   release         文件出现 = 放行"停在 result 之前"的回合
// 落盘的事实(测试侧可读):
//   <pid>.pid       本进程 pid —— 收尾只按这些 pid 文件杀,不按进程名/端口批量杀
//   <sid>.phase     init / events-done / final / error / interrupted
//   argv.log        每次启动的 argv(排查用)
// 每发一条 assistant 记录就**立刻追加**到转写($HOME/.claude/projects/<cwd 编码>/<sid>.jsonl),
// 回合结束后界面从磁盘读回的持久化轮与直播时看到的是同一份内容。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { encodeProjectDir } from './fixtures.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }
// 登录态查询:桩永远答"未登录"(不读任何凭据;BRIEF R3 的现场就是未登录)。
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })); process.exit(0); }
if (['mcp', 'plugin', 'config', 'doctor', 'update', 'install', 'setup-token'].includes(argv[0])) process.exit(0);

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const p = argv.find((a) => a.startsWith(`${n}=`));
  return p ? p.slice(n.length + 1) : undefined;
};
const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const cwd = process.cwd();
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', encodeProjectDir(cwd));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const append = (line) => { try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ } };
const writeCtl = (name, value) => { try { fs.mkdirSync(CTL, { recursive: true }); fs.writeFileSync(path.join(CTL, name), value || String(Date.now())); } catch { /* 忽略 */ } };
const exists = (name) => { try { fs.accessSync(path.join(CTL, name)); return true; } catch { return false; } };
const readScenario = () => { try { return JSON.parse(fs.readFileSync(path.join(CTL, 'scenario.json'), 'utf8')); } catch { return {}; } };
const MAX_HOLD_MS = 240_000;   // 兜底:测试忘了放行也不会永远挂着

try {
  fs.mkdirSync(CTL, { recursive: true });
  fs.writeFileSync(path.join(CTL, `${process.pid}.pid`), String(process.pid));
  fs.appendFileSync(path.join(CTL, 'argv.log'), `${stamp()} pid=${process.pid} argv=${JSON.stringify(argv)}\n`);
} catch { /* 忽略 */ }
const dropPid = () => { try { fs.unlinkSync(path.join(CTL, `${process.pid}.pid`)); } catch { /* 忽略 */ } };
process.on('exit', dropPid);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0));

const record = (extra) => ({
  parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid,
  version: '2.1.267', gitBranch: '', uuid: crypto.randomUUID(), timestamp: stamp(), ...extra,
});
const assistantLine = (id, blocks, stopReason) => record({
  message: { model: MODEL, id, type: 'message', role: 'assistant', content: blocks, stop_reason: stopReason, stop_sequence: null, stop_details: null, usage: USAGE },
  apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant', effort: 'high',
});
const toolResultLine = (toolUseId, content) => record({
  promptId: 'r122-fake', type: 'user', isMeta: false, toolUseResult: content, toolUseID: toolUseId,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
});

let interrupted = false;
let roundSeq = 0;

async function round(userText) {
  roundSeq += 1;
  const scenario = readScenario();
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append(record({ promptId: 'r122-fake', type: 'user', isMeta: false, message: { role: 'user', content: userText }, permissionMode: 'default', promptSource: 'sdk' }));
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  writeCtl(`${sid}.phase`, 'init');

  const events = Array.isArray(scenario.events) ? scenario.events : [{ kind: 'text', text: '(假 CLI:未给 scenario,默认一轮正文)' }];
  let seq = 0;
  for (const ev of events) {
    if (interrupted) break;
    seq += 1;
    const id = `r122_fake_r${roundSeq}_${seq}_${crypto.randomBytes(3).toString('hex')}`;
    if (ev.kind === 'thinking') {
      const blocks = [{ type: 'thinking', thinking: ev.text, signature: 'r122-fake-sig' }];
      out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: null, usage: USAGE } });
      append(assistantLine(id, blocks, null));
    } else if (ev.kind === 'tool') {
      const toolId = `toolu_r122_${seq}_${crypto.randomBytes(3).toString('hex')}`;
      const blocks = [{ type: 'tool_use', id: toolId, name: ev.name || 'Bash', input: ev.input || { command: 'echo r122' } }];
      out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: 'tool_use', usage: USAGE } });
      append(assistantLine(id, blocks, 'tool_use'));
      const result = ev.result ?? '(假 CLI)命令输出';
      out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result }] } });
      append(toolResultLine(toolId, result));
    } else {
      const blocks = [{ type: 'text', text: ev.text || '' }];
      out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: null, usage: USAGE } });
      append(assistantLine(id, blocks, null));
    }
    await sleep(scenario.stepDelayMs || 120);   // 让界面一帧一帧画出来("流式长出"的样子)
  }
  writeCtl(`${sid}.phase`, 'events-done');

  if (scenario.holdBeforeResult) {
    const deadline = Date.now() + MAX_HOLD_MS;
    while (!exists('release') && !interrupted && Date.now() < deadline) await sleep(60);
  }
  if (interrupted) return;                // 收尾由 interrupt 分支负责

  if (scenario.end === 'error') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(), result: scenario.errorText || '(假 CLI)这一轮故意报错', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
    writeCtl(`${sid}.phase`, 'error');
  } else {
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: 'ok', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
    writeCtl(`${sid}.phase`, 'final');
  }
}

function onInterrupt() {
  if (interrupted) return;
  interrupted = true;
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(), result: 'Interrupted by user', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  writeCtl(`${sid}.phase`, 'interrupted');
}

// -p 的一次性调用(标题生成那类):不参与交互,快速收尾
const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg !== undefined && !argv.includes('--input-format')) {
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: String(printArg).slice(0, 20), duration_ms: 5, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  process.exit(0);
}

// stdin 的读不能挡在回合里:宿主的控制请求(interrupt)必须在回合等待期间就能收到 → 事件回调 + 队列。
const queue = [];
let running = false;
const pump = async () => {
  if (running) return;
  running = true;
  while (queue.length) { interrupted = false; await round(queue.shift()); }
  running = false;
};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    const subtype = (msg.request && msg.request.subtype) || msg.subtype || '';
    if (/interrupt/i.test(subtype)) onInterrupt();
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  queue.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
  void pump();
});
rl.on('close', () => process.exit(0));
