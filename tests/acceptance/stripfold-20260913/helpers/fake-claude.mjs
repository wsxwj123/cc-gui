#!/usr/bin/env node
// 假 claude CLI：只说 stream-json，不碰实现内部。用来造"真回合"的现场
// （流式形态、收官收起、用户中断、报错、权限弹窗）—— 这些形态没有真回合就测不到。
//
// 现场由 CTL 目录（$CGUI_FAKE_CLAUDE_DIR）里的一份 scenario.json 描述：
//   {
//     "events": [ {"kind":"thinking","text":"…"},
//                 {"kind":"tool","name":"Bash","input":{…},"result":"…"},
//                 {"kind":"text","text":"…"} ],
//     "holdBeforeResult": true,          // 发完事件后停住等 CTL/release 文件（用户中断/报错用例要靠这个窗口）
//     "permission": {"tool_name":"Bash","input":{…}},   // 可选：发一条 can_use_tool 控制请求，等宿主应答
//     "end": "ok" | "error"
//   }
//
// 落盘：每发一条 assistant 事件就**立刻追加**到转写（$HOME/.claude/projects/<cwd 编码>/<sid>.jsonl），
// 所以用户中途点停止时，磁盘上已经有一条可被历史刷新接管的持久化轮 —— 这正是
// 「本地副本被持久化 turn 替换后条带仍展开」那条交接用例要的现场。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

// 版本/帮助探测要立刻答完并退出（留着挂住会把 CLI 探测拖到超时）。
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }

const sid = argOf('--session-id') || argOf('--resume') || process.env.SF_SESSION_ID || crypto.randomUUID();
const cwd = process.cwd();
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const append = (line) => {
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
const scenario = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(CTL, 'scenario.json'), 'utf8')); } catch { return {}; }
})();

const waitForFile = async (name) => {
  for (;;) {
    if (fs.existsSync(path.join(CTL, name))) return;
    await sleep(60);
  }
};

function assistantLine(id, blocks, stopReason) {
  return {
    parentUuid: null, isSidechain: false,
    message: { model: MODEL, id, type: 'message', role: 'assistant', content: blocks, stop_reason: stopReason, stop_sequence: null, stop_details: null, usage: USAGE },
    apiBlockIndex: 0, requestId: `req_${id}`, type: 'assistant',
    uuid: crypto.randomUUID(), timestamp: stamp(), effort: 'high',
    userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '',
  };
}
function toolResultLine(toolUseId, content) {
  return {
    parentUuid: null, isSidechain: false, promptId: 'sf-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    uuid: crypto.randomUUID(), timestamp: stamp(), toolUseResult: content,
    userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '',
  };
}

/** 宿主（GUI）答 can_use_tool 时走 stdin，标成已应答让下面的等待退出。 */
let answeredPermission = false;
let permissionRequestId = null;

async function runRound(userText) {
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({
    parentUuid: null, isSidechain: false, promptId: 'sf-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: userText },
    uuid: crypto.randomUUID(), timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk',
    userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '',
  });
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: [], permissionMode: 'default', uuid: crypto.randomUUID() });

  const events = Array.isArray(scenario.events) ? scenario.events : [{ kind: 'text', text: '（假 CLI：未给 scenario，默认一轮正文）' }];
  let seq = 0;
  for (const ev of events) {
    seq += 1;
    const id = `sf_fake_r_${seq}`;
    if (ev.kind === 'thinking') {
      const blocks = [{ type: 'thinking', thinking: ev.text, signature: 'sf-fake-sig' }];
      out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: null, usage: USAGE } });
      append(assistantLine(id, blocks, null));
    } else if (ev.kind === 'tool') {
      const toolId = `toolu_sf_${seq}_${crypto.randomBytes(3).toString('hex')}`;
      const blocks = [{ type: 'tool_use', id: toolId, name: ev.name || 'Bash', input: ev.input || { command: 'echo sf' } }];
      out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: 'tool_use', usage: USAGE } });
      append(assistantLine(id, blocks, 'tool_use'));
      const result = ev.result ?? '（假 CLI）命令输出';
      out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result }] } });
      append(toolResultLine(toolId, result));
    } else {
      const blocks = [{ type: 'text', text: ev.text || '' }];
      out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: null, usage: USAGE } });
      append(assistantLine(id, blocks, null));
    }
    await sleep(scenario.stepDelayMs || 120); // 让前端一帧一帧地画出来（"流式长出"的样子）
  }

  if (scenario.permission && !answeredPermission) {
    permissionRequestId = `sf-perm-${crypto.randomBytes(4).toString('hex')}`;
    out({
      type: 'control_request', request_id: permissionRequestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: scenario.permission.tool_name || 'Bash',
        input: scenario.permission.input || { command: 'rm -rf /tmp/sf-fixture' },
        permission_suggestions: [],
      },
    });
    for (let i = 0; i < 2000 && !answeredPermission; i += 1) await sleep(50); // 等宿主应答（最多 100s）
  }

  if (scenario.holdBeforeResult) await waitForFile('release');

  if (scenario.end === 'error') {
    out({
      type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, uuid: crypto.randomUUID(),
      result: scenario.errorText || '（假 CLI）这一轮故意报错',
      duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE,
    });
  } else {
    out({
      type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(),
      result: 'ok', duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: USAGE,
    });
  }
}

if (!fs.existsSync(CTL)) { try { fs.mkdirSync(CTL, { recursive: true }); } catch { /* 忽略 */ } }

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (printArg && !argv.includes('--input-format')) { await runRound(printArg); process.exit(0); }

// stdin 的读不能挡在回合里：宿主的 can_use_tool 应答（control_response）必须在
// runRound 等待期间就能被收到，所以用"事件回调 + 队列"，不许用 for await（那会在
// 回合进行中把 stdin 晾着，权限应答永远收不到）。
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
  if (msg.type === 'control_response') {
    const rid = msg.response && (msg.response.request_id || msg.request_id);
    if (!permissionRequestId || rid === permissionRequestId) answeredPermission = true;
    return;
  }
  if (msg.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  queue.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b.text || '').join('') : ''));
  void pump();
});
await new Promise((resolve) => rl.on('close', resolve));
process.exit(0);
