#!/usr/bin/env node
// r189 假 claude CLI:只说 stream-json,不碰产品实现。从 r118 的假命令行派生(三段回合由控制文件放行),另加:
//   · 记录里的用户消息 / 回复都带 parentUuid(接在文件里最后一条记录后面);
//   · 控制文件 <CTL>/defer-user 存在时,这一回合的记录(用户消息 + 回复)先不写,等回合收尾(放行 <sid>.done)才一起写
//     (真实命令行里用户消息落盘比界面显示晚;回合没收尾之前它「还没写进记录」);
//   · 用户消息以 /compact 开头时走压缩回合:init → 写 phase=compact-wait → 等 <sid>.done →
//     写 compact_boundary 记录并输出 compact_boundary 事件 → result;
//   · 一次性调用(-p,起标题那类)立刻静默退出,不落盘不吐字(标题保持夹具原样,侧栏行才找得到)。
// 普通回合:init → assistant(chunk1)【等 <sid>.chunk】→ assistant(chunk2)【等 <sid>.done】→ assistant(final)+ result。
// 控制文件在 $CGUI_FAKE_CLAUDE_DIR 下,按会话 id 命名;phase 文件记录回合走到哪(chunk1 / chunk2 / compact-wait / final)。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { encodeProjectDir, live, lastUuidOf } from './fixtures.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }
if (['mcp', 'plugin', 'config', 'doctor', 'update'].includes(argv[0])) process.exit(0);
if (argv.includes('-p') && !argv.includes('--input-format')) process.exit(0);

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
let deferring = false;   // defer-user 时:本回合的记录先攒着,等回合收尾(放行 .done)才一起写进会话记录
const pending = [];
const append = (line) => {
  if (deferring) { pending.push(line); return; }
  try {
    fs.mkdirSync(PROJ, { recursive: true });
    const parentUuid = lastUuidOf(TRANSCRIPT);
    fs.appendFileSync(TRANSCRIPT, `${JSON.stringify({ parentUuid, ...line })}\n`);
  } catch { /* 忽略 */ }
};
const flushPending = () => { deferring = false; while (pending.length) append(pending.shift()); };
const phaseFile = (suffix) => path.join(CTL, `${sid}.${suffix}`);
const writePhase = (suffix, value) => { try { fs.mkdirSync(CTL, { recursive: true }); fs.writeFileSync(phaseFile(suffix), value || String(Date.now())); } catch { /* 忽略 */ } };
const waitFor = async (suffix) => { while (!fs.existsSync(phaseFile(suffix))) await sleep(60); };
try {
  fs.mkdirSync(CTL, { recursive: true });
  fs.appendFileSync(path.join(CTL, 'argv.log'), `${stamp()} pid=${process.pid} argv=${JSON.stringify(argv)}\n`);
  fs.writeFileSync(path.join(CTL, `${sid}.started`), stamp());
} catch { /* 忽略 */ }

const say = (text) => {
  const msg = { id: `msg_r189_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: USAGE };
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: msg });
  append({ ...base(), type: 'assistant', uuid: crypto.randomUUID(), requestId: `req_${crypto.randomBytes(4).toString('hex')}`, message: msg });
};
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(),
  result: text, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE });

async function round(userText) {
  deferring = fs.existsSync(path.join(CTL, 'defer-user'));
  const isCompact = /^\/compact\b/.test(userText);
  const content = isCompact
    ? `<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>`
    : userText;
  append({ ...base(), type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content } });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });
  try { fs.unlinkSync(phaseFile('chunk')); fs.unlinkSync(phaseFile('done')); } catch { /* 本来就没有 */ }

  if (isCompact) {
    writePhase('phase', 'compact-wait');
    await waitFor('done');
    flushPending();
    const last = lastUuidOf(TRANSCRIPT);
    append({ ...base(), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, level: 'info',
      uuid: crypto.randomUUID(), logicalParentUuid: last, compactMetadata: { trigger: 'manual', preTokens: 1000 } });
    append({ ...base(), type: 'user', uuid: crypto.randomUUID(), isCompactSummary: true, isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation. R189-COMPACT-SUMMARY' } });
    out({ type: 'system', subtype: 'compact_boundary', session_id: sid, uuid: crypto.randomUUID(), compact_metadata: { trigger: 'manual', pre_tokens: 1000 } });
    result('');
    writePhase('phase', 'final');
    return;
  }

  say(live.chunk1(userText));
  writePhase('phase', 'chunk1');
  await waitFor('chunk');
  say(live.chunk2(userText));
  writePhase('phase', 'chunk2');
  await waitFor('done');
  flushPending();
  say(live.final(userText));
  result('R189-FINAL');
  writePhase('phase', 'final');
}

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
rl.on('close', () => process.exit(0));
