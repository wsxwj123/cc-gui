import { Router } from 'express';
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { homedir } from 'os';

const execFileP = promisify(execFile);
const CC_SWITCH_DB = join(homedir(), '.cc-switch', 'cc-switch.db');

const router = Router();
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// CLI hash convention: the Claude CLI replaces EVERY character that is not
// [A-Za-z0-9] with a single `-` (one-to-one, not collapsed). So `/`, space,
// `.`, and any Unicode char (中文 etc.) each become one dash. Verified against
// real ~/.claude/projects dir names, e.g. `/Users/wsxwj/.claude/x` →
// `-Users-wsxwj--claude-x` and a path with 4 CJK chars → `...----`.
//
// The previous version only replaced `/` and whitespace, leaving CJK intact —
// so a Chinese-named project got a dir like `-…-测试` while the CLI actually
// wrote its session jsonl to `-…---`. The GUI then watched an empty dir and
// showed "no reply". Matching the CLI exactly fixes that.
function pathToHash(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

// GET /api/settings — read current settings
router.get('/settings', async (req, res) => {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // Strip the bogus `_addProject` field that a prior buggy version of the
    // GUI may have written into settings.json. It's never meant to live here.
    delete parsed._addProject;
    res.json(parsed);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.json({});
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// PUT /api/settings — update settings.
// SPECIAL KEY: `_addProject` is NOT a real settings field; it's a request to
// register a new project root by creating its hashed dir under
// ~/.claude/projects/. Without this branch the field was being written
// verbatim into settings.json (polluting it) AND the project was never
// actually visible to listProjects, so users would add a folder and watch it
// vanish on every refresh.
router.put('/settings', async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    const addPath = typeof body._addProject === 'string' ? body._addProject : null;
    delete body._addProject;

    let addedHash = null;
    if (addPath && addPath.startsWith('/')) {
      const clean = addPath.replace(/\/+$/, '') || '/';
      addedHash = pathToHash(clean);
      const projectDir = join(PROJECTS_DIR, addedHash);
      try {
        await mkdir(projectDir, { recursive: true });
      } catch (err) {
        // If mkdir fails for any other reason, surface it — registering a
        // project that can't be created is a hard error.
        return res.status(500).json({ error: 'mkdir projects/<hash> failed: ' + err.message });
      }
      // Persist the REAL absolute path in a sidecar. The hash is lossy
      // (Unicode → dashes), so neither decode nor a colliding sibling dir can
      // recover it. session-reader reads this to (a) report the correct cwd
      // for sending the first message, and (b) filter out sessions belonging
      // to a DIFFERENT real path that the CLI collapsed into the same dir.
      try {
        await writeFile(
          join(projectDir, '.cgui-meta.json'),
          JSON.stringify({ cwd: clean, addedAt: Date.now() }, null, 2) + '\n',
        );
      } catch { /* best-effort — sidecar is an optimization, not required */ }
    }

    let current = {};
    try {
      current = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // Also scrub any pre-existing `_addProject` pollution from earlier bug.
    delete current._addProject;
    const updated = { ...current, ...body };
    await writeFile(SETTINGS_PATH, JSON.stringify(updated, null, 2) + '\n');
    res.json({ ...updated, ...(addedHash ? { _registeredHash: addedHash } : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/provider
 * Inspect settings.json (or process env) for an ANTHROPIC_BASE_URL +
 * ANTHROPIC_MODEL that would indicate a `cc switch`-style provider redirect.
 * The Claude CLI lies about the upstream model in its stream-json output
 * (it always says "claude-sonnet-X-X" because the CLI itself is Claude-shaped),
 * but `ANTHROPIC_MODEL` env tells us the REAL backend model the proxy will
 * forward to. Pricing should follow the backend, not the facade.
 *
 * Returns: { baseUrl, providerHint, model } where:
 *   providerHint ∈ 'anthropic' | 'deepseek' | 'mimo' | 'openrouter'
 *                | 'siliconflow' | 'bedrock' | 'vertex' | 'unknown'
 *   model        — the resolved upstream model (env-set, else null)
 */
router.get('/provider', async (_req, res) => {
  try {
    let env = {};
    try {
      const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'));
      if (settings && settings.env && typeof settings.env === 'object') env = settings.env;
    } catch {}
    // env vars on settings.json win over process.env (cc switch writes there).
    const baseUrl = String(
      env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL ||
      process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_API_URL || ''
    );
    const model = String(
      env.ANTHROPIC_MODEL || env.CLAUDE_MODEL ||
      process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || ''
    ) || null;

    const u = baseUrl.toLowerCase();
    let providerHint = 'anthropic';
    if (!u || u.includes('anthropic.com')) providerHint = 'anthropic';
    else if (u.includes('deepseek')) providerHint = 'deepseek';
    else if (u.includes('mimo') || u.includes('xiaomi')) providerHint = 'mimo';
    else if (u.includes('openrouter')) providerHint = 'openrouter';
    else if (u.includes('siliconflow')) providerHint = 'siliconflow';
    else if (u.includes('bedrock') || u.includes('amazonaws')) providerHint = 'bedrock';
    else if (u.includes('vertex') || u.includes('googleapis')) providerHint = 'vertex';
    else providerHint = 'unknown';

    res.json({ baseUrl, providerHint, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CC Switch provider integration ──────────────────────────────
// CC Switch stores ONE full settings.json snapshot per provider in a SQLite db
// (~/.cc-switch/cc-switch.db, table `providers`). We READ it (never write it) to
// list the user's claude providers and switch by overwriting ~/.claude/settings.json
// with the chosen snapshot — same semantics as the CC Switch desktop app, so the
// phone gets a one-tap switch. The CLI reads settings.json on its next spawn.

// Read-only query through the system `sqlite3` CLI (no new npm dependency, and
// -readonly guarantees we can't mutate the user's CC Switch db). Returns parsed
// rows, or [] if the db / CLI is unavailable.
async function ccSwitchQuery(sql) {
  try {
    const { stdout } = await execFileP('sqlite3', ['-json', '-readonly', CC_SWITCH_DB, sql], {
      timeout: 5000, maxBuffer: 16 * 1024 * 1024,
    });
    const t = stdout.trim();
    return t ? JSON.parse(t) : [];
  } catch {
    return [];
  }
}

// GET /api/providers — list the user's `claude` providers from CC Switch.
// Returns names + ids only; NEVER the settings_config (which holds API keys).
router.get('/providers', async (_req, res) => {
  const rows = await ccSwitchQuery(
    "SELECT id, name, is_current FROM providers WHERE app_type='claude' ORDER BY sort_index"
  );
  res.json({
    available: rows.length > 0,
    providers: rows.map((r) => ({ id: r.id, name: r.name, isCurrent: r.is_current === 1 })),
  });
});

// POST /api/provider/switch { id } — overwrite ~/.claude/settings.json with the
// chosen provider's snapshot. Timestamped backup first so it's reversible. We
// never write the CC Switch db (so its own is_current may lag — GUI reads the
// live settings.json via GET /provider, which is authoritative).
router.post('/provider/switch', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });

    // Read ALL claude providers and match in JS — user input never touches SQL.
    const rows = await ccSwitchQuery(
      "SELECT id, name, settings_config FROM providers WHERE app_type='claude'"
    );
    if (rows.length === 0) return res.status(503).json({ error: 'CC Switch 数据库不可用' });
    const hit = rows.find((r) => r.id === id);
    if (!hit) return res.status(404).json({ error: 'provider 不存在' });

    let snapshot;
    try { snapshot = JSON.parse(hit.settings_config); }
    catch { return res.status(500).json({ error: 'provider 配置解析失败' }); }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return res.status(500).json({ error: 'provider 配置非法' });
    }

    // Back up the current settings.json (timestamped) before overwriting.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(SETTINGS_PATH, `${SETTINGS_PATH}.${ts}.bak`).catch(() => {});

    await writeFile(SETTINGS_PATH, JSON.stringify(snapshot, null, 2));
    res.json({ ok: true, name: hit.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
