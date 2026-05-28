import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');

// mtime-keyed cache so `cc switch` (which rewrites settings.json) takes effect immediately.
let settingsCache = null;
let settingsCacheMtime = 0;

async function readSettings() {
  try {
    const st = await stat(CLAUDE_SETTINGS);
    const mtime = st.mtimeMs;
    if (settingsCache && mtime === settingsCacheMtime) return settingsCache;
    settingsCache = JSON.parse(await readFile(CLAUDE_SETTINGS, 'utf-8'));
    settingsCacheMtime = mtime;
  } catch {
    settingsCache = {};
    settingsCacheMtime = 0;
  }
  return settingsCache;
}

/**
 * Resolve the current default model.
 * Priority: settings.json env > settings.model > process.env > fallback
 *
 * settings.json comes FIRST because that's where both `cc switch` and the
 * GUI's own setDefaultModel write. process.env is the inherited shell value,
 * which is fine as a fallback but must not override an explicit user choice
 * — otherwise picking "sonnet" in the GUI silently reverts to whatever
 * ANTHROPIC_MODEL was set when the server was launched.
 */
export async function getDefaultModel() {
  // 1. Settings.json env section (what `cc switch` and our PUT /api/model write)
  const settings = await readSettings();
  if (settings.env?.ANTHROPIC_MODEL) return settings.env.ANTHROPIC_MODEL;

  // 2. settings.model / settings.defaultModel
  if (settings.model) return settings.model;
  if (settings.defaultModel) return settings.defaultModel;

  // 3. Process env (inherited from shell at launch — fallback only)
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;

  // 4. Hardcoded fallback
  return 'claude-sonnet-4-6';
}

// Infer a tier label from an env-var key or a model id, purely heuristic.
function inferTier(s) {
  const u = (s || '').toUpperCase();
  if (u.includes('OPUS'))   return 'Opus';
  if (u.includes('SONNET')) return 'Sonnet';
  if (u.includes('HAIKU'))  return 'Haiku';
  if (u.includes('FAST') || u.includes('SMALL')) return 'Fast';
  return null;
}

// Pretty-name an env-var key for display when no explicit *_NAME is set.
function envKeyToLabel(key, id) {
  const stripped = key
    .replace(/^ANTHROPIC_/, '')
    .replace(/^DEFAULT_/, '')
    .replace(/_MODEL$/, '')
    .replace(/^MODEL$/, '');
  if (!stripped) return id; // e.g. ANTHROPIC_MODEL → "" → fall back to model id
  return stripped.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Dynamically enumerate every model the CLI environment exposes:
 *   - any env/settings key ending in `_MODEL` (covers ANTHROPIC_MODEL,
 *     ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL, ANTHROPIC_SMALL_FAST_MODEL,
 *     CLAUDE_MODEL, and any user-defined XXX_MODEL)
 *   - plus the resolved current default (ensures it's always selectable)
 *   - plus the CLI aliases `sonnet`/`opus`/`haiku` so users can pin to "latest tier"
 *
 * No hardcoded model IDs — adapts automatically as cc switch rewrites settings.json.
 */
export async function getAvailableModels() {
  const settings = await readSettings();
  const env = { ...process.env, ...(settings.env || {}) };
  const current = await getDefaultModel();

  const models = new Map();
  // IMPORTANT: keep the FULL id, including a trailing `[1m]` suffix. That
  // suffix is how Claude Code opts a model into the 1M-context beta (it's what
  // the CLI's own `/model` picker writes). Stripping it here — as the old code
  // did via replace(/\[.*\]/,'') — meant the GUI could never request 1M, and
  // worse, picking from the dropdown persisted the stripped id back to
  // settings.json, silently deleting the user's `[1m]`. We dedup on the full
  // id so `foo` and `foo[1m]` can coexist as separate choices.
  const add = (id, label, tier, source) => {
    if (!id) return;
    const fullId = String(id);
    if (models.has(fullId)) return;
    const has1m = /\[1m\]/i.test(fullId);
    models.set(fullId, {
      id: fullId,
      name: label || fullId.replace(/\[1m\]/i, ''),
      tier: tier || inferTier(fullId) || '',
      context1m: has1m,
      source,
    });
  };

  // Every *_MODEL env key (skip *_MODEL_NAME companions and aliases we expand below)
  for (const [key, val] of Object.entries(env)) {
    if (typeof val !== 'string' || !val) continue;
    if (!/_MODEL$/.test(key)) continue;
    const nameKey = key + '_NAME';
    const tier = inferTier(key) || inferTier(val);
    add(val, env[nameKey] || envKeyToLabel(key, val), tier, key);
  }

  // CLI aliases — `claude --model sonnet` resolves to latest of that tier server-side
  add('sonnet', 'Sonnet (alias)', 'Sonnet', 'cli-alias');
  add('opus',   'Opus (alias)',   'Opus',   'cli-alias');
  add('haiku',  'Haiku (alias)',  'Haiku',  'cli-alias');

  // Guarantee current model is selectable (full id, [1m] preserved)
  if (!models.has(current)) {
    add(current, current.replace(/\[1m\]/i, ''), inferTier(current) || 'Current', 'resolved-default');
  }

  // Endpoint label
  const baseUrl = env.ANTHROPIC_BASE_URL || '';
  let provider = 'Anthropic';
  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname;
      if (host.endsWith('anthropic.com')) provider = 'Anthropic';
      else if (host.includes('mimo')) provider = 'Xiaomi MiMo';
      else if (host.includes('openrouter')) provider = 'OpenRouter';
      else if (host.includes('deepseek')) provider = 'DeepSeek';
      else if (host.includes('amazonaws')) provider = 'AWS Bedrock';
      else if (host.includes('googleapis')) provider = 'Google Vertex';
      else provider = host;
    } catch {}
  }

  // No hardcoded Anthropic catalog anymore.
  // Reason: hardcoded IDs go stale (e.g. opus-4-6 was deprecated, 4-7 may not
  // exist for all subscriptions). The CLI aliases sonnet/opus/haiku resolve
  // server-side to the latest available tier — that's the truth source.
  // Users who want a specific dated ID can still type it via "自定义模型 ID".

  return { models: [...models.values()], provider, current };
}

/**
 * Set the default model in settings.json env section.
 */
export async function setDefaultModel(modelId) {
  const settings = await readSettings();
  if (!settings.env) settings.env = {};
  settings.env.ANTHROPIC_MODEL = modelId;
  await writeFile(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  settingsCache = settings;
  try { settingsCacheMtime = (await stat(CLAUDE_SETTINGS)).mtimeMs; } catch {}
}

/**
 * Map model ID to a friendly display name.
 */
export function modelDisplayName(modelId) {
  if (!modelId) return 'Unknown';
  return modelId.replace(/\[.*\]/, '');
}
