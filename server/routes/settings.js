import { Router } from 'express';
import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { homedir } from 'os';
import { startOpenAIProxy, setOpenAIUpstream, getProxyPort } from '../services/openai-proxy.js';

const execFileP = promisify(execFile);
const CC_SWITCH_DB = join(homedir(), '.cc-switch', 'cc-switch.db');

const router = Router();
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
// Remembers which OpenAI-format provider is active so the proxy upstream can be
// re-established after a server restart (only the provider id — never the key).
const OPENAI_ACTIVE_PATH = join(homedir(), '.claude-gui', 'openai-active.json');

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

// Parse an OpenAI-format (app_type=codex/opencode) provider's settings_config.
// Returns { baseURL, apiKey, models[] } or null if it isn't usable.
function parseOpenAIProvider(settingsConfig) {
  let d;
  try { d = JSON.parse(settingsConfig); } catch { return null; }
  const o = d?.options || {};
  const baseURL = o.baseURL || o.base_url;
  const apiKey = o.apiKey || o.api_key;
  if (!baseURL || !apiKey) return null;
  const models = d.models && typeof d.models === 'object' ? Object.keys(d.models) : [];
  return { baseURL, apiKey, models };
}

// GET /api/providers — list the user's providers from CC Switch.
// `claude` providers are Anthropic-native; `openai` providers (codex/opencode
// app_type) are OpenAI-compatible and routed through the embedded translation
// proxy on switch. NEVER returns settings_config / API keys.
router.get('/providers', async (_req, res) => {
  const rows = await ccSwitchQuery(
    "SELECT id, name, is_current FROM providers WHERE app_type='claude' ORDER BY sort_index"
  );
  const oaRows = await ccSwitchQuery(
    "SELECT id, name, settings_config FROM providers WHERE app_type IN ('codex','opencode') ORDER BY sort_index"
  );
  const openai = [];
  for (const r of oaRows) {
    const p = parseOpenAIProvider(r.settings_config);
    if (p) openai.push({ id: r.id, name: r.name, format: 'openai', models: p.models });
  }
  res.json({
    available: rows.length > 0 || openai.length > 0,
    providers: rows.map((r) => ({ id: r.id, name: r.name, format: 'claude', isCurrent: r.is_current === 1 })),
    openaiProviders: openai,
  });
});

// POST /api/provider/switch { id } — overwrite ~/.claude/settings.json with the
// chosen provider's snapshot. Timestamped backup first so it's reversible. We
// never write the CC Switch db (so its own is_current may lag — GUI reads the
// live settings.json via GET /provider, which is authoritative).
router.post('/provider/switch', async (req, res) => {
  try {
    const { id, model } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });

    // Read ALL claude providers and match in JS — user input never touches SQL.
    const rows = await ccSwitchQuery(
      "SELECT id, name, settings_config FROM providers WHERE app_type='claude'"
    );
    const hit = rows.find((r) => r.id === id);

    // Not a claude provider? Try the OpenAI-format set (routed via proxy).
    if (!hit) {
      const oaRows = await ccSwitchQuery(
        "SELECT id, name, settings_config FROM providers WHERE app_type IN ('codex','opencode')"
      );
      const oaHit = oaRows.find((r) => r.id === id);
      if (oaHit) return switchToOpenAIProvider(oaHit, model, res);
      if (rows.length === 0) return res.status(503).json({ error: 'CC Switch 数据库不可用' });
      return res.status(404).json({ error: 'provider 不存在' });
    }

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

// Switch to an OpenAI-compatible provider. Unlike claude providers (whose
// settings_config IS a settings.json), these need the embedded proxy: we point
// the CLI's ANTHROPIC_BASE_URL at the loopback proxy and feed it the real
// upstream. We PRESERVE the current settings.json (hooks/plugins/permissions —
// notably the PreToolUse permission bridge) and only override the env keys.
async function switchToOpenAIProvider(oaHit, requestedModel, res) {
  const parsed = parseOpenAIProvider(oaHit.settings_config);
  if (!parsed) return res.status(500).json({ error: 'provider 配置缺少 baseURL/apiKey' });

  const model = (requestedModel && parsed.models.includes(requestedModel))
    ? requestedModel
    : (parsed.models[0] || requestedModel);
  if (!model) return res.status(400).json({ error: 'provider 未配置任何模型,需手动指定 model' });

  // Start the proxy (idempotent, fixed port) and point it at this upstream.
  let port = getProxyPort();
  if (!port) port = await startOpenAIProxy();
  setOpenAIUpstream({ baseURL: parsed.baseURL, apiKey: parsed.apiKey });

  // Start from the live settings.json so hooks/permissions survive the switch.
  let current = {};
  try { current = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8')); } catch {}
  const env = { ...(current.env || {}) };
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  // The CLI must send *some* token; the proxy ignores it and injects the real
  // upstream key itself, so we never expose the real key to the CLI env file
  // beyond what cc-switch already stores.
  env.ANTHROPIC_AUTH_TOKEN = 'sk-openai-proxy';
  env.ANTHROPIC_MODEL = model;
  // Route subagent aliases (haiku/sonnet/opus) to the same model so Task
  // subagents work under the OpenAI backend too.
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  delete env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;

  const next = { ...current, env };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(SETTINGS_PATH, `${SETTINGS_PATH}.${ts}.bak`).catch(() => {});
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  // Remember the active provider id (not the key) for restart recovery.
  try {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    await writeFile(OPENAI_ACTIVE_PATH, JSON.stringify({ providerId: oaHit.id, model }));
  } catch {}
  res.json({ ok: true, name: oaHit.name, model, via: 'openai-proxy' });
}

// Called once on server boot: if an OpenAI-format provider was active before a
// restart, re-establish the proxy upstream so the CLI's ANTHROPIC_BASE_URL
// (still pointing at the fixed proxy port in settings.json) keeps working.
export async function restoreOpenAIProvider() {
  let active;
  try { active = JSON.parse(await readFile(OPENAI_ACTIVE_PATH, 'utf-8')); } catch { return; }
  if (!active?.providerId) return;
  // Only restore if settings.json actually still points at the proxy — the user
  // may have switched back to a claude provider since.
  try {
    const cur = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'));
    if (!String(cur?.env?.ANTHROPIC_BASE_URL || '').includes('127.0.0.1')) return;
  } catch { return; }
  const oaRows = await ccSwitchQuery(
    "SELECT id, name, settings_config FROM providers WHERE app_type IN ('codex','opencode')"
  );
  const hit = oaRows.find((r) => r.id === active.providerId);
  if (!hit) return;
  const parsed = parseOpenAIProvider(hit.settings_config);
  if (!parsed) return;
  await startOpenAIProxy();
  setOpenAIUpstream({ baseURL: parsed.baseURL, apiKey: parsed.apiKey });
}

export default router;
