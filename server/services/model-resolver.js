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
 * Resolve the current default model from env vars + settings.json.
 * Priority: ANTHROPIC_MODEL env > settings.env.ANTHROPIC_MODEL > settings.model > fallback
 */
export async function getDefaultModel() {
  // 1. Process env (set by the server's own environment)
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;

  // 2. Settings.json env section (what the CLI actually sees)
  const settings = await readSettings();
  if (settings.env?.ANTHROPIC_MODEL) return settings.env.ANTHROPIC_MODEL;

  // 3. settings.model / settings.defaultModel
  if (settings.model) return settings.model;
  if (settings.defaultModel) return settings.defaultModel;

  // 4. Fallback
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
  const add = (id, label, tier, source) => {
    if (!id) return;
    const cleanId = String(id).replace(/\[.*\]/, '');
    if (models.has(cleanId)) return;
    models.set(cleanId, {
      id: cleanId,
      name: label || cleanId,
      tier: tier || inferTier(cleanId) || '',
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

  // Guarantee current model is selectable
  if (!models.has(current.replace(/\[.*\]/, ''))) {
    add(current, current, inferTier(current) || 'Current', 'resolved-default');
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

  // For Anthropic-official: when the user is on the subscription auth (no env-defined
  // model ids), supplement with the latest known Anthropic model IDs. Third-party
  // providers don't need this — their env vars carry their own model list.
  if (provider === 'Anthropic') {
    const ANTHROPIC_KNOWN = [
      { id: 'claude-opus-4-7',           name: 'Claude Opus 4.7',  tier: 'Opus' },
      { id: 'claude-sonnet-4-6',         name: 'Claude Sonnet 4.6', tier: 'Sonnet' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5',  tier: 'Haiku' },
    ];
    for (const m of ANTHROPIC_KNOWN) add(m.id, m.name, m.tier, 'anthropic-catalog');
  }

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
