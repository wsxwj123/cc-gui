import { Router } from 'express';
import { readFile, writeFile, mkdir, copyFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { startOpenAIProxy, setOpenAIUpstream, getProxyPort } from '../services/openai-proxy.js';
import { startAnthropicProxy, setAnthropicUpstream, getAnthropicProxyPort } from '../services/anthropic-proxy.js';

const execFileP = promisify(execFile);
const CC_SWITCH_DB = join(homedir(), '.cc-switch', 'cc-switch.db');

const router = Router();
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
// Shared prefs (hidden-projects list lives here). Adding a project must un-hide
// its hash SERVER-SIDE: the lossy CLI hash can collide with a previously-hidden
// sibling, and relying on the client to un-hide fails if the client runs a stale
// bundle or the persist races a reload — the folder then re-hides on next fetch
// and "vanishes" again. Doing it here makes an explicit add always win.
const PREFS_PATH = join(homedir(), '.claude-gui', 'prefs.json');
// Remembers which OpenAI-format provider is active so the proxy upstream can be
// re-established after a server restart (only the provider id — never the key).
const OPENAI_ACTIVE_PATH = join(homedir(), '.claude-gui', 'openai-active.json');
// Marks an active Anthropic-format third-party provider routed through the local
// anthropic passthrough proxy (so the subscription OAuth token can't poison it).
// Stores only id/name/baseURL/model — never the token (re-read on restart).
const ANTHROPIC_ACTIVE_PATH = join(homedir(), '.claude-gui', 'anthropic-active.json');

// Official Anthropic = use the CLI's own OAuth/subscription directly (no proxy).
// Anything else with the Anthropic wire format (deepseek/mimo/relays) must go
// through the proxy so the CLI's poisoned OAuth token is stripped + replaced.
function isOfficialAnthropic(baseURL) {
  if (!baseURL) return true; // empty → CLI default endpoint (api.anthropic.com)
  try { return new URL(baseURL).hostname.endsWith('anthropic.com'); } catch { return false; }
}

// A claude-family model id (or CLI tier alias). Used to drop FOREIGN model ids
// (e.g. deepseek) that cc-switch's "common config" leaks into the official
// provider's env, so switching to official never requests a non-claude model.
function isClaudeModel(id) {
  if (!id || typeof id !== 'string') return false;
  return /claude/i.test(id) || ['sonnet', 'opus', 'haiku'].includes(id);
}

const PROVIDER_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'CLAUDE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
]);

function mergeProviderEnv(currentEnv = {}, providerEnv = {}) {
  const env = { ...currentEnv };
  for (const key of PROVIDER_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(providerEnv || {})) {
    if (PROVIDER_ENV_KEYS.has(key) && value != null && value !== '') env[key] = value;
  }
  return env;
}

async function readCurrentSettings() {
  try { return JSON.parse(await readFile(SETTINGS_PATH, 'utf-8')); }
  catch { return {}; }
}
// Remembers the LAST provider switched via the GUI (claude or openai). CC Switch's
// own is_current flag never reflects a GUI switch (we only write settings.json,
// not its db), so GET /providers reads this marker to mark the right row current —
// otherwise the picker reverts to the stale db value every time it remounts.
const ACTIVE_PROVIDER_PATH = join(homedir(), '.claude-gui', 'active-provider.json');

async function readActiveProviderId() {
  try {
    const d = JSON.parse(await readFile(ACTIVE_PROVIDER_PATH, 'utf-8'));
    return typeof d?.id === 'string' ? d.id : null;
  } catch { return null; }
}

async function writeActiveProviderId(id) {
  try {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    await writeFile(ACTIVE_PROVIDER_PATH, JSON.stringify({ id }));
  } catch {}
}

// GUI-managed custom providers (Option A: isolated from cc-switch.db). Each:
// { id, name, type:'openai'|'anthropic', baseURL, apiKey, models[] }. apiKey is
// stored plaintext here (same trust level as cc-switch's own db) and NEVER
// returned by any GET — only used server-side at switch time.
const CUSTOM_PROVIDERS_PATH = join(homedir(), '.claude-gui', 'custom-providers.json');

async function readCustomProviders() {
  try {
    const d = JSON.parse(await readFile(CUSTOM_PROVIDERS_PATH, 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function writeCustomProviders(list) {
  await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
  await writeFile(CUSTOM_PROVIDERS_PATH, JSON.stringify(list, null, 2));
}

// K4: 一次性导入 cc-switch 后,GUI 不再读 cc-switch.db。该 flag 文件存在 = 已导入,
// GET /providers 仅返回 customProviders;再次"重新导入"会按 ccSwitchSource id 去重补差。
const CCSWITCH_IMPORTED_FLAG = join(homedir(), '.claude-gui', 'ccswitch-imported.flag');
async function isCCSwitchImported() {
  try { await readFile(CCSWITCH_IMPORTED_FLAG, 'utf-8'); return true; } catch { return false; }
}
async function markCCSwitchImported() {
  await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
  await writeFile(CCSWITCH_IMPORTED_FLAG, new Date().toISOString());
}

// Per-provider chosen model lists (the user's multi-select out of an OpenAI
// provider's auto-fetched catalogue). Shape: { [providerId]: [modelId, ...] }.
const PROVIDER_MODELS_PATH = join(homedir(), '.claude-gui', 'provider-models.json');

async function readProviderModels() {
  try {
    const d = JSON.parse(await readFile(PROVIDER_MODELS_PATH, 'utf-8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

async function writeProviderModels(map) {
  await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
  await writeFile(PROVIDER_MODELS_PATH, JSON.stringify(map, null, 2));
}

// Resolve an OpenAI-format provider's REAL upstream {baseURL, apiKey} by id —
// from cc-switch (codex/opencode) or the GUI custom store. Used to fetch its
// /v1/models directly (NOT through the loopback proxy).
async function resolveOpenAIUpstreamById(id) {
  const oaRows = await ccSwitchQuery(
    "SELECT id, settings_config FROM providers WHERE app_type IN ('codex','opencode')"
  );
  const hit = oaRows.find((r) => r.id === id);
  if (hit) {
    const p = parseOpenAIProvider(hit.settings_config);
    if (p) return { baseURL: p.baseURL, apiKey: p.apiKey };
  }
  const custom = (await readCustomProviders()).find((p) => p.id === id && p.type === 'openai');
  if (custom) return { baseURL: custom.baseURL, apiKey: custom.apiKey };
  return null;
}

// CLI hash convention: the Claude CLI replaces EVERY character that is not
// [A-Za-z0-9] with a single `-` (one-to-one, not collapsed). So `/`, space,
// `.`, and any Unicode char (中文 etc.) each become one dash. Verified against
// real ~/.claude/projects dir names, e.g. `/Users/alice/.claude/x` →
// `-Users-alice--claude-x` and a path with 4 CJK chars → `...----`.
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
    const addPath = typeof body._addProject === 'string' ? body._addProject.trim() : null;
    const createDir = body._createDir === true;
    delete body._addProject;
    delete body._createDir;

    let addedHash = null;
    let addedPath = null;
    if (addPath) {
      const absPath = addPath === '~'
        ? homedir()
        : /^~[/\\]/.test(addPath)
          ? join(homedir(), addPath.slice(2))
          : addPath;
      // isAbsolute is platform-aware: accepts /unix and C:\windows paths alike.
      if (!isAbsolute(absPath)) {
        return res.status(400).json({ error: '项目路径必须是绝对路径或 ~/ 开头' });
      }
      const clean = absPath.replace(/[/\\]+$/, '') || absPath;
      // If the target folder doesn't exist, don't silently register a phantom.
      // First call: tell the client (needsCreate) so it can ask the user. Second
      // call (createDir=true): actually create the real folder, then register.
      if (!existsSync(clean)) {
        if (!createDir) {
          return res.json({ needsCreate: true, addedPath: clean });
        }
        try {
          await mkdir(clean, { recursive: true });
        } catch (err) {
          return res.status(500).json({ error: '新建文件夹失败: ' + err.message });
        }
      }
      addedPath = clean;
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
      // Un-hide server-side: an explicitly added folder MUST be visible, even if
      // its (lossy) hash was hidden before or collides with a hidden sibling.
      try {
        const prefs = JSON.parse(await readFile(PREFS_PATH, 'utf-8'));
        if (Array.isArray(prefs.hiddenProjects) && prefs.hiddenProjects.includes(addedHash)) {
          prefs.hiddenProjects = prefs.hiddenProjects.filter((h) => h !== addedHash);
          await writeFile(PREFS_PATH, JSON.stringify(prefs, null, 2));
        }
      } catch { /* no prefs file or unparseable — nothing to un-hide */ }
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
    res.json({ ...updated, ...(addedHash ? { addedHash, addedPath } : {}) });
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

    // protocol: 'openai' only when we're routing through the embedded
    // Anthropic→OpenAI proxy (codex-local etc). Every claude-format provider —
    // official subscription AND relays like mimo/deepseek/openrouter — is
    // 'anthropic' protocol: the CLI talks the Anthropic wire format and
    // `--effort` is transmitted. The OpenAI proxy can't map --effort, so it's
    // the only case where reasoning effort is meaningless.
    let protocol = 'anthropic';
    try { await readFile(OPENAI_ACTIVE_PATH, 'utf-8'); protocol = 'openai'; } catch {}

    res.json({ baseUrl, providerHint, model, protocol });
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
  // K4: 一次性导入后停止读 cc-switch.db,GUI 自己管 customProviders 即可。
  const imported = await isCCSwitchImported();
  const rows = imported ? [] : await ccSwitchQuery(
    "SELECT id, name, is_current FROM providers WHERE app_type='claude' ORDER BY sort_index"
  );
  const oaRows = imported ? [] : await ccSwitchQuery(
    "SELECT id, name, app_type, settings_config FROM providers WHERE app_type IN ('codex','opencode') ORDER BY sort_index"
  );
  // A GUI switch is authoritative over the db's stale is_current; fall back to
  // the db flag only when the GUI hasn't switched anything yet.
  const activeId = await readActiveProviderId();
  const isCur = (id, dbCurrent) => (activeId != null ? id === activeId : dbCurrent);
  // User's multi-select overrides the cc-switch static models list (when set).
  const sel = await readProviderModels();
  const openai = [];
  for (const r of oaRows) {
    const p = parseOpenAIProvider(r.settings_config);
    if (p) openai.push({ id: r.id, name: r.name, appType: r.app_type, format: 'openai', models: sel[r.id]?.length ? sel[r.id] : p.models, isCurrent: isCur(r.id, false) });
  }
  // GUI custom providers (never expose apiKey — only whether one is stored).
  const customProviders = (await readCustomProviders()).map((p) => ({
    id: p.id, name: p.name, type: p.type, baseURL: p.baseURL,
    models: p.models || [], hasKey: !!p.apiKey, isCustom: true, isCurrent: isCur(p.id, false),
  }));
  res.json({
    available: rows.length > 0 || openai.length > 0 || customProviders.length > 0,
    providers: rows.map((r) => ({ id: r.id, name: r.name, appType: 'claude', format: 'claude', isCurrent: isCur(r.id, r.is_current === 1) })),
    openaiProviders: openai,
    customProviders,
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
      "SELECT id, name, category, settings_config FROM providers WHERE app_type='claude'"
    );
    const hit = rows.find((r) => r.id === id);

    // Not a claude provider? Try the OpenAI-format set (routed via proxy).
    if (!hit) {
      const oaRows = await ccSwitchQuery(
        "SELECT id, name, settings_config FROM providers WHERE app_type IN ('codex','opencode')"
      );
      const oaHit = oaRows.find((r) => r.id === id);
      if (oaHit) {
        const parsed = parseOpenAIProvider(oaHit.settings_config);
        if (!parsed) return res.status(500).json({ error: 'provider 配置缺少 baseURL/apiKey' });
        // Use the user's multi-select model list (which may add ids cc-switch's
        // static settings_config lacks, e.g. gpt-5.5) over the raw db list — same
        // precedence GET /providers uses — so ModelSelector offers all of them.
        const sel = await readProviderModels();
        const models = sel[oaHit.id]?.length ? sel[oaHit.id] : parsed.models;
        return switchToOpenAIUpstream({ id: oaHit.id, name: oaHit.name, baseURL: parsed.baseURL, apiKey: parsed.apiKey, models }, model, res);
      }
      // GUI custom providers (stored outside cc-switch).
      const custom = (await readCustomProviders()).find((p) => p.id === id);
      if (custom) return switchToCustomProvider(custom, model, res);
      if (rows.length === 0) return res.status(503).json({ error: 'CC Switch 数据库不可用' });
      return res.status(404).json({ error: 'provider 不存在' });
    }

    let snapshot;
    try { snapshot = JSON.parse(hit.settings_config); }
    catch { return res.status(500).json({ error: 'provider 配置解析失败' }); }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return res.status(500).json({ error: 'provider 配置非法' });
    }

    // cc-switch marks the official Anthropic subscription with category='official'.
    // Its stored settings_config can carry a STALE third-party env — cc-switch's
    // "common config" leaks deepseek's baseURL+token+models into every provider,
    // but cc-switch IGNORES them for official providers (uses the OAuth login). If
    // we applied that env literally the user's "Claude Official" would wrongly route
    // to deepseek. So for official: strip routing/auth env (use OAuth) and any
    // NON-claude model overrides, then write directly (no proxy).
    if (hit.category === 'official') {
      const current = await readCurrentSettings();
      const env = { ...(current.env || {}) };
      for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) delete env[k];
      for (const k of Object.keys(env)) {
        if (/_MODEL$/.test(k) && !isClaudeModel(env[k])) { delete env[k]; delete env[k + '_NAME']; }
      }
      if (model && isClaudeModel(model)) env.ANTHROPIC_MODEL = model;
      const next = { ...current, env };
      // Preserve the user's CURRENT default model — do NOT let cc-switch's official
      // snapshot (which carries model:haiku) overwrite it on every switch. Priority:
      // explicit claude request > live settings.json model (if a claude id/alias) >
      // snapshot's. This is why a user-set "sonnet" used to silently revert to haiku.
      const curModel = current.model;
      if (model && isClaudeModel(model)) next.model = model;
      else if (isClaudeModel(curModel)) next.model = curModel;
      // 🐛 修复:cc CLI 的 settings.json `model` 字段实际是 subagent default(haiku
      // 给 Task 用),不影响主 chat;主 chat 用 env.ANTHROPIC_MODEL,未设则 fallback
      // sonnet。之前 GUI 显示 model=haiku 但实际跑 sonnet 的根因。同步两个字段,
      // 让 GUI 显示和 CLI 实际跑的一致。
      if (next.model && isClaudeModel(next.model) && !env.ANTHROPIC_MODEL) {
        env.ANTHROPIC_MODEL = next.model;
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await copyFile(SETTINGS_PATH, `${SETTINGS_PATH}.${ts}.bak`).catch(() => {});
      await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
      await writeActiveProviderId(hit.id);
      await unlink(OPENAI_ACTIVE_PATH).catch(() => {});
      await unlink(ANTHROPIC_ACTIVE_PATH).catch(() => {});
      return res.json({ ok: true, name: hit.name, via: 'official' });
    }

    // Third-party Anthropic-format provider (deepseek/mimo/relay): route through
    // the local passthrough proxy so a logged-in subscription's OAuth token can't
    // override the provider's own key (the "every provider 401s with ...6gAA" bug).
    // Official Anthropic stays direct so the subscription itself keeps working.
    const snapBase = snapshot.env?.ANTHROPIC_BASE_URL || snapshot.env?.ANTHROPIC_API_URL || '';
    const snapTok = snapshot.env?.ANTHROPIC_AUTH_TOKEN || snapshot.env?.ANTHROPIC_API_KEY || '';
    if (!isOfficialAnthropic(snapBase) && snapTok) {
      const snapModels = [...new Set(Object.entries(snapshot.env || {})
        .filter(([k, v]) => /_MODEL$/.test(k) && typeof v === 'string' && v)
        .map(([, v]) => v))];
      return switchToAnthropicUpstream(
        { id: hit.id, name: hit.name, baseURL: snapBase, authToken: snapTok, snapshot, models: snapModels },
        model, res,
      );
    }

    // Back up the current settings.json (timestamped) before overwriting.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(SETTINGS_PATH, `${SETTINGS_PATH}.${ts}.bak`).catch(() => {});

    const current = await readCurrentSettings();
    const env = mergeProviderEnv(current.env, snapshot.env || {});
    const next = { ...current, env };
    if (snapshot.model) next.model = snapshot.model;
    await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
    await writeActiveProviderId(hit.id);
    await unlink(ANTHROPIC_ACTIVE_PATH).catch(() => {});
    // Switching to a NATIVE claude provider means we're off the OpenAI proxy.
    // Drop the openai-active marker, else restoreOpenAIProvider() on the next
    // server boot would clobber this settings.json back to the proxy — the model
    // would silently revert to the old gpt-* after any restart.
    await unlink(OPENAI_ACTIVE_PATH).catch(() => {});
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
// Normalized OpenAI-upstream switch — used by both cc-switch openai providers
// and GUI custom providers (type=openai). `up` = { id, name, baseURL, apiKey, models }.
async function switchToOpenAIUpstream(up, requestedModel, res) {
  const models = up.models || [];
  const model = (requestedModel && models.includes(requestedModel))
    ? requestedModel
    : (models[0] || requestedModel);
  if (!model) return res.status(400).json({ error: 'provider 未配置任何模型,需手动指定 model' });

  // Start the proxy (idempotent, fixed port) and point it at this upstream.
  let port = getProxyPort();
  if (!port) port = await startOpenAIProxy();
  setOpenAIUpstream({ baseURL: up.baseURL, apiKey: up.apiKey });

  // Start from the live settings.json so hooks/permissions survive the switch.
  const current = await readCurrentSettings();
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
  // Remember the active provider id (not the key) for restart recovery. Also
  // persist the provider's FULL model list + name so model-resolver can offer
  // every model in the ModelSelector (not just the one we switched to) — the CLI
  // sends whichever model the user picks and the proxy forwards it upstream.
  try {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    await writeFile(OPENAI_ACTIVE_PATH, JSON.stringify({ providerId: up.id, name: up.name, model, models }));
  } catch {}
  await unlink(ANTHROPIC_ACTIVE_PATH).catch(() => {}); // off the anthropic proxy
  await writeActiveProviderId(up.id);
  res.json({ ok: true, name: up.name, model, via: 'openai-proxy' });
}

// Switch to an Anthropic-format third-party provider VIA the passthrough proxy.
// Mirrors switchToOpenAIUpstream but no format translation: the proxy just swaps
// the (poisoned) OAuth auth header for the provider's real token and forwards.
// `up` = { id, name, baseURL, authToken, snapshot?, models? }.
async function switchToAnthropicUpstream(up, requestedModel, res) {
  let port = getAnthropicProxyPort();
  if (!port) port = await startAnthropicProxy();
  if (!port) return res.status(500).json({ error: 'anthropic 代理启动失败(端口占用)' });
  setAnthropicUpstream({ baseURL: up.baseURL, authToken: up.authToken });

  // Preserve the current settings base (hooks/MCP/plugins/permissions) and only
  // import provider env/model aliases from the provider snapshot, then redirect
  // BASE_URL to the loopback proxy.
  // AUTH_TOKEN is left as-is — the CLI's value is ignored (OAuth overrides it and
  // the proxy strips both), the proxy injects the real token from its upstream.
  const snapshot = (up.snapshot && typeof up.snapshot === 'object') ? up.snapshot : {};
  const current = await readCurrentSettings();
  const env = mergeProviderEnv(current.env, snapshot.env || {});
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  // Pick the active model: explicit request (if valid) > the snapshot's existing
  // ANTHROPIC_MODEL (if it belongs to THIS provider) > the provider's first model.
  // Without this, clicking a custom provider row (no model arg) would inherit the
  // PREVIOUS provider's stale ANTHROPIC_MODEL.
  const models = up.models || [];
  const chosen = (requestedModel && (!models.length || models.includes(requestedModel)))
    ? requestedModel
    : (models.includes(env.ANTHROPIC_MODEL) ? env.ANTHROPIC_MODEL : (models[0] || env.ANTHROPIC_MODEL));
  if (chosen) env.ANTHROPIC_MODEL = chosen; else delete env.ANTHROPIC_MODEL;
  const next = { ...current, env };
  if (snapshot.model) next.model = snapshot.model;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(SETTINGS_PATH, `${SETTINGS_PATH}.${ts}.bak`).catch(() => {});
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  // Persist the active marker (id/name/baseURL/model/models — NEVER the token).
  try {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    await writeFile(ANTHROPIC_ACTIVE_PATH, JSON.stringify({
      providerId: up.id, name: up.name, baseURL: up.baseURL,
      model: env.ANTHROPIC_MODEL || null, models: up.models || [],
    }));
  } catch {}
  await unlink(OPENAI_ACTIVE_PATH).catch(() => {}); // off the openai proxy
  await writeActiveProviderId(up.id);
  res.json({ ok: true, name: up.name, model: env.ANTHROPIC_MODEL || null, via: 'anthropic-proxy' });
}

// Switch to a GUI custom provider. openai → proxy (reuse upstream switch);
// anthropic → point the CLI straight at the upstream, no proxy.
async function switchToCustomProvider(p, requestedModel, res) {
  if (p.type === 'openai') {
    return switchToOpenAIUpstream(
      { id: p.id, name: p.name, baseURL: p.baseURL, apiKey: p.apiKey, models: p.models || [] },
      requestedModel, res,
    );
  }
  // anthropic-compatible upstream (third-party Claude relay): route through the
  // passthrough proxy so a logged-in subscription's OAuth token can't poison it.
  const models = p.models || [];
  if (!isOfficialAnthropic(p.baseURL)) {
    const cur = await readCurrentSettings();
    const snapEnv = { ...(cur.env || {}) };
    delete snapEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete snapEnv.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete snapEnv.ANTHROPIC_DEFAULT_OPUS_MODEL;
    return switchToAnthropicUpstream(
      { id: p.id, name: p.name, baseURL: p.baseURL, authToken: p.apiKey, snapshot: { ...cur, env: snapEnv }, models },
      requestedModel, res,
    );
  }
  // official-anthropic custom upstream (rare) — direct, uses the CLI OAuth.
  const model = (requestedModel && models.includes(requestedModel))
    ? requestedModel : (models[0] || requestedModel || '');
  const current = await readCurrentSettings();
  const env = { ...(current.env || {}) };
  env.ANTHROPIC_BASE_URL = p.baseURL;
  env.ANTHROPIC_AUTH_TOKEN = p.apiKey;
  if (model) env.ANTHROPIC_MODEL = model; else delete env.ANTHROPIC_MODEL;
  // Drop proxy-era subagent overrides so aliases resolve against THIS upstream.
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  const next = { ...current, env };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(SETTINGS_PATH, `${SETTINGS_PATH}.${ts}.bak`).catch(() => {});
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  await unlink(OPENAI_ACTIVE_PATH).catch(() => {}); // off the proxy
  await writeActiveProviderId(p.id);
  res.json({ ok: true, name: p.name, model: model || null });
}

// GET /api/providers/import-status — { imported, ccSwitchAvailable, ccSwitchCount }
router.get('/providers/import-status', async (_req, res) => {
  const imported = await isCCSwitchImported();
  const rows = await ccSwitchQuery("SELECT id FROM providers WHERE app_type IN ('claude','codex','opencode')");
  res.json({ imported, ccSwitchAvailable: rows.length > 0, ccSwitchCount: rows.length });
});

// POST /api/providers/import-from-ccswitch — 一次性把 cc-switch.db 全部 provider 导入到
// custom-providers.json(含 key,server 侧从不返回 key 给前端)。之后 GET /providers 不再
// 读 cc-switch.db。重复触发时按 ccSwitchSource 去重,仅补差,不覆盖已编辑的条目。
router.post('/providers/import-from-ccswitch', async (_req, res) => {
  try {
    const claudeRows = await ccSwitchQuery(
      "SELECT id, name, category, settings_config FROM providers WHERE app_type='claude'"
    );
    const oaRows = await ccSwitchQuery(
      "SELECT id, name, settings_config FROM providers WHERE app_type IN ('codex','opencode')"
    );
    const list = await readCustomProviders();
    const seen = new Set(list.map((p) => p.ccSwitchSource).filter(Boolean));
    let added = 0;
    // claude-format providers(第三方 anthropic 兼容):env.ANTHROPIC_BASE_URL/TOKEN + _MODEL 列表
    for (const r of claudeRows) {
      if (seen.has(r.id)) continue;
      if (r.category === 'official') continue; // OAuth 订阅不需要 key,不导入
      let snap; try { snap = JSON.parse(r.settings_config); } catch { continue; }
      const env = snap?.env || {};
      const baseURL = env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL;
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
      if (!baseURL || !apiKey) continue;
      const models = [...new Set(Object.entries(env)
        .filter(([k, v]) => /_MODEL$/.test(k) && typeof v === 'string' && v)
        .map(([, v]) => v))];
      list.push({
        id: randomUUID(),
        name: r.name,
        type: 'anthropic',
        baseURL: String(baseURL).replace(/\/+$/, ''),
        apiKey: String(apiKey),
        models,
        ccSwitchSource: r.id,
      });
      added++;
    }
    // openai-format(codex/opencode)providers
    for (const r of oaRows) {
      if (seen.has(r.id)) continue;
      const p = parseOpenAIProvider(r.settings_config);
      if (!p) continue;
      list.push({
        id: randomUUID(),
        name: r.name,
        type: 'openai',
        baseURL: String(p.baseURL).replace(/\/+$/, ''),
        apiKey: String(p.apiKey),
        models: p.models || [],
        ccSwitchSource: r.id,
      });
      added++;
    }
    await writeCustomProviders(list);
    await markCCSwitchImported();
    res.json({ ok: true, added, total: list.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/custom-providers — list custom providers (never returns apiKey).
router.get('/custom-providers', async (_req, res) => {
  const list = await readCustomProviders();
  res.json({
    providers: list.map((p) => ({
      id: p.id, name: p.name, type: p.type, baseURL: p.baseURL,
      models: p.models || [], hasKey: !!p.apiKey,
    })),
  });
});

// POST /api/custom-providers { name, type, baseURL, apiKey, models } — add one.
router.post('/custom-providers', async (req, res) => {
  try {
    const { name, type, baseURL, apiKey, models } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name 必填' });
    if (type !== 'openai' && type !== 'anthropic') return res.status(400).json({ error: 'type 必须是 openai 或 anthropic' });
    let url; try { url = new URL(baseURL); } catch { return res.status(400).json({ error: 'baseURL 非法' }); }
    if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: 'baseURL 必须是 http(s)' });
    const entry = {
      id: randomUUID(),
      name: name.trim(),
      type,
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
      models: Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()) : [],
    };
    const list = await readCustomProviders();
    list.push(entry);
    await writeCustomProviders(list);
    res.json({ ok: true, id: entry.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/custom-providers/:id { name, type, baseURL, apiKey?, models } — edit one.
// The id is preserved (keeps active-provider / provider-models links intact). The
// apiKey is optional: omit it (or send blank) to KEEP the stored key — the client
// never receives the key, so a blank field must not wipe it.
router.put('/custom-providers/:id', async (req, res) => {
  try {
    const list = await readCustomProviders();
    const idx = list.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const { name, type, baseURL, apiKey, models } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name 必填' });
    if (type !== 'openai' && type !== 'anthropic') return res.status(400).json({ error: 'type 必须是 openai 或 anthropic' });
    let url; try { url = new URL(baseURL); } catch { return res.status(400).json({ error: 'baseURL 非法' }); }
    if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: 'baseURL 必须是 http(s)' });
    const prev = list[idx];
    list[idx] = {
      ...prev,
      id: prev.id, // never change the id
      name: name.trim(),
      type,
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      apiKey: (typeof apiKey === 'string' && apiKey.trim()) ? apiKey.trim() : prev.apiKey,
      models: Array.isArray(models)
        ? models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim())
        : (prev.models || []),
    };
    await writeCustomProviders(list);
    // If the TYPE changed and this provider was active on the OLD type's marker,
    // that marker is now stale (wrong proxy/format) — clear it so GET /provider,
    // restore-on-boot, and getAvailableModels don't read an openai snapshot for a
    // now-anthropic provider (or vice versa). The user must re-switch to apply the
    // new routing anyway.
    if (prev.type !== type) {
      const oldPath = prev.type === 'openai' ? OPENAI_ACTIVE_PATH : ANTHROPIC_ACTIVE_PATH;
      try {
        const oldActive = JSON.parse(await readFile(oldPath, 'utf-8'));
        if (oldActive?.providerId === prev.id) await unlink(oldPath).catch(() => {});
      } catch { /* no old marker — nothing to clear */ }
    }
    // If this provider is the active one, refresh its model snapshot so the
    // ModelSelector reflects the edit immediately (no re-switch needed).
    await syncActiveProviderSnapshot(
      type === 'openai' ? OPENAI_ACTIVE_PATH : ANTHROPIC_ACTIVE_PATH,
      prev.id, list[idx].models,
    );
    res.json({ ok: true, id: prev.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/custom-providers/:id — remove one.
router.delete('/custom-providers/:id', async (req, res) => {
  try {
    const list = await readCustomProviders();
    const next = list.filter((p) => p.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: 'not found' });
    await writeCustomProviders(next);
    if ((await readActiveProviderId()) === req.params.id) await unlink(ACTIVE_PROVIDER_PATH).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Live-fetch a provider's model catalogue via GET {baseURL}/v1/models. Tries the
// Anthropic header style first (x-api-key) then OpenAI (Bearer) — some relays
// accept only one. Returns deduped model ids. Single-user local tool, so an
// arbitrary baseURL is the user's own choice (no SSRF guard).
async function probeUpstreamModels(baseURL, apiKey) {
  // Some bases already end in /v1 (OpenAI-style: http://host:8317/v1) — don't
  // double it into /v1/v1/models.
  const b = baseURL.trim().replace(/\/+$/, '');
  const url = /\/v\d+$/.test(b) ? `${b}/models` : `${b}/v1/models`;
  // Always send a real User-Agent + Accept: Node fetch's default UA is "node",
  // which some relays behind a WAF (e.g. Cloudflare) answer with a 403 challenge.
  const common = { 'User-Agent': 'claude-gui', Accept: 'application/json' };
  const headerSets = [
    { ...common, 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' },
    { ...common, Authorization: `Bearer ${apiKey || ''}` },
  ];
  let lastStatus = 0, lastBody = '';
  for (const headers of headerSets) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let r;
    try { r = await fetch(url, { headers, signal: ctrl.signal }); }
    catch (e) { clearTimeout(timer); if (e.name === 'AbortError') throw new Error('拉取超时(10s)'); continue; }
    clearTimeout(timer);
    if (r.ok) {
      const data = await r.json().catch(() => null);
      const arr = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
      return [...new Set(arr.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean))];
    }
    lastStatus = r.status;
    lastBody = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  // Include the upstream's own words so a 404 (endpoint not implemented) reads
  // differently from a 401/403 (auth/WAF) — the user can tell them apart.
  throw new Error(`上游 ${url} 返回 ${lastStatus || '错误'}${lastBody ? `: ${lastBody}` : ''}`);
}

// Read the local Claude Code subscription OAuth token. macOS stores it in the
// login keychain; some setups use ~/.claude/.credentials.json. Returns the
// accessToken or '' (non-macOS, logged out, or unreadable) so callers can fall
// back to the tier aliases.
async function readClaudeOAuthToken() {
  try {
    const { stdout } = await execFileP('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 });
    const tok = JSON.parse(stdout).claudeAiOauth?.accessToken;
    if (tok) return tok;
  } catch { /* not macOS / not logged in — fall through */ }
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf-8');
    return JSON.parse(raw).claudeAiOauth?.accessToken || '';
  } catch { return ''; }
}

// Fetch the official Anthropic catalogue (api.anthropic.com/v1/models) with the
// subscription OAuth token — the SAME source the CLI's /model picker uses, so
// the GUI lists exactly what `claude` knows (incl. the latest Opus). Runs via
// curl so it inherits the server's https_proxy (api.anthropic.com is often only
// reachable through one); the token is piped through curl's stdin `--config` so
// it never lands in argv / the process list.
function probeOfficialModels(token) {
  return new Promise((resolve, reject) => {
    const ch = spawn('curl',
      ['-sS', '--max-time', '15', '--config', '-', 'https://api.anthropic.com/v1/models']);
    let out = '', err = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('error', reject);
    ch.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `curl 退出码 ${code}`));
      let data; try { data = JSON.parse(out); } catch { return reject(new Error('解析模型目录失败')); }
      const arr = Array.isArray(data?.data) ? data.data : [];
      resolve([...new Set(arr.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean))]);
    });
    ch.stdin.write(`header = "Authorization: Bearer ${token}"\nheader = "anthropic-version: 2023-06-01"\n`);
    ch.stdin.end();
  });
}

// POST /api/custom-providers/fetch-models { type, baseURL, apiKey } — used by the
// add-provider form (client supplies the key being entered).
router.post('/custom-providers/fetch-models', async (req, res) => {
  try {
    const { baseURL, apiKey } = req.body || {};
    let base; try { base = new URL(baseURL); } catch { return res.status(400).json({ error: 'baseURL 非法' }); }
    if (!/^https?:$/.test(base.protocol)) return res.status(400).json({ error: 'baseURL 必须是 http(s)' });
    res.json({ models: await probeUpstreamModels(baseURL, apiKey) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/provider/fetch-models { id? } — live-fetch a provider's /v1/models.
// With `id`: fetch that OpenAI provider's REAL upstream (key read server-side).
// Without `id`: fetch the CURRENTLY active provider from settings.json. Official
// direct (no base) and the loopback proxy can't be probed.
router.post('/provider/fetch-models', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (id) {
      const up = await resolveOpenAIUpstreamById(id);
      if (!up) return res.status(404).json({ error: 'provider 不存在或非 OpenAI 格式' });
      return res.json({ models: await probeUpstreamModels(up.baseURL, up.apiKey) });
    }
    let env = {};
    try { env = (JSON.parse(await readFile(SETTINGS_PATH, 'utf-8')).env) || {}; } catch {}
    const base = env.ANTHROPIC_BASE_URL || '';
    const token = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
    // Official mode (no base URL): pull the real catalogue from api.anthropic.com
    // with the subscription OAuth token — same list the CLI's /model picker shows,
    // including the latest Opus. Falls back to the tier aliases if not logged in.
    if (!base) {
      const oauth = await readClaudeOAuthToken();
      if (!oauth) return res.json({ models: [], note: '官方模式:未检测到订阅登录,请先在终端 claude login;别名 opus/sonnet/haiku 即最新 tier' });
      try {
        return res.json({ models: await probeOfficialModels(oauth) });
      } catch (e) {
        return res.json({ models: [], note: `官方目录拉取失败:${e.message};可手输具体 id 如 claude-opus-4-8` });
      }
    }
    if (base.includes('127.0.0.1')) return res.json({ models: [], note: 'OpenAI 代理 provider,模型见 provider 配置' });
    res.json({ models: await probeUpstreamModels(base, token) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/provider-models — the user's per-provider model selections.
router.get('/provider-models', async (_req, res) => {
  res.json({ selections: await readProviderModels() });
});

// Keep the ACTIVE provider's *-active.json snapshot in sync when its model list
// is edited elsewhere (the multi-select OR the custom-provider edit form).
// getAvailableModels resolves the ModelSelector from THIS snapshot — a switch-time
// copy — so without this, editing the active provider's models would not show up
// in the picker until a manual re-switch. `activePath` is openai-active.json or
// anthropic-active.json. Best-effort: any failure (not the active provider /
// unreadable) is a no-op.
async function syncActiveProviderSnapshot(activePath, providerId, models) {
  try {
    const active = JSON.parse(await readFile(activePath, 'utf-8'));
    if (active?.providerId !== providerId) return;
    active.models = Array.isArray(models) ? models : [];
    // If the active model is no longer in the kept list (de-selected, or the list
    // was emptied), repoint it to the first kept model — or CLEAR it when none
    // remain (deselect-all) — and keep settings.json's ANTHROPIC_MODEL in sync so
    // the CLI doesn't keep sending a model the user just removed.
    if (!active.models.includes(active.model)) {
      active.model = active.models[0] || '';
      try {
        const cur = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'));
        if (cur?.env) {
          if (active.model) {
            cur.env.ANTHROPIC_MODEL = active.model;
            // The proxy subagent aliases only exist on the openai-proxy path; only
            // rewrite them when already present (anthropic switch deletes them).
            if (cur.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
              cur.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = active.model;
              cur.env.ANTHROPIC_DEFAULT_SONNET_MODEL = active.model;
              cur.env.ANTHROPIC_DEFAULT_OPUS_MODEL = active.model;
            }
          } else {
            delete cur.env.ANTHROPIC_MODEL; // no models left — don't pin a stale one
          }
          await writeFile(SETTINGS_PATH, JSON.stringify(cur, null, 2));
        }
      } catch { /* settings write failed — snapshot still updated below */ }
    }
    await writeFile(activePath, JSON.stringify(active));
  } catch { /* not the active provider, or unreadable — nothing to sync */ }
}

// PUT /api/provider-models/:id { models } — set the chosen models for a provider.
router.put('/provider-models/:id', async (req, res) => {
  try {
    const models = Array.isArray(req.body?.models)
      ? req.body.models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim())
      : [];
    const map = await readProviderModels();
    if (models.length) map[req.params.id] = [...new Set(models)];
    else delete map[req.params.id];
    await writeProviderModels(map);
    // Multi-select is for OpenAI-format providers (cc-switch codex/opencode).
    await syncActiveProviderSnapshot(OPENAI_ACTIVE_PATH, req.params.id, map[req.params.id] || []);
    res.json({ ok: true, models: map[req.params.id] || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  let upstream = hit ? parseOpenAIProvider(hit.settings_config) : null;
  // Custom openai providers live outside cc-switch — check the GUI store too.
  if (!upstream) {
    const custom = (await readCustomProviders()).find((p) => p.id === active.providerId && p.type === 'openai');
    if (custom) upstream = { baseURL: custom.baseURL, apiKey: custom.apiKey };
  }
  if (!upstream) return;
  await startOpenAIProxy();
  setOpenAIUpstream({ baseURL: upstream.baseURL, apiKey: upstream.apiKey });
}

// Boot-time twin of restoreOpenAIProvider for the Anthropic passthrough proxy.
// The token is never persisted, so re-read it from cc-switch.db / custom store.
export async function restoreAnthropicProvider() {
  let active;
  try { active = JSON.parse(await readFile(ANTHROPIC_ACTIVE_PATH, 'utf-8')); } catch { return; }
  if (!active?.providerId) return;
  // Only restore if settings.json still points at the loopback proxy.
  try {
    const cur = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'));
    if (!String(cur?.env?.ANTHROPIC_BASE_URL || '').includes('127.0.0.1')) return;
  } catch { return; }
  let baseURL = active.baseURL || '';
  let authToken = '';
  const rows = await ccSwitchQuery("SELECT id, settings_config FROM providers WHERE app_type='claude'");
  const hit = rows.find((r) => r.id === active.providerId);
  if (hit) {
    try {
      const snap = JSON.parse(hit.settings_config);
      authToken = snap.env?.ANTHROPIC_AUTH_TOKEN || snap.env?.ANTHROPIC_API_KEY || '';
      baseURL = baseURL || snap.env?.ANTHROPIC_BASE_URL || '';
    } catch {}
  }
  if (!authToken) {
    const custom = (await readCustomProviders()).find((p) => p.id === active.providerId && p.type !== 'openai');
    if (custom) { authToken = custom.apiKey; baseURL = baseURL || custom.baseURL; }
  }
  if (!baseURL || !authToken) return;
  await startAnthropicProxy();
  setAnthropicUpstream({ baseURL, authToken });
}

export default router;
