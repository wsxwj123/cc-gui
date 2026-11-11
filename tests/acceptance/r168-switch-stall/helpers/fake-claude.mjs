#!/usr/bin/env node
// r168 假 claude：只说 stream-json。一轮回复持续 ≥120 秒（默认 130s）：
// 每 250ms 发一个 stream_event 文本增量（词 R168T00001 R168T00002 …，只增不减），每 20 个增量（约 5 秒）收成一条完整 assistant 消息并追加进转写；
// 回合结束发 result。CTL 目录（$CGUI_FAKE_CLAUDE_DIR）里出现 finish-all 或 finish-<sid> 文件就提前收尾（用例收尾用）。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${n}=`));
  return eq === undefined ? undefined : eq.slice(n.length + 1);
};
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }

const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const cwd = process.cwd();
const MODEL = 'claude-sonnet-4-6';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const TITLE_GEN = /cgui-title-/.test(cwd);

// 转写位置：已有 <sid>.jsonl 就写进它（夹具会话），否则按 cwd 编码新建。
function transcriptPath() {
  const root = path.join(process.env.HOME || '.', '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; }
  } catch { /* 目录还没有 */ }
  const dir = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${sid}.jsonl`);
}
let TRANSCRIPT = null;
const append = (line) => {
  if (TITLE_GEN) return;
  try { TRANSCRIPT = TRANSCRIPT || transcriptPath(); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const base = () => ({ parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '' });

let scenario = {};
const loadScenario = () => { try { scenario = JSON.parse(fs.readFileSync(path.join(CTL, 'scenario.json'), 'utf8')); } catch { scenario = {}; } };
const finished = () => fs.existsSync(path.join(CTL, 'finish-all')) || fs.existsSync(path.join(CTL, `finish-${sid}`));

let roundNo = 0;
let tokenNo = 0;
async function runRound(userText) {
  loadScenario();
  roundNo += 1;
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({ ...base(), promptId: 'r168-fake', type: 'user', isMeta: false, message: { role: 'user', content: userText }, uuid: crypto.randomUUID(), timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk' });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  const se = (event) => out({ type: 'stream_event', event, session_id: sid, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  const dur = (TITLE_GEN || argv.includes('-p')) ? 0 : (scenario.durationMs || 130_000);
  const t0 = Date.now();
  let seg = 0;
  while (Date.now() - t0 < dur && !finished()) {
    seg += 1;
    const id = `msg_r168_${roundNo}_${seg}`;
    se({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } });
    se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    let text = '';
    for (let i = 0; i < 20 && !finished(); i += 1) {
      tokenNo += 1;
      const tok = `R168T${String(tokenNo).padStart(5, '0')} `;
      text += tok;
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tok } });
      await sleep(250);
    }
    se({ type: 'content_block_stop', index: 0 });
    se({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 34 } });
    se({ type: 'message_stop' });
    const blocks = [{ type: 'text', text }];
    out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: 'end_turn', usage: USAGE } });
    append({ ...base(), message: { model: MODEL, id, type: 'message', role: 'assistant', content: blocks, stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: USAGE }, apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant', uuid: crypto.randomUUID(), timestamp: stamp(), effort: 'high' });
  }
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: 'ok', duration_ms: Date.now() - t0, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}

if (!fs.existsSync(CTL)) { try { fs.mkdirSync(CTL, { recursive: true }); } catch { /* 忽略 */ } }
const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) { await runRound(printArg); process.exit(0); }

const queue = [];
let running = false;
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) await runRound(queue.shift());
  running = false;
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_response') return;
  if (msg.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }); return; }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  queue.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
  void pump();
});
await new Promise((resolve) => rl.on('close', resolve));
process.exit(0);
