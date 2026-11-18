#!/usr/bin/env node
// r197 假命令行(搭法照 r140 的桩件,自成一套)。控制文件都放在 <CTL>/ 下:
//   <sid>.slow-ms  这条会话的回合先静默这么多毫秒再开始(写很大的数 = 无限期按住)
//   <sid>.go       出现就立刻放行(无论 slow-ms 还剩多久)
//   <sid>.chunk    放行第二块;<sid>.done 放行回合收尾
//   <sid>.hold-once  (r197 新增)只按住下一个回合,之后的回合不再按住
//   <sid>.auto     (r197 新增)回合不停在 chunk/done 上,自己跑完
//   <sid>.die      (r197 新增)交互式进程启动后静默 N 毫秒(文件内容,默认 4000),然后不吐任何事件就退出码 1 退出;
//                  只生效一次(读到就删),重新拉起的进程不受影响
// 回合分三段:init → assistant(第 1 块)【等 chunk】→ assistant(第 2 块)【等 done】→ 收尾 + result。
// 回合结束后进程不退出(与真实命令行常驻模式一致)。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { encodeProjectDir, live } from './fixtures.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
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
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const base = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '', timestamp: stamp() });
const append = (line) => { try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ } };
const phaseFile = (suffix) => path.join(CTL, `${sid}.${suffix}`);
const rmQuiet = (p) => { try { fs.unlinkSync(p); } catch { /* 本来就没有 */ } };
const readRaw = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readNum = (p) => { const t = readRaw(p); return t === null ? null : (Number(t.trim()) || 0); };
const slowMsFor = (s) => {
  const per = readNum(path.join(CTL, `${s}.slow-ms`));
  return per === null ? (readNum(path.join(CTL, 'slow-ms')) || 0) : per;
};
// r197:<sid>.hold-once = 只按住"下一个到达闸门的回合"(读到就删),之后的回合(含重新拉起的进程里的)不再被按住。
const waitGate = async (s) => {
  const t0 = Date.now();
  let limit = null;
  if (fs.existsSync(path.join(CTL, `${s}.hold-once`))) { rmQuiet(path.join(CTL, `${s}.hold-once`)); limit = 3_600_000; }
  for (;;) {
    if (fs.existsSync(path.join(CTL, `${s}.go`))) return;
    if (Date.now() - t0 >= (limit === null ? slowMsFor(s) : limit)) return;
    await sleep(60);
  }
};
const writePhase = (suffix, value) => { try { fs.mkdirSync(CTL, { recursive: true }); fs.writeFileSync(phaseFile(suffix), value || String(Date.now())); } catch { /* 忽略 */ } };
const waitFor = async (suffix) => { while (!fs.existsSync(phaseFile(suffix))) await sleep(60); };

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
const oneShot = Boolean(printArg) && !argv.includes('--input-format');

try {
  fs.mkdirSync(CTL, { recursive: true });
  fs.appendFileSync(path.join(CTL, 'argv.log'), `${stamp()} pid=${process.pid} argv=${JSON.stringify(argv)}\n`);
  if (!oneShot) fs.writeFileSync(path.join(CTL, `${sid}.started`), `${stamp()} pid=${process.pid}`);
} catch { /* 忽略 */ }

// r197:启动即死。进程起来后一条事件都不吐,静默一阵就退出(模拟"命令行进程在吐出第一条事件之前就退出")。
if (!oneShot) {
  const dieRaw = readRaw(path.join(CTL, `${sid}.die`));
  if (dieRaw !== null) {
    rmQuiet(path.join(CTL, `${sid}.die`));
    await sleep(Number(dieRaw.trim()) || 4000);
    process.stderr.write('r197 fake claude: 启动即退出\n');
    process.exit(1);
  }
}

const assistantMsg = (text) => ({ id: `msg_r197_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL,
  content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: USAGE });
const say = (text) => { const msg = assistantMsg(text); out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: msg }); append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, message: msg }); };

async function round(userText) {
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: userText } });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  for (const s of ['chunk', 'done', 'go']) rmQuiet(phaseFile(s));
  say(live.chunk1(sid, userText));
  writePhase('phase', 'chunk1');
  const auto = () => oneShot || fs.existsSync(path.join(CTL, `${sid}.auto`));   // r197:<sid>.auto = 回合不停在 chunk/done 上,自己跑完
  if (!auto()) await waitFor('chunk');
  say(live.chunk2(sid));
  writePhase('phase', 'chunk2');
  if (!auto()) await waitFor('done');
  say(live.final(sid));
  writePhase('phase', 'final');
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(),
    result: 'R197-FINAL', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  writePhase('phase', 'final');
}

if (oneShot) { await round(printArg); process.exit(0); }

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
