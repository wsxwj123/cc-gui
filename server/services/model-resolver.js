import { readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');
// Written by switchToOpenAIUpstream when an OpenAI-format provider is active.
// Holds { providerId, name, model, models[] } so we can offer the provider's
// full model list even though settings.json only carries the one active model.
const OPENAI_ACTIVE = join(homedir(), '.claude-gui', 'openai-active.json');
// Twin marker for an Anthropic-format provider routed through the passthrough
// proxy — lets us show the real provider name instead of the loopback host.
const ANTHROPIC_ACTIVE = join(homedir(), '.claude-gui', 'anthropic-active.json');

async function readOpenAIActive() {
  try { return JSON.parse(await readFile(OPENAI_ACTIVE, 'utf-8')); }
  catch { return null; }
}

async function readAnthropicActive() {
  try { return JSON.parse(await readFile(ANTHROPIC_ACTIVE, 'utf-8')); }
  catch { return null; }
}

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

  // Resolve the upstream provider first — it decides whether CLI aliases make
  // sense. A non-Anthropic baseUrl (cc switch → mimo/deepseek/openrouter) means
  // sonnet/opus/haiku get silently redirected to that provider's default, so
  // they show up as misleading "duplicate" rows next to the real model ids.
  const baseUrl = env.ANTHROPIC_BASE_URL || '';
  let provider = 'Anthropic';
  // When an OpenAI-format provider is active, ANTHROPIC_BASE_URL points at the
  // loopback proxy (127.0.0.1) — useless as a label. Use the real provider name
  // and surface its WHOLE model list so the ModelSelector can pick any of them.
  const oaActive = await readOpenAIActive();
  const anthropicActive = await readAnthropicActive();
  const isLoopback = /^https?:\/\/127\.0\.0\.1[:/]/.test(baseUrl);
  const isProxyActive = isLoopback && oaActive;
  // Anthropic passthrough proxy active → show the real provider name, not 127.0.0.1.
  const isAnthropicProxyActive = isLoopback && !oaActive && anthropicActive;
  if (isProxyActive) {
    provider = oaActive.name || 'OpenAI';
  } else if (isAnthropicProxyActive) {
    provider = anthropicActive.name || 'Anthropic';
  } else if (baseUrl) {
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
  const isAnthropic = provider === 'Anthropic';
  // Add every model the active OpenAI provider exposes (the user picks one in the
  // ModelSelector; the CLI sends it and the proxy forwards it upstream).
  if (isProxyActive && Array.isArray(oaActive.models)) {
    for (const m of oaActive.models) add(m, m, '', 'openai-provider');
  }

  // Every *_MODEL key — enumerate from settings.json ONLY, never the inherited
  // process.env. A shell that launched the server may carry stale ANTHROPIC_*
  // model vars (e.g. a leftover ANTHROPIC_REASONING_MODEL=...opus-4-6-thinking),
  // which otherwise leaked a phantom "Reasoning"/"sonnet" row onto EVERY provider
  // regardless of the active settings.json. settings.json is the source of truth.
  const senv = settings.env || {};
  for (const [key, val] of Object.entries(senv)) {
    if (typeof val !== 'string' || !val) continue;
    if (!/_MODEL$/.test(key)) continue;
    const nameKey = key + '_NAME';
    const tier = inferTier(key) || inferTier(val);
    add(val, senv[nameKey] || envKeyToLabel(key, val), tier, key);
  }

  // Anthropic passthrough proxy: surface the provider's FULL model list in the
  // ModelSelector. A custom anthropic provider only carries ANTHROPIC_MODEL in
  // env, so its other models must come from the active marker. Added AFTER the
  // env loop so cc-switch's nicely-labeled tier rows win the dedup; this only
  // fills in models that env didn't already list.
  if (isAnthropicProxyActive && Array.isArray(anthropicActive.models)) {
    for (const m of anthropicActive.models) add(m, m, '', 'anthropic-provider');
  }

  // CLI aliases — `claude --model sonnet` resolves to latest of that tier
  // server-side. Only meaningful on Anthropic; on a redirected provider they're
  // noise (and look like duplicates of the concrete model ids), so skip them.
  if (isAnthropic) {
    add('sonnet', 'Sonnet (alias)', 'Sonnet', 'cli-alias');
    add('opus',   'Opus (alias)',   'Opus',   'cli-alias');
    add('haiku',  'Haiku (alias)',  'Haiku',  'cli-alias');
  }

  // Guarantee current model is selectable (full id, [1m] preserved)
  if (!models.has(current)) {
    add(current, current.replace(/\[1m\]/i, ''), inferTier(current) || 'Current', 'resolved-default');
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
