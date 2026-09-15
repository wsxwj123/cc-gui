#!/usr/bin/env node
// r116 假 claude CLI:只说 stream-json,不碰产品实现。每收到一条用户消息跑一个回合:
//   init → assistant(tool_use 电脑操控截图)→ user(tool_result = [文字, 图片(Anthropic 形态)])
//   → 【停住,等 $CGUI_FAKE_CLAUDE_DIR/release 出现】→ assistant 正文 → result。
// 停住的那段就是"回复进行中"的现场;每发一条都立刻追加进转写(与真 CLI 一样边跑边落盘),
// 放行后界面转由历史接管 —— 正是用户实报"回复完成后截图变成编码文字"的那一刻。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { IMG, TEXT, CU_TOOL, encodeProjectDir } from './fixtures.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
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
try { fs.mkdirSync(CTL, { recursive: true }); fs.writeFileSync(path.join(CTL, 'started'), stamp()); } catch { /* 忽略 */ }

async function round(userText) {
  let parent = crypto.randomUUID();
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: parent });
  append({ ...base(), type: 'user', uuid: parent, parentUuid: null, message: { role: 'user', content: userText } });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [CU_TOOL], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

  const toolId = `toolu_r116_live_${crypto.randomBytes(4).toString('hex')}`;
  const toolMsg = { id: `msg_r116_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL,
    content: [{ type: 'tool_use', id: toolId, name: CU_TOOL, input: {} }], stop_reason: 'tool_use', usage: USAGE };
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: toolMsg });
  const aUuid = crypto.randomUUID();
  append({ ...base(), type: 'assistant', uuid: aUuid, parentUuid: parent, message: toolMsg });
  parent = aUuid;
  await sleep(150);

  const content = [{ type: 'text', text: TEXT.live }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG.live.data } }];
  const resultMsg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content }] };
  out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: resultMsg });
  const rUuid = crypto.randomUUID();
  append({ ...base(), type: 'user', uuid: rUuid, parentUuid: parent, toolUseResult: content, message: resultMsg });
  parent = rUuid;

  while (!fs.existsSync(path.join(CTL, 'release'))) await sleep(80);   // 回复进行中:等测试放行

  const doneMsg = { id: `msg_r116_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL,
    content: [{ type: 'text', text: TEXT.liveDone }], stop_reason: 'end_turn', usage: USAGE };
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: doneMsg });
  append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: parent, message: doneMsg });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(),
    result: TEXT.liveDone, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
}

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) { await round(printArg); process.exit(0); }

// stdin 不能挡在回合里(控制请求要随时能答),用"回调 + 队列"
const queue = [];
let running = false;
const pump = async () => { if (running) return; running = true; while (queue.length) await round(queue.shift()); running = false; };
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } }); return; }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  queue.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
  void pump();
});
rl.on('close', () => process.exit(0));   // 宿主关 stdin / 被杀 → 立即退出,不留在停住的回合里
