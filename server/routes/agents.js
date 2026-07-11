import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, writeFile, mkdir, stat, open, unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { getActiveChatProcesses, claudeSpawn, cleanChildEnv, safeModelArg } from './chat.js';
import { resolveUnderHome } from '../utils/safe-path.js';
import { claudeCommand } from '../utils/claude-resolver.js';

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

// 对 ~/.claude/agents/ 下的 .md agent 批量同步。files 省略=全部 agent。
export async function syncMcpToAgents({ add = [], remove = [], files = null } = {}) {
  if (!add.length && !remove.length) return;
  let names = files;
  if (!names) {
    try { names = (await readdir(AGENTS_DIR)).filter((f) => f.endsWith('.md')); } catch { return; }
  }
  for (const f of names) {
    const full = join(AGENTS_DIR, f);
    let content; try { content = await readFile(full, 'utf-8'); } catch { continue; }
    const updated = rewriteAgentMcpTools(content, { add, remove });
    if (updated && updated !== content) { try { await writeFile(full, updated); } catch {} }
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
    });
    seenPids.add(Number(p.pid));
    if (p.sessionId) seenSessionIds.add(p.sessionId);
  }

  // 2. CLI's own active session registry
  // homedir() 而非 process.env.HOME:Windows 上 HOME 为空(CO-1 同款教训)→ 原来读
  // `undefined/.claude/sessions` 恒失败被吞 → Win 上 cli-session 卡片永远不出现。
  const SESSIONS_DIR = join(homedir(), '.claude', 'sessions');
  let entries = [];
  try { entries = await readdir(SESSIONS_DIR); } catch {}
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(`${SESSIONS_DIR}/${f}`, 'utf-8');
      const s = JSON.parse(raw);
      if (!s.pid) continue;
      // 已被 chat-process 收录的会话(按 sessionId 或 pid)不重复显示。
      if ((s.sessionId && seenSessionIds.has(s.sessionId)) || seenPids.has(Number(s.pid))) continue;
      // Check the process is still alive — claude often leaves stale files.
      let alive = false;
      try { process.kill(Number(s.pid), 0); alive = true; } catch {}
      if (!alive) continue;
      out.push({
        kind: 'cli-session',
        // 注册表自己的 kind(interactive/background 等)独立返回,前端据此分区
        // (后台代理面板 filter cliKind==='background');原来塞在 promptPreview 里没法区分。
        cliKind: s.kind || null,
        pid: String(s.pid),
        sessionId: s.sessionId || f.replace('.json', ''),
        cwd: s.cwd || null,
        model: null,
        promptPreview: s.kind || s.entrypoint || '',
        permissionMode: 'default',
        startedAt: s.startedAt || s.procStart || null,
        elapsedMs: (s.startedAt || s.procStart) ? Date.now() - (s.startedAt || s.procStart) : null,
        status: 'running',
        // We can still stop these via /api/processes/:pid/kill which whitelists
        // any pid listed in the sessions registry (which is exactly where this
        // entry came from). The UI should show a working stop button.
        stoppable: true,
      });
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
    };
  } catch { return null; }
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
    const agents = await Promise.all((Array.isArray(list) ? list : []).map(async (a) => {
      const base = {
        pid: a.pid, cwd: a.cwd || null, kind: a.kind || '', name: a.name || '',
        sessionId: a.sessionId || null, startedAt: a.startedAt || null,
        elapsedMs: a.startedAt ? Date.now() - a.startedAt : null,
        id: a.id || null,
        state: a.state || null,
        projectHash: a.cwd ? cwdToProjectHash(a.cwd) : null,
        endedAt: null, detail: '', resultPreview: '',
      };
      // 终态的后台会话补结束时间与结果摘要(jobs/<id>/state.json,best-effort)
      if (a.kind === 'background' && BG_TERMINAL_STATES.has(a.state)) {
        const jobId = a.id || (a.sessionId ? String(a.sessionId).slice(0, 8) : null);
        const extra = await readBgJobState(jobId);
        if (extra) Object.assign(base, extra);
      }
      return base;
    }));
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/background/dispatch { cwd, prompt, model? }
// `claude --bg -p <prompt>`:派后台代理立即返回。默认 --permission-mode acceptEdits ——
// 后台无人值守,default 会卡在授权等待(canUseTool 通道不在场);绝不静默 bypass。
router.post('/agents/background/dispatch', async (req, res) => {
  const { cwd, prompt, model } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'prompt 必填' });
  // Windows cmd 注入守卫:--bg 要求 prompt 走位置参数(无法改 stdin),Windows 上经 cmd.exe /c;
  // libuv 只给含空格的参数加引号,故【无空格且含 cmd 元字符】的 prompt(如 "x&calc")会被 cmd
  // 重解析执行 = 绕权限 RCE。真实任务描述都有空格(会被引用→安全),单 token 带元字符=攻击形态,拒。
  if (process.platform === 'win32' && !/\s/.test(prompt.trim()) && /[&|<>^]/.test(prompt)) {
    return res.status(400).json({ error: 'prompt 含不安全字符(单个词里的 & | < > ^);请用正常任务描述' });
  }
  let dir;
  try { dir = resolveUnderHome(String(cwd || ''), { label: 'cwd' }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  // 实测:--bg 与 -p 冲突(-p 不起 interactive 会话,agents 无法 attach)——prompt 必须
  // 走位置参数:`claude --bg '<task>'`。
  const args = ['--bg', prompt.trim(), '--permission-mode', 'acceptEdits'];
  // model 过白名单:Windows cmd.exe /c 下无空格+含 & 的 model 会被当命令分隔执行(RCE 绕权限)。
  // 注:--bg 要求 prompt 走位置参数无法改 stdin,现实 prompt 多含空格会被 libuv 引用;model 是干净活口。
  const safeModel = safeModelArg(model);
  if (safeModel) args.push('--model', safeModel);
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
    res.json({ ok: true, output: out.trim().slice(0, 2000), ...(done.timedOut ? { note: '派发进程未在 20s 内退出,代理可能仍已启动' } : {}) });
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
      await writeFile(dest, a.content, 'utf-8');
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
        return res.json({ name: req.params.name, path, content });
      } catch {}
    }
    res.status(404).json({ error: 'agent not found' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PUT /api/agents/:name  { content } */
router.put('/agents/:name', async (req, res) => {
  try {
    assertName(req.params.name);
    const { content } = req.body || {};
    if (typeof content !== 'string') throw new Error('content must be a string');
    await mkdir(AGENTS_DIR, { recursive: true });
    const path = join(AGENTS_DIR, req.params.name + '.md');
    // 区分新建 vs 编辑:新建时把当前所有 MCP 同步进这个新 agent(让它一创建就能用全部 MCP);
    // 编辑时不动(尊重用户手动增删的 MCP,避免把他刚删的又加回来)。
    let isNew = false;
    try { await stat(path); } catch { isNew = true; }
    await writeFile(path, content);
    if (isNew) {
      try { await syncMcpToAgents({ add: await currentUserMcpNames(), files: [req.params.name + '.md'] }); } catch {}
    }
    res.json({ ok: true, path });
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
