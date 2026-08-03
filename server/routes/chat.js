import { Router } from 'express';
import { spawn, execFileSync } from 'child_process';
import { dirname, join as pathJoin, isAbsolute, parse as pathParse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync, writeFileSync, unlinkSync, readdirSync, watch, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getDefaultModel } from '../services/model-resolver.js';
import { dropPendingForSession, requestPermission, resolvePendingForSession } from './permissions.js';
import { buildAlwaysAllowUpdates, buildDirAuthUpdates } from '../utils/permission-rules.js';
import { stripInheritedProviderEnv } from '../utils/provider-env.js';
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

// Windows(cmd.exe /c 分支)专用:把内联 JSON 参数落成临时文件、改传路径。cmd.exe 会重
// 解析参数里的双引号(它不认 MSVCRT 的 \" 转义),内联 JSON 必被打碎。--settings 与
// --mcp-config 都接受"文件路径或 JSON 字符串",落盘即绕开。文件由调用方在进程退出后删。
function jsonArgsToTempFiles(args) {
  let next = args;
  const tempFiles = [];
  for (const flag of ['--settings', '--mcp-config']) {
    const idx = next.indexOf(flag);
    if (idx === -1 || idx + 1 >= next.length) continue;
    const val = next[idx + 1];
    if (typeof val !== 'string' || !val.trim().startsWith('{')) continue; // 已是路径
    try {
      const f = pathJoin(tmpdir(), `cgui-${flag.slice(2)}-${process.pid}-${Math.round(process.hrtime()[1])}.json`);
      writeFileSync(f, val, 'utf8');
      if (next === args) next = args.slice();
      next[idx + 1] = f;
      tempFiles.push(f);
    } catch { /* 落盘失败就保持内联,不因临时文件问题阻断 spawn */ }
  }
  return { args: next, tempFiles };
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

// 自动压缩窗口联动:第三方 provider 下按【本回合实际模型 + 当前激活 provider】实时决定
// autoCompactWindow,经 --settings 临时文件 per-spawn 覆盖(不写全局 settings.json,多会话
// 互不影响;模型/provider 变化会重开进程,下一回合自动用新值)。
// 优先级:用户显式设置(settings.json 顶层 autoCompactWindow 或 env 的
// CLAUDE_CODE_AUTO_COMPACT_WINDOW)> 本联动 > CLI 默认。
// 窗口来源两档:①模型名带 [1m] → 1,048,576(与 GUI 的 1M 开关天然联动,kimi-k3[1m] 等);
// ②当前激活 provider(~/.claude-gui/active-provider.json → custom-providers.json)配置的
// contextWindow 字段(GUI Provider 表单可填,如 deepseek 128k)。都没有 → null 交 CLI 默认。
// 官方 OAuth(无 ANTHROPIC_BASE_URL)恒 null:CLI 认识官方模型,自动窗口本就准确。
// 压缩线 = 窗口×0.85(给压缩摘要留余量);CLI schema 下限 100k,算出 <100k(如 64k 小窗)
// 表达不了 → null(已知局限,如 kimi 不开 1M 的默认档)。
// 模型窗口规则表:按【模型名】匹配,先具体后泛化,首中即返。比 per-provider 单值精确
// 且不易过时 —— 新模型出来加一行即可(数据 2026-07 逐家官方文档核实)。claude-* 不列:
// 200K=CLI 默认口径,无需干预。
const MODEL_WINDOW_RULES = [
  [/deepseek-?v4|deepseek.*-(flash|pro)\b/i, 1_048_576], // DeepSeek V4 flash/pro 均 1M
  [/deepseek-(chat|reasoner|coder)/i, 131_072],          // DeepSeek 旧系 128K
  [/glm-?5\.[2-9]|glm-?[6-9]/i, 1_048_576],              // GLM 5.2+ 1M
  [/glm-?(4\.[5-9]|5(\.[01])?)\b/i, 204_800],            // GLM 4.5~5.1 200K
  [/qwen-?3\.7.*max|qwen.*-1m\b/i, 1_048_576],           // Qwen3.7-Max 1M
  [/kimi-?k3/i, 1_048_576],                              // Kimi k3 1M(实抓亦覆盖)
  [/^k3$/i, 262_144],                                    // 裸 k3=Kimi Code 套餐别名 256K(与客户端徽章一致)
  [/kimi-(k2\.[6-9]|for-coding)/i, 262_144],             // Kimi k2.6+/coding 256K
  [/minimax|abab/i, 204_800],                            // MiniMax M2 系 ~200K
  [/grok-?[4-9]/i, 262_144],
  [/grok-?3/i, 131_072],
  [/gemini/i, 1_048_576],
  [/gpt-?5/i, 400_000],
  [/sonar/i, 131_072],                                   // Perplexity Sonar 128K
];

// 解析模型真实窗口。优先级:[1m] 后缀(用户显式意图)> provider 实抓 modelWindows
// (fetch-models 顺带持久化,端点自己报的最权威)> 模型名规则表 > provider 手填
// contextWindow > null(CLI 默认)。
function resolveModelWindow(model, providerEntry) {
  const m = String(model || '');
  if (/\[1m\]/i.test(m)) return 1_048_576;
  const base = m.replace(/\[1m\]/i, '');
  const mw = providerEntry?.modelWindows;
  if (mw && Number.isFinite(Number(mw[base]))) return Number(mw[base]);
  for (const [re, win] of MODEL_WINDOW_RULES) if (re.test(m)) return win;
  if (providerEntry && Number.isFinite(Number(providerEntry.contextWindow))) return Number(providerEntry.contextWindow);
  return null;
}

// 当前激活 provider 条目(active-provider.json → custom-providers.json)。读不到返 null
// (→ 窗口解析只剩 [1m]/规则表两档)。
function readActiveProviderEntry() {
  try {
    const activeId = JSON.parse(readFileSync(pathJoin(homedir(), '.claude-gui', 'active-provider.json'), 'utf8'))?.id;
    if (!activeId) return null;
    const cp = JSON.parse(readFileSync(pathJoin(homedir(), '.claude-gui', 'custom-providers.json'), 'utf8'));
    const list = Array.isArray(cp) ? cp : (cp?.providers || []);
    return list.find((p) => p?.id === activeId) || null;
  } catch { return null; }
}

// 供显示层(上下文徽章分母/压缩预警/明细底数)与压缩联动同源取窗口:第三方按
// resolveModelWindow 解析;官方(无 BASE_URL)返回 null —— 前端本地表对官方是准的,
// 且避免显示层与 CLI 自身口径打架。
export function resolveDisplayWindow(model) {
  try {
    const st = JSON.parse(readFileSync(pathJoin(homedir(), '.claude', 'settings.json'), 'utf8'));
    if (!st?.env?.ANTHROPIC_BASE_URL) return null;
    return resolveModelWindow(model, readActiveProviderEntry());
  } catch { return null; }
}

export function resolveAutoCompactWindow(model) {
  try {
    const st = JSON.parse(readFileSync(pathJoin(homedir(), '.claude', 'settings.json'), 'utf8'));
    if (typeof st?.autoCompactWindow === 'number') return null;      // 用户显式设置,尊重
    if (st?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW) return null;       // env 显式设置,尊重
    if (!st?.env?.ANTHROPIC_BASE_URL) return null;                   // 官方,CLI 自动已准确
    const win = resolveModelWindow(model, readActiveProviderEntry());
    if (!win) return null;
    // 压缩触发百分比:用户可调(prefs.autoCompactPct,50-95),默认 80%。
    let pct = 80;
    try {
      const p = Number(JSON.parse(readFileSync(pathJoin(homedir(), '.claude-gui', 'prefs.json'), 'utf8'))?.autoCompactPct);
      if (Number.isFinite(p) && p >= 50 && p <= 95) pct = p;
    } catch {}
    // null 判据只看【窗口本身】<100K(CLI schema 下限压不住的真小窗,如 kimi 默认 64K);
    // 窗口 ≥100K 时压缩线钳进 [100K, min(win,1M)] —— 不能因 pct 调低算出 <100K 就返回 null:
    // 那会关掉 128K 家(deepseek旧系/grok-3/sonar)的防撞保护,CLI 默认压缩线(~156K)反而
    // 打穿真窗口,恰是本联动要防的事故(判官抓的:用户调低百分比本意更安全,结果更危险)。
    if (win < 100_000) return null;
    return Math.min(Math.max(Math.floor(win * pct / 100), 100_000), Math.min(win, 1_000_000));
  } catch { return null; }
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
      const { args: finalArgs, tempFiles } = jsonArgsToTempFiles(args);
      const proc = spawn('cmd.exe', ['/c', resolved, ...finalArgs], opts);
      // C5:CLI 启动即读取 --settings 文件,进程退出后删掉,避免每回合一个 cgui-settings-*.json
      // 在 Windows tmp 里持续堆积(用户报告)。
      if (tempFiles.length) proc.on('close', () => {
        for (const f of tempFiles) { try { unlinkSync(f); } catch {} }
      });
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

// A1(D1)/A2(D2) 停止范围判定 —— 抽成纯函数供 tests/unit/check-stop-epoch-scope.mjs 单测。
// 背景:liveTasks 跨回合保留(条目带 epoch),但此前只用于优雅窗计数,没用来决定"给谁发
// stopTask" → 打断当前回合会连带杀掉上一回合派出、仍在后台跑的子代理(原生 Esc 不杀,GUI
// 自己另有「停止后台 N」总闸,设计意图本就分开)。
//   shellTasks     Bash run_in_background:选择性停止刻意保留(误杀不可恢复)
//   stoppableTasks 本回合的非 shell 任务(allTasks 时=全部非 shell):发 stopTask
//   keptTasks      跨回合仍活着的后台子代理:本次不停,并抑制 closing / abort(否则进程一死连坐)
// allTasks=true 由「停止后台 N」总闸传入 → keptTasks 恒空,分组与改动前逐字等价。
// ⚠️ 口径差异(真机实测的 bug):shellTasks / stoppableTasks 收 map key(=task_id),后续
// stopTask(tid) 扇出靠它;keptTasks 却是回给客户端当 keptToolUseIds 用的,前端 visited 以
// tool_use_id(toolu_xxx)为键 → 推 task_id 永不命中、排除机制静默失效。故 keptTasks 收
// 条目的 toolUseId(缺失时回落 tid:前端 visited 不会命中,该条目维持改动前"不被排除"的旧行为)。
// 两种口径不可互换。
// now:陈旧判据的时基(默认取当前时刻,单测可注入)。终态通知丢失的残留条目会永远留在
// liveTasks 里,若照样归入 keptTasks,idle 分支会认为"没有可停对象"直接 no-op、活跃分支的
// abort 兜底被 shouldSuppressAbort 永久抑制 → 停止彻底失效。故年龄 ≥ LIVE_TASK_FRESH_MS
// 的跨回合条目按陈旧处理归入可停(与本函数"宁可多停,不让停止静默失效"的原则一致;判据与
// idleReclaim / 看门狗 busyNonShell 同款)。
export function partitionStopTasks(liveTasks, turnEpoch, allTasks, now = Date.now()) {
  const shellTasks = [];
  const stoppableTasks = [];
  const keptTasks = [];
  const epoch = turnEpoch | 0;
  for (const [tid, t] of (liveTasks || [])) {
    if (t && t.kind === 'shell') { shellTasks.push(tid); continue; }
    // 只有【明确带 epoch 且不等于本回合 且条目仍新鲜】才保留;空条目/缺 epoch/陈旧条目保持
    // 旧行为归入可停,宁可多停一个来路不明的条目,也不让停止对第三方 provider 静默失效。
    if (!allTasks && t && typeof t.epoch === 'number' && (t.epoch | 0) !== epoch
      && now - (t.createdAt || 0) < LIVE_TASK_FRESH_MS) { keptTasks.push(t.toolUseId || tid); continue; }
    stoppableTasks.push(tid);
  }
  return { shellTasks, stoppableTasks, keptTasks };
}

// A2(D2):优雅窗超时后是否抑制 abort。abort 杀的是整个 CLI 进程,进程内所有后台任务连坐死,
// 所以除了原有的"有活 shell",跨回合仍活着的后台子代理同样抑制(A1 刚把它们从 stopTask 里
// 摘出来保留,不抑制 abort 等于绕个弯还是杀了它)。本回合自己的任务不抑制:优雅窗内已发过
// stopTask,超窗仍没停净就该 abort,否则挂死的进程无人收。总闸(allTasks)也不抑制——用户
// 点名"停掉所有后台",杀干净正是意图,语义与改动前一致。
// 纯函数,tests/unit/check-stop-epoch-scope.mjs 单测。
export function shouldSuppressAbort({ liveShell = 0, liveCrossEpoch = 0, allTasks = false } = {}) {
  if (liveShell > 0) return true;
  return !allTasks && liveCrossEpoch > 0;
}

// ── level 信号对账(CLI 2.1.220+ system/background_tasks_changed)──────────────
// 边沿事件(task_started/task_notification/task_updated)任一条丢失,liveTasks 就永久
// 残留一条"在飞"条目 → 看门狗被解除、卡片永久转圈。官方给的 level 信号是【当前全部
// 存活后台任务的全量快照】,语义是 "replace their set with each payload",正为此而设。
// 纯函数(tests/unit/check-level-reconcile.mjs 真 import):就地改 liveTasks,返回本次
// 变化。A0 真机实样(2026-08-03,CLI 2.1.220,headless -p):
//   {"type":"system","subtype":"background_tasks_changed",
//    "tasks":[{"task_id":"bqmaziuib","task_type":"local_bash","description":"…"}],
//    "uuid":"…","session_id":"…"}   ← 无顶层 task_id,故走独立分支
// 实测 local_bash(Bash run_in_background)与 local_agent(前台 Task 子代理)都在集内,
// 空集恒对应任务真结束(sleep 300 直到被 kill 才出集),不随回合边界抖动。
// epoch:补建条目的回合世代,调用点必须传 slot.turnEpoch(审查 R2)。写死 0 会让复用回合
// (turnEpoch≥1)补建出来的条目被 partitionStopTasks 当成"跨回合任务"归进 keptTasks ——
// 选择性停止不对它发 stopTask,liveCrossEpoch>0 还会经 shouldSuppressAbort 抑制 abort 兜底,
// CLI 挂死时停止就失去硬兜底。参数排在最后是为了不动既有调用点的位置语义。
export function reconcileLiveTasks(liveTasks, tasksPayload, now = Date.now(), graceMs = LEVEL_GRACE_MS, epoch = 0) {
  if (!liveTasks) liveTasks = new Map(); // 未起过任务的 slot(实际恒非空,防御)
  const live = new Map();
  for (const t of (Array.isArray(tasksPayload) ? tasksPayload : [])) {
    if (t && t.task_id) live.set(t.task_id, t);
  }
  const settled = [];
  for (const [tid, t] of (liveTasks || new Map())) {
    if (live.has(tid)) { if (t) t.createdAt = now; continue; } // 权威确认仍活 → 刷新新鲜度
    if (now - (t?.createdAt || 0) < graceMs) continue;         // 刚登记,防乱序误剪
    settled.push({ taskId: tid, toolUseId: t?.toolUseId || null });
    liveTasks.delete(tid);
  }
  const added = [];
  for (const [tid, t] of live) {
    if (liveTasks.has(tid)) continue; // 【只补不改】已有条目的 kind 绝不覆盖:一次错分类
    // 就能让选择性停止把用户的后台训练任务当子代理杀掉(不可恢复)。
    const kind = t.task_type === 'local_bash' ? 'shell'
      : (t.task_type === 'local_agent' ? 'subagent' : 'unknown');
    liveTasks.set(tid, { toolUseId: null, kind, epoch: epoch | 0, createdAt: now, fromLevel: true });
    added.push(tid);
  }
  return { settled, added, liveIds: [...live.keys()] };
}

// task_updated 终态:删除前把 toolUseId 取出来。task_updated 的类型里【没有 tool_use_id】
// (sdk.d.ts:4142-4159),客户端只能靠每条流的局部 map 反查,跨回合/reattach/刷新后为空
// → 服务端已删、客户端永不收尾(僵尸"工作中"卡的结构性成因)。服务端知道映射,由它翻译。
// 纯函数,单测同上。
export const TASK_TERMINAL_STATUSES = ['completed', 'failed', 'killed'];
export function taskUpdatedTerminal(liveTasks, msg) {
  const status = msg?.patch?.status;
  if (!TASK_TERMINAL_STATUSES.includes(status)) return { deleted: false, notify: null };
  const t = (liveTasks || new Map()).get(msg.task_id);
  liveTasks?.delete(msg.task_id);
  if (!t?.toolUseId) return { deleted: true, notify: null };
  return {
    deleted: true,
    notify: { tool_use_id: t.toolUseId, task_id: msg.task_id, status: status === 'killed' ? 'stopped' : status },
  };
}

// 静默看门狗的"还有非 shell 任务在跑"判据。纯函数,单测同上。
// 原判据是 `t.epoch === turnEpoch || 年龄 < freshMs`,epoch 支【没有年龄上限】——本回合
// 派出的子代理只要丢一条终态通知,liveTasks 就永久留一条本 epoch 活条目 → 恒 true →
// 5 分钟兜底永不触发 → done 永不发 → 输入框永久卡"停止"(用户实报 65 分钟)。两支合并
// 成一支后本 epoch 条目不再无限期豁免;真活任务由 ① task_updated 非终态进度 ② level
// 信号确认(reconcileLiveTasks 刷新 createdAt)两条路持续续命。
export function hasFreshNonShellTask(liveTasks, now = Date.now(), freshMs = LIVE_TASK_FRESH_MS) {
  return [...(liveTasks?.values() ?? [])]
    .some((t) => t && t.kind !== 'shell' && now - (t.createdAt || 0) < freshMs);
}

// level 信号不新鲜时的降级判据(审查 R1)= 修前那支"本回合条目无限期豁免"。
// 上面的年龄上限之所以敢做,前提是 level 信号会持续确认真活任务并刷新 createdAt。但该信号
// 是【成员变化才发】的边沿信号,不是心跳,前提在两种情况下不成立:
//   ① 旧版 CLI(<2.1.220)根本不发(slot.lastLevelAt 恒 0);
//   ② 单个子代理独自长跑,期间无任何任务起停 —— 起它那一刻发过一条,之后一条都不来。
// 此时若照严判据走,"真活超 30 分钟 + 父流 5 分钟零消息"的子代理会被看门狗 abort 连坐杀死
// (强拆进程,不可恢复),而修前的 epoch 无限豁免恰好保护这个场景。
// 故判据用【时效】而非"收到过没有":最近一个 LIVE_TASK_FRESH_MS 窗内有 level 信号确认过,
// 才启用严判据;否则回落宽判据。失败方向由此翻转为"终态事件与 level 信号双丢失(极罕见)时
// 看门狗被挡住",而僵尸条目的清理本来就由 A1 的 level 对账负责 —— 宁漏标,不误杀。
export function hasCurrentEpochNonShellTask(liveTasks, epoch) {
  return [...(liveTasks?.values() ?? [])]
    .some((t) => t && t.kind !== 'shell' && (t.epoch | 0) === (epoch | 0));
}

// ── F1:CLI init 事件上报的权威命令/技能表 ─────────────────────────────────────
// /api/slash-commands 靠扫三处磁盘枚举,而 CLI 的内置 skill(/loop 等)打包在二进制里、
// 磁盘上没有对应目录 → 用户敲 "/" 永远看不到它们(#11 的全部根因)。init 事件的
// slash_commands + skills 是唯一权威来源(CLI 侧 = commands.filter(userInvocable !== false))。
// 按 cwd 记(项目级命令因 cwd 而异),上限 20 条防无界增长(Map 迭代序=插入序,满了删最早的)。
// 纯内存态:GUI server 重启后为空,合并逻辑必须容忍 null(回落纯磁盘扫描的现状)。
const initCommandCache = new Map(); // cwd → { commands: string[], skills: string[], at: number }
const INIT_CACHE_MAX = 20;

// cwd 未命中就返回 null,【不回落】到"最近一次任意 cwd"的表。曾以为回落只会带进全局内置类
// (项目级命令由磁盘扫描按 cwd 精确提供、先于合并插入),但真机抓 init 事件证伪:slash_commands
// 里确实含项目级命令(某项目的 od-contribute 就在那 171 条里)→ 回落会把 A 项目的项目命令名
// 追加进 B 项目的补全列表(幽灵命令),而新项目发首条消息前必然 miss,正是用户敲 "/" 的高频时点。
// 回落的剩余收益(其他内置 skill 在首条消息前提前可见)远小于跨项目泄漏的困惑;/loop 另有
// BUILTIN_COMMANDS 兜底,miss 时列表与改动前一致。
export function getInitCommands(cwd) {
  return initCommandCache.get(cwd) || null;
}

// 把 init 表并进磁盘扫描结果:只补缺失的名字,已有条目原样保留(BUILTIN_COMMANDS 由此
// 退化成"描述元数据表",不再是可用性判据)。就地改 commands 并返回它。
// 纯函数,tests/unit/check-slash-init-merge.mjs 真 import。
export function mergeInitCommands(commands, init) {
  if (!init) return commands;
  const names = new Set(commands.map((c) => c.name));
  for (const raw of [...(init.commands || []), ...(init.skills || [])]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const name = raw.startsWith('/') ? raw : `/${raw}`;
    if (names.has(name)) continue;
    names.add(name);
    // init 出现 = CLI 真有这条命令,故一律不过 SUBSCRIPTION_ONLY_NAMES 门。
    commands.push({ name, desc: 'CLI 上报的可用命令（无本地描述）', type: 'builtin', requiresAnthropic: false });
  }
  return commands;
}

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
      // F2:本会话建过 cron,进程正被豁免于 15 分钟闲置回收 —— 让"这个进程为什么不退"可见。
      cronHold: slot.cronHoldUntil > Date.now(),
    });
  }
  return out;
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// P2.2:加 'auto'(SDK 原生自动档,后台分类器逐动作审查)。spawn(:642)与热切
// (/chat/permission-mode)共用本 Set,一处改两处生效。
const VALID_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);

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

// liveTasks 条目的"新鲜度"窗口:看门狗 busyNonShell 与 idleReclaim 豁免共用。
// 超过窗长的条目视为陈旧(终态通知丢失的残留),不再阻塞看门狗/回收;窗内的
// 跨回合活任务(teammate 等)仍算活,避免看门狗 abort 宿主进程连坐杀 teammate。
// 天花板:真活超过 30 分钟的任务可能被误判陈旧 —— 看门狗可能在其仍跑时 finalize
// 本回合、idle 回收可能杀掉其宿主进程(丢完成通知)。可接受的折中:通知丢失的
// 陈旧条目会让 5 分钟兜底永不触发/常驻进程永不回收,危害更大。
const LIVE_TASK_FRESH_MS = 30 * 60 * 1000;

// ── F2:cron(/loop)保活 ──────────────────────────────────────────────────────
// cron 调度器活在 CLI 子进程内部(print.ts 的 createCronScheduler,1s tick),CronCreate
// 默认 session-only 不落盘 —— 进程一关,内存里的 job 连调度器一起消失。上面的 15 分钟
// idleReclaim 正是杀它的那把刀:实测全机 21+ 次定时任务、横跨 10 天、0 次触发记录。
// 上限 2 小时的理由:① CronCreate 自己 7 天过期,照它挂 7 天 = 进程泄漏;② 一个 idle CLI
// 进程连带它的全部 MCP server 常驻数百 MB,1s tick 也有 CPU 开销;③ 真实 /loop 场景(盯
// 构建、轮询 PR)是分钟到小时级,2h 足够覆盖,又比 15min 的常规回收高一个数量级、语义上
// 明确是"刻意豁免"而非"顺手延长"。到点后回落常规回收 —— /loop 的命令描述已写明"进程被
// 回收后停止",不算静默失约。
const CRON_HOLD_MS = 2 * 60 * 60 * 1000;
// 同时最多 3 个会话享受 cron 保活,防止用户在 10 个会话各建一个 cron 把 10 个 CLI 进程钉住。
// 超限时让【保活到期最早】的那些不再豁免(PLAN 原文写"先到先得",改成保新的:老 slot 本就
// 快到期、白占名额,而用户刚建的循环最该活着;也避免"数量一超全体不豁免"的悬崖)。
const CRON_HOLD_MAX_SLOTS = 3;

// CronCreate/CronDelete 信号 → slot.cronHoldUntil。就地改 slot,纯函数(时基/窗长可注入),
// tests/unit/check-cron-hold.mjs 真 import。形态取自真实会话 jsonl(95a66306,CLI 2.1.220,
// `/loop 1m 告诉我后台任务的进度`):
//   assistant: content[{type:'tool_use', id:'call_…', name:'CronCreate', input:{cron,prompt,recurring,durable}}]
//   user:      content[{tool_use_id:'call_…', type:'tool_result',
//                       content:'Scheduled recurring job 3fa91055 (Every minute). Session-only …'}]
// 成功的 tool_result 【不带】 is_error 字段(失败/拒绝才带 is_error:true),故判 !b.is_error。
// CronDelete 宽松处理:tool_result 里看不出删的是哪个 job、也不知道还剩没剩,删过就清零豁免,
// 下一次 CronCreate 成功会重新挂上 —— 宁可少保活,不做进程泄漏。
export function applyCronSignals(slot, m, now = Date.now(), holdMs = CRON_HOLD_MS) {
  const content = m?.message?.content;
  if (!slot || !Array.isArray(content)) return;
  if (m.type === 'assistant') {
    for (const b of content) {
      if (b?.type !== 'tool_use') continue;
      if (b.name === 'CronCreate') slot.cronToolIds?.add(b.id);
      else if (b.name === 'CronDelete') slot.cronPendingDelete = true;
    }
    return;
  }
  if (m.type !== 'user') return;
  // 【必须在下面的循环之前清】:模型并行"删旧建新"(改循环间隔)时,同一条 user 消息里
  // CronDelete 与 CronCreate 的 tool_result 一起到 —— 放在循环之后会把刚挂上的新保活抹掉。
  // 先清后挂,净效果才对。
  if (slot.cronPendingDelete) { slot.cronPendingDelete = false; slot.cronHoldUntil = 0; }
  for (const b of content) {
    if (b?.type !== 'tool_result' || !slot.cronToolIds?.has(b.tool_use_id)) continue;
    slot.cronToolIds.delete(b.tool_use_id);
    if (!b.is_error) slot.cronHoldUntil = now + holdMs;
  }
}

// idleReclaim 的 cron 豁免判据。纯函数,单测同上。
// 上限用"比我晚到期的 slot 有几个"表达:≥ maxSlots 说明我在最旧的那批之外 → 不豁免。
export function shouldHoldForCron(slot, allSlots, now = Date.now(), maxSlots = CRON_HOLD_MAX_SLOTS) {
  if (!(slot?.cronHoldUntil > now)) return false;
  let newer = 0;
  for (const s of (allSlots || [])) {
    if (s !== slot && s?.cronHoldUntil > slot.cronHoldUntil) newer++;
  }
  return newer < maxSlots;
}

// background_tasks_changed(level 信号)对账的年龄豁免窗。A0 真机实测:该信号恒在对应
// 边沿事件【之前】不到 1ms 发出(起任务时先于 task_started、结束时先于 task_updated),
// 所以刚登记的条目理论上不会撞上"不在集内"。1.5s 是防事件乱序/重连回放的安全余量:
// 年龄不足此窗的条目一律不剪,宁可晚一轮收尾也不误剪真在跑的任务。
const LEVEL_GRACE_MS = 1500;

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

// level 信号广播:把服务端刚对完账的存活集喂给所有客户端,让它们剪掉自己那份僵尸卡。
// 走全局 WS 而非 SSE —— 卡片可能属于已切走/已关窗格的会话,那些窗格没有 SSE 通道。
// 载荷只带 id 数组(不含描述/正文),体积恒定。
// 去重:存活集签名与上次相同【且本次无增删】才跳过,防任务多时成员抖动刷屏;
// 只比签名会漏掉"集合没变但有条目过了 grace 被剪"的那一拍(settled 被吞 = 卡片继续转)。
function broadcastLiveTasks(slot, liveIds, settled, added) {
  const sig = liveIds.join(',');
  if (sig === slot.lastLevelSig && !settled.length && !added.length) return;
  slot.lastLevelSig = sig;
  try {
    broadcast({
      type: 'background-tasks',
      sessionId: slot.sessionId || null,
      taskIds: liveIds,
      // 客户端卡片按 tool_use_id 索引,故把服务端才知道的映射一并翻译过去。
      // 这里不按 kind 过滤,shell(local_bash)条目也在内:客户端只拿它做"存活 = 别剪"的
      // 白名单,而 shell 从不建子代理卡片,多带无害。若将来给 shell 也建卡,这里必须按
      // kind 拆开,否则两类卡会共用同一份存活集互相干扰。
      toolUseIds: [...(slot.liveTasks?.values() ?? [])].map((t) => t?.toolUseId).filter(Boolean),
      settled: settled.map((s) => s.toolUseId).filter(Boolean),
      ts: Date.now(),
    });
  } catch {}
}

// 消息泵结束(result 后 generator 自然结束 / 出错 / 中断)收尾一次。
function finishSlot(slot, procId) {
  if (slot.pumpEnded) return;
  slot.pumpEnded = true;
  slot.idle = false;
  if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
  if (slot.stopTimer) { clearTimeout(slot.stopTimer); slot.stopTimer = null; }
  if (slot.exitCode === null) slot.exitCode = 0;
  slot.finishedAt = Date.now();
  try { slot.nulWatcher?.close(); } catch {}
  sweepWinNulFiles(slot.cwd);
  if (slot.sessionId) { try { dropPendingForSession(slot.sessionId); } catch {} }
  // closePersistentForSession 的等待方:进程收尾完成,可以安全读写 jsonl 了。
  if (slot.closeWaiters?.length) {
    const ws = slot.closeWaiters;
    slot.closeWaiters = null;
    for (const w of ws) { try { w(); } catch {} }
  }
  // done:client 据此结束 SSE 读取。attach 中直接发;否则缓冲,等 attach 回放后收尾。
  deliverLine(slot, JSON.stringify({ type: 'done', exitCode: slot.exitCode }));
  setTimeout(() => activeProcesses.delete(procId), 60_000).unref();
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

// A1 裁决单点化:mode 相关的自动裁决唯一实现。canUseTool(新请求广播前)与
// POST /chat/permission-mode 的切档重裁(resolvePendingForSession)共用这一个函数,
// 杜绝两份判定漂移。客户端不再按本地 mode 抢答(多端 localStorage 缓存过期互抢的根因)。
// 返回:{ decision:'allow', authorizeDir? } 自动放行 / { decision:'deny', reason } 自动拒绝 /
// null = 需要用户决定(弹卡/留卡)。
const EXIT_PLAN_DENY_REASON = '用户已切出规划模式。请勿继续规划或再次调用 ExitPlanMode，直接简要总结并结束本回合；用户将以新模式重新发起请求。';
function autoDecide(mode, toolName, input, boundary) {
  // 提问卡永远等人;计划确认卡只在 plan 档等人 —— 已切出 plan 直接 deny(U5 上收服务端)。
  if (toolName === 'AskUserQuestion') return null;
  if (toolName === 'ExitPlanMode') {
    return mode === 'plan' ? null : { decision: 'deny', reason: EXIT_PLAN_DENY_REASON };
  }
  // plan = 只读规划:源文件写类直接拒绝;计划类文档(.md/.txt/plan/todo 等)弹卡由用户批准;
  // Bash 一律弹卡(危险黑名单枚举不全);读类探索工具自动放行;MCP/越界落到下方处理。
  if (mode === 'plan') {
    if (WRITE_CLASS.has(toolName)) {
      const fp = String(input?.file_path || input?.path || input?.notebook_path || '').toLowerCase();
      const base = fp.split(/[\\/]/).pop() || '';
      const planClass = /\.(md|markdown|txt|rst|mdx)$/.test(fp) || /(plan|todo|notes?|draft|计划|待办)/.test(base);
      if (!planClass) {
        return { decision: 'deny', reason: '规划模式禁止修改源文件。可写计划类文档(.md/.txt 或名含 plan/todo),或用 ExitPlanMode 提交计划等待用户批准,获批后再改源码。' };
      }
      return null;
    }
    if (toolName === 'Bash') return null;
    if (!/^mcp__/.test(toolName) && !boundary) return { decision: 'allow' };
    // MCP 工具可能有写副作用 / 越界不静默扩权 → 落到下方按 autoapprove/弹卡处理。
  }
  // auto 档(P2.2):放行/拦截由 SDK 内部分类器完成,能到达 canUseTool 的都是分类器
  // 上交/ask 规则强制的 → 走与 default 相同的分支(下方危险命令/MCP 自动放行/弹卡),
  // GUI 不做二次裁决。无需显式分支:'auto' 不命中 plan/bypass/acceptEdits 任何一支。
  // 放任模式:一切放行(AskUserQuestion 上面已排除);越界附 session 级目录授权。
  if (mode === 'bypassPermissions') {
    return { decision: 'allow', ...(boundary ? { authorizeDir: 'session' } : {}) };
  }
  // 危险 Bash 强制弹卡,放在 acceptEdits 自动放行【之前】(bypass 除外,上面已放行)。
  if (isDangerousBash(toolName, input)) return null;
  // 接受编辑:读类 + 文件写入/编辑类自动放行;越界例外,一律弹越界卡。
  if (mode === 'acceptEdits' && (READ_CLASS.has(toolName) || WRITE_CLASS.has(toolName)) && !boundary) {
    return { decision: 'allow' };
  }
  if (mcpAutoApproved(toolName) && !boundary) return { decision: 'allow' };
  return null;
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
      // U5 上收服务端:已切出 plan 收到 ExitPlanMode → 直接 deny,不再弹卡等人
      // (原客户端按本地 mode 抢答的分支已删,这里是唯一裁决点)。
      const preVerdict = autoDecide(slot.guiMode, toolName, input, boundary);
      if (preVerdict) return { behavior: 'deny', message: preVerdict.reason };
      const r = await ask();
      if (r.decision === 'allow') {
        // 批准计划 → 切到执行档(写仍弹窗)。SDK 模式切换由前端额外 POST /chat/permission-mode
        // 完成;这里更新 guiMode 供本回合后续 canUseTool 判定。
        slot.guiMode = 'acceptEdits';
        return { behavior: 'allow', updatedInput: input };
      }
      // 切档重裁(resolvePendingForSession)送来的 U5 deny:用户已切出规划,不能再附
      // "修订后重新提交 ExitPlanMode"指引(自相矛盾),原样返回。
      if (r.reason === EXIT_PLAN_DENY_REASON) return { behavior: 'deny', message: r.reason };
      // CQ-6:用户点"修改"= deny。强化回写文案,明确要求模型【修订后再次调用 ExitPlanMode
      // 重新提交计划】,不要直接开始执行——否则模型常把 deny 当"放行去做"而在规划模式下直接动手。
      const refineReason = r.reason || '用户要求修改计划';
      return { behavior: 'deny', message: `${refineReason}\n\n请根据以上反馈修订计划,然后再次调用 ExitPlanMode 重新提交修订后的计划等待用户确认。在计划获批前不要开始执行实际改动。` };
    }
    // mode 相关自动裁决统一走 autoDecide(与切档重裁共用一份判定,详见其注释)。
    const mode = slot.guiMode;
    const verdict = autoDecide(mode, toolName, input, boundary);
    if (verdict) {
      if (verdict.decision === 'allow') {
        return allowResult(verdict.authorizeDir ? { authorizeDir: verdict.authorizeDir } : {}, { allowAlways: false });
      }
      return { behavior: 'deny', message: verdict.reason };
    }
    // null = 弹卡等用户。plan 档的写类/Bash 与危险命令忽略 always(不写持久规则:
    // 规划期不留跨会话授权;危险命令写下 allow 规则会让 CLI 规则层直接放行绕过 G3 强拦)。
    const noAlways = isDangerousBash(toolName, input)
      || (mode === 'plan' && (WRITE_CLASS.has(toolName) || toolName === 'Bash'));
    const r = await ask();
    if (r.decision === 'allow') return allowResult(r, { allowAlways: !noAlways });
    const fallbackReason = (mode === 'plan' && WRITE_CLASS.has(toolName)) ? '规划模式下该写入被拒绝'
      : (mode === 'plan' && toolName === 'Bash') ? '规划模式下该命令被拒绝'
        : isDangerousBash(toolName, input) ? '用户拒绝执行该命令'
          : '用户拒绝执行该工具';
    return { behavior: 'deny', message: r.reason || fallbackReason };
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
  // MCP 配置增删改(存 ~/.claude.json)后旧进程不能复用,否则新 MCP 同会话不生效。不能直接
  // stat ~/.claude.json(CLI 每次会话都写它=永远不复用),mcp.js 的写路径会 touch 这个戳文件。
  let mcpStampMtime = 0;
  try { mcpStampMtime = statSync(pathJoin(homedir(), '.claude', 'gui', 'mcp-config.stamp')).mtimeMs; } catch {}
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
    gr: globalRead !== false, dirs, settingsMtime, disToolsMtime, projSettingsMtime, mcpStampMtime,
    budget: maxBudgetUsd || null, // 花费上限变化不能复用旧进程(query 级选项,起时定死)
  });
}

// 关掉某会话的常驻/在跑进程(回滚截断、删除会话前必须调:常驻进程的内存上下文与
// 改写后的 jsonl 已分叉,复用会答非所问;删除后残余进程可能复活刚删的文件)。
// 停止语义:closing+abort 直接杀进程,天然 hard(后台 shell 任务一并停,符合删除/回滚语义)。
// 返回 Promise:进程退出/泵收尾(finishSlot 经 closeWaiters 通知)后 resolve —— 调用方
// (trim/compact 等)await 后再读写 jsonl,不会读到进程退出前的旧写入;slot 本就不在或
// 已结束则立即 resolve,5s 超时兜底防进程赖死永久等待。
export function closePersistentForSession(sessionId) {
  if (!sessionId) return Promise.resolve();
  // 先清该会话挂起的权限卡:否则卡片残留到进程退出才被 finishSlot 清(删/裁剪会话后
  // 前端仍看到旧卡)。幂等,与 finishSlot 里的清理重复调用无害。
  try { dropPendingForSession(sessionId); } catch {}
  const waits = [];
  for (const [procId, slot] of activeProcesses) {
    if (slot.sessionId !== sessionId || slot.exitCode !== null) continue;
    slot.closing = true;
    try { slot.input?.close(); } catch {}
    if (!slot.idle) { try { slot.abort?.abort(); } catch {} }
    waits.push(new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 5s 超时兜底不能resolve了之:赖死 slot 残留 activeProcesses,后续再 trim/delete
        // 同会话会重等 5s,残余进程还可能继续写 jsonl。补一次 abort 并强制 finishSlot
        // 收尾(清 waiters/删定时器/60s 后移出表);pumpEnded 幂等,真泵随后自然结束时
        // 对 finishSlot 的二次调用自动 no-op,不双发 done。
        try { slot.abort?.abort(); } catch {}
        finishSlot(slot, procId);
        resolve();
      }, 5000);
      timer.unref?.();
      (slot.closeWaiters ??= []).push(() => { clearTimeout(timer); resolve(); });
    }));
  }
  return Promise.all(waits);
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

// CQ:追加(而非替换)规划模式行为引导——修第 10/11 项并强化第 6 项。不用 SDK 的
// planModeInstructions(它会整段替换默认计划工作流 body,丢失原生规划逻辑),改成 append
// 叠加在 claude_code preset 上,additive、低风险:① 提问走 AskUserQuestion 工具而非写进
// 计划正文(第10);② 计划批准后用 TaskCreate 拆任务清单跟踪(第11);③ 被要求"修改"时
// 修订后再次 ExitPlanMode 重新提交、不要直接开始执行(第6,与 deny 文案双保险)。
const PLAN_GUIDE = '【规划模式补充指引 —— 仅与规划(plan)工作流及其后续执行回合相关,无关回合忽略本段】1) 若需要向用户提问以澄清需求,必须调用 AskUserQuestion 工具,不要把问题直接写进 ExitPlanMode 的计划正文里。2) 计划被用户批准、进入执行后,请用 TaskCreate 把计划拆成任务清单并逐项更新状态,让用户能看到进度。3) 若用户对计划反馈"需要修改",请据此修订计划后【再次调用 ExitPlanMode】重新提交、等待确认,不要直接开始执行。';

// 引导【无条件】进系统提示,不再按 permissionMode 分支——两点收益,一点代价:
//  ① 前缀缓存:系统提示是整个前缀的最前段,按模式分两种写法 = 账号级前缀缓存劈成两桶
//     (DeepSeek pro 未命中价是命中的 120 倍)。恒定写法让所有会话共享同一前缀。
//  ② 顺带修一个真 bug:引导只在 spawn 时定型,POST /chat/permission-mode 中途热切进
//     plan 的回合此前【根本没有】引导。恒定注入后热切回合也有。
// 代价:非规划回合的系统提示也带这段。故文案首句写死适用条件让模型自行门控;三条正文
// 逐字未动,规划模式下的语义与改动前完全一致。首句门控条件写的是「规划工作流及其后续
// 执行回合」而非「plan 模式」:第2条(批准后用 TaskCreate 拆清单)本就发生在计划批准、
// 退出 plan 模式【之后】的执行回合,写成"仅 plan 模式适用"会让模型把它一并忽略。
// (曾评估"改注入用户消息"以避免这点代价:与 CLI 的斜杠命令解析冲突——前置会让 `/xxx`
//  不再以 `/` 开头认不出命令,后置会被卷进 <command-args> 传给 skill 当参数,故放弃。)
export function composeAppendSystemPrompt(appendSystemPrompt) {
  const userAppend = (typeof appendSystemPrompt === 'string') ? appendSystemPrompt.trim() : '';
  return userAppend ? `${userAppend}\n\n${PLAN_GUIDE}` : PLAN_GUIDE;
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
  // SDK permissionMode:plan 用 'plan'(让模型产出计划并经 canUseTool 弹 ExitPlanMode);
  // auto 用 'auto'(P2.2:分类器在 CLI/SDK 内部,GUI 模拟不了,必须原样透传让原生分类器接管);
  // GUI 的 default/acceptEdits/bypassPermissions 一律用 SDK 'default',放行/弹窗由 canUseTool
  // 按 slot.guiMode 决定(集中分级,复刻旧 hook 的语义)。
  const sdkPermMode = chosenMode === 'plan' ? 'plan' : chosenMode === 'auto' ? 'auto' : 'default';

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
      // epoch 门控前移到任何 await 之前:await setPermissionMode 让出事件循环期间,上一回合
      // 停止链路武装但没 clear 掉的旧 stopTimer 兜底回调可能溜进来,以旧 epoch 匹配成功 →
      // abort 这个正被复用的 slot。先 clear 旧 stopTimer 并推进 turnEpoch,让门控不依赖
      // "idle slot 无 pending stopTimer"这条隐性不变式。
      if (s.stopTimer) { clearTimeout(s.stopTimer); s.stopTimer = null; }
      s.turnEpoch = (s.turnEpoch | 0) + 1;
      // SDK 层档位不一致(plan/auto/default 三种可能)→ 热切;失败放弃复用关旧开新。
      if (sdkPermMode !== s.sdkMode) {
        try {
          await s.query.setPermissionMode(sdkPermMode);
          s.sdkMode = sdkPermMode;
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
      s.revived = false;
      s.startedAt = Date.now();
      s.finishedAt = null;
      // H2:上一回合停止链路的残留不得毒化本回合(stopTimer clear + turnEpoch 推进已前移到
      // await 之前)。① 清 lastResultAt(否则新回合 stop 的 settled 判据读到旧 result 时间);
      // ② liveTasks 跨回合保留:条目由 task_started/notification 自维护增删,跨回合仍存活的后台
      // 子代理也在其中——若按"非 shell 即陈旧"清掉,本回合选择性 /stop 与 stop-task 就停不到
      // 上个回合遗留的活任务(调研 R2)。漏网条目(通知丢失)留着无害:stopTask 幂等 no-op。
      s.lastResultAt = null;
      s.promptPreview = String(prompt).slice(0, 80);
      s.guiMode = chosenMode;
      s.permissionMode = chosenMode;
      s.input.push({ type: 'user', message: { role: 'user', content: String(prompt) } });
      return res.json({ pid: alivePid, model: s.model, reused: true });
    }
  }

  // #26 一会话一进程(H1 双 resume 根治):走到这里=没复用到 idle 进程,要冷启新
  // `claude --resume <sid>`。但同一 sid 的上一回合进程可能正在收尾——用户点"停止"后
  // interrupt 已发、abort 兜底还没到点(closing=true / idle=false / pumpEnded=false),
  // 或配置变更刚把一个 idle slot 置 closing 关流。此刻并起第二个 --resume 会与它抢同一
  // jsonl / 会话锁 → 新回合读到半写状态、拿不到干净 init/result → 几秒空产出。先等它
  // pumpEnded 或被 delete 再冷启;非阻塞短轮询到上限,超时才强制 abort 兜底(interrupt
  // 已在飞,极少走到)。idle 可复用 slot 不在此列(上面复用块已 return),不误伤 shell 保活。
  if (sessionId) {
    const tearingDown = () => {
      for (const s of activeProcesses.values()) {
        if (s.sessionId !== sessionId) continue;
        if (!s.pumpEnded && s.exitCode === null && (s.closing || !s.idle)) return s;
      }
      return null;
    };
    const deadline = Date.now() + 4000;
    let lingering;
    // 后台 shell 保活的 slot:配置变更(改 settings.json/换 model/effort)会把它置 closing 关流,
    // 但 CLI 为后台任务保活、generator 不结束 → pumpEnded 永假 → tearingDown() 每轮都返回它。若
    // 留在等待循环里会稳定白等满 4s,超时后 abort() 又会杀掉整个 CLI = 连坐杀后台训练 shell(不
    // 可恢复)。铁律:误杀不可恢复 > 双 resume 竞争 —— 一旦发现活 shell 立即跳出,既不白等也不
    // abort,退回改动前"旧进程为 shell 保活、与新 --resume 并存"的孤儿存活行为。判据与选择性
    // 停止路径一致:t.kind === 'shell'。
    const slotHasLiveShell = (s) => [...(s?.liveTasks?.values() ?? [])].some(t => t && t.kind === 'shell');
    while ((lingering = tearingDown()) && Date.now() < deadline) {
      if (slotHasLiveShell(lingering)) { lingering = null; break; } // 保活:不等不杀,容忍双 resume
      await new Promise((r) => setTimeout(r, 50));
    }
    if (lingering) {
      // 走到这里 lingering 必无活 shell(有 shell 已上面 break 清空),是正在停止/被弃用的进程,
      // 强制 abort 是正确兜底,避免同 sid 双 --resume 抢会话锁。
      lingering.closing = true;
      try { lingering.abort?.abort(); } catch {}
      try { lingering.input?.close(); } catch {}
      const hardDeadline = Date.now() + 1000;
      while (tearingDown() && Date.now() < hardDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
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
    // 活跃 SSE 连接句柄 { onLine, end }。listeners 只有写函数、没法主动关掉老响应,
    // 新连接接管时需要它逐个 end(见 claimAttach)。
    attachments: new Set(),
    exitCode: null,
    pumpEnded: false,
    attached: false,
    attachToken: 0,     // 当前 attach 持有者的序号,close 回调据此判断该不该让位
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
    revived: false,          // 本回合是否经复活守卫从 idle 翻回活跃(看门狗判据,回合级重置)
    idleTimer: null,
    // 停止兜底定时器(/stop 的 abort 兜底 setTimeout 句柄)+ 回合世代计数。回合级:复用一个
    // idle slot 时 turnEpoch 自增,上一回合武装的 stopTimer 回调进门先比对 capturedEpoch,
    // 不等即 no-op —— 即便 clear 没赶上也绝不误伤已被复用成新回合的 slot(H2 根治)。
    stopTimer: null,
    turnEpoch: 0,
    // 停止链路 #1:在飞子代理/后台任务薄记 { task_id → { toolUseId, kind } }。task_started 加、
    // task_notification / task_updated(终态) 删。kind 三分:'shell'(Bash run_in_background,
    // 选择性停止时保留)/'subagent'(带 subagent_type,停)/'unknown'(缺字段,防漏一并停)。
    // stop 时按 kind 决定 stopTask 目标与 abort 抑制;空→行为与改动前逐字节一致(零回归底座)。
    // 跨回合存活,不随回合级状态重置。
    liveTasks: new Map(),
    // Bash run_in_background 的 tool_use_id 集合:task_started 的 task_type==='local_bash' 是
    // shell 直接判据,此集合是双保险(第三方/旧版 CLI 缺 task_type 时按 tool_use_id 反查)。
    bgBashToolIds: new Set(),
    // 批A level 信号(background_tasks_changed)。lastLevelAt:最近一次收到该信号的时刻 ——
    // 看门狗据此在严/宽判据间切换(见 hasCurrentEpochNonShellTask);0 = 从没收到过(旧版
    // CLI 不发)。lastLevelSig:上次广播的存活集签名,用于去重。都随进程重建而重置,
    // 这就是"进程重启重置空集"的落点。
    lastLevelAt: 0,
    lastLevelSig: null,
    // F2 cron 保活:在飞的 CronCreate tool_use id(等 tool_result 判成败)、
    // 保活截止时刻(0=无)、本回合见过 CronDelete 待其 tool_result 落地。见 applyCronSignals。
    cronToolIds: new Set(),
    cronHoldUntil: 0,
    cronPendingDelete: false,
  };
  activeProcesses.set(procId, slot);
  slot.nulWatcher = startWinNulWatcher(workingDir);

  // 首条用户消息(streaming-input);保持 input 打开作 control 通道。
  input.push({ type: 'user', message: { role: 'user', content: String(prompt) } });

  const appendText = composeAppendSystemPrompt(appendSystemPrompt);
  const systemPrompt = appendText
    ? { type: 'preset', preset: 'claude_code', append: appendText.slice(0, 8000) }
    : { type: 'preset', preset: 'claude_code' };
  // 缓存优化(对应 CLI --exclude-dynamic-system-prompt-sections):把工作目录 / auto-memory /
  // git 状态等每轮变化的动态段移出系统提示、由 SDK 改注入首条用户消息,使系统提示静态可缓存,
  // 提升第三方 provider 前缀缓存命中。仅加系统提示选项,不影响消息泵/关流时序。
  if (resolveExcludeDyn(excludeDynamicSystemPrompt) === true) systemPrompt.excludeDynamicSections = true;

  const options = {
    model,
    // 新模型(Fable5/Opus4.8·4.7/Sonnet5)默认 adaptive 思考的 display 是 omitted(不回摘要),
    // GUI 就看不到思考内容。显式设 display:'summarized' 让其返回思考摘要;老模型本就 summarized,
    // 设了无副作用。摘要由旁路模型生成、不计入用户 token 计费,恒定常量对所有请求一致(不进 compatKey)。
    thinking: { type: 'adaptive', display: 'summarized' },
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
      // 曾在此注册 TeammateIdle hook 广播「待命」态。实测(SDK 0.3.191 / claude 2.1.220,
      // 含命名 agent + SendMessage 排队 + 长任务三组 probe)全程零触发:二进制里该 hook 被
      // in-process teammate 的 AsyncLocalStorage 上下文门控,SDK 起的 local_agent 走的是
      // SubagentStart/SubagentStop 分支,永不进 teammate 分支 → 整条待命链路是死代码,已删。
    },
    cwd: workingDir,
    env: childEnv,
    // .sort():Set 的插入序让同一组目录在不同会话里顺序不同 → 系统提示里的目录列表不同 →
    // 跨会话前缀缓存不共享(缓存是账号级前缀匹配,不是会话级)。上面 chatCompatKey 的 dirs
    // 本就是 [...dirSet].sort(),改完两边口径才一致(改前是"键排序、实参不排序")。
    additionalDirectories: [...dirSet].sort(),
    abortController: abort,
    stderr: (d) => { const t = String(d).trim(); if (t) deliverLine(slot, JSON.stringify({ type: 'stderr', text: t })); },
  };
  if (effort && VALID_EFFORTS.has(effort)) options.effort = effort;
  if (budget) options.maxBudgetUsd = budget;
  // 自动压缩窗口联动(1M 开关/provider contextWindow):per-spawn --settings 覆盖文件。
  // extraArgs 经 SDK 透传为 CLI --settings <path>;进程随流结束,文件在 finally 清理。
  let acwTmpFile = null;
  {
    const acw = resolveAutoCompactWindow(model);
    if (acw) {
      try {
        acwTmpFile = pathJoin(tmpdir(), `cgui-acw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        writeFileSync(acwTmpFile, JSON.stringify({ autoCompactWindow: acw }), 'utf8');
        options.extraArgs = { ...(options.extraArgs || {}), settings: acwTmpFile };
        // (此块内别调用声明在下方的辅助 —— TDZ 抛错会被本 catch 吞掉并把
        // acwTmpFile 置 null → finally 清理失效、每次联动冷启泄漏一个临时文件。)
      } catch { acwTmpFile = null; }
    }
  }
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
    if (acwTmpFile) { try { unlinkSync(acwTmpFile); } catch {} } // 泵未启动,finally 不会跑,就地清理(判官建议)
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
  let closeDelayMs = 0; // 本回合 result 分支算出的关流延迟,收摊重武装时复用同一窗口
  let lastResultLine = null;
  const cancelClose = () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } };
  const finalize = () => {
    cancelClose();
    // 回合优雅收尾:上一个 stop 武装的 abort 兜底不再需要,清掉防其误伤后续复用回合。
    if (slot.stopTimer) { clearTimeout(slot.stopTimer); slot.stopTimer = null; }
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
        // 只豁免【年龄 < LIVE_TASK_FRESH_MS】的条目:终态通知丢失的陈旧条目不再永久
        // 阻回收(此前 liveTasks.size>0 恒豁免,残留一条就永不回收)。天花板见常量注释。
        const now = Date.now();
        const hasFreshTask = [...(slot.liveTasks?.values() ?? [])]
          .some((t) => t && now - (t.createdAt || 0) < LIVE_TASK_FRESH_MS);
        if (hasFreshTask) {
          slot.idleTimer = setTimeout(idleReclaim, KEEPALIVE_IDLE_MS);
          return;
        }
        // F2 cron 豁免:本会话建过 cron 且保活未到期 → 再等一轮(上限 2h / 最多 3 个 slot,
        // 见 CRON_HOLD_MS)。回收这个进程 = 连带杀死进程内的 cron 调度器,循环静默停。
        if (shouldHoldForCron(slot, activeProcesses.values(), now, CRON_HOLD_MAX_SLOTS)) {
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
  // #13 静默看门狗:部分第三方主控模型拿到子代理 tool_result 后,上游既不续写也不发
  // 终态 result → 生成器永久阻塞、回合永不收尾、输入框恒灰(官方无此病)。条件极窄:
  // 静默超 STALL_MS 且【本回合起过子代理 + 当前无在跑的非 shell 任务 + 尚未收尾】才
  // 主动 finalize 解锁;任何消息到达即重置。正常流(消息间隔远小于阈值)与真在跑的
  // 子代理(liveTasks 门)都不会触发;shell 后台任务不阻塞主控,不计入等待。
  // 阈值 300s:第三方 TTFT 常态 60-90s,大上下文/限流重试可更久,180s 只有 2-3x 余量
  // 会误杀"慢但正常"的请求(判官缺陷2)——砍在生成中途会丢实时答案。300s 给足余量。
  const STALL_MS = 300_000;
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      // busyNonShell 只统计【年龄 < LIVE_TASK_FRESH_MS】的非 shell 任务(判据见
      // hasFreshNonShellTask 注释):原来的 `epoch === turnEpoch` 一支没有年龄上限,
      // 本回合子代理丢一条终态通知就把 5 分钟兜底永久解除。跨回合仍活着的 teammate
      // 在窗内照样算忙,看门狗不会 abort 宿主进程连坐杀它(权衡见常量注释)。
      // 降级守卫(审查 R1):严判据的续命全靠 level 信号刷新 createdAt,而它是【成员变化才发】
      // 的边沿信号、不是心跳。故判据取【时效】:最近一个 LIVE_TASK_FRESH_MS 窗内没有任何
      // level 信号确认过(旧版 CLI 恒 0 / 单个子代理独自长跑期间无任务起停)就回落修前的宽
      // 判据,否则真活的长任务会被 abort 连坐杀掉 —— 看门狗到点是强拆进程,误杀不可恢复。
      const now = Date.now();
      const busyNonShell = hasFreshNonShellTask(slot.liveTasks, now, LIVE_TASK_FRESH_MS)
        || (now - (slot.lastLevelAt || 0) >= LIVE_TASK_FRESH_MS
          && hasCurrentEpochNonShellTask(slot.liveTasks, slot.turnEpoch));
      // 判据含 revived:无子代理回合的续跑(auto-compact 后续写等)经复活守卫翻回活跃,
      // turnSubagentSeen 仍是 false,不设 revived 分支这类续跑卡死永无看门狗兜底(判官 S2)。
      if (!slot.idle && (slot.turnSubagentSeen || slot.revived) && !busyNonShell) {
        // stall_notice:客户端专用渲染分支(中性系统提示 turn,非红色错误)。原用 type:stderr
        // 但客户端 SSE 分发根本不渲染 stderr = 提示白发(判官缺陷3)。
        const stallText = slot.turnSubagentSeen
          ? '子代理已全部结束,但上游超过 5 分钟无后续输出,已结束本回合并重置连接(部分第三方 provider 偶发)。已有内容完好,直接重发或继续即可。'
          : '上游超过 5 分钟无后续输出,已结束本回合并重置连接(部分第三方 provider 偶发)。已有内容完好,直接重发或继续即可。';
        deliverLine(slot, JSON.stringify({ type: 'stall_notice', text: stallText }));
        // 【必须强制拆进程,不能走 idle 复用】(判官缺陷1):卡死场景下 CLI 子进程正阻塞在
        // 死掉的上游请求上,不是健康空闲。若只 finalize 转 idle,同会话 15 分钟内下一条消息
        // 会复用这个僵尸(input.push 进挂住的进程、stdin 不被读、armStall 因 for await 不进
        // 循环体而永不重挂)→ 二次卡死且无看门狗兜底。closing=true 让 finalize 走 input.close
        // 分支、复用块的 !s.closing 门拒绝复用;abort 是本文件既有的标准拆除手段。
        slot.closing = true;
        try { slot.abort?.abort(); } catch {}
        finalize();
      } else if (!slot.idle) {
        armStall(); // 子代理仍在跑等条件不满足:继续观察下一窗
      }
    }, STALL_MS);
  };
  (async () => {
    try {
      armStall();
      for await (const m of q) {
        armStall(); // 任何入站消息=上游还活着,重置静默计时
        const line = JSON.stringify(m);
        if (!slot.sessionId && m.type === 'system' && m.subtype === 'init' && m.session_id) {
          slot.sessionId = m.session_id;
        }
        // F1:init 带的权威命令/技能表喂给 /api/slash-commands(含打包进二进制、磁盘扫不到的
        // 内置 skill)。与上一个 if 分开写:那条有 !slot.sessionId 前置,复用回合(resume)时
        // 恒 false,而命令表每回合都值得刷新。
        if (m.type === 'system' && m.subtype === 'init'
            && (Array.isArray(m.slash_commands) || Array.isArray(m.skills))) {
          if (!initCommandCache.has(slot.cwd) && initCommandCache.size >= INIT_CACHE_MAX) {
            initCommandCache.delete(initCommandCache.keys().next().value); // 满了删最早插入的
          }
          initCommandCache.set(slot.cwd, { commands: m.slash_commands || [], skills: m.skills || [], at: Date.now() });
        }
        if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          for (const b of m.message.content) {
            if (b?.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')) slot.turnSubagentSeen = true;
            // 选择性停止:记下 Bash run_in_background 的 tool_use_id,task_started 时反查判 shell
            if (b?.type === 'tool_use' && b.name === 'Bash' && b.input?.run_in_background === true) slot.bgBashToolIds.add(b.id);
          }
        }
        // F2:CronCreate 成功 = 本会话有内存 cron(/loop 的正解),调度器就跑在这个 CLI 进程里,
        // 15 分钟 idle 回收 = 循环静默死。只改 slot 上的簿记,不碰任何时序。
        applyCronSignals(slot, m, Date.now(), CRON_HOLD_MS);
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
            // epoch=创建时回合世代:优雅判据只数本回合任务,跨回合保留的活条目由 stopTask
            // 全量扇出+notification 收尾负责,陈旧(通知丢失)条目不致毒化 abort 判据(判官 R)。
            // createdAt:看门狗 busyNonShell 与 idleReclaim 的"新鲜度"判据(见 LIVE_TASK_FRESH_MS)。
            slot.liveTasks.set(m.task_id, { toolUseId: m.tool_use_id || null, kind, epoch: slot.turnEpoch | 0, createdAt: Date.now() });
          }
          else if (m.subtype === 'task_notification') slot.liveTasks.delete(m.task_id);
          else if (m.subtype === 'task_updated') {
            const { deleted, notify } = taskUpdatedTerminal(slot.liveTasks, m);
            // 无条件广播(不像 deliverLine 只在无监听时兜底):本 bug 的核心正是"SSE 在线
            // 但客户端解不出 tool_use_id"。安全性靠客户端 finalizeAgent 的终态幂等守卫,
            // 与 SSE 路径重复到达无害;tool_use_id 全局唯一,串不到别的会话。
            if (notify) {
              try { broadcast({ type: 'task-notification-bg', sessionId: slot.sessionId || null, ...notify }); } catch {}
            }
            if (!deleted) {
              // 非终态进度汇报 = 任务确实还活着:刷新新鲜度。否则 LIVE_TASK_FRESH_MS(30min)
              // 会把真活超 30 分钟、持续汇报状态的 teammate/长任务误判陈旧;只有长时间
              // 无任何事件的条目才该被判陈旧。
              const t = slot.liveTasks.get(m.task_id);
              if (t) t.createdAt = Date.now();
            }
          }
        }
        // 停止链路 #4(level 信号,CLI 2.1.220+):无顶层 task_id,故走独立分支。tasks 是
        // 【当前全部存活后台任务】的全量快照,官方语义 "replace their set with each payload"
        // —— 丢失的 bookend 不再能把卡片钉死在"工作中"。
        // 【只喂簿记与 UI】:绝不用它驱动 finalize()/abort()/input.close()/stopTimer,
        // 停止链路的既有时序一个字不动。
        else if (m.type === 'system' && m.subtype === 'background_tasks_changed' && Array.isArray(m.tasks)) {
          slot.lastLevelAt = Date.now(); // 看门狗据此在严/宽判据间切换(见 hasCurrentEpochNonShellTask)
          const { settled, added, liveIds } = reconcileLiveTasks(
            slot.liveTasks, m.tasks, Date.now(), LEVEL_GRACE_MS, slot.turnEpoch | 0);
          broadcastLiveTasks(slot, liveIds, settled, added);
        }
        deliverLine(slot, line);
        // Bug 修复(子代理后主 agent 续跑「看起来停了」):中间 result 已被 4s 去抖 finalize 转 idle,
        // 但主 agent 又续跑了新回合(子代理完 → 续开回合去弹计划/权限卡,期间第三方 provider TTFT
        // 可达 60-90s 远超 4s 窗)。把 idle 的 slot 标回活跃 → /agents/active 不再报 idle → 前端
        // backgroundPid 轮询重新发现 → auto-reattach 重开 SSE 回放 earlyLines,续跑正文重现。
        // 只认主 agent 顶层内容(parent_tool_use_id 空);后台子代理自身消息(带该字段)不触发,保住
        // keepalive 语义与 deep-research(backgroundify 子代理)不回归;result/system/rate_limit_event
        // 是终态/纯信息不触发。续跑回合自己的 result 到来照常 finalize→done→再 idle,每轮自愈。
        if (slot.idle && !m.parent_tool_use_id
            && m.type !== 'result' && m.type !== 'system' && m.type !== 'rate_limit_event' && m.type !== 'prompt_suggestion') {
          slot.idle = false;
          slot.revived = true; // 看门狗判据(无子代理续跑也纳入 5 分钟静默兜底)
          if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
          // 复活=主 agent 续跑,则之前被 4s 去抖过早缓冲进 earlyLines 的 done 是错的:若 SSE 在
          // finalize 前已断(WebView 空闲掐断/切窗格),done 落 earlyLines,reattach 回放到它会
          // 立即收尾 SSE、丢弃其后续跑正文(判官指出的「陈旧 done 致 reattach 自杀」)。清掉它们,
          // 续跑回合自己的真 result→done 会照常在末尾补上。
          if (slot.earlyLines && slot.earlyLines.length) {
            // 只剔行首就是 {"type":"done" 的控制行:assistant 正文若讨论 JSON 含同名字段,
            // 子串匹配会把整条正文行误删(判官 S1)。done 行由本进程生成,恒为行首前缀。
            slot.earlyLines = slot.earlyLines.filter((l) => !l.startsWith('{"type":"done"'));
          }
        }
        if (m.type === 'result') {
          lastResultLine = line;
          slot.lastResultAt = Date.now(); // stop 端点优雅窗判据(见 /stop 注释)
          // 关流延迟:子代理回合沿用 4s 去抖;开了输入预测时 suggestion 在 result 之后
          // 才到,必须给等待窗(3s;SDK 不发时到点正常收尾)。都没有则立即关,零延迟。
          const delay = slot.turnSubagentSeen ? 4000 : (suggestOn ? 3000 : 0);
          closeDelayMs = delay;
          if (delay) { cancelClose(); closeTimer = setTimeout(() => finalize(), delay); }
          else finalize();
        } else if (m.type === 'prompt_suggestion') {
          // 建议是本回合最后一条消息:result 已到(closeTimer 在挂)就立即收尾,
          // 不能走下面的 cancelClose 分支——那会把关闭取消掉、进程挂死等不到下一条。
          if (closeTimer) finalize();
        } else if (closeTimer && !m.parent_tool_use_id && m.type !== 'rate_limit_event' && m.type !== 'system') {
          // result 之后又来事件 → 那个 result 不是最终的,等主回合续跑静默满 4s 才收摊。
          // !m.parent_tool_use_id 守卫(与上方复活守卫对称):主回合派出的 run_in_background
          // 后台子代理自己的事件(带该字段)不碰收摊计时器——否则子代理在 4s 窗内一吐字就把
          // 收摊取消,而主回合已结束、唯一重武装点(下一个 result)永不到来 → done 永不发、
          // slot 恒非 idle、前端发送按钮卡停止、新消息卡队列(实测:后台子代理窗内 2 条
          // assistant 事件即触发)。原生 SDK 语义:result 后回合结束、后台任务继续跑、用户
          // 可随时发新消息开新回合,外壳不挡路。
          // rate_limit_event / system(status、api_retry)例外:纯信息事件、任何时刻都可能到,
          // 不代表还有回合;尤其 suggestOn 的 3s 建议窗内 SDK 生成建议那次调用若限流/重试会发
          // system/api_retry,让它 cancel 会把 finalize 永久取消掉(无重武装)→ slot 挂死等不到
          // 下一条、前端"正在预测下一步输入…"卡死(fable 审计)。真续跑只会是 assistant/tool 事件。
          // 取消后尾部去抖重武装(非永久取消):经守卫过滤后进得来这里的只剩主回合顶层续跑
          // 事件,续跑输出静默满原窗口即收摊(复用 result 分支算好的 closeDelayMs,不把仅
          // suggestOn 的 3s 窗延长成 4s);closeDelayMs 为 0(无子代理无 suggest 本不挂窗)
          // 防御性兜底 4s。teammate/任何未预见事件类型最多推迟收摊,不会再造成永久挂死。
          cancelClose();
          closeTimer = setTimeout(() => finalize(), closeDelayMs || 4000);
        }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') {
        deliverLine(slot, JSON.stringify({ type: 'error', error: e?.message || String(e) }));
      }
    } finally {
      clearTimeout(stallTimer); // 看门狗随流关闭,不留孤儿定时器
      if (acwTmpFile) { try { unlinkSync(acwTmpFile); } catch {} } // 压缩窗口覆盖临时文件清理
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
// 上下文徽章分母/压缩预警查询:按模型解析真实窗口(与压缩联动同一套 resolveModelWindow,
// 显示与行为同源)。官方或无解析返回 window:null,前端走本地兜底表。
router.get('/model-window', (req, res) => {
  res.json({ window: resolveDisplayWindow(String(req.query.model || '')) });
});

router.post('/chat/permission-mode', async (req, res) => {
  const { sessionId, mode } = req.body || {};
  if (!sessionId || !mode || !VALID_PERMISSION_MODES.has(mode)) {
    return res.status(400).json({ error: 'sessionId 与合法 mode 必填' });
  }
  const sdkMode = mode === 'plan' ? 'plan' : mode === 'auto' ? 'auto' : 'default';
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
  // A1 切档重裁:对该会话已 pending 的卡按【新档】重新自动裁决(判定与 canUseTool 共用
  // autoDecide 同一份)。allow/deny 走既有 settle 幂等路径,null 的卡保持等待用户。
  // 原客户端"切放任批量放行"effect 与各 mode 抢答分支的职责全部由这里接管。
  try {
    resolvePendingForSession(sessionId, (r) => autoDecide(mode, r.toolName, r.toolInput, r.blockedPath || null));
  } catch {}
  res.json({ ok: true, delivered });
});


// ── SSE 接管协议(修「关窗格后重开会话历史空」)────────────────────────────────
// 原来 slot.attached 为真就回 409 拒绝。可老监听多半是僵尸:客户端关窗格时从不 abort
// (已在 App.jsx 补 detachStream,这里是第二道保险,也覆盖崩溃/断网等 close 事件丢失的
// 情况),于是新窗格被永久挡在门外 —— 没有任何追加通道,只剩一条承诺"自动追加"的横幅。
// 改成「新连接接管」:主动 end 掉老响应,它的 req.on('close') 照常跑清理。
// attachToken 是这条协议的唯一防线:老连接的 close 回调必然晚于新 attach 到达,若无条件
// 把 slot.attached 置 false,下一个 attach 又会走接管分支踢掉刚接上的正常连接(attach 抖动)。
// 故让位只在【自己仍是当前持有者】时生效。纯函数,tests/unit/check-stream-attach-takeover.mjs 真 import。
let attachSeq = 0;

// 「被接管」必须由服务端明说(批J J2)。客户端原来只能从「reader 无 done 却正常结束」去
// 猜自己被接管,可 WebView 空闲掐断 / 网络断开也是同一形态 —— 猜错一次就把 reattach 闩锁
// 焊死(本回合内永不重连),横幅一直挂、内容只能等回合结束一次性塞入。故 end 之前先给每个
// 旧响应写一行 detached 事件,让客户端确定性区分「被接管」与「传输掉线」。
export const DETACHED_TAKEOVER_LINE = JSON.stringify({ type: 'detached', reason: 'takeover' });

export function claimAttach(slot, token) {
  if (slot.attached) {
    // 先 end 老响应再清 listeners:end 之后老连接的 safeWrite 有 closed/!res.writable 守卫,
    // 写不进去只静默返回,不会与新连接双写同一条流。
    // 告知与 end 分两步各自 try/catch:某条连接已死(EPIPE)不得跳过它的 end,更不得中断
    // 其余连接的清理 —— 接管走不完的话新窗格永远接不上。
    // 走 ev.onLine 而不是自己拼 `data: `:它就是这条连接的写函数(带 closed/writable 守卫),
    // 且 detached 不匹配 `{"type":"done"` 前缀,不会被误当收尾控制行。
    for (const ev of [...(slot.attachments || [])]) {
      try { ev.onLine?.(DETACHED_TAKEOVER_LINE); } catch { /* 写不进去也要往下走 end */ }
      try { ev.end(); } catch { /* 已断开 */ }
    }
    slot.attachments?.clear();
    slot.listeners.clear();
  }
  slot.attached = true;
  slot.attachToken = token;
  return slot;
}

export function releaseAttach(slot, token, onLine) {
  slot.listeners.delete(onLine);
  for (const ev of (slot.attachments || [])) {
    if (ev.onLine === onLine) { slot.attachments.delete(ev); break; }
  }
  if (slot.attachToken === token) slot.attached = false; // 只有仍是当前持有者才让位
  return slot;
}

// SSE attach。SDK 引擎下消息由 slot.listeners 实时推送(deliverLine),不再监听 proc.stdout。
// 断连不杀 query(detach-don't-abort):移除监听后续消息回落 earlyLines,重连回放。
router.get('/chat/:pid/stream', (req, res) => {
  const slot = activeProcesses.get(req.params.pid);
  if (!slot) return res.status(404).json({ error: 'Process not found' });
  const myToken = ++attachSeq;
  claimAttach(slot, myToken);

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
    // 行首前缀匹配(判官 S):子串匹配会把正文里讨论 {"type":"done"} 的消息行误当控制行收尾。
    if (line.startsWith('{"type":"done"')) {
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
    // 接管时要能主动 end 掉老响应,故把 onLine 与它的 end 成对登记。
    slot.attachments.add({ onLine, end: safeEnd });
  }

  req.on('close', () => {
    closed = true;
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    // 后续消息回落 earlyLines,等重连回放。attached 只在自己仍是持有者时让位:
    // 被接管的老连接 close 晚到,不能把新连接的 attached 抹掉(否则下一个 attach 又踢人)。
    releaseAttach(slot, myToken, onLine);
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
  // A1:allTasks=true 只由「停止后台 N」总闸传(用户显式"停掉所有后台"),保持全量语义;
  // 主停止键 / Esc 不传 → 只停本回合派出的任务,跨回合后台子代理保留。
  const allTasks = req.body?.allTasks === true;
  const stopAt = Date.now();
  // 按 kind 分组:shell(Bash run_in_background,选择性停止时保留)/ 其余可停
  // (subagent + unknown——unknown 也停,防第三方 provider 缺字段时停止失效)。
  // A1:再按回合世代分出 keptTasks(跨回合后台子代理,主停止不碰)。
  const { shellTasks, stoppableTasks, keptTasks } = partitionStopTasks(slot.liveTasks, slot.turnEpoch, allTasks);
  // hadTasks 口径不变(= liveTasks 非空):它决定 idle 快路径与 2s/3s 窗长,keptTasks 必须计入,
  // 否则"只剩跨回合后台任务"会被当成无任务而直接 input.close() 关掉进程(连坐)。
  const hadTasks = shellTasks.length + stoppableTasks.length + keptTasks.length > 0;

  // 停止时清掉本会话挂起的交互卡片(Ask/计划/授权):它们等在后端的裸 Promise 上,停止链路原来
  // 完全不碰 → 会话停了卡片却残留在最前方(用户实报)。dropPendingForSession 会 settle 那些
  // Promise(deny,防 CLI 永久挂死)+ 按 sessionId 广播 permission:resolved,前端经现成 WS 路径
  // 自动清掉【该会话】的卡片,天然分屏隔离。hard 与选择性两条路径都要清,故置于分支之前。
  if (slot.sessionId) { try { dropPendingForSession(slot.sessionId); } catch {} }

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
    const hardEpoch = slot.turnEpoch | 0;
    slot.stopTimer = setTimeout(() => {
      // H2:回合已被复用推进(turnEpoch 变了)→ 这个兜底属于上一回合,no-op,绝不 abort 新回合。
      if ((slot.turnEpoch | 0) !== hardEpoch) return;
      slot.stopTimer = null;
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
  // A1:跨回合后台子代理(keptTasks)与 shell 同处理 —— 保留它却让进程关掉等于白留。
  const keptCount = shellTasks.length + keptTasks.length;
  if (!keptCount) slot.closing = true;
  if (slot.idle) {
    if (!hadTasks) {
      // idle 无任务:直接关流即退(closing 已置,=hard 同分支=改动前行为)。
      try { slot.input?.close(); } catch {}
      return res.json({ ok: true });
    }
    if (!stoppableTasks.length) {
      // idle 仅 shell / 仅跨回合后台任务:没有可停对象,no-op 保活(不 closing、不 interrupt、不 abort)。
      return res.json({ ok: true, kept: keptCount, keptToolUseIds: keptTasks });
    }
    if (keptCount) {
      // idle 混合:stopTask 已发(子代理经 stopped notification 收尾),不 closing、
      // 不 interrupt、不 abort,进程为 shell / 跨回合后台任务保活。
      return res.json({ ok: true, kept: keptCount, keptToolUseIds: keptTasks });
    }
    // idle 仅 stoppable(无 shell):closing 已置、stopTask 已发,落到下方 interrupt+窗+abort(=hard)。
  }
  try { slot.query?.interrupt?.()?.catch?.(() => {}); } catch {}
  const selEpoch = slot.turnEpoch | 0;
  slot.stopTimer = setTimeout(() => {
    // H2:回合已被复用推进(turnEpoch 变了)→ 兜底属于上一回合,no-op,绝不 abort 新回合。
    if ((slot.turnEpoch | 0) !== selEpoch) return;
    slot.stopTimer = null;
    // 优雅判据同 hard(pumpEnded / stop 后 result,三坑注释见 hard 路径),但任务清零只数
    // 非 shell —— shell 是被刻意保留的,不算"没停净"。顺手修 HEAD bug:回合已 result、
    // 4s 关流去抖窗内、只剩 shell 活任务时,旧判据 liveTasks.size===0 恒 false → 超窗
    // abort 误杀训练;新判据 shell 不计入,settled 即优雅退。
    const settled = slot.pumpEnded || (slot.lastResultAt && slot.lastResultAt >= stopAt);
    let liveStoppable = 0;
    let liveShell = 0;
    let liveCrossEpoch = 0; // A2:跨回合仍活着的后台子代理(A1 已把它们排除在 stopTask 之外)
    for (const t of (slot.liveTasks?.values() ?? [])) {
      if (t && t.kind === 'shell') { liveShell++; continue; }
      // 只数本回合(selEpoch)任务:跨回合保留的活后台子代理的 stopTask 已发、notification
      // 会照常收尾;陈旧(通知丢失)条目不算"没停净",防 idle 槽位被无谓 abort 回收(判官 R)。
      if (t && (t.epoch | 0) === selEpoch) liveStoppable++;
      // 陈旧条目(终态通知丢失的残留)不计入 liveCrossEpoch:计入会让 shouldSuppressAbort
      // 永久抑制 abort 兜底 = 停止静默失效。判据同 partitionStopTasks / 看门狗。
      else if (t && typeof t.epoch === 'number'
        && Date.now() - (t.createdAt || 0) < LIVE_TASK_FRESH_MS) liveCrossEpoch++;
    }
    if (settled && liveStoppable === 0) return;
    if (shouldSuppressAbort({ liveShell, liveCrossEpoch, allTasks })) {
      // 存在活 shell / 跨回合后台子代理 → 永不 abort(abort 杀整个 CLI 进程,它们连坐、
      // 不可恢复)。本回合子代理若没停净,接受"不优雅"代价;要全杀走 hard(进程管理区)。
      console.warn(`[chat] stop(${req.params.pid}): ${liveStoppable} stoppable task(s) unsettled but ${liveShell} live shell / ${liveCrossEpoch} cross-turn task(s) present — abort suppressed`);
      return;
    }
    try { slot.abort?.abort(); } catch {}
    try { slot.input?.close(); } catch {}
  }, hadTasks ? 3000 : 2000);
  // keptToolUseIds:被保留的跨回合后台子代理 id,回给客户端 —— 前端停止收尾会把该会话全部
  // 非终态子代理乐观标 stopped,不排除这些就会"进程还活着却显示已停止"(与「停止后台 N」
  // 徽章读的服务端真值互相矛盾)。仅数据,不影响本路由任何时序。
  res.json(keptCount ? { ok: true, kept: keptCount, keptToolUseIds: keptTasks } : { ok: true });
});

// 停止链路 #1(部件①):按单个 task 精确停止 —— 净新增独立路由,与上面 1195-1321 的
// /stop 停止链路零交叉(那是历史烧过六版的逐字节敏感区)。只对该 slot 内 toolUseId 对应的
// 在飞 task 调 stopTask(fire-and-forget),【绝不 await、绝不 interrupt/abort、不碰优雅窗/
// closing/turnEpoch/杀进程】——stopTask 自己发 task_notification(status:'stopped') 收尾,
// 进程为其它任务/会话保活。幂等:重复调用安全。
router.post('/chat/:pid/stop-task', (req, res) => {
  const slot = activeProcesses.get(req.params.pid);
  if (!slot) return res.status(404).json({ error: 'Process not found' });
  const toolUseId = req.body?.toolUseId;
  if (typeof toolUseId !== 'string' || !toolUseId) return res.status(400).json({ error: 'toolUseId required' });
  // 会话归属守卫(防御纵深):前端把同一请求扇出到该会话的多个 pid;传了 sessionId 且与本
  // slot 不匹配 → no-op stopped:false,停不到别的会话/窗格的 slot(即便前端 pid 扇出算错)。
  const sessionId = req.body?.sessionId;
  if (typeof sessionId === 'string' && sessionId && slot.sessionId !== sessionId) {
    return res.json({ ok: true, stopped: false });
  }
  // 反查 liveTasks(value = {toolUseId, kind},task_started 时建于本文件上方)找 task_id。
  let taskId = null;
  let taskKind = null;
  for (const [tid, t] of (slot.liveTasks || new Map())) {
    if (t && t.toolUseId === toolUseId) { taskId = tid; taskKind = t.kind; break; }
  }
  // 查无 task(已终态/已被移出 liveTasks/发到了非属主 pid)或 query 句柄不可用(已 close):
  // 都不是错误,stopped:false(前端扇出到多 pid,只属主且会话匹配的 slot stopped:true)。
  if (taskId == null) return res.json({ ok: true, stopped: false });
  // shell 长任务(run_in_background 训练等)不可经此端点停:选择性 /stop 刻意保留它们
  // (误杀不可恢复),单停语义同样只覆盖子代理/teammate;停 shell 走进程管理区。
  if (taskKind === 'shell') return res.json({ ok: true, stopped: false });
  if (typeof slot.query?.stopTask !== 'function') return res.json({ ok: true, stopped: false });
  try { slot.query.stopTask(taskId)?.catch?.(() => {}); } catch {}
  return res.json({ ok: true, stopped: true });
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
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    'ANTHROPIC_REASONING_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
    'ANTHROPIC_PERMISSION_MODE', 'CLAUDE_PERMISSION_MODE', 'CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS']) {
    delete childEnv[k];
  }
  stripHostClaudeEnv(childEnv);

  // cwd 物理隔离(用户二报:标题 prompt 仍以会话形态冒头)。标题 prompt 自包含,根本
  // 不需要项目上下文;此前 cwd 用会话项目目录,CLI 任何落盘/索引行为(版本差异、超时
  // 被杀、错误路径)都会把"标题会话"挂进【用户项目】的会话列表。固定到专用 tmp 目录后,
  // 即便上游行为再变,残留也只会出现在无人查看的 tmp hash 下,与用户项目彻底绝缘。
  // 每次请求用唯一子目录:两个标题请求并发时共用同一 cwd 会互相污染(CLI 在该目录的
  // 落盘/锁文件串扰);用完只删自己建的这个子目录,父目录 cgui-title 保留。
  const titleCwd = pathJoin(tmpdir(), 'cgui-title', `${process.pid}-${randomBytes(4).toString('hex')}`);
  try { mkdirSync(titleCwd, { recursive: true }); } catch {}
  const cleanupTitleCwd = () => { try { rmSync(titleCwd, { recursive: true, force: true }); } catch {} };
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
    proc = claudeSpawn(titleArgs, {
      cwd: titleCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });
    // prompt 经 stdin 喂入(见上方注释:绕开 Windows cmd 参数解析)。写完即关,让 -p 一次性执行。
    try { proc.stdin.write(prompt); proc.stdin.end(); } catch {}
  } catch {
    cleanupTitleCwd();
    return res.json({ title: '' });
  }
  if (!proc.pid) { cleanupTitleCwd(); return res.json({ title: '' }); }
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
    cleanupTitleCwd();
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

// 旁问的 system-reminder,对齐 CLI 原生 /btw(side_question)的语义:独立轻量代理、
// 单回合、零工具、只答不做。**必须有它**,因为 --resume 会把主会话尾部的悬空回合原样
// 带进来,CLI 还会自动补一句 "Continue from where you left off."(--resume 遇未完成
// 回合的固定修复注入)—— 没有这段约束时模型看到的字面诉求是"把主会话那件事做完",
// 于是旁问答的是主会话的问题(用户报的串台)。"Do NOT continue, resume…"那两行专压这句注入。
// 形态约束(Windows:win32 分支走 `cmd.exe /c claude.cmd`,argv 被 cmd 重解析):
//   · 单行 —— 换行在 cmd 参数里无法转义(BatBadBut/CVE-2024-24576 同源),LF 处整条命令
//     被截断,reminder 正文连同它后面的全部 flag 一起丢失。`- ` 项目符保留可读性。
//   · 纯 ASCII、无双引号 —— 码页与引号都会被 cmd 重解析。
// 三条都由 check-btw-args.mjs 焊死。
export const BTW_SYSTEM_REMINDER = [
  '<system-reminder>',
  'This is a side question from the user. You must answer this one question directly, in a single response.',
  '- You are a separate, lightweight agent spawned only to answer this question.',
  '- The main agent is NOT interrupted; it keeps working independently in the background.',
  '- You share the conversation context but are a completely separate instance.',
  '- Do NOT reference being interrupted, and do not describe what you were previously doing; that framing is wrong.',
  '- Do NOT continue, resume, or finish any task, question or instruction that appears earlier in the context, including any directive to continue from where you left off. Answer ONLY the new question below.',
  'CRITICAL CONSTRAINTS:',
  '- You have NO tools available: you cannot read files, run commands, search, or take any action.',
  '- This is a one-off response; there will be no follow-up turn.',
  '- Answer only from what you already know from the conversation context.',
  '- NEVER open with phrases like Let me check or I will now, and never promise to take any action.',
  '- If you do not know, say so; do not offer to look it up.',
  '</system-reminder>',
].join(' ');

// 旁问 argv。抽成纯函数只为可单测(tests/unit/check-btw-args.mjs)。
// --tools "" 只关【内置】工具集,MCP 服务器照常加载(实测旁问 tools 里躺着 13 个
// mcp__* → 模型自称有工具、还真去调)。真零工具 = --tools "" + 空 --mcp-config +
// --strict-mcp-config(只认 --mcp-config 给的,忽略 .mcp.json/用户配置)+
// --disable-slash-commands(CLI 官方描述 "Disable all skills")。
// model 必须先过 safeModelArg 白名单再传进来(Windows 上 `--model x&calc` 经 cmd.exe
// 是 RCE,见 MODEL_ARG_RE);本函数只拼参数,不做校验。
export function buildBtwArgs({ sessionId, model } = {}) {
  const args = ['-p', '--tools', '',
    '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config',
    '--disable-slash-commands',
    '--append-system-prompt', BTW_SYSTEM_REMINDER,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (sessionId) args.push('--resume', sessionId, '--fork-session');
  args.push('--no-session-persistence');
  if (model) args.push('--model', model);
  return args;
}

// 旁问的【内联】首尾标记。BTW_SYSTEM_REMINDER 已在 system 层说清语义,但位置权重压不住:
// 它只占整条 prompt 的约 0.3%,其后还跟着几百 KB 的主任务上下文 —— 模型最后读到的是主任务,
// 于是接着做主任务(用户报的串台)。故把同一约束在【用户消息】里复制一份,首尾各一。
// **后缀是重点**:消息层最后一个位置权重最高,它必须是整条消息的字面最后内容,后面不再拼
// 任何东西(check-btw-inline.mjs 焊死这一点)。
// 这段文本走 stdin 消息体、不进 argv,故多行与中文都安全,不受 Windows cmd.exe 的单行纯
// ASCII 约束(那条只管 --append-system-prompt,BTW_SYSTEM_REMINDER 保持原样 = 双保险)。
export const BTW_INLINE_PREFIX =
  '[旁问]下面是一个独立的旁支问题。只回答这一个问题,一次答复;忽略上文中任何未完成的任务、待办或"继续"类指令。';
export const BTW_INLINE_SUFFIX =
  '[旁问结束]再次提醒:只回答上面这个旁支问题,不要继续或执行上文的任何任务。';

// 纯函数只为可单测(tests/unit/check-btw-inline.mjs)。原文原样保留在中间,不做任何改写。
export function wrapBtwInline(composed) {
  return `${BTW_INLINE_PREFIX}\n\n${composed}\n\n${BTW_INLINE_SUFFIX}`;
}

// POST /api/chat/btw  { question, sessionId?, cwd?, model? }
// 旁问(对齐 CLI 交互式 /btw 的语义):不打断当前工作、不写入会话历史地问一个问题。
// CLI 的 /btw 是 local-jsx 交互式专属命令 —— stream-json 通道里发送实测被回
// "isn't available in this environment",故 GUI 用 headless fork 复刻:
//   --resume + --fork-session   → 在主会话的【fork 副本】上提问,回答带完整上下文;
//   --no-session-persistence    → fork 不落盘(实测:主会话 jsonl md5 不变、无新 jsonl)。
// 无 sessionId(草稿会话)时退化为无上下文的一次性提问。
// argv 见 buildBtwArgs(零工具 + 单回合 side-question reminder);旧版误用
// --permission-mode plan 让旁问能 Read/Grep 调查=比原生更宽、更慢,已纠。
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
  // 流式:stream-json + --include-partial-messages 拿逐 token 的 text_delta,以 NDJSON
  // ({delta}/{done}/{error} 行)转发给前端逐块渲染 —— 旧版攒全量 res.json({answer}) 是
  // "旁问不流式"的根因。-p + stream-json 必须带 --verbose(CLI 硬要求)。
  const args = buildBtwArgs({ sessionId, model });

  // 旁问线程连续化(transcript replay):前端把本线程前序问答随 history 发来,拼进
  // prompt 让本轮旁问延续上下文。全走 stdin(无 cmd 注入面),各处 slice 截断防 prompt 爆:
  // 最多最近 20 轮,单问 4k / 单答 8k 字符。超限截旧的。history 只进 stdin 不落盘,不污染主会话。
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-20) : [];
  let composed = question;
  if (history.length) {
    const transcript = history
      .map(h => `Q: ${String(h?.q || '').slice(0, 4000)}\nA: ${String(h?.a || '').slice(0, 8000)}`)
      .join('\n\n');
    composed =
      `以下是此前的旁问对话记录(供你延续上下文,不要重复回答已答过的旧问题):\n\n${transcript}\n\n` +
      `现在的追问:\n${question}`;
  }

  let proc;
  try {
    proc = claudeSpawn(args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: cleanChildEnv() });
    proc.stdin.write(wrapBtwInline(composed)); proc.stdin.end();
  } catch (e) { return res.status(500).json({ error: 'spawn claude failed: ' + e.message }); }
  if (!proc.pid) { proc.on('error', () => {}); return res.status(500).json({ error: 'claude CLI not found' }); }
  // 同 /chat/title:stderr 是 pipe 但只读 stdout,必须排空,否则超 ~64KB 子进程挂死到超时。
  proc.stderr?.resume();

  // NDJSON 转发:首个 delta 到达才写流式头(之前失败仍可走 500 JSON);之后错误只能以
  // {error} 行传递。X-Accel-Buffering: no 防中间层攒块。
  let headersSent = false;
  const send = (obj) => {
    // 客户端断开到 close 杀进程的窄窗内,write 打到已销毁响应(偶发 ERR_STREAM_DESTROYED)。
    if (res.writableEnded || res.destroyed) return;
    if (!headersSent) {
      headersSent = true;
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
    }
    res.write(JSON.stringify(obj) + '\n');
  };
  let emitted = false;    // 已发过 delta
  let resultText = '';    // 兜底:无 partial(异常形态)时用 result 整段
  let resultErr = '';     // cli-stream-json-error-shape:API 错误 is_error=true、文案在 result
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { killProcessTree(proc); } catch {}
    if (res.writableEnded || res.destroyed) return;
    if (!emitted && resultText) { send({ delta: resultText }); emitted = true; }
    if (emitted) {
      // 流中途 API 错误(cli-stream-json-error-shape:is_error、文案在 result):已发过
      // delta 也要补发 {error} 行再收尾,否则错误被 {done} 吞掉,用户只见半截答案无提示。
      // 前端 handleLine 收到 {error} 抛出→catch 把错误文案缀在已渲染的半截输出之后(4138)。
      if (resultErr) send({ error: resultErr });
      send({ done: true });
    }
    else if (headersSent) send({ error: resultErr || '旁问失败:超时或模型无回答' });
    else return res.status(500).json({ error: resultErr || '旁问失败:超时或模型无回答' });
    res.end();
  };
  // 大会话 resume + 冷启动可能较慢,给 120s;超时若已有部分输出仍收尾返回已有部分。
  const timer = setTimeout(finish, 120000);
  let buf = '';
  proc.stdout.on('data', (c) => {
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'stream_event'
        && ev.event?.type === 'content_block_delta'
        && ev.event.delta?.type === 'text_delta'
        && ev.event.delta.text) {
        emitted = true;
        send({ delta: ev.event.delta.text });
      } else if (ev.type === 'result') {
        if (ev.is_error) resultErr = String(ev.result || '').trim();
        else if (typeof ev.result === 'string') resultText = ev.result.trim();
      }
    }
  });
  proc.on('close', finish);
  proc.on('error', finish);
  res.on('close', finish); // 客户端断开(关窗/刷新)→ 杀子进程,不留孤儿
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
  // 键清单已抽到 utils/provider-env.js(与 index.js 的 boot 清理共用同一份),行为不变。
  const env = stripInheritedProviderEnv({ ...process.env });
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
