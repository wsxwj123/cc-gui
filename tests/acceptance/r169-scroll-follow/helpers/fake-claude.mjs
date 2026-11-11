#!/usr/bin/env node
// r169 假 claude：只说 stream-json。一轮回复持续 ≥25 秒（默认 30s，CTL 目录里 scenario.json 的 {"durationMs":N} 可调）：
//   - 每 300ms 发一个 stream_event 文本增量（词 R169T00001 + 一句固定文字，每 4 个增量一个段落分隔），一段 10 个增量；
//   - 每第 3 段在文字之后接一次工具调用（Bash），并给出 120 行的工具结果（user 消息里的 tool_result）；
//   - 每段结束发完整 assistant 消息并追加进转写（工具段还追加 tool_use 与 tool_result 两条）；
//   - 回合结束发 result。CTL 目录（$CGUI_FAKE_CLAUDE_DIR）里出现 finish-all 或 finish-<sid> 文件就提前收尾（用例收尾用）。
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
const FILLER = '滚动跟随测试用的流式文字，持续追加一小段内容来拉长这条回复。';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const TITLE_GEN = /cgui-title-/.test(cwd);

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

const toolResultText = (roundNo, seg) => Array.from({ length: 120 }, (_, i) => `r169 工具输出 轮${roundNo} 段${seg} 第 ${String(i + 1).padStart(3, '0')} 行：job step=${i} processed ok`).join('\n');

let roundNo = 0;
let tokenNo = 0;
async function runRound(userText) {
  loadScenario();
  roundNo += 1;
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({ ...base(), promptId: 'r169-fake', type: 'user', isMeta: false, message: { role: 'user', content: userText }, uuid: crypto.randomUUID(), timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk' });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  const se = (event) => out({ type: 'stream_event', event, session_id: sid, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  const dur = (TITLE_GEN || argv.includes('-p')) ? 0 : (scenario.durationMs || 30_000);
  const t0 = Date.now();
  let seg = 0;
  while (Date.now() - t0 < dur && !finished()) {
    seg += 1;
    const withTool = seg % 3 === 0;
    const id = `msg_r169_${roundNo}_${seg}`;
    se({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } });
    // 先流一小段思考（index 0），再流正文（index 1），工具段最后接工具调用（index 2）。
    se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    let thinking = '';
    for (let i = 0; i < 3 && !finished(); i += 1) {
      const t = `r169 第 ${roundNo} 轮第 ${seg} 段思考 ${i + 1}：先想一想这段要写什么，再接着往下写。`;
      thinking += t;
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } });
      await sleep(300);
    }
    se({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'r169-sig' } });
    se({ type: 'content_block_stop', index: 0 });
    se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    let text = '';
    for (let i = 0; i < 10 && !finished(); i += 1) {
      tokenNo += 1;
      let tok = `R169T${String(tokenNo).padStart(5, '0')} ${FILLER}${tokenNo % 4 === 0 ? '\n\n' : ' '}`;
      if (tokenNo % 5 === 0) tok += `\`\`\`js\nconst n = ${tokenNo};\nconsole.log('r169', n);\n\`\`\`\n\n`;
      if (tokenNo % 7 === 0) tok += `- 要点一：第 ${tokenNo} 项\n- 要点二：继续\n\n`;
      text += tok;
      se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: tok } });
      await sleep(300);
    }
    se({ type: 'content_block_stop', index: 1 });
    const blocks = [{ type: 'thinking', thinking, signature: 'r169-sig' }, { type: 'text', text }];
    let toolId = null;
    if (withTool) {
      toolId = `toolu_r169_${roundNo}_${seg}`;
      const input = { command: `tail -n 120 /var/log/r169-${roundNo}-${seg}.log`, description: `读日志 ${roundNo}-${seg}` };
      se({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} } });
      se({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      se({ type: 'content_block_stop', index: 2 });
      blocks.push({ type: 'tool_use', id: toolId, name: 'Bash', input });
    }
    const stop = withTool ? 'tool_use' : 'end_turn';
    se({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 34 } });
    se({ type: 'message_stop' });
    out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: stop, usage: USAGE } });
    blocks.forEach((b, k) => {
      append({ ...base(), message: { model: MODEL, id: `${id}_${k}`, type: 'message', role: 'assistant', content: [b], stop_reason: stop, stop_sequence: null, stop_details: null, usage: USAGE }, apiBlockIndex: 0, requestId: `req_${id}_${k}`, type: 'assistant', uuid: crypto.randomUUID(), timestamp: stamp(), effort: 'high' });
    });
    if (withTool) {
      const result = toolResultText(roundNo, seg);
      out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result }] } });
      append({ ...base(), promptId: 'r169-fake', type: 'user', isMeta: false, toolUseResult: result, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result }] }, uuid: crypto.randomUUID(), timestamp: stamp(), toolUseID: toolId });
      await sleep(500);
    }
  }
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: 'ok', duration_ms: Date.now() - t0, num_turns: 1, total_cost_usd: 0.0123, usage: USAGE });
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
