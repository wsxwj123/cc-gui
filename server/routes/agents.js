import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, writeFile, mkdir, stat, open } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { getActiveChatProcesses } from './chat.js';

const execFileP = promisify(execFile);
const router = Router();
const AGENTS_DIR = join(homedir(), '.claude', 'agents');
// Bundled agent presets shipped with the GUI (ported from oh-my-opencode-slim).
const BUILTIN_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'builtin-agents');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function assertName(name) {
  if (!NAME_RE.test(String(name || ''))) throw new Error('invalid agent name (lowercase letters/digits/dash)');
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
      const out = await execFileP('claude', ['agents', 'list'], { timeout: 6000 });
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

  // 1. Live chat children — always available, richest metadata.
  // Finished turns linger for a 60s grace window (chat.js) so they show as
  // 已完成/错误 (= 会话等待用户回复) instead of vanishing the instant they end.
  for (const p of getActiveChatProcesses()) {
    const finished = p.exitCode !== null;
    const status = finished
      ? (p.exitCode === 0 ? 'done' : 'error')
      : (p.attached ? 'streaming' : 'starting');
    out.push({
      kind: 'chat-process',
      pid: p.pid,
      sessionId: p.sessionId,
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
  }

  // 2. CLI's own active session registry
  const SESSIONS_DIR = `${process.env.HOME}/.claude/sessions`;
  let entries = [];
  try { entries = await readdir(SESSIONS_DIR); } catch {}
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(`${SESSIONS_DIR}/${f}`, 'utf-8');
      const s = JSON.parse(raw);
      if (!s.pid || seenPids.has(Number(s.pid))) continue;
      // Check the process is still alive — claude often leaves stale files.
      let alive = false;
      try { process.kill(Number(s.pid), 0); alive = true; } catch {}
      if (!alive) continue;
      out.push({
        kind: 'cli-session',
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
    await writeFile(path, content);
    res.json({ ok: true, path });
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
