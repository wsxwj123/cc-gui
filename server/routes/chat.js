import { Router } from 'express';
import { spawn, execFileSync } from 'child_process';
import { dirname, join as pathJoin, isAbsolute, parse as pathParse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync, writeFileSync, unlinkSync, readdirSync, watch, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDefaultModel } from '../services/model-resolver.js';
import { dropPendingForSession, requestPermission } from './permissions.js';
import { broadcast } from '../index.js';

// T2: 回合完成 WS 通知。前端切走会话时 SSE fetch 已被 abort(I4 渲染隔离的
// 切会话 effect),完成信号唯一可靠的来源是服务端。每个进程只广播一次;三条
// stdout 路径(spawn 早期缓冲 / attached 实时 / detached 缓冲)都喂到这里。
// 客户端(useWebSocket)收到后:非当前聚焦会话 → 顶部悬浮提醒。
function maybeBroadcastTurnComplete(slot, line) {
  if (slot.completeNotified) return;
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (obj.type !== 'result') return;
  slot.completeNotified = true;
  // SDK 引擎自管子进程,slot.proc 恒为 null —— 真正关 stdin 由消息泵的 input.close() 完成。
  // (旧裸 spawn 模型遗留的 slot.proc.stdin.end() 已删,它在 SDK 路径恒为 no-op。)
  const text = typeof obj.result === 'string' ? obj.result : '';
  const cwd = String(slot.cwd || '');
  try {
    broadcast({
      type: 'turn-complete',
      sessionId: obj.session_id || slot.sessionId || null,
      // cc 的 projectHash 编码:路径中所有非字母数字字符(/ . 空格等)→ '-'
      projectHash: cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : null,
      isError: !!obj.is_error,
      summary: text.replace(/[#*`>\s]+/g, ' ').trim().slice(0, 160),
    });
  } catch {}
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const router = Router();

// 客户端断连后 detachedStdout 会持续把 stdout 推进 earlyLines。给它上限防止长
// 会话+长时间断连下无界增长 OOM。超限停止缓冲 —— 重连时 fetchMessages 从 jsonl
// 读完整历史兜底,不丢数据。
const MAX_EARLY_LINES = 5000;

// Windows:npm 装的 claude 是 claude.cmd,Node spawn 无法直接执行(.cmd 必须经
// cmd.exe;Node 出于安全也拒绝直接跑 .cmd)。这里解析真实路径并缓存:仅当它是
// .cmd/.bat 时用 cmd.exe /c 包一层,并把超长的 --settings inline JSON 落临时文件
// 传路径(避开 cmd.exe 对 JSON 引号的破坏)。非 Windows / native claude.exe 路径
// 完全不变(仍裸 'claude' + 原 args),对现有可用环境零回归。
let _winClaudePath; // undefined/null=未解析或失败(下次重试), string=路径
function resolveWinClaude() {
  if (_winClaudePath) return _winClaudePath; // 只缓存成功,失败下次重试(PATH 可能稍后才就绪)
  try {
    const out = execFileSync('where', ['claude'], { timeout: 5000 }).toString();
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // npm 同时生成无扩展名 `claude`(bash 脚本,Win 跑不了)、`claude.cmd`、`claude.ps1`。
    // 优先 .exe(直接 spawn)> .cmd/.bat(经 cmd.exe);别盲取 [0] 拿到跑不了的那个。
    _winClaudePath = lines.find((p) => /\.exe$/i.test(p))
      || lines.find((p) => /\.(cmd|bat)$/i.test(p))
      || lines[0] || null;
  } catch { _winClaudePath = null; }
  // `where` 落空 = claude 不在后端进程 PATH(GUI 启动时 npm 全局前缀没进 PATH / 自定义
  // prefix / nvm4w)。但 cmd 里 claude -v 能跑 → 前缀其实存在。用 `npm config get prefix`
  // 兜底定位(npm 本体在 Node 目录恒在 PATH),与 cli-check 检测同源,避免"检测到却 spawn 不到"。
  if (!_winClaudePath) {
    try {
      const prefix = execFileSync('cmd.exe', ['/c', 'npm', 'config', 'get', 'prefix'], { timeout: 6000 }).toString().trim();
      if (prefix && !/^undefined$/i.test(prefix)) {
        for (const cand of [pathJoin(prefix, 'claude.exe'), pathJoin(prefix, 'claude.cmd')]) {
          if (existsSync(cand)) { _winClaudePath = cand; break; }
        }
      }
    } catch {}
  }
  return _winClaudePath;
}
function settingsArgsToTempFile(args) {
  const idx = args.indexOf('--settings');
  if (idx === -1 || idx + 1 >= args.length) return { args, tempFile: null };
  const val = args[idx + 1];
  if (typeof val !== 'string' || !val.trim().startsWith('{')) return { args, tempFile: null }; // 已是路径
  try {
    const f = pathJoin(tmpdir(), `cgui-settings-${process.pid}-${Math.round(process.hrtime()[1])}.json`);
    writeFileSync(f, val, 'utf8');
    const next = args.slice();
    next[idx + 1] = f;
    return { args: next, tempFile: f };
  } catch { return { args, tempFile: null }; }
}
export function claudeSpawn(args, opts) {
  if (process.platform === 'win32') {
    const resolved = resolveWinClaude();
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      const { args: finalArgs, tempFile } = settingsArgsToTempFile(args);
      const proc = spawn('cmd.exe', ['/c', resolved, ...finalArgs], opts);
      // C5:CLI 启动即读取 --settings 文件,进程退出后删掉,避免每回合一个 cgui-settings-*.json
      // 在 Windows tmp 里持续堆积(用户报告)。
      if (tempFile) proc.on('close', () => { try { unlinkSync(tempFile); } catch {} });
      return proc;
    }
    // 解析到 .exe(或其他可直接执行路径)→ 直接 spawn 该路径,比裸 'claude' 更可靠
    // (裸名在只有 .cmd/无 .exe 的 PATH 下会 ENOENT)。
    if (resolved) return spawn(resolved, args, opts);
  }
  return spawn('claude', args, opts);
}

// Windows 残留 NUL 文件清扫。模型跑 shell 命令时常加 cmd 风格 `>NUL`/`2>NUL`,而
// GUI 在 Windows 上经 Git Bash 执行 —— `NUL` 不是空设备而是普通文件名,会在 cwd 留下
// 一个名为 NUL 的垃圾文件(用户报告:跑 teacher-paper/fetch-everything 等技能后出现)。
// 回合结束扫 cwd 顶层删之。仅匹配保留名 NUL(任何大小写),零误删风险。删除保留名文件
// 必须用 \\?\ 扩展长度前缀,否则 fs 会把 NUL 当设备而非文件。仅 Windows 生效。
function sweepWinNulFiles(dir) {
  if (process.platform !== 'win32' || !dir) return;
  try {
    for (const name of readdirSync(dir)) {
      if (/^nul$/i.test(name)) {
        try { unlinkSync('\\\\?\\' + pathJoin(dir, name)); } catch {}
      }
    }
  } catch {}
}

// Windows:回合期间实时监听整棵 cwd,NUL 文件一出现立刻删 —— 比"回合结束才扫顶层"更稳:
// ① 覆盖子目录(技能可能在子目录建 NUL);② 抢在 OneDrive 检测到非法名(NUL 是保留名)
// 弹"重命名"前删掉。递归 watch 仅 Windows 原生支持且高效;回调只对 basename=NUL 动手。
// 返回 watcher(调用方在回合结束 close 它);非 Windows / 失败返回 null。
function startWinNulWatcher(dir) {
  if (process.platform !== 'win32' || !dir) return null;
  try {
    return watch(dir, { recursive: true }, (_evt, name) => {
      if (!name) return;
      const base = String(name).split(/[\\/]/).pop();
      if (/^nul$/i.test(base)) {
        try { unlinkSync('\\\\?\\' + pathJoin(dir, name)); } catch {}
      }
    });
  } catch { return null; }
}

// 跨平台杀进程树。Windows 不支持 POSIX signal,proc.kill('SIGTERM') 只杀直接子
// (claude CLI 本身),它派生的 node/MCP 子进程留在系统里继续吃 CPU。Windows 必
// 须用 `taskkill /F /T /PID` (/T = 杀整树,/F = 强制) 才能彻底清理。Bug #1。
function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' }); } catch {}
  } else {
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000).unref();
  }
}

// procId → {
//   proc, earlyLines, earlyTail, earlyErrors, exitCode, attached,
//   sessionId, cwd, model, promptPreview, permissionMode, startedAt
// }
// Exported via getActiveChatProcesses() so the agents/processes routes can
// surface the live list to the GUI's Subagent monitor panel.
const activeProcesses = new Map();

export function getActiveChatProcesses() {
  const out = [];
  for (const [procId, slot] of activeProcesses) {
    out.push({
      pid: procId,
      sessionId: slot.sessionId || null,
      cwd: slot.cwd || null,
      model: slot.model || null,
      promptPreview: slot.promptPreview || '',
      permissionMode: slot.permissionMode || 'default',
      startedAt: slot.startedAt || null,
      finishedAt: slot.finishedAt || null,
      exitCode: slot.exitCode,
      attached: slot.attached,
    });
  }
  return out;
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

// ── SDK 引擎(@anthropic-ai/claude-agent-sdk)进程内辅助 ──────────────────────
// canUseTool 回调能拿到 ExitPlanMode / AskUserQuestion(裸 CLI -p 不注册这俩工具),
// 从而恢复"规划确认卡片"和"问题选择弹窗"。query() 吐的消息与裸 stream-json 同构
// (assistant/user/result/system/stream_event),逐条 JSON.stringify 即可按原契约喂 SSE。

// 读类工具:GUI acceptEdits/plan 档位下自动放行(不弹窗),写/Bash 等仍弹窗。
const READ_CLASS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList',
  'TaskGet', 'TaskOutput', 'TaskStop', 'NotebookRead', 'Skill', 'WebFetch', 'WebSearch',
]);
// 写类工具:acceptEdits(接受编辑)下自动放行 —— 名副其实"改文件不弹窗"(对齐官方 acceptEdits);
// plan 下永远拦(只读探索)。Bash/执行类与 MCP 不在此列,接受编辑下仍弹窗。
const WRITE_CLASS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

let sdkCounter = 0;

// 动态解析用户已装 claude(路径绝不写死,便于公开版在别人机器上跑)。解析到则让 SDK
// 指向它(避免其自带 ~237M 二进制);解析不到返回 null,SDK 回落自带二进制。PATH 已在
// index.js 的 expandClaudePath() 启动时补全(含 ~/.local/bin 等)。
let _userClaudePath; // undefined=未解析, string=路径, null=失败
function resolveUserClaude() {
  if (_userClaudePath !== undefined) return _userClaudePath;
  _userClaudePath = null;
  try {
    if (process.platform === 'win32') {
      const w = resolveWinClaude();
      if (w && /\.exe$/i.test(w)) _userClaudePath = w; // SDK 要可执行;.cmd 驱动不了,回落自带
    } else {
      const out = execFileSync('which', ['claude'], { timeout: 5000 }).toString().trim();
      if (out) _userClaudePath = out.split(/\r?\n/)[0];
    }
  } catch {}
  return _userClaudePath;
}

// 可控异步输入流:首条用户消息推进去后保持打开作 control 通道(setPermissionMode /
// interrupt 仅 streaming-input 模式可用),回合 result 到达再 close,session 干净收尾。
function makeInputQueue() {
  const q = [];
  let waiting = null;
  let closed = false;
  return {
    push(msg) {
      if (closed) return;
      if (waiting) { const w = waiting; waiting = null; w({ value: msg, done: false }); }
      else q.push(msg);
    },
    close() {
      closed = true;
      if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); }
    },
    iterable: {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (q.length) return Promise.resolve({ value: q.shift(), done: false });
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { waiting = resolve; });
      },
      return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
    },
  };
}

// 把一行消息送给 SSE:有活跃监听(已 attach)→ 实时写;否则回落 earlyLines 缓冲,
// 供下次 /stream 重连回放(detach-don't-abort)。
function deliverLine(slot, line) {
  if (slot.listeners.size) { for (const fn of slot.listeners) { try { fn(line); } catch {} } }
  else if (slot.earlyLines.length < MAX_EARLY_LINES) slot.earlyLines.push(line);
}

// 消息泵结束(result 后 generator 自然结束 / 出错 / 中断)收尾一次。
function finishSlot(slot, procId) {
  if (slot.pumpEnded) return;
  slot.pumpEnded = true;
  if (slot.exitCode === null) slot.exitCode = 0;
  slot.finishedAt = Date.now();
  try { slot.nulWatcher?.close(); } catch {}
  sweepWinNulFiles(slot.cwd);
  if (slot.sessionId) { try { dropPendingForSession(slot.sessionId); } catch {} }
  // done:client 据此结束 SSE 读取。attach 中直接发;否则缓冲,等 attach 回放后收尾。
  deliverLine(slot, JSON.stringify({ type: 'done', exitCode: slot.exitCode }));
  setTimeout(() => activeProcesses.delete(procId), 60_000);
}

// 统一权限回调:复刻旧 hook 的集中分级。AskUserQuestion / ExitPlanMode 必弹卡;普通工具
// 按 slot.guiMode(可被 /chat/permission-mode 中途改)放行或弹窗。
// MCP 自动放行:GUI 里勾了"自动执行"的 server,其工具(mcp__<server>__*)直接放行不弹窗。
// 列表 ~/.claude/gui/mcp-autoapprove.json(GUI 写)。旧版在 permission-bridge hook 里读,
// 迁 SDK 后那个 hook 不再被调,必须在 canUseTool 里补回(否则勾了自动执行仍每次弹窗)。
function mcpAutoApproved(toolName) {
  if (!/^mcp__/.test(toolName)) return false;
  try {
    const list = JSON.parse(readFileSync(pathJoin(homedir(), '.claude', 'gui', 'mcp-autoapprove.json'), 'utf8'));
    if (!Array.isArray(list) || !list.length) return false;
    const seg = toolName.replace(/^mcp__/, '').split('__')[0];
    const norm = (s) => String(s).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return list.some((n) => n === seg || norm(n) === norm(seg));
  } catch { return false; }
}

function makeCanUseTool(slot) {
  return async (toolName, input) => {
    const ask = () => requestPermission({ toolName, toolInput: input, sessionId: slot.sessionId, cwd: slot.cwd });
    if (toolName === 'AskUserQuestion') {
      const r = await ask();
      if (r.decision === 'allow') {
        const ui = (r.updatedInput && typeof r.updatedInput === 'object')
          ? r.updatedInput : { questions: input.questions || [], answers: {} };
        return { behavior: 'allow', updatedInput: ui };
      }
      return { behavior: 'deny', message: r.reason || '用户取消了提问' };
    }
    if (toolName === 'ExitPlanMode') {
      const r = await ask();
      if (r.decision === 'allow') {
        // 批准计划 → 切到执行档(写仍弹窗)。SDK 模式切换由前端额外 POST /chat/permission-mode
        // 完成;这里更新 guiMode 供本回合后续 canUseTool 判定。
        slot.guiMode = 'acceptEdits';
        return { behavior: 'allow', updatedInput: input };
      }
      // CQ-6:用户点"修改"= deny。强化回写文案,明确要求模型【修订后再次调用 ExitPlanMode
      // 重新提交计划】,不要直接开始执行——否则模型常把 deny 当"放行去做"而在规划模式下直接动手。
      const refineReason = r.reason || '用户要求修改计划';
      return { behavior: 'deny', message: `${refineReason}\n\n请根据以上反馈修订计划,然后再次调用 ExitPlanMode 重新提交修订后的计划等待用户确认。在计划获批前不要开始执行实际改动。` };
    }
    const mode = slot.guiMode;
    if (mode === 'bypassPermissions') return { behavior: 'allow', updatedInput: input };
    // 接受编辑:只读类 + 文件写入/编辑类自动放行(名副其实=改文件不弹窗,对齐官方 acceptEdits);
    // Bash/执行类与 MCP 仍走下面的弹窗。这才和"默认"拉开区别(默认下改文件也要弹窗)。
    if (mode === 'acceptEdits' && (READ_CLASS.has(toolName) || WRITE_CLASS.has(toolName))) {
      return { behavior: 'allow', updatedInput: input };
    }
    // plan = 只读探索:除写类(SDK plan 模式本就拦)外,探索工具(Bash/Read/Grep 等)一律自动
    // 放行,复刻旧 permission-bridge 的 plan 行为。ExitPlanMode/AskUserQuestion 已在上面单独处理。
    if (mode === 'plan') {
      if (!WRITE_CLASS.has(toolName)) return { behavior: 'allow', updatedInput: input };
    }
    if (mcpAutoApproved(toolName)) return { behavior: 'allow', updatedInput: input };
    const r = await ask();
    if (r.decision === 'allow') {
      const ui = (r.updatedInput && typeof r.updatedInput === 'object') ? r.updatedInput : input;
      return { behavior: 'allow', updatedInput: ui };
    }
    return { behavior: 'deny', message: r.reason || '用户拒绝执行该工具' };
  };
}

router.post('/chat', async (req, res) => {
  const {
    prompt, sessionId, cwd,
    model: requestedModel,
    effort, addDirs,
    permissionMode,
    globalRead,
    appendSystemPrompt,
    agent,
    promptSuggestions,
    excludeDynamicSystemPrompt,
  } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const model = requestedModel || await getDefaultModel();
  // DO NOT normalize cwd here. Claude CLI hashes the EXACT cwd string to
  // locate the session jsonl under ~/.claude/projects/<hash>/. Sessions
  // created with a malformed cwd (e.g. `/Users/foo/bar////`) live in
  // `-Users-foo-bar----` dirs. If we normalize cwd before spawning,
  // CLI computes a different hash and resume fails with "No conversation
  // found with session ID". The client sends the cwd that matches each
  // session's original storage; we trust it as-is for CLI spawn.
  const workingDir = cwd || homedir(); // CO-1:Windows 上 process.env.HOME 为空,用 homedir()

  // Validate the working dir exists and is a directory. A session whose project
  // folder was deleted or moved (e.g. a stale cwd like /Desktop/gui) otherwise
  // makes the CLI sit ~3min in an invalid dir before exiting 1 — surfacing in
  // the UI as a stuck "connecting" with no reply. Fail fast with a clear message.
  try {
    if (!statSync(workingDir).isDirectory()) throw new Error('not a directory');
  } catch {
    return res.status(400).json({
      error: `工作目录不存在或无法访问：${workingDir}\n该项目可能已被删除或移动，请在左侧选择一个有效的项目后重试。`,
    });
  }

  const chosenMode = (permissionMode && VALID_PERMISSION_MODES.has(permissionMode))
    ? permissionMode : 'default';
  // SDK permissionMode:仅 plan 用 'plan'(让模型产出计划并经 canUseTool 弹 ExitPlanMode);
  // GUI 的 default/acceptEdits/bypassPermissions 一律用 SDK 'default',放行/弹窗由 canUseTool
  // 按 slot.guiMode 决定(集中分级,复刻旧 hook 的语义)。
  const sdkPermMode = chosenMode === 'plan' ? 'plan' : 'default';

  // additionalDirectories = SDK 的文件访问沙箱边界(越界读会在 FS 层被挡、**不经 canUseTool**,
  // 故无授权卡可弹——用户报"沙箱限制读不了本地文件却不弹卡片"的根因)。
  // CO-1:① 用 homedir() 而非 process.env.HOME——Windows 上 HOME 为空(它用 USERPROFILE),
  //   原写法导致 Windows 家目录都没加进可读范围,读任何本地文件都被挡。
  //   ② globalRead 时直接放开整盘"读"(posix 加 '/';win 加 cwd/home 所在盘根)——这是本地单用户
  //   工具,用户明确要读本机文件;写入仍走 canUseTool(默认模式弹卡),故只放宽读、不放宽写,安全。
  const dirSet = new Set();
  if (globalRead) {
    dirSet.add(homedir());
    if (process.platform === 'win32') {
      try { const r = pathParse(workingDir).root; if (r) dirSet.add(r); } catch {}
      try { const r = pathParse(homedir()).root; if (r) dirSet.add(r); } catch {}
    } else {
      dirSet.add('/');
    }
  }
  if (Array.isArray(addDirs)) {
    for (const d of addDirs) if (typeof d === 'string' && isAbsolute(d)) dirSet.add(d);
  }

  // env:剥掉继承的 ANTHROPIC_* 路由/鉴权 + 宿主 CLAUDE_CODE_* 标识,provider 由
  // settings.json(或 OAuth 钥匙串)决定。SDK 的 env 选项是"整体替换",传剥好的全量。
  const childEnv = cleanChildEnv();

  const procId = 'sdk-' + (++sdkCounter);
  const abort = new AbortController();
  const input = makeInputQueue();
  const slot = {
    proc: null,           // SDK 自管子进程,无直接 proc 句柄(stop 走 interrupt/abort)
    query: null,
    input,
    abort,
    earlyLines: [],
    earlyErrors: [],
    listeners: new Set(), // 活跃 SSE 写函数(attach 加,断连删)
    exitCode: null,
    pumpEnded: false,
    attached: false,
    sessionId: sessionId || null,
    cwd: workingDir,
    model,
    promptPreview: String(prompt).slice(0, 80),
    permissionMode: permissionMode || 'default',
    guiMode: chosenMode,
    startedAt: Date.now(),
  };
  activeProcesses.set(procId, slot);
  slot.nulWatcher = startWinNulWatcher(workingDir);

  // 首条用户消息(streaming-input);保持 input 打开作 control 通道。
  input.push({ type: 'user', message: { role: 'user', content: String(prompt) } });

  // CQ:规划模式下追加(而非替换)行为引导——修第 10/11 项并强化第 6 项。不用 SDK 的
  // planModeInstructions(它会整段替换默认计划工作流 body,丢失原生规划逻辑),改成 append
  // 叠加在 claude_code preset 上,additive、低风险:① 提问走 AskUserQuestion 工具而非写进
  // 计划正文(第10);② 计划批准后用 TaskCreate 拆任务清单跟踪(第11);③ 被要求"修改"时
  // 修订后再次 ExitPlanMode 重新提交、不要直接开始执行(第6,与下方 deny 文案双保险)。
  let appendText = (typeof appendSystemPrompt === 'string') ? appendSystemPrompt.trim() : '';
  if (sdkPermMode === 'plan') {
    const planGuide = '【规划模式补充指引】1) 若需要向用户提问以澄清需求,必须调用 AskUserQuestion 工具,不要把问题直接写进 ExitPlanMode 的计划正文里。2) 计划被用户批准、进入执行后,请用 TaskCreate 把计划拆成任务清单并逐项更新状态,让用户能看到进度。3) 若用户对计划反馈"需要修改",请据此修订计划后【再次调用 ExitPlanMode】重新提交、等待确认,不要直接开始执行。';
    appendText = appendText ? `${appendText}\n\n${planGuide}` : planGuide;
  }
  const systemPrompt = appendText
    ? { type: 'preset', preset: 'claude_code', append: appendText.slice(0, 8000) }
    : { type: 'preset', preset: 'claude_code' };
  // 缓存优化(对应 CLI --exclude-dynamic-system-prompt-sections):把工作目录 / auto-memory /
  // git 状态等每轮变化的动态段移出系统提示、由 SDK 改注入首条用户消息,使系统提示静态可缓存,
  // 提升第三方 provider 前缀缓存命中。仅加系统提示选项,不影响消息泵/关流时序。
  if (excludeDynamicSystemPrompt === true) systemPrompt.excludeDynamicSections = true;

  const options = {
    model,
    // 默认 SDK 不带 Claude Code 系统提示 → 必须显式 preset 才复刻 CLI 行为(工具集/CLAUDE.md 等)。
    systemPrompt,
    // 必须含 user/project/local 才加载 settings.json(=第三方 provider 配置)与 CLAUDE.md。
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    permissionMode: sdkPermMode,
    canUseTool: makeCanUseTool(slot),
    // 返回 {continue:true} 的 no-op PreToolUse hook。注:曾以为它修 "Stream closed",经 opus
    // 实证那是误判(真因是子代理打穿 canUseTool 通道,见 disallowedTools 那段);此 hook 对
    // TS 无实质作用(官方那条"需 dummy hook"只针对 Python)。保留作无害保险(保持流活性)。
    hooks: {
      PreToolUse: [{ hooks: [async () => ({ continue: true })] }],
    },
    cwd: workingDir,
    env: childEnv,
    additionalDirectories: [...dirSet],
    abortController: abort,
    stderr: (d) => { const t = String(d).trim(); if (t) deliverLine(slot, JSON.stringify({ type: 'stderr', text: t })); },
  };
  if (effort && VALID_EFFORTS.has(effort)) options.effort = effort;
  // 输入预测:每回合末 SDK 发一条 prompt_suggestion(在 result 之后,蹭父回合缓存
  // 几乎免费;首轮/plan 模式/API 错误后 SDK 自己不发)。开启时消息泵的关流时序对应放宽。
  const suggestOn = promptSuggestions === true;
  if (suggestOn) options.promptSuggestions = true;
  // --agent 仅新会话首轮(会话级设定,resume 时传会被拒)。
  if (typeof agent === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(agent) && !sessionId) options.agent = agent;
  if (sessionId) options.resume = sessionId;
  const claudePath = resolveUserClaude();
  if (claudePath) options.pathToClaudeCodeExecutable = claudePath;

  // 每条消息都打完整结构体(含 cwd/提示词片段)——默认噪声且日志转发时算轻微信息泄漏。
  // 仅 DEBUG 下打印。
  if (process.env.DEBUG || process.env.CGUI_DEBUG) {
    console.log('[chat] sdk', JSON.stringify({
      procId, cwd: workingDir, sessionId: sessionId || null, model,
      permissionMode: chosenMode, claudePath: claudePath || '(bundled)',
      promptPreview: String(prompt).slice(0, 60),
    }));
  }

  let q;
  try {
    q = query({ prompt: input.iterable, options });
    slot.query = q;
  } catch (err) {
    activeProcesses.delete(procId);
    return res.status(500).json({ error: 'query() failed: ' + err.message });
  }

  // 消息泵:迭代 SDK 生成器,逐条转 stream-json 行喂 SSE。
  //
  // 关闭 input(=stdin)的时机是关键 —— stdin 同时是 control 通道,canUseTool 的响应经它回写。
  // 过早关(在"中间 result"上关)会让后续回合的 control 请求写不进去 → CLI 等不到响应 →
  // "Stream closed"、计划/提问卡片弹不出。这是规划模式起子代理后卡片弹不出的真根因(实证:
  // 子代理跑完先吐一个 result、父进程随后再开一回合调 ExitPlanMode/AskUserQuestion;旧代码在
  // 那个中间 result 上就 input.close() 关了 stdin)。而 result 事件没有任何字段能区分"中间/最终"
  // (session_id/subtype/num_turns 实测全一样),唯一可靠信号是时序:最终 result 之后再无事件。
  // 解法:只有"本回合起过子代理"时才对 result 去抖关闭(随后任何事件即取消=还有回合,最终
  // result 后 4s 静默到点才真正关);没起子代理的普通回合只有一个 result,立即关——零延迟、零回归。
  // 同时修好 CG-2(非规划模式"子代理后再要授权"也是同一根因)。
  let subagentSeen = false;
  let closeTimer = null;
  let lastResultLine = null;
  const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };
  const finalize = () => {
    cancelClose();
    if (lastResultLine) maybeBroadcastTurnComplete(slot, lastResultLine); // 回合完成 WS 只在最终 result 播
    try { input.close(); } catch {}
  };
  (async () => {
    try {
      for await (const m of q) {
        const line = JSON.stringify(m);
        if (!slot.sessionId && m.type === 'system' && m.subtype === 'init' && m.session_id) {
          slot.sessionId = m.session_id;
        }
        if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          for (const b of m.message.content) {
            if (b?.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')) subagentSeen = true;
          }
        }
        deliverLine(slot, line);
        if (m.type === 'result') {
          lastResultLine = line;
          // 关流延迟:子代理回合沿用 4s 去抖;开了输入预测时 suggestion 在 result 之后
          // 才到,必须给等待窗(3s;SDK 不发时到点正常收尾)。都没有则立即关,零延迟。
          const delay = subagentSeen ? 4000 : (suggestOn ? 3000 : 0);
          if (delay) { cancelClose(); closeTimer = setTimeout(finalize, delay); }
          else finalize();
        } else if (m.type === 'prompt_suggestion') {
          // 建议是本回合最后一条消息:result 已到(closeTimer 在挂)就立即收尾,
          // 不能走下面的 cancelClose 分支——那会把关闭取消掉、进程挂死等不到下一条。
          if (closeTimer) finalize();
        } else if (closeTimer) {
          cancelClose(); // result 之后又来事件 → 那个 result 不是最终的,取消关闭等下一个
        }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') {
        deliverLine(slot, JSON.stringify({ type: 'error', error: e?.message || String(e) }));
      }
    } finally {
      cancelClose();
      if (lastResultLine) maybeBroadcastTurnComplete(slot, lastResultLine);
      input.close();
      finishSlot(slot, procId);
    }
  })();

  res.json({ pid: procId, model });
});


// 回合进行中切权限模式 —— SDK setPermissionMode(streaming-input 模式即时生效)。
// GUI 档位映射:plan→SDK 'plan';其余→SDK 'default'(放行/弹窗由 canUseTool 按 guiMode 判)。
// 批准计划后"执行"也走这里(前端把档位切到 acceptEdits)。已结束/无 query 的 slot 跳过。
router.post('/chat/permission-mode', async (req, res) => {
  const { sessionId, mode } = req.body || {};
  if (!sessionId || !mode || !VALID_PERMISSION_MODES.has(mode)) {
    return res.status(400).json({ error: 'sessionId 与合法 mode 必填' });
  }
  const sdkMode = mode === 'plan' ? 'plan' : 'default';
  let delivered = 0;
  for (const slot of activeProcesses.values()) {
    if (slot.sessionId !== sessionId || slot.exitCode !== null || !slot.query) continue;
    try {
      await slot.query.setPermissionMode(sdkMode);
      slot.guiMode = mode;
      slot.permissionMode = mode;
      delivered++;
    } catch {}
  }
  res.json({ ok: true, delivered });
});


// SSE attach。SDK 引擎下消息由 slot.listeners 实时推送(deliverLine),不再监听 proc.stdout。
// 断连不杀 query(detach-don't-abort):移除监听后续消息回落 earlyLines,重连回放。
router.get('/chat/:pid/stream', (req, res) => {
  const slot = activeProcesses.get(req.params.pid);
  if (!slot) return res.status(404).json({ error: 'Process not found' });
  if (slot.attached) return res.status(409).json({ error: 'Stream already attached' });
  slot.attached = true;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Safe write — 客户端中途断连后 res 不可写,写入会同步抛 EPIPE;吞掉避免崩进程。
  let closed = false;
  let keepAlive = null;
  const safeWrite = (data) => {
    if (closed || !res.writable) return false;
    try { res.write(data); return true; } catch { closed = true; return false; }
  };
  const safeEnd = () => {
    if (closed) return;
    closed = true;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    try { res.end(); } catch {}
  };

  // 每一行消息:写给 client;若是 done 事件则收尾 SSE。
  const onLine = (line) => {
    if (!safeWrite('data: ' + line + '\n\n')) return;
    if (line.indexOf('"type":"done"') !== -1) {
      try { if (JSON.parse(line).type === 'done') safeEnd(); } catch {}
    }
  };

  // 回放断连/未 attach 期间缓冲的行(可能含已缓冲的 done → onLine 里收尾)。
  for (const l of slot.earlyLines) { if (!closed) onLine(l); }
  for (const e of slot.earlyErrors) safeWrite(`data: ${JSON.stringify({ type: 'error', error: e })}\n\n`);
  slot.earlyLines.length = 0;
  slot.earlyErrors.length = 0;

  // 泵已结束但 done 没缓冲到(竞态兜底):补发一个。
  if (!closed && slot.pumpEnded) onLine(JSON.stringify({ type: 'done', exitCode: slot.exitCode ?? 0 }));

  if (!closed) {
    // SSE 心跳:大会话首 token 前可能 20s+,空闲连接会被网络/WebView 掐断造成假"无返回"。
    // ': ' 前缀行被客户端忽略,只为保活。
    keepAlive = setInterval(() => {
      if (!safeWrite(': keep-alive\n\n')) { clearInterval(keepAlive); keepAlive = null; }
    }, 10000);
    slot.listeners.add(onLine);
  }

  req.on('close', () => {
    closed = true;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    slot.listeners.delete(onLine);
    slot.attached = false; // 后续消息回落 earlyLines,等重连回放
  });
});

router.post('/chat/:pid/stop', async (req, res) => {
  const slot = activeProcesses.get(req.params.pid);
  if (!slot) return res.status(404).json({ error: 'Process not found' });
  // SDK:interrupt 让当前回合优雅停;abort 兜底强停;close input 让 generator 收尾。
  try { await slot.query?.interrupt?.(); } catch {}
  try { slot.abort?.abort(); } catch {}
  try { slot.input?.close(); } catch {}
  res.json({ ok: true });
});

// POST /api/chat/title  { firstUser, firstAssistant?, cwd? }
// One-shot, isolated `claude -p` call that summarizes the opening exchange into a
// short session title. Does NOT --resume any session (writes no session jsonl) and
// injects no permission hook. Env is stripped the same way as the main chat spawn so
// the user's configured provider (settings.json) is honoured, not inherited official
// ANTHROPIC_* vars. Best-effort: any failure → 200 with empty title so the client
// silently falls back to the first message.
router.post('/chat/title', async (req, res) => {
  const firstUser = String(req.body?.firstUser || '').slice(0, 2000).trim();
  const firstAssistant = String(req.body?.firstAssistant || '').slice(0, 1500).trim();
  // 会话当前模型:标题必须用和正文同一个 provider+模型,否则落到 settings.json 的
  // small/fast 默认(如不存在的 mimo-v2.5)→ 标题永远失败(用户报告)。剥掉 [1m] 后缀。
  const model = String(req.body?.model || '').replace(/\[1m\]/i, '').trim();
  if (!firstUser) return res.json({ title: '' });

  // CI-6:斜杠命令开场的标题。首条是 `/xxx`(或 jsonl 里的 <command-name> 包裹形态)时,
  // 直接把它喂给模型会得到"没有看到需要起标题的对话内容,请把对话粘贴过来"这类反问
  // (用户实报)。剥掉包裹取实义(命令的 args 才是用户真实诉求);剥完为空(纯命令无
  // 参数)则直接用命令本身当标题,不调模型。
  let titleSource = firstUser;
  const cmdNameM = firstUser.match(/<command-name>\s*([^<]*?)\s*<\/command-name>/);
  if (cmdNameM) {
    const cmdArgsM = firstUser.match(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/);
    const cmdArgs = cmdArgsM ? cmdArgsM[1].trim() : '';
    if (!cmdArgs) return res.json({ title: cmdNameM[1].trim().slice(0, 24) });
    titleSource = cmdArgs;
  } else if (/^\/\S/.test(firstUser)) {
    // GUI 直发的纯斜杠形态:`/name` 或 `/name args`
    const slashM = firstUser.match(/^(\/\S+)\s*([\s\S]*)$/);
    const cmdArgs = (slashM?.[2] || '').trim();
    if (!cmdArgs) return res.json({ title: firstUser.slice(0, 24) });
    titleSource = cmdArgs;
  }

  // 提示词硬化:模型对超短输入(如 "hi")常输出"当前会话内容比较简单…"这类元话术解释
  // 而非标题(用户实报)。明确"无论多简单都必须给标题、禁止解释",配合下方 finish 的兜底双保险。
  const prompt = `给下面这段对话起一个简短中文标题。要求:只输出标题本身,不超过 16 个字,不加引号、不加标点、不加任何解释;无论对话内容多简单(哪怕只是一句问候),都必须给出一个描述性标题,禁止输出"内容比较简单""请提供更多信息"之类的说明文字。\n\n用户: ${titleSource}\n${firstAssistant ? `助手: ${firstAssistant}\n` : ''}`;

  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_MODEL;
  delete childEnv.CLAUDE_MODEL;
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_PERMISSION_MODE', 'CLAUDE_PERMISSION_MODE', 'CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS']) {
    delete childEnv[k];
  }
  stripHostClaudeEnv(childEnv);

  let proc;
  try {
    // --no-session-persistence:标题生成是一次性调用,绝不能落盘成会话 jsonl,否则项目
    // 会话列表里会冒出"给下面这段对话起标题…"的空白会话(刷新后可见,用户报告 #5)。
    const titleArgs = ['-p', prompt, '--permission-mode', 'plan', '--no-session-persistence'];
    if (model) titleArgs.push('--model', model);
    proc = claudeSpawn(titleArgs, {
      cwd: typeof req.body?.cwd === 'string' && req.body.cwd ? req.body.cwd : homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
  } catch {
    return res.json({ title: '' });
  }
  if (!proc.pid) return res.json({ title: '' });
  // stderr 设了 pipe 但下面只读 stdout —— 不排空的话 CLI 往 stderr 写超 ~64KB(TCC/MCP 警告等)
  // 会撑爆管道缓冲区 → 子进程阻塞 → close 永不触发 → 卡到超时。drain 掉即可(标题生成用不到 stderr)。
  proc.stderr?.resume();

  let out = '';
  let done = false;
  const finish = (title) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { killProcessTree(proc); } catch {}
    // 清洗:去引号/换行/常见前缀(先不截断,元话术判定要看原始长度)
    const clean = String(title || '')
      .replace(/[\r\n]+/g, ' ')
      .replace(/^["'「『]+|["'」』]+$/g, '')
      .replace(/^(标题|title)\s*[:：]\s*/i, '')
      .trim();
    // 元话术兜底:提示词硬化后模型仍可能输出"当前会话内容比较简单…"这类解释当标题。
    // 命中特征(超长 / 整句以句号结尾 / 元话术关键词且偏长)一律丢弃,回退用户消息截断。
    const isMeta =
      clean.length > 30 ||
      /[。.]\s*$/.test(clean) ||
      /比较简单|请提供|无法生成|没有(看到|提供)/.test(clean) ||
      (clean.length > 20 && /会话|对话|内容|无法/.test(clean));
    const finalTitle = (!clean || isMeta)
      ? titleSource.replace(/\s+/g, ' ').trim().slice(0, 24)
      : clean.slice(0, 24);
    res.json({ title: finalTitle });
  };
  const timer = setTimeout(() => finish(out), 30000);
  proc.stdout.on('data', (c) => { out += c.toString(); });
  proc.on('close', () => finish(out));
  proc.on('error', () => finish(''));
});

// ── Context breakdown (#1) ────────────────────────────────────────────────
// Run the CLI's `/context` slash command against a FORKED copy of the session
// (--fork-session → new session id, original jsonl untouched) and parse the
// markdown table it emits. /context 不走主对话模型,但对每个分类(系统提示/工具/
// MCP/agents/memory/skills/messages)各打一次 count_tokens(免费但有网络往返,回退还
// 会真调 haiku) + CLI 冷启动,合计 5~30s —— 不是"纯本地",慢的根因在此。GUI 侧已
// 改为后台探测一次即缓存明细,弹层秒读缓存(AA1)。afterwards 删除 forked jsonl。
// X2(深层):剥离【宿主 Claude Code 会话】的标识变量。当 GUI app 从一个正在运行的
// claude 会话里被启动(macOS `open -a` 会透传调用方环境)时,server 继承了
// CLAUDECODE=1 / CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_ENTRYPOINT / SDK 握手标志等
// 整套宿主变量并透传给子 CLI —— 子进程自认嵌套在宿主里,启动即挂死(/context 全部
// 30s 超时的根因;dev server 同代码因 env 干净而正常,A/B 实锤)。这些变量只属于
// 宿主会话,GUI 的任何子 CLI 都不该见到。
export function stripHostClaudeEnv(env) {
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_/.test(k) || /^CLAUDE_AGENT_/.test(k)) delete env[k];
  }
  for (const k of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_EFFORT', 'API_TIMEOUT_MS',
    'ENABLE_TOOL_SEARCH', 'MCP_CONNECTION_NONBLOCKING', 'DISABLE_MICROCOMPACT', 'DISABLE_AUTOUPDATER']) {
    delete env[k];
  }
  return env;
}

export function cleanChildEnv() {
  const env = { ...process.env };
  for (const k of [
    'ANTHROPIC_MODEL', 'CLAUDE_MODEL',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_PERMISSION_MODE', 'CLAUDE_PERMISSION_MODE', 'CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS',
  ]) delete env[k];
  return stripHostClaudeEnv(env);
}

function parseTokNum(s) {
  s = String(s).trim().replace(/,/g, '');
  const m = s.match(/^([\d.]+)\s*([kKmM]?)/);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (/k/i.test(m[2])) n *= 1000;
  else if (/m/i.test(m[2])) n *= 1_000_000;
  return Math.round(n);
}

function parseContextMarkdown(md) {
  const out = { model: null, totalTokens: 0, windowTokens: 0, pct: 0, categories: [], mcpServers: [] };
  const mm = md.match(/\*\*Model:\*\*\s*(.+)/);
  if (mm) out.model = mm[1].trim();
  const tk = md.match(/\*\*Tokens:\*\*\s*([\d.,kKmM]+)\s*\/\s*([\d.,kKmM]+)\s*\((\d+)%\)/);
  if (tk) { out.totalTokens = parseTokNum(tk[1]); out.windowTokens = parseTokNum(tk[2]); out.pct = parseInt(tk[3], 10); }
  // Category table is everything before the "### MCP Tools" per-tool section.
  // BK-9:/context 在 ### MCP Tools 之后还有 ### Custom Agents / ### Memory Files /
  // ### Skills 等小节(行格式同为 `| 名称 | 来源 | tokens |`)。只取 MCP Tools 到下一个
  // ### 标题之间,否则后面那些小节的"来源"列(User/Built-in/CLAUDE.md 路径等)会被
  // 误聚合成 MCP 服务器(用户报"MCP 里冒出 User/CLAUDE.md")。
  const [catSection, mcpRest = ''] = md.split(/###\s*MCP Tools/i);
  const mcpSection = mcpRest.split(/\n###\s/)[0];
  for (const line of catSection.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([\d.,kKmM]+)\s*\|\s*([\d.]+)%\s*\|/);
    if (!m) continue;
    const name = m[1].trim();
    if (/^category$/i.test(name) || /^-+$/.test(name)) continue;
    out.categories.push({ name, tokens: parseTokNum(m[2]), pct: parseFloat(m[3]) });
  }
  // Aggregate per-tool MCP rows into per-server totals.
  const byServer = {};
  for (const line of mcpSection.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([\d.,kKmM]+)\s*\|/);
    if (!m) continue;
    const tool = m[1].trim();
    const server = m[2].trim();
    if (/^tool$/i.test(tool) || /^-+$/.test(tool)) continue;
    byServer[server] = (byServer[server] || 0) + parseTokNum(m[3]);
  }
  out.mcpServers = Object.entries(byServer)
    .map(([server, tokens]) => ({ server, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  return out;
}

router.get('/context/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const cwd = req.query.cwd || homedir(); // CO-1:Windows HOME 为空 → homedir()
  const projectHash = req.query.projectHash || '';
  // V2:不带 --model 时 CLI 按 settings.json 默认模型(如 haiku)计算窗口与显示,
  // 与会话实际模型不符(用户报告:点徽章显示 haiku)。前端把会话当前模型传进来。
  const model = String(req.query.model || '').trim();
  try { if (!statSync(cwd).isDirectory()) throw new Error('nd'); }
  catch { return res.status(400).json({ error: '工作目录无效' }); }

  const args = [
    '-p', '/context',
    '--output-format', 'stream-json',
    '--verbose',
    '--resume', sessionId,
    '--fork-session',
    // 不落盘:/context 只是读当前上下文,fork 副本不该留在磁盘(否则也会冒出空白会话)。
    '--no-session-persistence',
  ];
  if (model) args.push('--model', model);
  let proc;
  try {
    proc = claudeSpawn(args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: cleanChildEnv() });
  } catch (e) { return res.status(500).json({ error: 'spawn claude failed: ' + e.message }); }
  if (!proc.pid) { proc.on('error', () => {}); return res.status(500).json({ error: 'claude CLI not found' }); }
  // 同 /chat/title:stderr 是 pipe 但只读 stdout,必须排空,否则 stderr 超 ~64KB 子进程挂死到超时。
  proc.stderr?.resume();

  let out = '';
  let forkedSid = null;
  let done = false;
  const cleanupFork = () => {
    if (forkedSid && projectHash && forkedSid !== sessionId) {
      try { unlinkSync(pathJoin(homedir(), '.claude', 'projects', projectHash, `${forkedSid}.jsonl`)); } catch {}
    }
  };
  const finish = (payload, code = 200) => {
    if (done) return; done = true;
    clearTimeout(timer);
    try { killProcessTree(proc); } catch {}
    cleanupFork();
    if (!res.headersSent) res.status(code).json(payload);
  };
  const timer = setTimeout(() => finish({
    // X2:实测超时的常见根因不是 CLI 慢,而是 macOS TCC —— 重装/升级 GUI 后
    // cdhash 变化,完全磁盘访问的旧授权"显示勾选实为失效",子进程 open() 被挂起。
    error: '/context 超时。若反复出现：系统设置→隐私与安全性→完全磁盘访问 里把 Claude GUI 关掉再打开，然后重启应用（重装后旧授权会失效）。',
  }, 504), 30000);

  proc.stdout.on('data', (c) => {
    out += c.toString();
    if (!forkedSid) {
      for (const ln of out.split('\n')) {
        if (!ln.trim()) continue;
        try { const o = JSON.parse(ln); if (o.type === 'system' && o.subtype === 'init' && o.session_id) { forkedSid = o.session_id; break; } } catch {}
      }
    }
  });
  proc.on('close', () => {
    let md = '';
    for (const ln of out.split('\n')) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln);
        if (o.type === 'result' && typeof o.result === 'string' && o.result.includes('Context Usage')) md = o.result;
      } catch {}
    }
    if (!md) return finish({ error: '未获取到 /context 输出' }, 502);
    finish({ raw: md, ...parseContextMarkdown(md) });
  });
  proc.on('error', (e) => finish({ error: e.message }, 500));
});

export default router;
