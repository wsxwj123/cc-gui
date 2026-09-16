#!/usr/bin/env node
// r121 假 claude CLI(stub):只讲 stream-json,不碰产品实现。
// 依据只有 .devflow/BRIEF-r121.md 与 .devflow/INTERFACE-r121.md §C 的硬性要求:
//   "正在生成"必须由测试可控(桩能按需吐字、可暂停),不依赖真实模型速度。
//
// 控制文件(都在 CGUI_FAKE_CLAUDE_DIR 下):
//   <CTL>/max-chunks=N   吐满 N 块就**正常收尾**(发 result,走完成态)。不写 = 一直吐到 MAX_MS / 被打断。
//   <CTL>/chunk-ms       每块之间的间隔(默认 250ms):调大 = 生成得慢,便于"正在生成中"操作。
//   <CTL>/chunk-chars    每块文字长度(默认 200)。
//   <CTL>/pause          文件存在 = 暂停吐字(停在原地,仍处于"正在生成");删除 = 继续。
//   <CTL>/gate           文件存在 = 收到 user 后先不开始,直到删除(用于"发送那一刻"精确卡点)。
// 落盘的事实(测试侧可读,做"桩自己写了什么"的基准):
//   <sid>.streamed       最新一块的序号
//   <sid>.phase          init / chunk-N / final / interrupted
//   <sid>.interrupted    收到 interrupt 的时刻
//   <CTL>/argv.log       每次启动的 argv(排查用)
// 进程身份:<CTL>/<sid>.pid,收尾时只按这些 pid 文件杀,不按进程名/端口批量杀。
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
const ctlFile = (suffix) => path.join(CTL, `${sid}.${suffix}`);
const writeCtl = (suffix, value) => { try { fs.mkdirSync(CTL, { recursive: true }); fs.writeFileSync(ctlFile(suffix), value || String(Date.now())); } catch { /* 忽略 */ } };
const exists = (name) => { try { fs.accessSync(path.join(CTL, name)); return true; } catch { return false; } };
const ctlNum = (name, d) => {
  try { const n = Number(fs.readFileSync(path.join(CTL, name), 'utf8').trim()); return Number.isFinite(n) && n > 0 ? n : d; } catch { return d; }
};
const numFromEnv = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const MAX_MS = numFromEnv('R121_MAX_STREAM_MS', 300_000);

try {
  fs.mkdirSync(CTL, { recursive: true });
  fs.writeFileSync(ctlFile('pid'), String(process.pid));
  fs.appendFileSync(path.join(CTL, 'argv.log'), `${stamp()} pid=${process.pid} argv=${JSON.stringify(argv)}\n`);
  fs.writeFileSync(ctlFile('started'), stamp());
} catch { /* 忽略 */ }
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { writeCtl('killed', sig); process.exit(0); });
}

const assistantMsg = (text) => ({ id: `msg_r121_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: null, usage: USAGE });
const say = (text) => {
  const msg = assistantMsg(text);
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: msg });
  append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: msg });
};
const filler = (n) => `  · 第 ${n} 行说明文字,用来把界面的正文撑起来。`;

let interrupted = false;

async function round(userText) {
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: userText } });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  writeCtl('phase', 'init');
  // gate:测试想在"发送那一刻"精确卡点(比如先开分屏再放行)时用它。
  while (exists('gate') && !interrupted) await sleep(50);
  const deadline = Date.now() + MAX_MS;
  let n = 0;
  while (!interrupted && Date.now() < deadline) {
    while (exists('pause') && !interrupted) await sleep(50);     // 暂停:停在原地,仍是"正在生成"
    if (interrupted) break;
    const cap = ctlNum('max-chunks', 0);
    if (cap > 0 && n >= cap) break;
    n += 1;
    const chars = ctlNum('chunk-chars', 200);
    const head = `R121STREAM ${sid.slice(0, 8)} #${String(n).padStart(5, '0')}\n`;
    const lines = [];
    let size = head.length;
    for (let i = 0; size < chars; i += 1) { const l = `${filler(i)}\n`; lines.push(l); size += l.length; }
    say(head + lines.join(''));
    writeCtl('phase', `chunk-${n}`);
    writeCtl('streamed', String(n));
    await sleep(ctlNum('chunk-ms', 250));
  }
  if (interrupted) return;                // 收尾由 interrupt 分支负责
  say(`R121STREAM ${sid.slice(0, 8)} 这一轮到此为止。`);
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: 'R121DONE', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  writeCtl('phase', 'final');
}

function onInterrupt() {
  if (interrupted) return;
  interrupted = true;
  writeCtl('interrupted', String(Date.now()));
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(), result: 'Interrupted by user', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  writeCtl('phase', 'interrupted');
}

// -p 的一次性调用(标题生成那类):不参与交互,快速收尾
const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) {
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: String(printArg).slice(0, 20), duration_ms: 5, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  process.exit(0);
}

const queue = [];
let running = false;
const pump = async () => {
  if (running) return;
  running = true;
  while (queue.length && !interrupted) await round(queue.shift());
  running = false;
};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
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
