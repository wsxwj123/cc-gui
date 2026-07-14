import { Router } from 'express';
import { spawn, execFileSync } from 'child_process';
import { dirname, join as pathJoin, isAbsolute, parse as pathParse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync, writeFileSync, unlinkSync, readdirSync, watch, existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDefaultModel } from '../services/model-resolver.js';
import { dropPendingForSession, requestPermission } from './permissions.js';
import { buildAlwaysAllowUpdates, buildDirAuthUpdates } from '../utils/permission-rules.js';
import { resolveClaude } from '../utils/claude-resolver.js';
import { broadcast } from '../broadcast.js';

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
// 模型名白名单:一次性 spawn(title/context/compact)把 model 当 `--model <v>` 参数传,
// Windows 走 cmd.exe /c,libuv 不给不含空格的参数加引号 → `x&calc` 里的 `&` 被 cmd 当命令
// 分隔符执行,绕过整个权限体系(局域网模式=密码后 RCE)。合法模型名只含 [\w.:\-\[\]/],
// 不匹配就不传该参数(回落默认模型)—— 拒绝注入而非放行。主 /chat 走 SDK 不经 cmd,无此面。
export const MODEL_ARG_RE = /^[\w.:\-\[\]/]{1,128}$/;
export function safeModelArg(m) {
  const s = String(m || '').trim();
  return MODEL_ARG_RE.test(s) ? s : '';
}

// spawn claude 的统一入口:路径解析交给 claude-resolver(PATH → login shell →
// npm prefix → 固定候选),此处只处理平台执行形态。
// Windows:npm 装的 claude 是 claude.cmd,Node spawn 无法直接执行(.cmd 必须经
// cmd.exe;Node 出于安全也拒绝直接跑 .cmd)→ cmd.exe /c 包一层,并把超长的
// --settings inline JSON 落临时文件传路径(避开 cmd.exe 对 JSON 引号的破坏)。
export function claudeSpawn(args, opts) {
  const resolved = resolveClaude()?.path || null;
  if (process.platform === 'win32') {
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
  // 非 Windows:解析到绝对路径就用它(PATH 外安装位也能 spawn);落空回落裸 'claude'。
  return spawn(resolved || 'claude', args, opts);
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
      draftId: slot.draftId || null,
      cwd: slot.cwd || null,
      model: slot.model || null,
      promptPreview: slot.promptPreview || '',
      permissionMode: slot.permissionMode || 'default',
      startedAt: slot.startedAt || null,
      finishedAt: slot.finishedAt || null,
      exitCode: slot.exitCode,
      attached: slot.attached,
      idle: !!slot.idle, // #26:回合间保活(非"正在跑"),agents/active 据此报 status idle
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

// 危险 Bash 命令服务端权威判定(原只在 client/useWebSocket.js 一份,注释指向的
// server/hooks/permission-bridge.js 早已删除 → G3 完全单端化:客户端离线/多设备
// 状态异常时危险命令无人拦。挪到服务端 canUseTool = 权威兜底,客户端那份只做红卡渲染)。
const DANGEROUS_BASH = /\brm\s+-[a-z]*[rf]|\brm\s+--(recursive|force)|\bgit\s+clean\s+-[a-z]*f|\bgit\s+push\b[^\n]*(--force|\s-f\b)|\bgit\s+reset\s+--hard\b|\bgit\s+branch\s+-D\b|\bfind\b[^\n]*-delete\b|\bshred\b|\bdrop\s+(table|database)\b|\btruncate\b|\bmkfs\b|\bdd\s+if=[^\n]*of=\/dev|>\s*\/dev\/sd|[|]\s*(sudo\s+)?(ba)?sh\b|\bnpm\s+(i|install|add)\b|\bpnpm\s+(i|install|add)\b|\byarn\s+(add|install)\b|\bpip[23]?\s+install\b|\bbrew\s+install\b|\bsudo\b|\b(del|erase)\b[^\n]*\/[sq]|\brd\b[^\n]*\/s|\brmdir\b[^\n]*\/s|\bremove-item\b[^\n]*-(recurse|force)|\bformat\s+[a-z]:/i;
function isDangerousBash(toolName, input) {
  return toolName === 'Bash' && DANGEROUS_BASH.test(String(input?.command || ''));
}

let sdkCounter = 0;

// #26 会话常驻:回合结束后进程保活等待下一条消息的空闲上限。到点关闭回收 ——
// 常驻收益(免冷启/免 MCP 重启/前缀稳定)集中在活跃对话内,挂太久只是白占内存。
const KEEPALIVE_IDLE_MS = 15 * 60 * 1000;

// 动态解析用户已装 claude(路径绝不写死,便于公开版在别人机器上跑)。解析到则让 SDK
// 指向它(避免其自带 ~237M 二进制);解析不到返回 null,SDK 回落自带二进制。
// 解析走统一 claude-resolver(PATH → login shell → npm prefix → 固定候选,带缓存
// 失效),后端启动后才装 claude 也能被发现,无需重启。
function resolveUserClaude() {
  const hit = resolveClaude();
  if (!hit) return null;
  // SDK 要真正可执行的文件;Windows 的 .cmd/.bat/.ps1 驱动不了,回落自带二进制。
  if (process.platform === 'win32' && !/\.exe$/i.test(hit.path)) return null;
  return hit.path;
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
  else {
    if (slot.earlyLines.length < MAX_EARLY_LINES) slot.earlyLines.push(line);
    // 停止链路 #3 兜底:后台化子代理跨回合才完成时,权威终态 task_notification 到达的
    // 时刻往往没有活跃 SSE(per-turn 流已关)——只落 earlyLines 会被下条消息的
    // `s.earlyLines = []` 清掉(或无人再读),前端卡片永远"工作中"。此处额外走全局 WS
    // 广播(新类型 task-notification-bg;SSE 在线时走上面 if 分支不进这里,不会双发),
    // 前端按 tool_use_id 幂等收尾。
    if (line.includes('task_notification')) {
      try {
        const ev = JSON.parse(line);
        if (ev?.type === 'system' && ev.subtype === 'task_notification') {
          broadcast({
            type: 'task-notification-bg',
            sessionId: slot.sessionId || null,
            tool_use_id: ev.tool_use_id || null,
            task_id: ev.task_id || null,
            status: ev.status || 'completed',
          });
        }
      } catch {}
    }
  }
}

// 消息泵结束(result 后 generator 自然结束 / 出错 / 中断)收尾一次。
function finishSlot(slot, procId) {
  if (slot.pumpEnded) return;
  slot.pumpEnded = true;
  slot.idle = false;
  if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
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
  // 第三参 opts(sdk.d.ts CanUseTool):blockedPath=触发本次请求的沙箱越界路径;
  // suggestions=CLI 生成的"始终允许"规则建议(整组返回即官方 always-allow 语义);
  // decisionReason/toolUseID 透传给前端展示/去重。
  return async (toolName, input, opts = {}) => {
    const boundary = typeof opts.blockedPath === 'string' && opts.blockedPath ? opts.blockedPath : null;
    const ask = () => requestPermission({
      toolName, toolInput: input, sessionId: slot.sessionId, cwd: slot.cwd,
      blockedPath: boundary, decisionReason: opts.decisionReason || null, toolUseID: opts.toolUseID || null,
    });
    // 统一 allow 构造:updatedInput 沿用旧语义;r.always=用户点"始终允许"→ 经
    // updatedPermissions 写 settings.json 的 permissions.allow(CLI 落盘,终端同享);
    // r.authorizeDir=越界卡"授权此目录"→ addDirectories(session 或永久)。
    // allowAlways=false 的调用点(危险 Bash)忽略 always —— 若给 rm -rf 之类写下
    // allow 规则,后续 CLI 在规则层直接放行、canUseTool 不再被调,G3 强拦即失效。
    const allowResult = (r, { allowAlways = true } = {}) => {
      const out = { behavior: 'allow', updatedInput: (r.updatedInput && typeof r.updatedInput === 'object') ? r.updatedInput : input };
      const updates = [];
      if (allowAlways && r.always) {
        updates.push(...buildAlwaysAllowUpdates(toolName, input, opts.suggestions));
        out.decisionClassification = 'user_permanent';
      }
      if (boundary && r.authorizeDir) {
        let isDir = null;
        try { isDir = statSync(boundary).isDirectory(); } catch {}
        updates.push(...buildDirAuthUpdates(boundary, { permanent: r.authorizeDir === 'permanent', isDir }));
      }
      if (updates.length) out.updatedPermissions = updates;
      return out;
    };
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
    // plan = 只读规划:源文件写类【直接拒绝】(不能靠弹卡放行——实测 canUseTool 返回
    // allow 会覆盖 SDK plan 层,用户点"允许"就在规划模式下真写了源文件);但计划类文档
    // (.md/.txt/plan/todo 等)是特性(#4:允许 AI 在规划期写 plan.md)→ 走弹卡由用户
    // 批准。危险 Bash 也弹卡(黑名单枚举不全,plan 号称只读却静默跑任意 Bash=信任违背)。
    // 读类探索工具自动放行。判定与客户端 useWebSocket 的 planClass 逐字对齐。
    if (mode === 'plan') {
      if (WRITE_CLASS.has(toolName)) {
        const fp = String(input?.file_path || input?.path || input?.notebook_path || '').toLowerCase();
        const base = fp.split(/[\\/]/).pop() || '';
        const planClass = /\.(md|markdown|txt|rst|mdx)$/.test(fp) || /(plan|todo|notes?|draft|计划|待办)/.test(base);
        if (!planClass) {
          return { behavior: 'deny', message: '规划模式禁止修改源文件。可写计划类文档(.md/.txt 或名含 plan/todo),或用 ExitPlanMode 提交计划等待用户批准,获批后再改源码。' };
        }
        // 计划类文档 → 弹卡由用户决定(保留 #4 特性,不硬拒)。plan 下忽略 always
        // (不写持久规则,规划期不留跨会话授权)。
        const r = await ask();
        if (r.decision === 'allow') return allowResult(r, { allowAlways: false });
        return { behavior: 'deny', message: r.reason || '规划模式下该写入被拒绝' };
      }
      // Bash 在 plan 下【一律弹卡】,不自动放行:危险命令黑名单枚举不全(`> file` 清空、
      // `mv` 覆盖、`python -c "shutil.rmtree()"` 等都不在),plan 号称只读却静默跑任意
      // Bash = 信任违背。读类探索工具(Read/Grep/Glob/LS)仍自动放行,不影响规划体验。
      if (toolName === 'Bash') {
        const r = await ask();
        if (r.decision === 'allow') return allowResult(r, { allowAlways: false });
        return { behavior: 'deny', message: r.reason || '规划模式下该命令被拒绝' };
      }
      // 越界访问(boundary)不随读类自动放行 → 落到下面弹越界卡。
      if (!/^mcp__/.test(toolName) && !boundary) return { behavior: 'allow', updatedInput: input };
      // MCP 工具可能有写副作用,plan 下不无条件放行,落到下面按 autoapprove/弹卡处理。
    }
    // 放任模式:一切放行;越界时附带 session 级目录授权,否则 allow 也会在 FS 层再被挡。
    if (mode === 'bypassPermissions') {
      return allowResult(boundary ? { authorizeDir: 'session' } : {}, { allowAlways: false });
    }
    // 危险 Bash 走弹卡,放在 acceptEdits 自动放行【之前】:确保未来若 acceptEdits 扩大到
    // 放行 Bash,危险命令仍先弹卡。当前 default/acceptEdits 下 Bash 本就落到下面 ask(),
    // 故此块目前对裁决是等效前置(不改变结果);真正的"永久授权/自动放行"裁决在客户端
    // respond 侧,客户端 G3(useWebSocket)对危险命令强制弹卡,两端正则逐字一致。
    if (isDangerousBash(toolName, input)) {
      const r = await ask();
      if (r.decision === 'allow') return allowResult(r, { allowAlways: false });
      return { behavior: 'deny', message: r.reason || '用户拒绝执行该命令' };
    }
    // 接受编辑:只读类 + 文件写入/编辑类自动放行(名副其实=改文件不弹窗,对齐官方 acceptEdits);
    // Bash/执行类与 MCP 仍走下面的弹窗。这才和"默认"拉开区别(默认下改文件也要弹窗)。
    // 越界访问例外:沙箱边界外的路径不随档位静默扩权,一律弹越界卡。
    if (mode === 'acceptEdits' && (READ_CLASS.has(toolName) || WRITE_CLASS.has(toolName)) && !boundary) {
      return { behavior: 'allow', updatedInput: input };
    }
    if (mcpAutoApproved(toolName) && !boundary) return { behavior: 'allow', updatedInput: input };
    const r = await ask();
    if (r.decision === 'allow') return allowResult(r);
    return { behavior: 'deny', message: r.reason || '用户拒绝执行该工具' };
  };
}

// 缓存优化三态解析:true/false=用户显式;'auto'/未传=按 provider 决定——settings.json env
// 带 ANTHROPIC_BASE_URL 即第三方(默认开,前缀缓存对费用/首字延迟影响巨大),官方 OAuth 关。
// 导出仅为可单测(HOME 指到假目录直接验)。
export function resolveExcludeDyn(v) {
  if (v === true || v === false) return v;
  try {
    return !!JSON.parse(readFileSync(pathJoin(homedir(), '.claude', 'settings.json'), 'utf8'))?.env?.ANTHROPIC_BASE_URL;
  } catch { return false; }
}

// #26 会话常驻:同会话回合间保活的复用兼容键。**完全一致才复用**,任何差异都关旧开新
// (回落到与逐回合冷启相同的行为,零语义变化)。settings.json 的 mtime 计入键 ——
// 切 provider / 改任何全局配置(无论经 GUI 还是终端 cc-switch)都会使旧进程不再被
// 复用,规避"常驻进程拿着旧 provider/旧配置继续跑"的整类失败模式。
function chatCompatKey({ workingDir, model, effort, appendSystemPrompt, promptSuggestions, excludeDynamicSystemPrompt, globalRead, dirs, maxBudgetUsd }) {
  let settingsMtime = 0;
  try { settingsMtime = statSync(pathJoin(homedir(), '.claude', 'settings.json')).mtimeMs; } catch {}
  // 禁用工具清单变更也不能复用旧进程(disallowedTools 是 query 级选项,起时定死)→ 计入 mtime。
  let disToolsMtime = 0;
  try { disToolsMtime = statSync(pathJoin(homedir(), '.claude', 'gui', 'disabled-mcp-tools.json')).mtimeMs; } catch {}
  // 项目级 settings(.claude/settings{,.local}.json,hook/权限也可写在这)同理:终端改完
  // 项目 hook,若该项目常驻进程还活着会拿旧 hook 继续跑 → mtime 计入键让下一轮换新进程。
  let projSettingsMtime = 0;
  try { projSettingsMtime += statSync(pathJoin(workingDir, '.claude', 'settings.json')).mtimeMs; } catch {}
  try { projSettingsMtime += statSync(pathJoin(workingDir, '.claude', 'settings.local.json')).mtimeMs; } catch {}
  return JSON.stringify({
    cwd: workingDir, model, effort: effort || null,
    append: (typeof appendSystemPrompt === 'string' ? appendSystemPrompt.trim() : ''),
    suggest: promptSuggestions === true,
    xdyn: excludeDynamicSystemPrompt === true ? 1 : excludeDynamicSystemPrompt === false ? 0 : 'auto',
    gr: globalRead !== false, dirs, settingsMtime, disToolsMtime, projSettingsMtime,
    budget: maxBudgetUsd || null, // 花费上限变化不能复用旧进程(query 级选项,起时定死)
  });
}

// 关掉某会话的常驻/在跑进程(回滚截断、删除会话前必须调:常驻进程的内存上下文与
// 改写后的 jsonl 已分叉,复用会答非所问;删除后残余进程可能复活刚删的文件)。
// 停止语义:closing+abort 直接杀进程,天然 hard(后台 shell 任务一并停,符合删除/回滚语义)。
export function closePersistentForSession(sessionId) {
  if (!sessionId) return;
  for (const slot of activeProcesses.values()) {
    if (slot.sessionId !== sessionId || slot.exitCode !== null) continue;
    slot.closing = true;
    try { slot.input?.close(); } catch {}
    if (!slot.idle) { try { slot.abort?.abort(); } catch {} }
  }
}

// 关掉所有常驻/在跑的 claude 进程,返回关掉的数量。用途:Windows 上更新 claude 前必须先释放
// claude.exe —— 运行中的 claude 会锁住该文件,npm/claude upgrade 覆盖时报 "could not write ...claude.exe"
// (用户实报)。SDK 进程靠 close input + abort 退出(几百 ms 内),之后 npm 才能覆盖。
// 停止语义:同上,直接 abort 天然 hard(更新 claude 必须释放 claude.exe,全杀是刻意的)。
export function closeAllPersistentProcesses() {
  let n = 0;
  for (const slot of activeProcesses.values()) {
    if (slot.exitCode !== null) continue;
    slot.closing = true;
    try { slot.input?.close(); } catch {}
    try { slot.abort?.abort(); } catch {}
    n++;
  }
  return n;
}

// 用户在 MCP 面板手动禁用的单个工具 → SDK disallowedTools(`mcp__<server>__<tool>`),模型
// 【根本看不到】被禁工具(不是权限拦截)。解决 paper-search 这类 server 暴露十几个工具、模型
// 乱选 crossref 的噪音。同步读小 JSON(同 mcp-autoapprove 读法);不 import mcp.js 避免循环依赖
// (mcp→agents→chat)。存储由 GET/PUT /api/mcp/:name/tools 维护。
function buildDisallowedMcpTools() {
  try {
    const map = JSON.parse(readFileSync(pathJoin(homedir(), '.claude', 'gui', 'disabled-mcp-tools.json'), 'utf8'));
    const out = [];
    for (const [server, tools] of Object.entries(map || {})) {
      for (const t of (Array.isArray(tools) ? tools : [])) if (t) out.push(`mcp__${server}__${t}`);
    }
    return out;
  } catch { return []; }
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
    keepAlive,
    maxBudgetUsd,
  } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  // 花费上限(美元):>0 才生效。SDK 透传 CLI --max-budget-usd,进程累计花费达到
  // 上限时本轮停止并返回 result subtype=error_max_budget_usd(前端有专门提示)。
  const budgetUsd = Number(maxBudgetUsd);
  const budget = Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : null;

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

  // additionalDirectories = SDK 的文件访问沙箱边界。越界访问现经 canUseTool 第三参的
  // blockedPath 透出 → makeCanUseTool 弹"越界访问"卡,用户可仅本次放行或授权目录
  // (addDirectories 经 updatedPermissions 回传,session 级或永久写 settings.json)。
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

  // ── #26 会话常驻复用:同会话上一回合的进程还挂着(idle)且配置键完全一致 → 新消息
  // 直接推进它的 input,免掉整套冷启动(bun 二进制 + settings + 全部 MCP server,实测
  // ~5s)且上游看到稳定连接/前缀(第三方缓存友好)。plan 档位差异经 setPermissionMode
  // 热切(与 /chat/permission-mode 同机制);其余任何差异 → 关旧进程走全新冷启,行为
  // 与逐回合冷启完全一致。keepAlive===false(GUI 开关关掉)时同样只关不复用。
  const wantKeepAlive = keepAlive !== false;
  const reuseKey = chatCompatKey({
    workingDir, model, effort, appendSystemPrompt, promptSuggestions,
    excludeDynamicSystemPrompt, globalRead, dirs: [...dirSet].sort(),
    maxBudgetUsd: budget,
  });
  if (sessionId) {
    for (const [alivePid, s] of activeProcesses) {
      if (!s.idle || s.closing || s.pumpEnded || s.exitCode !== null || s.sessionId !== sessionId) continue;
      if (!wantKeepAlive || s.compatKey !== reuseKey) {
        s.closing = true;
        try { s.input.close(); } catch {}
        continue;
      }
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      const wantPlanMode = (chosenMode === 'plan');
      if (wantPlanMode !== (s.sdkMode === 'plan')) {
        try {
          await s.query.setPermissionMode(wantPlanMode ? 'plan' : 'default');
          s.sdkMode = wantPlanMode ? 'plan' : 'default';
        } catch {
          // 热切失败 → 放弃复用,关旧开新
          s.closing = true;
          try { s.input.close(); } catch {}
          break;
        }
      }
      // 重置回合级状态(新回合从干净缓冲开始;上一回合内容客户端已消费或以 jsonl 为准)
      s.idle = false;
      s.earlyLines = [];
      s.completeNotified = false;
      s.turnSubagentSeen = false;
      s.startedAt = Date.now();
      s.finishedAt = null;
      s.promptPreview = String(prompt).slice(0, 80);
      s.guiMode = chosenMode;
      s.permissionMode = chosenMode;
      s.input.push({ type: 'user', message: { role: 'user', content: String(prompt) } });
      return res.json({ pid: alivePid, model: s.model, reused: true });
    }
  }

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
    // draft 发起的流带客户端 draftId:init 前用户切走再切回时,轮询按它找回本进程
    // reattach(僵尸 draft 修复,fable 审计第5项)。init 后 sessionId 就位,它只是冗余。
    draftId: (!sessionId && typeof req.body?.draftId === 'string' && req.body.draftId) ? req.body.draftId : null,
    cwd: workingDir,
    model,
    promptPreview: String(prompt).slice(0, 80),
    permissionMode: permissionMode || 'default',
    guiMode: chosenMode,
    startedAt: Date.now(),
    // #26 会话常驻状态
    idle: false,             // 回合间保活等待下一条消息
    closing: false,          // 收尾中(stop/删除/配置变化),finalize 不得转 idle
    sdkMode: sdkPermMode,    // SDK 层权限模式(plan 热切时同步)
    compatKey: reuseKey,     // 复用兼容键(含 settings.json mtime)
    keepAlive: wantKeepAlive,
    turnSubagentSeen: false, // 本回合是否起过子代理(关流去抖判据,回合级重置)
    idleTimer: null,
    // 停止链路 #1:在飞子代理/后台任务薄记 { task_id → { toolUseId, kind } }。task_started 加、
    // task_notification / task_updated(终态) 删。kind 三分:'shell'(Bash run_in_background,
    // 选择性停止时保留)/'subagent'(带 subagent_type,停)/'unknown'(缺字段,防漏一并停)。
    // stop 时按 kind 决定 stopTask 目标与 abort 抑制;空→行为与改动前逐字节一致(零回归底座)。
    // 跨回合存活,不随回合级状态重置。
    liveTasks: new Map(),
    // Bash run_in_background 的 tool_use_id 集合:task_started 的 task_type==='local_bash' 是
    // shell 直接判据,此集合是双保险(第三方/旧版 CLI 缺 task_type 时按 tool_use_id 反查)。
    bgBashToolIds: new Set(),
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
  if (resolveExcludeDyn(excludeDynamicSystemPrompt) === true) systemPrompt.excludeDynamicSections = true;

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
  if (budget) options.maxBudgetUsd = budget;
  // 手动禁用的 MCP 工具:模型这一回合看不到它们(解决 paper-search crossref 噪音等)。
  const disallowedMcpTools = buildDisallowedMcpTools();
  if (disallowedMcpTools.length) options.disallowedTools = disallowedMcpTools;
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
  let closeTimer = null;
  let lastResultLine = null;
  const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };
  const finalize = () => {
    cancelClose();
    if (lastResultLine) { maybeBroadcastTurnComplete(slot, lastResultLine); lastResultLine = null; } // 回合完成 WS 只在最终 result 播
    // #26 会话常驻:回合收尾但进程不关。客户端照常收 done 结束本回合 SSE;slot 转 idle
    // 等同会话下一条消息复用(POST /chat 的复用块)。空闲超时回收防进程堆积。
    // 不保活的情形照旧关 input 让 generator 收尾:关关开关/draft 没拿到 sessionId/
    // 正在 closing(stop、删除、配置变化)。
    if (slot.keepAlive && slot.sessionId && !slot.closing && !slot.pumpEnded) {
      slot.idle = true;
      slot.finishedAt = Date.now();
      deliverLine(slot, JSON.stringify({ type: 'done', exitCode: 0 }));
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      // idle 回收豁免:带活任务(不分 kind——后台化子代理同样不该被 idle 回收误杀)的进程
      // 到点不关,重新武装同时长再等;任务全完成(liveTasks 清空)后下一轮到点正常回收。
      const idleReclaim = () => {
        if (slot.liveTasks?.size) {
          slot.idleTimer = setTimeout(idleReclaim, KEEPALIVE_IDLE_MS);
          return;
        }
        slot.closing = true;
        try { input.close(); } catch {}
      };
      slot.idleTimer = setTimeout(idleReclaim, KEEPALIVE_IDLE_MS);
    } else {
      try { input.close(); } catch {}
    }
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
            if (b?.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')) slot.turnSubagentSeen = true;
            // 选择性停止:记下 Bash run_in_background 的 tool_use_id,task_started 时反查判 shell
            if (b?.type === 'tool_use' && b.name === 'Bash' && b.input?.run_in_background === true) slot.bgBashToolIds.add(b.id);
          }
        }
        // 停止链路 #1:薄记在飞任务(task_started 加,终态事件删)。task_notification 权威终态,
        // task_updated 的 completed/failed/killed 亦算结束。SDK 事件都带 task_id(sdk.d.ts 4078-4159)。
        if (m.type === 'system' && m.task_id) {
          if (m.subtype === 'task_started') {
            // kind 分类(A0 真机实测):Bash run_in_background 的 task_started 带
            // task_type:'local_bash'(无 subagent_type);Task 子代理带 subagent_type
            // (sdk.d.ts 4118-4140);都缺则 'unknown'(选择性停止时按可停处理,防第三方
            // provider 缺字段时停止失效)。bgBashToolIds 是 task_type 缺失时的双保险。
            const kind = (m.task_type === 'local_bash' || slot.bgBashToolIds.has(m.tool_use_id)) ? 'shell'
              : (m.subagent_type ? 'subagent' : 'unknown');
            slot.liveTasks.set(m.task_id, { toolUseId: m.tool_use_id || null, kind });
          }
          else if (m.subtype === 'task_notification') slot.liveTasks.delete(m.task_id);
          else if (m.subtype === 'task_updated' && ['completed', 'failed', 'killed'].includes(m.patch?.status)) slot.liveTasks.delete(m.task_id);
        }
        deliverLine(slot, line);
        if (m.type === 'result') {
          lastResultLine = line;
          slot.lastResultAt = Date.now(); // stop 端点优雅窗判据(见 /stop 注释)
          // 关流延迟:子代理回合沿用 4s 去抖;开了输入预测时 suggestion 在 result 之后
          // 才到,必须给等待窗(3s;SDK 不发时到点正常收尾)。都没有则立即关,零延迟。
          const delay = slot.turnSubagentSeen ? 4000 : (suggestOn ? 3000 : 0);
          if (delay) { cancelClose(); closeTimer = setTimeout(finalize, delay); }
          else finalize();
        } else if (m.type === 'prompt_suggestion') {
          // 建议是本回合最后一条消息:result 已到(closeTimer 在挂)就立即收尾,
          // 不能走下面的 cancelClose 分支——那会把关闭取消掉、进程挂死等不到下一条。
          if (closeTimer) finalize();
        } else if (closeTimer && m.type !== 'rate_limit_event' && m.type !== 'system') {
          // result 之后又来事件 → 那个 result 不是最终的,取消关闭等下一个。
          // rate_limit_event / system(status、api_retry)例外:纯信息事件、任何时刻都可能到,
          // 不代表还有回合;尤其 suggestOn 的 3s 建议窗内 SDK 生成建议那次调用若限流/重试会发
          // system/api_retry,让它 cancel 会把 finalize 永久取消掉(无重武装)→ slot 挂死等不到
          // 下一条、前端"正在预测下一步输入…"卡死(fable 审计)。真续跑只会是 assistant/tool 事件。
          cancelClose();
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
      slot.sdkMode = sdkMode; // #26:常驻复用的 plan 热切判据与此保持同步
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

// 停止语义(2026-07-14 用户拍板「选择性停止」)。调用方语义表:
//   默认(hard 缺省/false)= 停当前回合 + 全部子代理(含后台化深度调研),**保留 Bash
//   run_in_background 长任务**(训练等误杀不可恢复)。调用方:App.jsx handleStop 两分支
//   (停止按钮/Esc)、handleAccelerate(加速)。
//   hard:true = 全杀(与旧 A 版行为一致)。调用方:App.jsx stopSessionProcs(删会话)、
//   编辑重发两处、AgentMonitorPanel stop(进程管理)。
//   closePersistentForSession / closeAllPersistentProcesses 不走本路由,直接 closing+abort,
//   天然 hard(见各自注释)。
router.post('/chat/:pid/stop', async (req, res) => {
  const slot = activeProcesses.get(req.params.pid);
  if (!slot) return res.status(404).json({ error: 'Process not found' });
  // SDK:interrupt 让当前回合优雅停;abort 兜底强停;close input 让 generator 收尾。
  // **不能 await interrupt**(用户实报"按停止后子代理继续跑到完"的根因):回合正在跑
  // 子代理时,CLI 对 interrupt 控制请求的响应可能等到子代理收尾才回,await 会把下面的
  // abort 兜底永远挡住 → 停止形同虚设。改 fire-and-forget + 优雅窗:窗内消息泵
  // 正常收尾(pumpEnded,interrupt 生效、jsonl 完整)就不硬杀;超窗则 abort 杀整个 CLI
  // 进程(子代理是 CLI 进程内循环,进程死即全停)。input.close 同步延后——它与 interrupt
  // 共用 stdin 通道,立即关会把刚发的 interrupt 请求截断。
  // express.json 全局挂载:无 body → {} → hard=false,老调用方向后兼容(选择性)。
  const hard = req.body?.hard === true;
  const stopAt = Date.now();
  // 按 kind 分组:shell(Bash run_in_background,选择性停止时保留)/ 其余可停
  // (subagent + unknown——unknown 也停,防第三方 provider 缺字段时停止失效)。
  const shellTasks = [];
  const stoppableTasks = [];
  if (slot.liveTasks) {
    for (const [tid, t] of slot.liveTasks) {
      if (t && t.kind === 'shell') shellTasks.push(tid); else stoppableTasks.push(tid);
    }
  }
  const hadTasks = shellTasks.length + stoppableTasks.length > 0;

  if (hard) {
    // ===== hard 路径:全杀(删会话/编辑重发/进程管理),与旧 A 版行为一致。 =====
    // #26:彻底关闭不转 idle —— 删除会话的先停后删链路靠"进程退净"判据,
    // 留个 idle 常驻进程会拖住轮询/事后复活刚删的 jsonl。空闲 slot 直接关流即退。
    slot.closing = true;
    // 先对所有在飞子代理/后台任务 query.stopTask()——它承诺发 task_notification
    // status:stopped(sdk.d.ts:2440),UI 经 task-notification-bg 自动收尾。必须在
    // interrupt / input.close 之前发,三者共用 stdin control 通道,先关会截断 stopTask
    // 请求。全 fire-and-forget + .catch(旧版 CLI 无此能力/竞态失败都不挂死,由下方 abort 兜底)。
    if (hadTasks) {
      for (const tid of slot.liveTasks.keys()) {
        try { slot.query?.stopTask?.(tid)?.catch?.(() => {}); } catch {}
      }
    }
    // 空闲 slot 且无在飞任务:直接关流即退(原逻辑)。带活后台任务的 idle slot 不走此快路——
    // CLI 为在飞任务保活不退(Stop hook background_tasks 证据),须走下方 stopTask+窗口+abort。
    if (slot.idle && !hadTasks) {
      try { slot.input?.close(); } catch {}
      return res.json({ ok: true });
    }
    try { slot.query?.interrupt?.()?.catch?.(() => {}); } catch {}
    setTimeout(() => {
      // 优雅收尾判据:pumpEnded(泵已收尾)或【stop 之后】到达过 result(interrupt 生效,
      // 回合已以 interrupted result 停住)。两个坑都躲开(fable 审计):① 不能只看
      // pumpEnded——子代理回合 result 后有 4s 关流去抖(suggestion 3s),窗内恒 false,
      // interrupt 成功也被硬杀;② 不能看"到过任何 result"——子代理回合的中间 result 在
      // stop 前早已出现,会误判已停而放跑还在继续的回合。
      // 第三个坑:后台化子代理时 interrupt 秒回的 result 会满足前半判据,但后台任务活在
      // CLI 进程内不经父流、进程没死。加 liveTasks.size===0 门控:仅当 stopTask 触发的
      // stopped notification 已泵到、薄记清空,才认优雅退出;仍有活任务=没停净→abort 杀整个
      // CLI 进程。无后台任务时 size===0 恒真=原判据,逐字节一致。
      const settled = slot.pumpEnded || (slot.lastResultAt && slot.lastResultAt >= stopAt);
      const noLiveTasks = !slot.liveTasks || slot.liveTasks.size === 0;
      if (settled && noLiveTasks) return;
      try { slot.abort?.abort(); } catch {}
      try { slot.input?.close(); } catch {}
    }, hadTasks ? 3000 : 2000);
    return res.json({ ok: true });
  }

  // ===== 选择性路径(默认):停当前回合 + 全部子代理,保留 shell 长任务。 =====
  // stopTask 只发非 shell 任务;必须在 interrupt 之前发(共用 stdin,防截断),fire-and-forget。
  for (const tid of stoppableTasks) {
    try { slot.query?.stopTask?.(tid)?.catch?.(() => {}); } catch {}
  }
  // closing 后置:留 shell 时不置 —— finalize 的 keepAlive 分支要 !slot.closing 才转 idle,
  // 置了会毒化 slot(回合收尾即关进程,shell 任务被连坐)。无 shell 时照旧彻底关闭。
  if (!shellTasks.length) slot.closing = true;
  if (slot.idle) {
    if (!hadTasks) {
      // idle 无任务:直接关流即退(closing 已置,=hard 同分支=改动前行为)。
      try { slot.input?.close(); } catch {}
      return res.json({ ok: true });
    }
    if (!stoppableTasks.length) {
      // idle 仅 shell:没有可停对象,no-op 保活(不 closing、不 interrupt、不 abort)。
      return res.json({ ok: true, kept: shellTasks.length });
    }
    if (shellTasks.length) {
      // idle 混合:stopTask 已发(子代理经 stopped notification 收尾),不 closing、
      // 不 interrupt、不 abort,进程为 shell 保活。
      return res.json({ ok: true, kept: shellTasks.length });
    }
    // idle 仅 stoppable(无 shell):closing 已置、stopTask 已发,落到下方 interrupt+窗+abort(=hard)。
  }
  try { slot.query?.interrupt?.()?.catch?.(() => {}); } catch {}
  setTimeout(() => {
    // 优雅判据同 hard(pumpEnded / stop 后 result,三坑注释见 hard 路径),但任务清零只数
    // 非 shell —— shell 是被刻意保留的,不算"没停净"。顺手修 HEAD bug:回合已 result、
    // 4s 关流去抖窗内、只剩 shell 活任务时,旧判据 liveTasks.size===0 恒 false → 超窗
    // abort 误杀训练;新判据 shell 不计入,settled 即优雅退。
    const settled = slot.pumpEnded || (slot.lastResultAt && slot.lastResultAt >= stopAt);
    let liveStoppable = 0;
    let liveShell = 0;
    for (const t of (slot.liveTasks?.values() ?? [])) {
      if (t && t.kind === 'shell') liveShell++; else liveStoppable++;
    }
    if (settled && liveStoppable === 0) return;
    if (liveShell > 0) {
      // 存在活 shell → 永不 abort(abort 杀整个 CLI 进程,shell 连坐、不可恢复)。
      // 子代理若没停净,接受"不优雅"代价;要全杀走 hard(进程管理区)。
      console.warn(`[chat] stop(${req.params.pid}): ${liveStoppable} stoppable task(s) unsettled but ${liveShell} live shell task(s) present — abort suppressed`);
      return;
    }
    try { slot.abort?.abort(); } catch {}
    try { slot.input?.close(); } catch {}
  }, hadTasks ? 3000 : 2000);
  res.json(shellTasks.length ? { ok: true, kept: shellTasks.length } : { ok: true });
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
  // 另一类失败(用户实报"对话标题命名规则说明"):弱模型把"起标题"这条指令本身当成要概括
  // 的对话 → 给指令起了标题。修法:把真实对话包进 <对话> 标签,明确只概括标签内内容,并禁止
  // 对指令本身起标题。配合下方 isMeta 对自指标题(含"标题"+命名/规则等)的兜底拦截。
  const prompt = `为一段对话生成简短中文标题。真实对话内容在下面的 <对话></对话> 标签之间,只概括标签内用户真正在聊的主题。\n要求:只输出标题本身,不超过 16 个字,不加引号、不加标点、不加任何解释;无论对话内容多简单(哪怕只是一句问候),都必须给出一个描述性标题,禁止输出"内容比较简单""请提供更多信息"之类的说明文字;禁止给这条指令本身起标题(不要出现"命名规则""如何起标题""标题生成"等字样)。\n\n<对话>\n用户: ${titleSource}\n${firstAssistant ? `助手: ${firstAssistant}\n` : ''}</对话>`;

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
    // prompt 走 stdin,不作 -p 的参数 —— Windows 上 `cmd.exe /c claude.cmd -p "<prompt>"`
    // 会被 prompt 里的换行(cmd 逐行解析截断)、`<对话>` 的 <>(重定向符)、双引号 三重
    // cmd 元字符破坏 → prompt 残缺 → 标题在 Windows 恒失败(用户实报,mac 正常)。stdin 不经
    // cmd 参数解析,跨平台稳。实测 `claude -p`(无 prompt 参数)从 stdin 读 prompt 正常。
    const titleArgs = ['-p', '--permission-mode', 'plan', '--no-session-persistence'];
    const safeModel = safeModelArg(model);
    if (safeModel) titleArgs.push('--model', safeModel);
    // cwd 物理隔离(用户二报:标题 prompt 仍以会话形态冒头)。标题 prompt 自包含,根本
    // 不需要项目上下文;此前 cwd 用会话项目目录,CLI 任何落盘/索引行为(版本差异、超时
    // 被杀、错误路径)都会把"标题会话"挂进【用户项目】的会话列表。固定到专用 tmp 目录后,
    // 即便上游行为再变,残留也只会出现在无人查看的 tmp hash 下,与用户项目彻底绝缘。
    const titleCwd = pathJoin(tmpdir(), 'cgui-title');
    try { mkdirSync(titleCwd, { recursive: true }); } catch {}
    proc = claudeSpawn(titleArgs, {
      cwd: titleCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    // prompt 经 stdin 喂入(见上方注释:绕开 Windows cmd 参数解析)。写完即关,让 -p 一次性执行。
    try { proc.stdin.write(prompt); proc.stdin.end(); } catch {}
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
    // CLI/provider 调用失败时(未登录、鉴权失败、限流、第三方报错)stdout 可能是一段
    // 英文错误文本(如 "Not logged in · Please run …")而非标题 → 也要拦截回退,
    // 否则错误提示被当成会话标题(实测临时环境未登录复现)。
    const isErr = /not logged in|please run|invalid|api key|unauthor|rate limit|quota|exceeded|forbidden|error:|failed|usage:/i.test(clean);
    // 自指标题:模型给"起标题"指令本身起了标题(实报"对话标题命名规则说明")。
    // 正常概括对话几乎不会出现"标题"二字,故"标题"+命名/规则/生成/说明 组合即判为元话术。
    const isSelfRef = /标题/.test(clean) && /(命名|规则|生成|说明|起名)/.test(clean);
    const isMeta =
      clean.length > 30 ||
      /[。.]\s*$/.test(clean) ||
      /比较简单|请提供|无法生成|没有(看到|提供)/.test(clean) ||
      (clean.length > 20 && /会话|对话|内容|无法/.test(clean)) ||
      isSelfRef ||
      isErr;
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

// POST /api/chat/btw  { question, sessionId?, cwd?, model? }
// 旁问(对齐 CLI 交互式 /btw 的语义):不打断当前工作、不写入会话历史地问一个问题。
// CLI 的 /btw 是 local-jsx 交互式专属命令 —— stream-json 通道里发送实测被回
// "isn't available in this environment",故 GUI 用 headless fork 复刻:
//   --resume + --fork-session   → 在主会话的【fork 副本】上提问,回答带完整上下文;
//   --no-session-persistence    → fork 不落盘(实测:主会话 jsonl md5 不变、无新 jsonl)。
// 无 sessionId(草稿会话)时退化为无上下文的一次性提问。
// --permission-mode plan:旁问只答不改,写类工具在 FS 层被挡,读类照常。
router.post('/chat/btw', async (req, res) => {
  const question = String(req.body?.question || '').slice(0, 8000).trim();
  if (!question) return res.status(400).json({ error: 'question is required' });
  const sessionId = (typeof req.body?.sessionId === 'string') ? req.body.sessionId.trim() : '';
  const model = safeModelArg(String(req.body?.model || '').replace(/\[1m\]/i, ''));
  const cwd = (typeof req.body?.cwd === 'string' && req.body.cwd) ? req.body.cwd : homedir();
  try { if (!statSync(cwd).isDirectory()) throw new Error('nd'); }
  catch { return res.status(400).json({ error: '工作目录无效' }); }

  // question 走 stdin 不作 -p 参数:Windows 上 `cmd.exe /c claude.cmd -p "<question>"` 里无空格
  // 且含 cmd 元字符(&|<>)的 question 会被 cmd 重解析执行(注入);model 同理过白名单。同 title/compact。
  const args = ['-p', '--permission-mode', 'plan'];
  if (sessionId) args.push('--resume', sessionId, '--fork-session');
  args.push('--no-session-persistence');
  if (model) args.push('--model', model);

  let proc;
  try {
    proc = claudeSpawn(args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() });
    proc.stdin.write(question); proc.stdin.end();
  } catch (e) { return res.status(500).json({ error: 'spawn claude failed: ' + e.message }); }
  if (!proc.pid) { proc.on('error', () => {}); return res.status(500).json({ error: 'claude CLI not found' }); }
  // 同 /chat/title:stderr 是 pipe 但只读 stdout,必须排空,否则超 ~64KB 子进程挂死到超时。
  proc.stderr?.resume();

  let out = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { killProcessTree(proc); } catch {}
    const answer = out.trim();
    if (!answer) return res.status(500).json({ error: '旁问失败:超时或模型无回答' });
    res.json({ answer });
  };
  // 大会话 resume + 冷启动可能较慢,给 120s;超时若已有部分输出仍返回。
  const timer = setTimeout(finish, 120000);
  proc.stdout.on('data', (c) => { out += c.toString(); });
  proc.on('close', finish);
  proc.on('error', finish);
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
  const out = stripHostClaudeEnv(env);
  // A(#50085) 兜底:第三方 provider(settings.json env 带 ANTHROPIC_BASE_URL)时强制关掉
  // CLI 每条消息都变的归因头 cch 哈希(x-anthropic-billing-header)——它把上游/中转的
  // 前缀缓存键每轮打穿,3.5 万 token 级系统前缀每轮全价重算(deepseek 首字慢+费用爆根因)。
  // GUI 切换路径已写 =0 进 settings.json;这里兜住终端 cc-switch 切的/旧版 GUI 切的存量
  // 配置。用户在 settings.json 显式设置过(任意值)则尊重。进程 env 独立于 CLI 版本与
  // 切换路径,升级 claude 不失效。官方 OAuth 渠道(无 BASE_URL)不注入。
  // **必须在 stripHostClaudeEnv 之后注入**:strip 会把所有 CLAUDE_CODE_* 整类删掉,
  // 先注后 strip = 注了个寂寞(实测抓到的真 bug,别再挪回去)。
  try {
    const se = JSON.parse(readFileSync(pathJoin(homedir(), '.claude', 'settings.json'), 'utf8'))?.env || {};
    if (se.ANTHROPIC_BASE_URL && se.CLAUDE_CODE_ATTRIBUTION_HEADER === undefined) {
      out.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    }
  } catch {}
  return out;
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

// 从会话 jsonl 读原始 cwd:`claude --resume <sid>` 要求进程 cwd 哈希到会话所在 project,
// 否则 CLI 报 "No conversation found" → /context 落空("未获取到 /context 输出",用户报"当前无法获取")。
// 前端传的 cwd(来自 session.projectPath)对某些会话为空 → 旧代码回落 homedir() 必然 mismatch。
// jsonl 的消息行带权威 cwd,直接读它最可靠(与 provider 无关,官方/第三方同理)。
function cwdFromSessionFile(projectHash, sessionId) {
  if (!/^[A-Za-z0-9._-]+$/.test(projectHash) || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return '';
  try {
    const txt = readFileSync(pathJoin(homedir(), '.claude', 'projects', projectHash, `${sessionId}.jsonl`), 'utf8');
    const m = txt.match(/"cwd":"((?:[^"\\]|\\.)*)"/); // 首个带 cwd 的行
    if (m) return JSON.parse(`"${m[1]}"`); // 反转义 JSON 字符串(路径含反斜杠时)
  } catch {}
  return '';
}

// 把 SDK getContextUsage() 的结构化返回映射成本端点历史(spawn+parse)口径的字段,
// 前端徽章/明细零改动即兼容。窗口取 maxTokens(实测 CLI 内部 maxTokens===rawMaxTokens,
// percentage=round(total/max*100),与 /context markdown 的"a / b (c%)"同口径);第三方
// provider 超窗时 pct 可 >100,照实返回不截断(前端有超窗提示)。isDeferred 分类(延迟
// 加载、不占 totalTokens)原样保留 —— SDK 给的 name 已带 "(deferred)" 后缀,两路显示一致。
function mapSdkContextUsage(u) {
  const max = u.maxTokens || u.rawMaxTokens || 0;
  const byServer = {};
  for (const t of u.mcpTools || []) {
    const s = t.serverName || '(unknown)';
    byServer[s] = (byServer[s] || 0) + (t.tokens || 0);
  }
  return {
    source: 'sdk', // 调试标记:毫秒级直调路径(vs 回落 spawn 路径无此字段)
    model: u.model || null,
    totalTokens: u.totalTokens || 0,
    windowTokens: max,
    pct: Math.round(u.percentage ?? (max ? (u.totalTokens / max) * 100 : 0)),
    // 实测 SDK 的 isDeferred 分类 name 自带 " (deferred)" 后缀,与 markdown 表同名,原样透传。
    categories: (u.categories || []).map((c) => ({
      name: c.name,
      tokens: c.tokens || 0,
      pct: max ? +(((c.tokens || 0) / max) * 100).toFixed(1) : 0,
    })),
    mcpServers: Object.entries(byServer)
      .map(([server, tokens]) => ({ server, tokens }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

router.get('/context/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const projectHash = req.query.projectHash || '';

  // 快路(#26 常驻进程红利):目标会话的保活进程还在(流式中或 idle)→ 直调 SDK 控制
  // 请求 getContextUsage(),毫秒返回、不 fork、不留 jsonl、不碰 TCC。进程不在(draft/
  // 首轮前/已回收/旧会话)或直调失败 → 回落下面的 spawn /context 路径,行为不变。
  for (const slot of activeProcesses.values()) {
    if (slot.sessionId !== sessionId || slot.exitCode !== null || slot.closing) continue;
    if (typeof slot.query?.getContextUsage !== 'function') continue;
    try {
      const usage = await Promise.race([
        slot.query.getContextUsage(),
        // 8s(实测 warm ~1.5-3s,大上下文近满窗时 count_tokens 往返可超 5s):超时太短会白等
        // 后再回落到更慢的 spawn(5-30s),反而更慢;放宽到 8s 让绝大多数大会话仍走快路。
        new Promise((_, rej) => setTimeout(() => rej(new Error('getContextUsage 超时')), 8000)),
      ]);
      if (usage?.totalTokens > 0 && (usage?.maxTokens > 0 || usage?.rawMaxTokens > 0)) {
        return res.json(mapSdkContextUsage(usage));
      }
    } catch {} // 控制通道异常/进程正退出 → 回落 spawn
    break; // 同会话至多一个活 slot;直调失败也不再试其他
  }
  // cwd 优先级:会话 jsonl 里的权威 cwd > 前端传的 > homedir 兜底。前端有时传空 cwd(session
  // 无 projectPath),回落 homedir 会让 --resume 找不到会话 → /context 失败。jsonl cwd 保证匹配。
  const cwd = cwdFromSessionFile(projectHash, sessionId) || req.query.cwd || homedir();
  // V2:不带 --model 时 CLI 按 settings.json 默认模型(如 haiku)计算窗口与显示,
  // 与会话实际模型不符(用户报告:点徽章显示 haiku)。前端把会话当前模型传进来。
  const model = safeModelArg(req.query.model);
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
