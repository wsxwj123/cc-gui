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

/**
 * Get available models dynamically from env vars.
 * Returns models from ANTHROPIC_DEFAULT_*_MODEL env vars, plus the current model.
 */
export async function getAvailableModels() {
  const settings = await readSettings();
  const env = { ...process.env, ...(settings.env || {}) };
  const current = await getDefaultModel();

  const models = new Map();

  // From ANTHROPIC_DEFAULT_*_MODEL env vars
  const tierMap = {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Haiku',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'Sonnet',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'Opus',
  };

  for (const [envKey, tier] of Object.entries(tierMap)) {
    const id = env[envKey];
    if (id) {
      const cleanId = id.replace(/\[.*\]/, ''); // Remove [1M] suffix
      const nameKey = envKey + '_NAME';
      const displayName = env[nameKey] || cleanId;
      models.set(cleanId, { id: cleanId, name: displayName, tier });
    }
  }

  // Ensure current model is in the list
  if (!models.has(current)) {
    const cleanCurrent = current.replace(/\[.*\]/, '');
    models.set(cleanCurrent, { id: cleanCurrent, name: cleanCurrent, tier: '当前' });
  }

  // Provider info
  const baseUrl = env.ANTHROPIC_BASE_URL || '';
  let provider = 'Anthropic';
  if (baseUrl.includes('mimo')) provider = 'MiMo';
  else if (baseUrl.includes('openai')) provider = 'OpenAI';
  else if (baseUrl.includes('amazonaws')) provider = 'AWS Bedrock';
  else if (baseUrl.includes('googleapis')) provider = 'Google Vertex';
  else if (baseUrl && !baseUrl.includes('anthropic.com')) provider = new URL(baseUrl).hostname;

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
