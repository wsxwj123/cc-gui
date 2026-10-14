#!/usr/bin/env node
// r151a 假 claude CLI(挂在隔离实例的 PATH 上)。不发任何网络请求。三件事:
// 1) 记录:每次被拉起都往 <CTL>/spawn.jsonl 记一行 { pid, sid, cwd, argv, mode, hasAutoModeServer, autoModeServer, interactive };
//    宿主发来的每个控制请求记进 <CTL>/control.jsonl(set_permission_mode 等);本进程发出的权限询问的答复记进 <CTL>/perm-responses.jsonl。
// 2) 回合:收到一条用户消息就跑一回合。消息里带 "R151S:<名字>" 时照 <CTL>/scripts/<名字>.json(步骤数组)演;
//    否则默认:init → 一句助手回复 → result。init 里的 permissionMode = 当前档位(启动参数 --permission-mode,
//    之后随 set_permission_mode 控制请求变)。
// 3) 步骤(脚本里的每一项,按顺序):
//    {emit:{…}}                  原样吐一条事件(没带 session_id 就补上)
//    {say:"文字"}                吐一条助手文字
//    {toolUse:{id,name,input}}   吐一条助手工具调用
//    {toolResult:{tool_use_id,content,is_error}}  吐一条工具结果
//    {sleep:毫秒}                停一会儿
//    {waitFile:"名字"}           等 <CTL>/<名字> 出现(最多 60 秒)
//    {canUseTool:{…}}            向宿主发 can_use_tool 控制请求,等答复(最多 45 秒),答复记进 perm-responses.jsonl
//    {hook:{callback_id,input}}  向宿主发 hook_callback 控制请求,等答复,答复记进 hook-responses.jsonl
//    {errorIfMode:{mode,text}}   当前档位等于 mode 时以"API 错误"形态的 result 收场(文本 = text)
//    {result:{…}}                以给定字段的 result 收场
// 没写 result 的脚本,演完自动补一条成功的 result。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const CTL = process.env.CGUI_FAKE_CLAUDE_DIR || path.join(process.env.HOME || '.', 'fake-claude');
const stamp = () => new Date().toISOString();
const argOf = (n) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const p = argv.find((a) => a.startsWith(`${n}=`));
  return p ? p.slice(n.length + 1) : undefined;
};
const appendJson = (file, o) => { try { fs.mkdirSync(CTL, { recursive: true }); fs.appendFileSync(path.join(CTL, file), `${JSON.stringify(o)}\n`); } catch { /* 忽略 */ } };

const sid = argOf('--session-id') || argOf('--resume') || crypto.randomUUID();
const interactive = argv.includes('--input-format');
let mode = argOf('--permission-mode') || 'default';
const hasAMS = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CODE_AUTO_MODE_SERVER');
appendJson('spawn.jsonl', { at: stamp(), pid: process.pid, sid, cwd: process.cwd(), argv, mode, interactive,
  hasAutoModeServer: hasAMS, autoModeServer: hasAMS ? process.env.CLAUDE_CODE_AUTO_MODE_SERVER : null });

if (argv.includes('--version') || argv.includes('-v')) { console.log('99.0.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: claude [options]'); process.exit(0); }
if (['mcp', 'plugin', 'config', 'doctor', 'update', 'auth', 'setup-token'].includes(argv[0])) process.exit(0);

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL = 'r151-chat';
const PROJ = path.join(process.env.HOME || '.', '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
const transcript = (line) => { try { fs.mkdirSync(PROJ, { recursive: true }); fs.appendFileSync(path.join(PROJ, `${sid}.jsonl`), `${JSON.stringify(line)}\n`); } catch { /* 忽略 */ } };
const base = () => ({ isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd: process.cwd(), sessionId: sid, version: '2.1.296', gitBranch: '', timestamp: stamp() });
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const assistant = (content, stop = 'end_turn') => {
  const message = { id: `msg_r151_${crypto.randomBytes(4).toString('hex')}`, type: 'message', role: 'assistant', model: MODEL, content, stop_reason: stop, usage };
  const uuid = crypto.randomUUID();
  out({ type: 'assistant', session_id: sid, uuid, parent_tool_use_id: null, message });
  transcript({ ...base(), type: 'assistant', uuid, parentUuid: null, message });
};

// ---- 向宿主发控制请求并等答复 ----
const pending = new Map();
function askHost(request, file, timeoutMs) {
  const id = `r151req_${crypto.randomBytes(5).toString('hex')}`;
  out({ type: 'control_request', request_id: id, request });
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); appendJson(file, { at: stamp(), pid: process.pid, sid, request, response: null, timedOut: true }); resolve(null); }, timeoutMs);
    pending.set(id, (resp) => { clearTimeout(t); appendJson(file, { at: stamp(), pid: process.pid, sid, request, response: resp }); resolve(resp); });
  });
}

async function runTurn(text) {
  transcript({ type: 'summary', summary: String(text).slice(0, 40) || '新会话', leafUuid: crypto.randomUUID() });
  transcript({ ...base(), type: 'user', uuid: crypto.randomUUID(), parentUuid: null, message: { role: 'user', content: text } });
  let steps = null;
  const m = /R151S:([A-Za-z0-9_.-]+)/.exec(text);
  if (m) { try { steps = JSON.parse(fs.readFileSync(path.join(CTL, 'scripts', `${m[1]}.json`), 'utf8')); } catch { steps = null; } }
  // 消息里带 "R151INIT:<档位>" 时,init 里报这个档位(造"请求的档位与 CLI 实际档位不一致")
  const im = /R151INIT:([A-Za-z]+)/.exec(text);
  out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: MODEL, tools: ['Bash', 'Read', 'Edit'], mcp_servers: [], permissionMode: im ? im[1] : mode, uuid: crypto.randomUUID() });
  appendJson('turns.jsonl', { at: stamp(), pid: process.pid, sid, mode, text: String(text).slice(0, 300) });
  if (!steps) steps = [{ say: `R151-REPLY ${String(text).slice(0, 60)}` }];
  for (const s of steps) {
    if (s.emit) out({ session_id: sid, uuid: crypto.randomUUID(), ...s.emit });
    else if (typeof s.say === 'string') assistant([{ type: 'text', text: s.say }]);
    else if (s.toolUse) assistant([{ type: 'tool_use', id: s.toolUse.id, name: s.toolUse.name, input: s.toolUse.input || {} }], 'tool_use');
    else if (s.toolResult) {
      const msg = { role: 'user', content: [{ type: 'tool_result', tool_use_id: s.toolResult.tool_use_id, content: s.toolResult.content || '', is_error: Boolean(s.toolResult.is_error) }] };
      out({ type: 'user', session_id: sid, uuid: crypto.randomUUID(), parent_tool_use_id: null, message: msg });
    } else if (s.sleep) await sleep(Number(s.sleep) || 0);
    else if (s.waitFile) { const t0 = Date.now(); while (!fs.existsSync(path.join(CTL, s.waitFile)) && Date.now() - t0 < 60_000) await sleep(80); }
    else if (s.canUseTool) await askHost({ subtype: 'can_use_tool', ...s.canUseTool }, 'perm-responses.jsonl', 45_000);
    else if (s.hook) await askHost({ subtype: 'hook_callback', ...s.hook }, 'hook-responses.jsonl', 30_000);
    else if (s.errorIfMode) {
      if (mode === s.errorIfMode.mode) {
        out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, session_id: sid, uuid: crypto.randomUUID(),
          result: String(s.errorIfMode.text), duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage });
        return;
      }
    } else if (s.result) { out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage, result: 'R151-FINAL', ...s.result }); return; }
  }
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: 'R151-FINAL', duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage });
}

const printArg = argv.includes('-p') ? argv[argv.indexOf('-p') + 1] : undefined;
if (!interactive) {
  // 非交互调用(如标题生成):回一句就退出,不进脚本
  if (printArg !== undefined) {
    out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), model: MODEL, tools: [], mcp_servers: [], permissionMode: mode, uuid: crypto.randomUUID() });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, uuid: crypto.randomUUID(), result: 'R151 标题', duration_ms: 1, num_turns: 1, total_cost_usd: 0, usage });
  }
  process.exit(0);
}

const queue = [];
let running = false;
// 消息里带 "R151EXIT" 时,这一回合结束后进程自己退出(只看启动环境的用例用它,免得常驻进程越积越多)
const pump = async () => {
  if (running) return; running = true;
  while (queue.length) { const t = queue.shift(); await runTurn(t); if (/R151EXIT/.test(t)) { await sleep(400); process.exit(0); } }
  running = false;
};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_response') {
    const id = msg.response && msg.response.request_id;
    const fn = id && pending.get(id);
    if (fn) { pending.delete(id); fn(msg.response); }
    return;
  }
  if (msg.type === 'control_request') {
    const req = msg.request || {};
    appendJson('control.jsonl', { at: stamp(), pid: process.pid, sid, request: req });
    if (req.subtype === 'set_permission_mode' && typeof req.mode === 'string') mode = req.mode;
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== 'user') return;
  const c = msg.message && msg.message.content;
  queue.push(typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : ''));
  void pump();
});
rl.on('close', () => process.exit(0));
