#!/usr/bin/env node
// r119 假 claude CLI(stub):只讲 stream-json,不碰产品实现。
// 与 r118 那个"分段放行"的桩不同,这个桩**持续吐字**,让界面一直处于"正在生成"状态 ——
// 测的就是这个状态里点「停止」/按 Esc 的响应。
//   收到 user 消息 → init → 每 R119_CHUNK_MS 吐一块 assistant 文字(带递增序号 R119STREAM #n)→ …
//   收到控制请求 interrupt → 停吐、写 <sid>.interrupted、发 result(这一轮结束),进程留在原地等 stdin 关闭
//   被信号杀掉 → 写 <sid>.killed
// 慢启动:控制文件 <CTL>/slow-ms 里有毫秒数时,收到请求先静默这么久(模拟挂了很多 MCP 的真实机器)。
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
const numFromEnv = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const CHUNK_MS = numFromEnv('R119_CHUNK_MS', 120);          // 每块之间的间隔
const CHUNK_CHARS = numFromEnv('R119_CHUNK_CHARS', 220);    // 每块文字长度
const MAX_MS = numFromEnv('R119_MAX_STREAM_MS', 300_000);   // 兜底:别真的吐到天荒地老
const slowMs = () => { try { return Number(fs.readFileSync(path.join(CTL, 'slow-ms'), 'utf8').trim()) || 0; } catch { return 0; } };
// 吐字节奏也可以由控制文件改(测试中途可调):<CTL>/chunk-ms、<CTL>/chunk-chars
const ctlNum = (name, d) => {
  try { const n = Number(fs.readFileSync(path.join(CTL, name), 'utf8').trim()); return Number.isFinite(n) && n > 0 ? n : d; } catch { return d; }
};

// 桩自己的进程身份:收尾时按这些 pid 文件杀,不按进程名/端口批量杀
try {
  fs.mkdirSync(CTL, { recursive: true });
  fs.writeFileSync(ctlFile('pid'), String(process.pid));
  fs.appendFileSync(path.join(CTL, 'argv.log'), `${stamp()} pid=${process.pid} argv=${JSON.stringify(argv)}\n`);
  fs.writeFileSync(ctlFile('started'), stamp());
} catch { /* 忽略 */ }
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => { writeCtl('killed', sig); process.exit(0); });
}

const assistantMsg = (text) => ({ id: `msg_r119_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: null, usage: USAGE });
const say = (text) => {
  const msg = assistantMsg(text);
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: msg });
  append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: msg });
};
const filler = (n) => `  · 第 ${n} 行说明文字,用来把界面的正文撑起来(渲染代价接近真实流式输出)。`;

let interrupted = false;
let streaming = false;

async function round(userText) {
  streaming = true;
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: userText } });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  writeCtl('phase', 'init');
  const deadline = Date.now() + MAX_MS;
  let n = 0;
  while (!interrupted && Date.now() < deadline) {
    n += 1;
    const chars = ctlNum('chunk-chars', CHUNK_CHARS);
    const head = `R119STREAM ${sid.slice(0, 8)} #${String(n).padStart(5, '0')}\n`;
    const lines = [];
    let size = head.length;
    for (let i = 0; size < chars; i += 1) { const l = `${filler(i)}\n`; lines.push(l); size += l.length; }
    say(head + lines.join(''));
    writeCtl('phase', `chunk-${n}`);
    writeCtl('streamed', String(n));      // 测试/收尾用:最新一块的序号
    await sleep(ctlNum('chunk-ms', CHUNK_MS));
  }
  if (interrupted) return;                // 收尾由 interrupt 分支负责
  say(`R119STREAM ${sid.slice(0, 8)} 这一轮到此为止。`);
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: 'R119DONE', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  writeCtl('phase', 'final');
  streaming = false;
}

function onInterrupt() {
  if (interrupted) return;
  interrupted = true;
  writeCtl('interrupted', String(Date.now()));
  // 真实 CLI 被中断时这一轮以「未完成」收尾;这里如实照做
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(), result: 'Interrupted by user', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  writeCtl('phase', 'interrupted');
  streaming = false;
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
  while (queue.length && !interrupted) {
    const wait = slowMs();
    if (wait > 0 && !streaming) await sleep(wait);
    if (interrupted) break;
    await round(queue.shift());
  }
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
