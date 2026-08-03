import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, writeFile, mkdir, stat, open, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { getActiveChatProcesses, claudeSpawn, cleanChildEnv, safeModelArg } from './chat.js';
import { resolveWorkspacePath } from '../utils/safe-path.js';
import { claudeCommand } from '../utils/claude-resolver.js';
import { dropPendingForSession } from './permissions.js';

const execFileP = promisify(execFile);
const router = Router();
const AGENTS_DIR = join(homedir(), '.claude', 'agents');
// Bundled agent presets shipped with the GUI (ported from oh-my-opencode-slim).
const BUILTIN_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'builtin-agents');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function assertName(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('invalid agent name (lowercase letters/digits/dash)');
}

// ─── MCP 工具 → agent tools 自动同步 ───────────────────────────────────
// 子代理的 tools 是白名单,MCP 工具必须显式写 `mcp__<server>__*`,且官方不支持 mcp__*
// 全通配。所以用户加/删 MCP 时,自动把对应 `mcp__<server>__*` 同步进各 agent 的 tools,
// 免去手动逐个改(用户选择:同步到所有 agent)。
// server 名转义:冒号→下划线(plugin:context7:context7 → plugin_context7_context7),
// 连字符保留(paper-search-mcp 不变)——与 Claude Code 的工具命名一致。
function escapeMcpName(n) { return String(n).replace(/:/g, '_'); }

// 改一个 .md 的 frontmatter `tools:` 行:add 追加缺失的 mcp__x__*,remove 删掉该 server 的
// 所有 mcp__x__ 条目。无 tools 字段的 agent(继承全部工具,本就含 MCP)直接跳过。
// 返回新内容,无变化/不适用返回 null。仅按行操作,不碰其它 frontmatter/正文。
function rewriteAgentMcpTools(content, { add = [], remove = [] }) {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === '---') { end = i; break; } }
  if (end === -1) return null;
  let ti = -1;
  for (let i = 1; i < end; i++) { if (/^tools:/.test(lines[i])) { ti = i; break; } }
  if (ti === -1) return null; // 无 tools 字段 → 继承全部,不动
  let tokens = lines[ti].replace(/^tools:\s*/, '').split(',').map((s) => s.trim()).filter(Boolean);
  const matches = (t, esc) => t === `mcp__${esc}__*` || t === `mcp__${esc}` || t.startsWith(`mcp__${esc}__`);
  for (const r of remove) { const esc = escapeMcpName(r); tokens = tokens.filter((t) => !matches(t, esc)); }
  for (const a of add) { const esc = escapeMcpName(a); if (!tokens.some((t) => matches(t, esc))) tokens.push(`mcp__${esc}__*`); }
  const newLine = `tools: ${tokens.join(', ')}`;
  if (newLine === lines[ti]) return null;
  lines[ti] = newLine;
  return lines.join('\n');
}

// per-file 串行队列:syncMcpToAgents(后台)与 PUT /agents/:name(用户保存)并发
// 读-改-写同一 .md 会互踩丢内容。同一文件的写操作挂队尾串行,finally 清 Map 项
// (与 sessions.js writeJsonlAtomic 同模式)。
const _agentFileQueues = new Map(); // filePath -> 队尾 Promise
function enqueueAgentFile(file, fn) {
  const prev = _agentFileQueues.get(file) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  _agentFileQueues.set(file, run);
  const cleanup = () => { if (_agentFileQueues.get(file) === run) _agentFileQueues.delete(file); };
  run.then(cleanup, cleanup);
  return run;
}

// 对 ~/.claude/agents/ 下的 .md agent 批量同步。files 省略=全部 agent。
export async function syncMcpToAgents({ add = [], remove = [], files = null } = {}) {
  if (!add.length && !remove.length) return;
  let names = files;
  if (!names) {
    try { names = (await readdir(AGENTS_DIR)).filter((f) => f.endsWith('.md')); } catch { return; }
  }
  for (const f of names) {
    const full = join(AGENTS_DIR, f);
    await enqueueAgentFile(full, async () => {
      let content, mtime;
      try {
        content = await readFile(full, 'utf-8');
        mtime = (await stat(full)).mtimeMs;
      } catch { return; }
      let updated = rewriteAgentMcpTools(content, { add, remove });
      if (!updated || updated === content) return;
      // 乐观锁:最终写之前再对一次 mtime —— 队列外的写入(编辑器/CLI/旧客户端直写)
      // 在读之后动了文件,就重读重算一次;仍不一致则放弃本轮,宁可不同步也不覆盖他人写入。
      try {
        if ((await stat(full)).mtimeMs !== mtime) {
          content = await readFile(full, 'utf-8');
          mtime = (await stat(full)).mtimeMs;
          updated = rewriteAgentMcpTools(content, { add, remove });
          if (!updated || updated === content) return;
        }
      } catch { return; }
      try { await writeFile(full, updated); } catch {}
    });
  }
}

export async function currentUserMcpNames() {
  try {
    const j = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf-8'));
    return Object.keys(j.mcpServers || {});
  } catch { return []; }
}

/**
 * GET /api/agents
 * Lists agent presets from ~/.claude/agents/<name>.{md,json}. Falls back to
 * `claude agents` if the directory doesn't exist (some installs use a
 * different storage). We never invent agents — only echo what's on disk.
 */
router.get('/agents', async (req, res) => {
  try {
    const agents = [];
    try {
      const files = await readdir(AGENTS_DIR);
      for (const f of files) {
        if (!/\.(md|json)$/.test(f)) continue;
        const full = join(AGENTS_DIR, f);
        const name = f.replace(/\.(md|json)$/, '');
        let content;
        try { content = await readFile(full, 'utf-8'); } catch { continue; }
        let description = '';
        const m = content.match(/^---[\s\S]*?description:\s*(.+?)[\n\r]/);
        if (m) description = m[1].trim();
        agents.push({ name, file: full, description, format: f.endsWith('.md') ? 'md' : 'json' });
      }
    } catch {}

    // Always try the CLI as a secondary source — some installs register agents
    // elsewhere. If both succeed we merge by name.
    try {
      // 路径解析统一走 claude-resolver(PATH 外安装位也可用;Win .cmd 经 cmd.exe)。
      const { file, args: fullArgs } = claudeCommand(['agents', 'list']);
      const out = await execFileP(file, fullArgs, { timeout: 6000 });
      const lines = out.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        const m = line.match(/^([a-z0-9-]+)\b/);
        if (m && !agents.some((a) => a.name === m[1])) {
          agents.push({ name: m[1], file: null, description: '(via claude CLI)', format: 'cli' });
        }
      }
    } catch {}

    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/agents/active — Subagent monitor panel data source.
 *
 * Aggregates two signals:
 *   1. chat.js's `activeProcesses` Map — Claude child processes we spawned
 *      ourselves via the GUI's chat endpoint (most fine-grained metadata)
 *   2. `~/.claude/sessions/*.json` — claude CLI's own registry of every
 *      active session/subagent across the machine. Each file contains
 *      { pid, sessionId, cwd, startedAt, kind, entrypoint }. We filter to
 *      sessions whose pid is actually still alive, since claude leaves
 *      stale entries.
 *
 * The two are merged by pid (so a chat-process we spawned doesn't appear
 * twice). Frontend polls this every ~1.5s when the panel is open.
 */
// CLI 的会话注册表目录。homedir() 而非 process.env.HOME:Windows 上 HOME 为空
// (CO-1 同款教训)→ 读 `undefined/.claude/sessions` 恒失败被吞。
const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

// 注册表条目(~/.claude/sessions/<pid>.json)→ /agents/active 的一条记录。
// 纯函数(IO 在调用方),便于单测。job = readBgJobState() 结果,仅后台代理传。
//
// status 只认 'waiting' 一个源值,其余一律 'alive':批K 定的语义是"注册表对外部会话
// 只能确知进程还活着"。CLI 目前只在会话真的停下来等人时才写 status/waitingFor
// (busy/shell/idle 等取值前端没有对应桶,盲目透传会把外部终端会话甩进"其他"桶)。
// 'waiting' 是唯一能确知的新事实——它在等人,所以透传。
export function buildCliSessionEntry(s, fallbackId, job = null) {
  const isBg = s.kind === 'bg' || s.kind === 'background';
  const waiting = s.status === 'waiting' || job?.jobState === 'blocked';
  const startedAt = s.startedAt || s.procStart || null;
  return {
    kind: 'cli-session',
    // 注册表自己的 kind(interactive/bg 等)独立返回,前端据此分区。
    cliKind: s.kind || null,
    pid: String(s.pid),
    sessionId: s.sessionId || fallbackId,
    cwd: s.cwd || null,
    model: null,
    promptPreview: s.kind || s.entrypoint || '',
    permissionMode: 'default',
    startedAt,
    elapsedMs: startedAt ? Date.now() - startedAt : null,
    status: waiting ? 'waiting' : 'alive',
    // waitingFor:CLI 写下的等待原因(permission prompt / input needed / dialog open /
    // sandbox request / worker request),前端翻成中文副标题。
    waitingFor: s.waitingFor || null,
    // 后台代理补落盘状态:state=working/blocked/…,needs 是 CLI 写的人话待办
    // (如 "approve Write: /abs/path")= "它在等你什么"的答案。
    ...(isBg ? {
      state: job?.jobState ?? null,
      tempo: job?.tempo ?? s.tempo ?? null,
      needs: job?.needs || s.needs || '',
    } : {}),
    // 后台代理**只读**:多个后台代理的 pid 都指向同一个 CLI supervisor,pid kill 会
    // 连坐全停(见 background/stop 注释)。它们的停止走 `claude stop <id>`,由
    // /api/agents/background 那条通道提供按钮。
    stoppable: !isBg,
  };
}

router.get('/agents/active', async (req, res) => {
  const out = [];
  const seenPids = new Set();
  // CG-5:SDK 引擎下 chat-process 的 pid 是合成 'sdk-N',Number() 后 NaN,按 pid 去重失效
  // → 同一会话既出 chat-process 卡又出 cli-session 卡(双显 + 元数据丢)。改按 sessionId
  // 去重为主,pid 去重保留作旧路径兜底;无 sessionId(draft)退回 pid。
  const seenSessionIds = new Set();

  // 1. Live chat children — always available, richest metadata.
  // Finished turns linger for a 60s grace window (chat.js) so they show as
  // 已完成/错误 (= 会话等待用户回复) instead of vanishing the instant they end.
  for (const p of getActiveChatProcesses()) {
    const finished = p.exitCode !== null;
    // #26:idle = 会话常驻进程在回合间保活等下一条消息 —— 不是"正在跑"。客户端的
    // 运行中判定(侧栏绿点/后台横幅)都要排除 idle;stoppable 保持 true,删除链路照杀。
    const status = finished
      ? (p.exitCode === 0 ? 'done' : 'error')
      : (p.idle ? 'idle' : (p.attached ? 'streaming' : 'starting'));
    out.push({
      kind: 'chat-process',
      pid: p.pid,
      sessionId: p.sessionId,
      draftId: p.draftId || null,
      cwd: p.cwd,
      model: p.model,
      promptPreview: p.promptPreview,
      permissionMode: p.permissionMode,
      startedAt: p.startedAt,
      elapsedMs: finished
        ? (p.startedAt && p.finishedAt ? p.finishedAt - p.startedAt : 0)
        : (p.startedAt ? Date.now() - p.startedAt : 0),
      status,
      stoppable: !finished,
      cronHold: !!p.cronHold, // 建过 cron(/loop),进程被豁免于闲置回收(chat.js CRON_HOLD_MS)
    });
    seenPids.add(Number(p.pid));
    if (p.sessionId) seenSessionIds.add(p.sessionId);
  }

  // 2. CLI's own active session registry
  let entries = [];
  try { entries = await readdir(SESSIONS_DIR); } catch {}
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(`${SESSIONS_DIR}/${f}`, 'utf-8');
      const s = JSON.parse(raw);
      if (!s.pid) continue;
      // `claude --bg` 后台代理(注册表 kind='bg';`claude agents --json` 里叫 'background')
      // 以【只读条目】列出(stoppable:false),不给 pid kill 按钮 —— 多个后台代理的 pid 都指向
      // 同一个 CLI supervisor,pid kill 会连坐全停(background/stop 注释警告的危险路径)。
      // 之所以要列:它们的"在等你"(status/waitingFor + jobs 落盘 state/needs)是 app 级角标
      // 的数据源,而这条通道是本机唯一不需要每次 spawn `claude agents` 的廉价来源。
      // 面板里它们仍由 /api/agents/background 那一区呈现(前端按 cliKind 过滤,不重复显示)。
      const isBg = s.kind === 'bg' || s.kind === 'background';
      // 已被 chat-process 收录的会话(按 sessionId 或 pid)不重复显示。
      if ((s.sessionId && seenSessionIds.has(s.sessionId)) || seenPids.has(Number(s.pid))) continue;
      // Check the process is still alive — claude often leaves stale files.
      let alive = false;
      try { process.kill(Number(s.pid), 0); alive = true; } catch {}
      if (!alive) continue;
      // 后台代理:补读 ~/.claude/jobs/<id>/state.json(state/needs/tempo)。
      const job = isBg ? await readBgJobState(bgJobIdOf(s)) : null;
      // 已结束的后台代理不列出:supervisor pid 长期存活,否则终态条目会永久挂在列表里。
      if (isBg && job && BG_TERMINAL_STATES.has(job.jobState)) continue;
      out.push(buildCliSessionEntry(s, f.replace('.json', ''), job));
    } catch {}
  }

  res.json({
    agents: out,
    sources: {
      chatProcesses: out.filter((a) => a.kind === 'chat-process').length,
      cliSessions: out.filter((a) => a.kind === 'cli-session').length,
    },
  });
});

// GET /api/workflow-agents?projectHash=X&sid=Y — 当前会话 workflow 内层 agent 实时状态。
// Workflow 工具起的内层 agent 不流经父流(父流只发 workflow 整体的 task_* 事件,见 App.jsx),
// 其转写落磁盘 <sid>/subagents/workflows/wf_*/agent-*.jsonl。这里【只扫当前打开会话】的
// workflows 目录出实时状态(前端面板关闭即停轮询):journal.jsonl 的 result 条 = 权威 done;
// 否则 agent-*.jsonl mtime 新(<WF_ALIVE_MS)= running,过期 = idle(不谎称完成,同 bgTask 三态
// 哲学)。Win 路径复用 join/readdir 不手拼分隔符。
const WF_ALIVE_MS = 15000;
const WF_SAFE_ID = /^(?!\.+$)[A-Za-z0-9._-]+$/;  // 排除纯点名(..)防路径穿透,见 LEARNINGS 同款规矩
router.get('/workflow-agents', async (req, res) => {
  const projectHash = String(req.query.projectHash || '');
  const sid = String(req.query.sid || '');
  if (!WF_SAFE_ID.test(projectHash) || !WF_SAFE_ID.test(sid)) return res.json({ agents: [] });
  const wfRoot = join(homedir(), '.claude', 'projects', projectHash, sid, 'subagents', 'workflows');
  let wfDirs = [];
  try { wfDirs = await readdir(wfRoot); } catch { return res.json({ agents: [] }); }
  const now = Date.now();
  const out = [];
  for (const wf of wfDirs) {
    if (!wf.startsWith('wf_')) continue;
    const wfDir = join(wfRoot, wf);
    let files;
    try { files = await readdir(wfDir); } catch { continue; }
    // journal.jsonl:每内层 agent 一条 started + 完成后一条 result(带 agentId)。有 result = 权威 done。
    const doneIds = new Set();
    try {
      const j = await readFile(join(wfDir, 'journal.jsonl'), 'utf-8');
      for (const line of j.split('\n')) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (o.type === 'result' && o.agentId) doneIds.add(o.agentId); } catch {}
      }
    } catch {}
    for (const af of files) {
      if (!af.startsWith('agent-') || !af.endsWith('.jsonl')) continue;
      const agentId = af.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      let mtimeMs = 0;
      try { mtimeMs = (await stat(join(wfDir, af))).mtimeMs; } catch { continue; }
      let agentType = null;
      try { agentType = JSON.parse(await readFile(join(wfDir, af.replace('.jsonl', '.meta.json')), 'utf-8')).agentType || null; } catch {}
      const status = doneIds.has(agentId) ? 'done' : (now - mtimeMs < WF_ALIVE_MS ? 'running' : 'idle');
      out.push({ id: agentId, workflowId: wf, agentType: agentType || 'workflow-subagent', status, lastActivity: mtimeMs || null });
    }
  }
  res.json({ agents: out });
});

// ── 后台代理(claude --bg / claude agents)────────────────────────────────
// CLI 原生能力包一层:`claude agents --json [--all]` 直接吐 JSON 数组
// {pid,cwd,kind,startedAt,sessionId,name}(实测 2.1.198,非 TTY 可用);后台会话
// 另有 {id,state}(实测 2.1.200,--all 时已结束的 state 为 done/failed/killed 等,
// 无 pid)。停止复用现有 /api/processes/:pid/kill(白名单=同一 ~/.claude/sessions
// 注册表)。

// cwd → ~/.claude/projects 目录名(与 CLI 同算法:非字母数字逐个替换为 -,
// 同 settings.js 的 pathToHash)。前端拿它 + sessionId 即可打开该会话的转写。
function cwdToProjectHash(p) {
  return String(p || '').replace(/[^A-Za-z0-9]/g, '-');
}

// --json 输出没有结束时间/结果摘要;CLI 把后台会话的落盘状态写在
// ~/.claude/jobs/<id>/state.json({state,detail,output.result,updatedAt,...},
// 实测 2.1.200)。这里尽力而为地补读,读不到不影响列表本身。
async function readBgJobState(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return null;
  try {
    const raw = await readFile(join(homedir(), '.claude', 'jobs', String(id), 'state.json'), 'utf-8');
    const s = JSON.parse(raw);
    return {
      endedAt: s.updatedAt ? Date.parse(s.updatedAt) || null : null,
      detail: typeof s.detail === 'string' ? s.detail.slice(0, 300) : '',
      resultPreview: typeof s.output?.result === 'string' ? s.output.result.slice(0, 500) : '',
      // needs:CLI 写的人话待办(如 "approve Write: /abs/path"),blocked 时才有 ——
      // 这就是"后台代理在等你什么"的答案,面板直接显示给用户。
      needs: typeof s.needs === 'string' ? s.needs.slice(0, 300) : '',
      tempo: typeof s.tempo === 'string' ? s.tempo : null,
      // 落盘 state 单独用 jobState 键回传,【不能】叫 state:/agents/background 那边
      // Object.assign 到 base 上会覆盖 `claude agents --json` 的权威 state
      // (两边不同步时终态判定会来回跳)。cli-session 那边没有别的来源,才用它当 state。
      jobState: typeof s.state === 'string' ? s.state : null,
    };
  } catch { return null; }
}

// 后台会话 → jobs 目录名。`claude agents --json` 给 id;注册表文件里叫 jobId;
// 都缺时用 sessionId 前 8 位(实测 2.1.200 的命名规则)。
function bgJobIdOf(a) {
  return a.jobId || a.id || (a.sessionId ? String(a.sessionId).slice(0, 8) : null);
}

// 停止时要清权限卡:前端传来的 id 可能是 jobId 也可能是 sessionId,而权限卡按
// hook 报的 session_id 归属。把 job state 里记的会话 id 一并取出,逐个清。
async function bgSessionIdsFor(id) {
  const ids = new Set([id]);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return ids;
  try {
    const s = JSON.parse(await readFile(join(homedir(), '.claude', 'jobs', String(id), 'state.json'), 'utf-8'));
    for (const k of ['sessionId', 'resumeSessionId']) if (typeof s[k] === 'string' && s[k]) ids.add(s[k]);
  } catch {}
  return ids;
}

// ~/.claude/sessions/*.json 里 CLI 自己写的等待态,按 sessionId 索引。
// 后台代理的 `claude agents --json` 输出没有 status/waitingFor,只有注册表有。
async function readWaitingRegistry() {
  const map = new Map();
  let entries = [];
  try { entries = await readdir(SESSIONS_DIR); } catch { return map; }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(await readFile(join(SESSIONS_DIR, f), 'utf-8'));
      if (!s.sessionId) continue;
      map.set(s.sessionId, {
        status: s.status === 'waiting' ? 'waiting' : null,
        waitingFor: s.waitingFor || null,
      });
    } catch {}
  }
  return map;
}

// 后台会话的终态(结束不再变化)。running/working 等一律视为进行中。
const BG_TERMINAL_STATES = new Set(['done', 'failed', 'killed', 'stopped', 'error']);

// GET /api/agents/background?all=1 — 列出后台代理(--all 含已结束)
router.get('/agents/background', async (req, res) => {
  const args = ['agents', '--json'];
  if (req.query.all === '1') args.push('--all');
  try {
    const list = await new Promise((resolve, reject) => {
      const proc = claudeSpawn(args, { stdio: ['ignore', 'pipe', 'pipe'], env: cleanChildEnv() });
      proc.stderr?.resume(); // 只读 stdout,排空 stderr 防 64KB 挂死(v0.2.93 教训)
      let out = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('claude agents 超时')); }, 15000);
      proc.stdout.on('data', (d) => { out += d; });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(out)); } catch { reject(new Error('claude agents 输出不是 JSON')); }
      });
    });
    const registry = await readWaitingRegistry();
    const agents = await Promise.all((Array.isArray(list) ? list : []).map(async (a) => {
      const base = {
        pid: a.pid, cwd: a.cwd || null, kind: a.kind || '', name: a.name || '',
        sessionId: a.sessionId || null, startedAt: a.startedAt || null,
        elapsedMs: a.startedAt ? Date.now() - a.startedAt : null,
        id: a.id || null,
        state: a.state || null,
        projectHash: a.cwd ? cwdToProjectHash(a.cwd) : null,
        endedAt: null, detail: '', resultPreview: '',
        // 等待态四件套(与 /agents/active 的 cli-session 条目同构)
        status: null, waitingFor: null, needs: '', tempo: null,
      };
      // jobs/<id>/state.json(best-effort)。**非终态也读**:blocked 的 needs 才是
      // "它在等你什么"的答案,只在终态读等于把等待信息全丢了。
      if (a.kind === 'background') {
        const extra = await readBgJobState(bgJobIdOf(a));
        if (extra) Object.assign(base, extra);
        // status/waitingFor 只有注册表有(--json 输出不带)。
        const reg = a.sessionId ? registry.get(a.sessionId) : null;
        if (reg) Object.assign(base, reg);
        // 落盘 state 是 blocked 但注册表还没写 waiting 时,仍按"在等你"呈现。
        if (!base.status && base.jobState === 'blocked') base.status = 'waiting';
      }
      return base;
    }));
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 后台代理的权限应答通道(default 档)────────────────────────────────────
// GUI 自带的 PermissionRequest hook:把后台代理的授权请求转成界面上的权限卡。
// 经 `--settings <file>` 挂上,不动用户的 ~/.claude/settings.json(实测 CLI 对
// --settings 是【追加合并】,用户原有配置照常生效;哨兵见 checkSettingsMergeSentinel)。
const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'permission-request-hook.mjs');
const BG_HOOK_SETTINGS = join(homedir(), '.claude-gui', 'bg-permission-hook.settings.json');

// hook 的 command 是交给 shell 执行的字符串,路径带空格(如 "/…/claude gui/…")必须自己引。
function shellQuote(s) {
  const v = String(s);
  return process.platform === 'win32' ? `"${v.replace(/"/g, '""')}"` : `'${v.replace(/'/g, "'\\''")}'`;
}

// 写成【稳定文件】而不是内联 JSON:claudeSpawn 的 Windows 分支会把内联 JSON 落成临时
// 文件、并在**派发进程**退出时删掉,而真正跑代理的是另一个常驻 supervisor,之后再读就
// 没了。稳定文件没有这个竞态,也方便排查。端口每次重写(GUI 可能落在 6677..6687)。
async function writeBgHookSettings(port) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(HOOK_SCRIPT)} ${Number(port) || 6677}`;
  const body = {
    hooks: {
      // matcher '*' = 所有工具(CLI 的匹配函数:matcher 缺省或 '*' 直接返回 true)。写明
      // 而不是省略,免得日后有人以为它只对某几个工具生效。
      // timeout 是 hook 允许阻塞的秒数 = 用户的应答窗口(hook 脚本自己在 295s 先超时吐 deny)。
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 300 }] }],
    },
  };
  await mkdir(dirname(BG_HOOK_SETTINGS), { recursive: true });
  await writeFile(BG_HOOK_SETTINGS, JSON.stringify(body, null, 2), 'utf-8');
  return BG_HOOK_SETTINGS;
}

// --settings 合并语义哨兵。实测(CLI 2.1.220)是追加合并:挂了 hook 的后台代理,job
// state 里照样带着用户 settings 的 providerEnv。若哪天变成整体替换,后台代理会静默丢掉
// 用户的 provider 配置(跑错账号/错模型)——那是必须立刻知道的语义变更,故派发后抽查一次。
// 只在用户确实有 ANTHROPIC_* 环境变量时才判(否则 providerEnv 本就该是空的);只 log。
async function checkSettingsMergeSentinel(sinceMs) {
  try {
    const userEnv = JSON.parse(await readFile(join(homedir(), '.claude', 'settings.json'), 'utf-8'))?.env || {};
    if (!Object.keys(userEnv).some((k) => k.startsWith('ANTHROPIC_'))) return;
    const jobsDir = join(homedir(), '.claude', 'jobs');
    let newest = null;
    for (const d of await readdir(jobsDir)) {
      try {
        const p = join(jobsDir, d, 'state.json');
        const m = (await stat(p)).mtimeMs;
        if (m >= sinceMs && (!newest || m > newest.m)) newest = { m, p };
      } catch {}
    }
    if (!newest) return;
    const s = JSON.parse(await readFile(newest.p, 'utf-8'));
    if (!s.providerEnv || !Object.keys(s.providerEnv).length) {
      console.warn('[bg-dispatch] --settings 似乎已从"合并"变为"替换":新后台代理的 providerEnv 为空,'
        + '而用户 settings.json 里有 ANTHROPIC_* 环境变量。后台代理可能跑在错误的 provider 上,请核实。');
    }
  } catch {}
}

// 后台代理的权限档白名单。默认仍是 acceptEdits(不改变现有用户行为)。
const BG_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);

// POST /api/agents/background/dispatch { cwd, prompt, model?, permissionMode? }
// `claude --bg <prompt>`:派后台代理立即返回。permissionMode 默认 acceptEdits ——
// 后台无人值守;选 default 时必须同时挂上 PermissionRequest hook,否则代理会卡在
// 授权等待永不返回。绝不静默 bypass。
router.post('/agents/background/dispatch', async (req, res) => {
  const { cwd, prompt, model, permissionMode } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'prompt 必填' });
  // Windows cmd 注入守卫:--bg 要求 prompt 走位置参数(无法改 stdin),Windows 上经 cmd.exe /c;
  // libuv 只给含空格的参数加引号,故【无空格且含 cmd 元字符】的 prompt(如 "x&calc")会被 cmd
  // 重解析执行 = 绕权限 RCE。真实任务描述都有空格(会被引用→安全),单 token 带元字符=攻击形态,拒。
  if (process.platform === 'win32' && !/\s/.test(prompt.trim()) && /[&|<>^]/.test(prompt)) {
    return res.status(400).json({ error: 'prompt 含不安全字符(单个词里的 & | < > ^);请用正常任务描述' });
  }
  let dir;
  // 工作区例外版(fable 审计):后台代理语义=在该项目目录跑 claude --bg,Windows
  // 其他盘项目走严格 $HOME 门禁必 400(与 purge 同类)。spawn cwd 用归一化形态无害
  // (claude 记录的是自身 process.cwd())。
  try { dir = resolveWorkspacePath(String(cwd || ''), { label: 'cwd' }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  // 实测:--bg 与 -p 冲突(-p 不起 interactive 会话,agents 无法 attach)——prompt 必须
  // 走位置参数:`claude --bg '<task>'`。
  const mode = BG_PERMISSION_MODES.has(permissionMode) ? permissionMode : 'acceptEdits';
  const args = ['--bg', prompt.trim(), '--permission-mode', mode];
  // 只给用户主动选的 default / plan 挂 hook。acceptEdits 一个字不动 —— 它是既有默认档,
  // 挂上会改变它的既有行为(GUI 没开时,原本"卡着等、可事后在终端 attach 应答"的请求
  // 会变成立即拒绝)。注:acceptEdits 档下的非编辑类请求(Bash 等)照旧可能永久等待,
  // 那是本批之外的老问题,现在至少能在监控面板看见"等待授权"。
  if (mode !== 'acceptEdits') {
    // 挂不上 hook 就不派:这两档没有应答通道 = 代理必然卡在授权等待永不返回,
    // 那正是本通道要消灭的静默失败,不能"降级"成它。
    try { args.push('--settings', await writeBgHookSettings(req.socket?.localPort)); }
    catch (e) { return res.status(500).json({ error: `无法写入授权 hook 配置(${e.message});已取消派发` }); }
  }
  // model 过白名单:Windows cmd.exe /c 下无空格+含 & 的 model 会被当命令分隔执行(RCE 绕权限)。
  // 注:--bg 要求 prompt 走位置参数无法改 stdin,现实 prompt 多含空格会被 libuv 引用;model 是干净活口。
  const safeModel = safeModelArg(model);
  if (safeModel) args.push('--model', safeModel);
  const dispatchedAt = Date.now();
  try {
    const proc = claudeSpawn(args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: cleanChildEnv() });
    let out = '';
    let errOut = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { if (errOut.length < 4000) errOut += d; });
    // --bg 打印派发信息后立即退出;等它退出把 stdout 返回(含 agent 名/说明供前端展示)。
    const done = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), 20000);
      proc.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
      proc.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
    });
    if (done.error) return res.status(500).json({ error: done.error });
    // 退出码非 0 = 派发失败(如 flag 冲突/额度),必须如实报错,不能装 ok。
    if (!done.timedOut && done.code !== 0) {
      return res.status(500).json({ error: (errOut || out || `claude --bg 退出码 ${done.code}`).trim().slice(0, 1000) });
    }
    if (mode !== 'acceptEdits') setTimeout(() => { checkSettingsMergeSentinel(dispatchedAt); }, 3000).unref();
    res.json({ ok: true, mode, output: out.trim().slice(0, 2000), ...(done.timedOut ? { note: '派发进程未在 20s 内退出,代理可能仍已启动' } : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/background/stop { id }
// 停后台代理的【官方】方式:`claude stop <id>`(停会话、保留可 attach)。
// 绝不用 pid kill —— `claude agents --json` 里多个后台代理的 pid 都指向同一个
// CLI supervisor 进程,按 pid kill 会【连坐全停】且常无效(用户实报:停一个全停、
// 停止没反应、已停的仍显示运行中)。用各自的 id 逐个停才正确。
router.post('/agents/background/stop', async (req, res) => {
  const id = String(req.body?.id || '').trim();
  // CLI 的会话 id / sessionId:字母数字加连字符/下划线,不含路径分隔符。
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'id 必填且需为合法会话标识' });
  }
  try {
    const proc = claudeSpawn(['stop', id], { stdio: ['ignore', 'pipe', 'pipe'], env: cleanChildEnv() });
    let out = '', errOut = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { if (errOut.length < 2000) errOut += d; });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(-1); }, 10000);
      proc.on('close', (c) => { clearTimeout(timer); resolve(c); });
      proc.on('error', () => { clearTimeout(timer); resolve(-2); });
    });
    if (code !== 0) {
      return res.status(500).json({ error: (errOut || out || `claude stop 退出码 ${code}`).trim().slice(0, 500) });
    }
    // 停进程不会自动清它的权限卡(卡片是独立态,批J 同款教训):留着就是一张"应答了也
    // 没人收"的卡。id 可能是 jobId 也可能是 sessionId,连同 job state 里记的会话 id
    // 一起清一遍(不匹配的是 no-op)。
    for (const sid of await bgSessionIdsFor(id)) dropPendingForSession(sid);
    res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Bundled (built-in) agent presets ─────────────────────────────────────
// The GUI ships agent .md presets (explorer/librarian/oracle/designer/fixer +
// orchestrator, ported from oh-my-opencode-slim). They are NOT auto-installed —
// the user installs on demand, after which they live in ~/.claude/agents/ as
// ordinary, fully-editable custom agents.
// NOTE: these routes MUST be registered before `/agents/:name`, otherwise
// Express matches `:name = "builtin"` and returns "agent not found".

async function readBuiltinAgents() {
  const out = [];
  let files = [];
  try { files = await readdir(BUILTIN_AGENTS_DIR); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const name = f.replace(/\.md$/, '');
    let content = '';
    try { content = await readFile(join(BUILTIN_AGENTS_DIR, f), 'utf-8'); } catch { continue; }
    let description = '';
    const m = content.match(/^---[\s\S]*?description:\s*(.+?)[\n\r]/);
    if (m) description = m[1].trim();
    let model = '';
    const mm = content.match(/^---[\s\S]*?\bmodel:\s*(.+?)[\n\r]/);
    if (mm) model = mm[1].trim();
    let installed = false;
    try { await stat(join(AGENTS_DIR, f)); installed = true; } catch {}
    out.push({ name, description, model, installed, content });
  }
  return out;
}

/** GET /api/agents/builtin — list bundled presets + whether each is installed. */
router.get('/agents/builtin', async (_req, res) => {
  try {
    const agents = (await readBuiltinAgents()).map(({ content, ...rest }) => rest);
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents/builtin/install  { names?: string[], overwrite?: boolean }
 * Copies bundled presets into ~/.claude/agents/. Without `names`, installs all.
 * Skips already-present files unless `overwrite` is true. Never deletes anything.
 */
router.post('/agents/builtin/install', async (req, res) => {
  try {
    const { names, overwrite } = req.body || {};
    const builtin = await readBuiltinAgents();
    const wanted = Array.isArray(names) && names.length
      ? builtin.filter((a) => names.includes(a.name))
      : builtin;
    if (!wanted.length) return res.status(400).json({ error: '没有匹配的内置 agent' });
    await mkdir(AGENTS_DIR, { recursive: true });
    const installed = [];
    const skipped = [];
    for (const a of wanted) {
      const dest = join(AGENTS_DIR, `${a.name}.md`);
      let exists = false;
      try { await stat(dest); exists = true; } catch {}
      if (exists && !overwrite) { skipped.push(a.name); continue; }
      // 走与 PUT /agents/:name / syncMcpToAgents 相同的 per-file 队列:批量安装与
      // 后台 MCP 同步并发写同一 .md 会互踩。
      await enqueueAgentFile(dest, async () => { await writeFile(dest, a.content, 'utf-8'); });
      installed.push(a.name);
    }
    res.json({ ok: true, installed, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/agents/:name — raw file content (md or json) */
router.get('/agents/:name', async (req, res) => {
  try {
    assertName(req.params.name);
    const candidates = [join(AGENTS_DIR, req.params.name + '.md'), join(AGENTS_DIR, req.params.name + '.json')];
    for (const path of candidates) {
      try {
        const content = await readFile(path, 'utf-8');
        // mtimeMs 供编辑乐观锁:前端保存时带回 expectedMtimeMs,与磁盘比对防
        // MCP 自动同步等后台改写被静默覆盖。
        let mtimeMs = null;
        try { mtimeMs = (await stat(path)).mtimeMs; } catch {}
        return res.json({ name: req.params.name, path, content, mtimeMs });
      } catch {}
    }
    res.status(404).json({ error: 'agent not found' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PUT /api/agents/:name  { content, expectedMtimeMs? }
 * 乐观锁:带 expectedMtimeMs 时与磁盘 mtime 比对,不一致返 409 + 当前磁盘内容
 * (典型冲突源:用户编辑期间 MCP 面板增删触发 syncMcpToAgents 后台改写同一文件)。
 * 不带 expectedMtimeMs = 无条件覆盖(前端"强制覆盖"选项/旧客户端兼容)。 */
router.put('/agents/:name', async (req, res) => {
  try {
    assertName(req.params.name);
    const { content, expectedMtimeMs } = req.body || {};
    if (typeof content !== 'string') throw new Error('content must be a string');
    await mkdir(AGENTS_DIR, { recursive: true });
    const path = join(AGENTS_DIR, req.params.name + '.md');
    // 乐观锁比对 + 写入挂进与 syncMcpToAgents 相同的 per-file 队列:否则后台同步可能
    // 插在 stat 与 writeFile 之间,先被覆盖再覆盖回去 = 两边内容互丢。
    const { isNew, conflict } = await enqueueAgentFile(path, async () => {
      // 区分新建 vs 编辑:新建时把当前所有 MCP 同步进这个新 agent(让它一创建就能用全部 MCP);
      // 编辑时不动(尊重用户手动增删的 MCP,避免把他刚删的又加回来)。
      let isNew = false;
      let cur = null;
      try { cur = await stat(path); } catch { isNew = true; }
      if (!isNew && expectedMtimeMs != null && cur.mtimeMs !== Number(expectedMtimeMs)) {
        let current = '';
        try { current = await readFile(path, 'utf-8'); } catch {}
        return { conflict: { mtimeMs: cur.mtimeMs, content: current } };
      }
      await writeFile(path, content);
      return { isNew };
    });
    if (conflict) return res.status(409).json({ error: 'conflict', mtimeMs: conflict.mtimeMs, content: conflict.content });
    let syncedContent = null;
    if (isNew) {
      try {
        await syncMcpToAgents({ add: await currentUserMcpNames(), files: [req.params.name + '.md'] });
        // 同步可能追加了 mcp__x__* → 回传改写后内容,前端据此刷新编辑区,
        // 否则下次保存会用旧内容把同步结果抹掉。
        const after = await readFile(path, 'utf-8');
        if (after !== content) syncedContent = after;
      } catch {}
    }
    let mtimeMs = null;
    try { mtimeMs = (await stat(path)).mtimeMs; } catch {}
    res.json({ ok: true, path, mtimeMs, ...(syncedContent != null ? { content: syncedContent } : {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** DELETE /api/agents/:name — remove the agent .md/.json from ~/.claude/agents. */
router.delete('/agents/:name', async (req, res) => {
  try {
    assertName(req.params.name);
    let removed = false;
    for (const ext of ['.md', '.json']) {
      try { await unlink(join(AGENTS_DIR, req.params.name + ext)); removed = true; } catch {}
    }
    if (!removed) return res.status(404).json({ error: 'agent not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 后台任务 .output 路径白名单(防越权读/越权杀任意进程)。规范化分隔符后兼容两种
// claude 后台输出落盘形态:
//  · macOS/Linux: /tmp/claude-<uid>/<projectHash>/<sid>/tasks/<id>.output(也含 /private/tmp)
//  · Windows:     <盘>:\Users\..\AppData\Local\Temp\claude\<projectHash>\<sid>\tasks\<id>.output
// 安全锚点:必须以 /tasks/<安全id>.output 结尾 + 禁 ..(中间段任意,末段文件名受限字符集)。
function isValidBgOutputPath(p) {
  if (!p || p.includes('..')) return false;
  const norm = String(p).replace(/\\/g, '/');
  return /(?:^|\/)(?:private\/)?tmp\/claude-\d+\/.+\/tasks\/[A-Za-z0-9_-]+\.output$/.test(norm)   // POSIX
    || /(?:^|\/)temp\/claude\/.+\/tasks\/[A-Za-z0-9_-]+\.output$/i.test(norm);                    // Windows
}

// GET /api/bgtask/output?path=<abs>&offset=N
// tail 后台任务的输出文件(claude run_in_background 的 stdout 落盘文件)。按 offset 增量返回。
// 安全:仅允许 /tmp/claude-<uid>/.../tasks/<id>.output 形态的路径,禁 ..(防越权读任意文件)。
router.get('/bgtask/output', async (req, res) => {
  try {
    const p = String(req.query.path || '');
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    if (!isValidBgOutputPath(p)) {
      return res.status(400).json({ error: 'invalid bgtask output path' });
    }
    let st;
    try { st = await stat(p); } catch { return res.json({ exists: false }); }
    const size = st.size;
    let content = '';
    if (size > offset) {
      const fh = await open(p, 'r');
      try {
        const len = Math.min(size - offset, 256 * 1024); // 单次最多 256KB,防超大输出撑爆
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        content = buf.toString('utf8');
      } finally { await fh.close(); }
    }
    res.json({ exists: true, size, mtimeMs: st.mtimeMs, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bgtask/kill  { path: <.output 绝对路径> }
// 手动中断仍在跑的后台任务(用户怕它损坏文件时随时停)。**安全第一**:只杀文件句柄/
// 命令行精确引用「那个 .output 路径或其唯一 shellId」的进程,定位不到就如实返回
// located:false(前端提示手动结束),绝不按命令名等宽匹配乱杀。
router.post('/bgtask/kill', async (req, res) => {
  try {
    const p = String(req.body?.path || '');
    if (!isValidBgOutputPath(p)) return res.status(400).json({ error: 'invalid bgtask output path' });
    const norm = p.replace(/\\/g, '/');
    const shellId = norm.split('/').pop().replace(/\.output$/i, ''); // 受限字符集,可安全内插

    let pids = [];
    if (process.platform === 'win32') {
      // 无 lsof。查命令行里引用了该 .output 路径或唯一 shellId 的进程(后台 shell 及其子树)。
      // shellId 仅 [A-Za-z0-9_-],无注入风险。CIM 失败回落 wmic。
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${shellId}*' } | Select-Object -ExpandProperty ProcessId`;
      try {
        const { stdout } = await execFileP('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000 });
        pids = stdout.split(/\s+/).map((s) => parseInt(s, 10)).filter(Boolean);
      } catch {
        try {
          const { stdout } = await execFileP('wmic', ['process', 'where', `CommandLine like '%${shellId}%'`, 'get', 'ProcessId'], { timeout: 8000 });
          pids = stdout.split(/\s+/).map((s) => parseInt(s, 10)).filter(Boolean);
        } catch {}
      }
      pids = [...new Set(pids)].filter((pid) => pid !== process.pid);
      for (const pid of pids) { try { await execFileP('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 6000 }); } catch {} }
    } else {
      // 持有该输出文件的进程(后台 shell 把 stdout 重定向到它,运行期间一直持有句柄)→ 最精确。
      try {
        const { stdout } = await execFileP('lsof', ['-t', '--', p], { timeout: 6000 });
        pids = stdout.split(/\s+/).map((s) => parseInt(s, 10)).filter(Boolean);
      } catch {}
      pids = [...new Set(pids)].filter((pid) => pid !== process.pid);
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
      setTimeout(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } }, 2000).unref();
    }
    res.json({ ok: true, located: pids.length > 0, killed: pids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
