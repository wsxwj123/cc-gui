#!/usr/bin/env node
// r143 假 claude CLI(照抄自 r118 的同名桩):只说 stream-json,不碰产品实现。每收到一条用户消息跑一个回合,回合被切成三段,
// 由测试用控制文件逐段放行(INTERFACE §C 要求"回合进行中"由测试自己可控):
//   init → assistant(第 1 块文字)【停住,等 $CGUI_FAKE_CLAUDE_DIR/<sid>.chunk】
//        → assistant(第 2 块文字)【停住,等 $CGUI_FAKE_CLAUDE_DIR/<sid>.done】→ assistant 收尾 + result
// 控制文件按会话 id 命名:多条会话同时跑时互不干扰。
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
// 慢启动开关:控制文件 <CTL>/slow-ms 里写着毫秒数(测试在发消息前放/删)。
// 真实用户机器上挂了很多 MCP,会话进程要十几秒才吐第一条事件 —— 这段"已收到请求但界面上什么都还没吐"
// 的窗口在秒开的桩上不存在,靠这个开关造出来。只作用于交互式回合(不含标题生成那类 -p 调用)。
const slowMs = () => { try { return Number(fs.readFileSync(path.join(CTL, 'slow-ms'), 'utf8').trim()) || 0; } catch { return 0; } };
const writePhase = (suffix, value) => { try { fs.mkdirSync(CTL, { recursive: true }); fs.writeFileSync(phaseFile(suffix), value || String(Date.now())); } catch { /* 忽略 */ } };
const waitFor = async (suffix) => { while (!fs.existsSync(phaseFile(suffix))) await sleep(60); };
try {
  fs.mkdirSync(CTL, { recursive: true });
  fs.appendFileSync(path.join(CTL, 'argv.log'), `${stamp()} pid=${process.pid} argv=${JSON.stringify(argv)}\n`);
  fs.writeFileSync(path.join(CTL, `${sid}.started`), stamp());
} catch { /* 忽略 */ }

const assistantMsg = (text) => ({ id: `msg_r143_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL,
  content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: USAGE });
const say = (text) => { const msg = assistantMsg(text); out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: msg }); append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: msg }); };

// ── 权限卡开关(S7 用)──────────────────────────────────────────────────────
// 测试在**发消息之前**写 <CTL>/<sid>.permission,这一轮就会在吐完第一块文字之后发一条
// can_use_tool 控制请求、停在那儿等宿主应答(宿主 = GUI:卡片 → 用户裁决 → control_response)。
// 报文格式逐字抄自本仓已有的可用先例 tests/acceptance/stripfold-20260913/helpers/fake-claude.mjs:112-124。
// 等待有上限(20s):卡一直没人答也不把进程永久挂住。相位写进 <sid>.phase:
//   'permission'(请求已发出) / 'permission-answered'(值是 yes|timeout)。
let answeredPermission = false;
let permissionRequestId = null;
const PERMISSION_WAIT_MS = 20_000;
const permissionOn = () => { try { return fs.existsSync(phaseFile('permission')); } catch { return false; } };

async function askPermission() {
  permissionRequestId = `r143-perm-${crypto.randomBytes(4).toString('hex')}`;
  out({ type: 'control_request', request_id: permissionRequestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo r143-fixture' }, permission_suggestions: [] } });
  writePhase('phase', 'permission');
  const deadline = Date.now() + PERMISSION_WAIT_MS;
  while (!answeredPermission && Date.now() < deadline) await sleep(50);
  writePhase('permission-answered', answeredPermission ? 'yes' : 'timeout');
}

async function round(userText) {
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: userText } });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

  try { fs.unlinkSync(phaseFile('chunk')); fs.unlinkSync(phaseFile('done')); } catch { /* 本来就没有 */ }
  say(live.chunk1(sid, userText));
  writePhase('phase', 'chunk1');
  if (permissionOn() && !answeredPermission) await askPermission();   // S7:这一轮挂一张授权卡
  await waitFor('chunk');                       // 切走/切回就发生在这段停住里
  say(live.chunk2(sid));
  writePhase('phase', 'chunk2');
  await waitFor('done');
  say(live.final(sid));
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(),
    result: 'R143-FINAL', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  writePhase('phase', 'final');
}

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) { await round(printArg); process.exit(0); }

// stdin 不能挡在回合里(控制请求要随时能答),用"回调 + 队列"
const queue = [];
let running = false;
const pump = async () => { if (running) return; running = true; while (queue.length) { const wait = slowMs(); if (wait > 0) await sleep(wait); await round(queue.shift()); } running = false; };
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  // 宿主答我们那条 can_use_tool 时走这里(S7)——必须排在 control_request 分支之前
  if (msg.type === 'control_response') {
    const rid = msg.response && (msg.response.request_id || msg.request_id);
    if (!permissionRequestId || rid === permissionRequestId) answeredPermission = true;
    return;
  }
  if (msg.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }); return; }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  queue.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
  void pump();
});
rl.on('close', () => process.exit(0));
