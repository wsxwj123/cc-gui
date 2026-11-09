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
// 参数值两种写法都认：`--resume <id>`（分开）与 `--resume=<id>`（带等号；服务端实际用的是这种）。
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${n}=`));
  return eq === undefined ? undefined : eq.slice(n.length + 1);
};

// 版本/帮助探测要立刻答完并退出（留着挂住会把 CLI 探测拖到超时）。
if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }

const sid = argOf('--session-id') || argOf('--resume') || process.env.SF_SESSION_ID || crypto.randomUUID();
const cwd = process.cwd();
// GUI 会另起一个 CLI（cwd 形如 /tmp/cgui-title-*）只为给新会话起标题：它不该吃场景事件、也不该往转写里落盘
// （落盘会在侧栏多出一个名叫 cgui-title-* 的“项目”，把夹具项目挤掉）。
const TITLE_GEN = /cgui-title-/.test(cwd);
// 诊断：每次启动落一行（argv / 取到的会话 id / cwd），放在 CTL 目录之外，不会被各用例的 resetCtl 清掉。
try { fs.appendFileSync(path.join(path.dirname(CTL), 'fake-claude-spawn.jsonl'), `${JSON.stringify({ argv, sid, cwd, titleGen: TITLE_GEN })}\n`); } catch { /* 忽略 */ }
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', cwd.replace(/[/\\]/g, '-'));
const TRANSCRIPT = path.join(PROJ, `${sid}.jsonl`);
const MODEL = 'claude-sonnet-4-6';
const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 5120, cache_creation_input_tokens: 340 };

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();
const append = (line) => {
  if (TITLE_GEN) return;
  try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(TRANSCRIPT, `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ }
};
// r152a 扩展①：每个回合开始时重读 scenario（常驻进程跨回合复用时，第二回合也要吃到新场景）。
let scenario = {};
const loadScenario = () => {
  try { scenario = JSON.parse(fs.readFileSync(path.join(CTL, 'scenario.json'), 'utf8')); } catch { scenario = {}; }
};
loadScenario();

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
function toolResultLine(toolUseId, content, isError) {
  return {
    parentUuid: null, isSidechain: false, promptId: 'sf-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
    uuid: crypto.randomUUID(), timestamp: stamp(), toolUseResult: content,
    userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '',
  };
}

/** 宿主（GUI）答 can_use_tool 时走 stdin，标成已应答让下面的等待退出。 */
let answeredPermission = false;
let permissionRequestId = null;

/** 一条只含正文块的 assistant 消息（直播里按需插入的“同步标记”）。 */
function emitText(id, text) {
  const blocks = [{ type: 'text', text: text || '' }];
  out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: null, usage: USAGE } });
  append(assistantLine(id, blocks, null));
}

/** r152a 扩展②：按真实流式形态发工具入参 —— content_block_start(input:{}) + 若干 input_json_delta。
 *  streamGate：发最后一段入参之前，等 CTL 目录里出现该名字的文件（造“入参还没传完”的窗口）。 */
async function streamToolInput(id, toolId, ev, chunks) {
  const se = (event) => out({ type: 'stream_event', event, session_id: sid, parent_tool_use_id: null, uuid: crypto.randomUUID() });
  se({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } });
  se({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: ev.name || 'Bash', input: {} } });
  for (let i = 0; i < chunks.length; i += 1) {
    if (i === chunks.length - 1 && ev.streamGate) await waitForFile(ev.streamGate);
    se({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: chunks[i] } });
    await sleep(60);
  }
  se({ type: 'content_block_stop', index: 0 });
  se({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 34 } });
  se({ type: 'message_stop' });
}

async function runRound(userText) {
  loadScenario();
  if (TITLE_GEN) scenario = {};
  const pendings = [];
  // r163 扩展:{"initDelayMs":N} —— 模拟冷启动。真命令行实测(2.1.319,5 个插件 MCP + 若干钩子):发出消息后约 0.7 秒才落盘用户行 / 发 init,
  // 首个字约 5.7 秒才到(温进程第二条只要 1.2 秒)。这里在落盘用户行与发 init 之前先等 N 毫秒。
  if (scenario.initDelayMs) await sleep(scenario.initDelayMs);
  append({ type: 'summary', summary: String(userText || '').slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  append({
    parentUuid: null, isSidechain: false, promptId: 'sf-fake', type: 'user', isMeta: false,
    message: { role: 'user', content: userText },
    uuid: crypto.randomUUID(), timestamp: stamp(), permissionMode: 'default', promptSource: 'sdk',
    userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.267', gitBranch: '',
  });
  // r163 扩展:{"mcpServers":[{"name":"x","status":"pending"},…]} —— init 里带的 MCP 状态(真命令行冷启动时 15 个里 13 个非 connected,多数是 pending)。
  out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: MODEL, tools: [], mcp_servers: Array.isArray(scenario.mcpServers) ? scenario.mcpServers : [], permissionMode: 'default', uuid: crypto.randomUUID() });

  const events = Array.isArray(scenario.events) ? scenario.events : [{ kind: 'text', text: '（假 CLI：未给 scenario，默认一轮正文）' }];
  let seq = 0;
  for (const ev of events) {
    seq += 1;
    const id = `sf_fake_r_${seq}`;
    // r152a 扩展③：{"kind":"wait","file":"x"} —— 事件流停在这里，直到 CTL 目录里出现文件 x。
    if (ev.kind === 'wait') { await waitForFile(ev.file); continue; }
    // r157 扩展：{"kind":"raw","payload":{…}} —— 原样发一行 stream-json（造"压缩上下文"这类系统状态：
    // {"type":"system","subtype":"status","status":"compacting"}，形态取自 Agent SDK 公开的 SDKStatusMessage）。
    if (ev.kind === 'raw') { out({ ...ev.payload, session_id: sid, uuid: crypto.randomUUID() }); await sleep(scenario.stepDelayMs || 120); continue; }
    if (ev.kind === 'thinking') {
      const blocks = [{ type: 'thinking', thinking: ev.text, signature: 'sf-fake-sig' }];
      out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: null, usage: USAGE } });
      append(assistantLine(id, blocks, null));
    } else if (ev.kind === 'tool') {
      const toolId = `toolu_sf_${seq}_${crypto.randomBytes(3).toString('hex')}`;
      const hasInput = Object.prototype.hasOwnProperty.call(ev, 'input');
      const blocks = [{ type: 'tool_use', id: toolId, name: ev.name || 'Bash', input: hasInput ? ev.input : { command: 'echo sf' } }];
      if (Array.isArray(ev.streamChunks)) await streamToolInput(id, toolId, ev, ev.streamChunks);
      out({ type: 'assistant', session_id: sid, uuid: crypto.randomUUID(), message: { id, role: 'assistant', model: MODEL, type: 'message', content: blocks, stop_reason: 'tool_use', usage: USAGE } });
      append(assistantLine(id, blocks, 'tool_use'));
      const result = ev.result ?? '（假 CLI）命令输出';
      const emitResult = () => {
        // r157 扩展：ev.isError → tool_result 带 is_error:true（造"工具出错"的条目 / 子代理卡）。
        out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: result, ...(ev.isError ? { is_error: true } : {}) }] } });
        append(toolResultLine(toolId, result, ev.isError));
      };
      if (ev.pending) {
        // r152a 扩展④：{"kind":"tool","pending":"x"} —— 只发工具调用、不发结果；CTL 目录里出现文件 x 才补结果
        // （不挡后面的事件，所以可以造“并行发出多个、只有一部分有结果”）。afterText：补完结果后紧跟一段正文，当同步标记。
        pendings.push(waitForFile(ev.pending).then(() => {
          emitResult();
          if (ev.afterText) emitText(`${id}_after`, ev.afterText);
        }));
      } else {
        emitResult();
      }
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

  await Promise.all(pendings); // 还没补结果的 pending 工具：补完才许收尾
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
