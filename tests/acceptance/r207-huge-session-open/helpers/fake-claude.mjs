#!/usr/bin/env node
// r207 假命令行(精简自 r196 的桩件,不 import 别的套件):收到一条用户消息 → 写会话文件(用户行 + 助手行)→ 回一段文字 → result。
// 观察文件:<CTL>/<sid>.turn-end(回合结束时写入时间戳)。<CTL>/auto-ms:回复前停多少毫秒(默认 300)。
// 后台起标题的调用(参数带 -p 与 --no-session-persistence,或提示里有 cgui-title):回一句标题就退出,不写会话文件。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }
if (['mcp', 'plugin', 'config', 'doctor', 'update'].includes(argv[0])) process.exit(0);

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argOf = (n) => { const i = argv.indexOf(n); if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]; const p = argv.find((a) => a.startsWith(`${n}=`)); return p ? p.slice(n.length + 1) : undefined; };
const cwd = process.cwd();
const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const MODEL = argOf('--model') || 'claude-sonnet-4-6';
const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(`${JSON.stringify({ session_id: sid, uuid: crypto.randomUUID(), ...o })}\n`);
const textOf = (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text || '' : '')).join('') : ''));
const readNum = (p) => { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return null; } };

const joined = argv.join(' ');
if ((argv.includes('-p') && argv.includes('--no-session-persistence')) || /cgui-title/.test(joined) || /cgui-title/.test(cwd)) {
  try { fs.readFileSync(0, 'utf8'); } catch { /* 没有标准输入 */ }
  const title = '短标题';
  if (/stream-json/.test(joined)) {
    out({ type: 'system', subtype: 'init', cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default' });
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_title_${crypto.randomBytes(3).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: title }], stop_reason: 'end_turn', usage: USAGE } });
    out({ type: 'result', subtype: 'success', is_error: false, result: title, duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  } else process.stdout.write(`${title}\n`);
  process.exit(0);
}

const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const base = () => ({ isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.327', gitBranch: '', timestamp: new Date().toISOString() });
const append = (line) => { try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ } };

let tail = Promise.resolve();
async function userTurn(content) {
  const text = textOf(content);
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content } });
  out({ type: 'system', subtype: 'init', cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: argOf('--permission-mode') || 'default' });
  const per = readNum(path.join(CTL, `${sid}.auto-ms`));
  await sleep(per === null ? (readNum(path.join(CTL, 'auto-ms')) ?? 300) : per);
  const id = `msg_r207_${crypto.randomBytes(4).toString('hex')}`;
  const reply = `R207-REPLY-OK ${sid.slice(0, 8)} 收到:${text}`;
  const msg = { id, type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: USAGE };
  out({ type: 'assistant', parent_tool_use_id: null, message: msg });
  append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), parentUuid: null, requestId: `req_${id}`, message: { ...msg, stop_sequence: null } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });
  try { fs.mkdirSync(CTL, { recursive: true }); fs.writeFileSync(path.join(CTL, `${sid}.turn-end`), String(Date.now())); } catch { /* 忽略 */ }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } }); return; }
  if (msg.type !== 'user') return;
  tail = tail.then(() => userTurn(msg.message && msg.message.content)).catch((e) => process.stderr.write(`${String((e && e.stack) || e)}\n`));
});
rl.on('close', () => { tail.then(() => process.exit(0)); });
