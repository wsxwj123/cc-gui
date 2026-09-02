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

// ── 外部模型名残留:三层防线共用的判据 ───────────────────────────────────
// Official Anthropic = the CLI's own OAuth/subscription endpoint (no BASE_URL, or
// an anthropic.com host). A loopback base means the local proxy = third party.
export function isOfficialAnthropic(baseURL) {
  if (!baseURL) return true; // empty → CLI default endpoint (api.anthropic.com)
  // 边界要点住:endsWith('anthropic.com') 会把 notanthropic.com / evilanthropic.com
  // 判成官方 —— 那样的 provider 会被当官方直连(不过回环代理)、A5 也不改写 user_id。
  try {
    const h = new URL(baseURL).hostname.toLowerCase();
    return h === 'anthropic.com' || h.endsWith('.anthropic.com');
  } catch { return false; }
}

// A claude-family model id (or CLI tier alias). Used to drop FOREIGN model ids
// (e.g. deepseek) that cc-switch's "common config" leaks into the official
// provider's env, so switching to official never requests a non-claude model.
// `[1m]` 是 Claude Code 的 1M 上下文后缀,不是模型名的一部分 —— 先剥掉再判,否则
// `sonnet[1m]`(官方端点上完全合法的选择)会被当成外部模型名丢掉/拒绝。
export function isClaudeModel(id) {
  if (!id || typeof id !== 'string') return false;
  const base = id.replace(/\[1m\]$/i, '');
  return /claude/i.test(base) || ['sonnet', 'opus', 'haiku', 'fable'].includes(base);
}

// 官方端点上出现非 claude 模型名 = 第三方 provider 的残留(cc-switch 的"通用配置"会把
// deepseek 等模型名漏进官方 provider 的 env,切回官方后请求一个官方根本不存在的模型)。
// 第三方 provider 下一律放行——那里的模型名本来就不是 claude。
export function isForeignModelResidue(baseURL, modelId) {
  return isOfficialAnthropic(baseURL) && !!modelId && !isClaudeModel(modelId);
}

const OFFICIAL_FALLBACK_MODEL = 'claude-sonnet-4-6';
let lastHealed = null; // 同一个残留值只 log 一次(getDefaultModel 每次轮询都会走到)

// 防线之二(读取自愈):解析出的模型若是残留,置换成官方默认并记一行日志。
export function healForeignModel(baseURL, modelId) {
  if (!isForeignModelResidue(baseURL, modelId)) return modelId;
  if (lastHealed !== modelId) {
    lastHealed = modelId;
    console.warn(`[model] 官方端点下解析到非 claude 模型名 "${modelId}"(第三方 provider 残留),本次读取置换为 ${OFFICIAL_FALLBACK_MODEL}`);
  }
  return OFFICIAL_FALLBACK_MODEL;
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
  // 1. The active model explicitly written to settings.json (cc switch / our
  //    PUT /api/model / a provider switch). Authoritative.
  //    healForeignModel:官方端点下的第三方残留(deepseek 等)在这里就地置换,否则整个
  //    GUI(徽章/选择器/发送)都会带着一个官方不存在的模型名跑,回合直接报错。
  const settings = await readSettings();
  const officialBase = settings.env?.ANTHROPIC_BASE_URL || '';
  if (settings.env?.ANTHROPIC_MODEL) return healForeignModel(officialBase, settings.env.ANTHROPIC_MODEL);

  // 2. A relay/proxy is active (loopback base) but NO explicit model. Resolve from
  //    the relay's OWN config — and crucially do NOT fall through to the inherited
  //    shell env (step 4) or the hardcoded Claude default (step 5), both of which
  //    surface a misleading "sonnet"/"haiku" on a non-Claude relay. This is the
  //    root cause of "switched a model-less relay → settings.json has only
  //    ANTHROPIC_BASE_URL → picker/badge show claude-sonnet-4-6". Checked BEFORE
  //    process.env because a polluted launch env must not override the active relay.
  const base = settings.env?.ANTHROPIC_BASE_URL || '';
  if (/^https?:\/\/127\.0\.0\.1[:/]/.test(base)) {
    const oa = await readOpenAIActive();
    if (oa?.models?.length) return oa.defaultModel || oa.models[0];
    const an = await readAnthropicActive();
    if (an?.models?.length) return an.defaultModel || an.models[0];
    return ''; // model-less relay — show "no model", never fake Claude
  }

  // 3. settings.model / settings.defaultModel
  if (settings.model) return healForeignModel(officialBase, settings.model);
  if (settings.defaultModel) return healForeignModel(officialBase, settings.defaultModel);

  // 4. Process env (inherited from shell at launch — fallback only)
  //    这一步【故意不自愈】:宿主继承来的 ANTHROPIC_MODEL 往往和宿主的 ANTHROPIC_BASE_URL
  //    成对出现(第三方 provider 下起的 dev server),而 officialBase 只看 settings.json ——
  //    在这里置换等于拿错误的端点判据去改一个本就该被 boot 时 stripInheritedProviderEnv()
  //    删掉的值,还会把"宿主 env 污染"这个真 bug 遮住(见 check-provider-env-strip 的变异探针)。
  //    残留防线只管 settings.json 这条来源。
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  if (process.env.CLAUDE_MODEL) return process.env.CLAUDE_MODEL;

  // 5. Official Anthropic endpoint (or no base) — the Claude default is correct here.
  return 'claude-sonnet-4-6';
}

// Infer a tier label from an env-var key or a model id, purely heuristic.
function inferTier(s) {
  const u = (s || '').toUpperCase();
  if (u.includes('OPUS'))   return 'Opus';
  if (u.includes('SONNET')) return 'Sonnet';
  if (u.includes('HAIKU'))  return 'Haiku';
  if (u.includes('FABLE'))  return 'Fable';
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
    add('fable',  'Fable (alias)',  'Fable',  'cli-alias');
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
  // 防线之一(写入拒绝):官方端点下不接受非 claude 模型名。挡在写盘前,残留就进不了
  // settings.json —— 否则每个读点都要自愈一遍,且 CLI 会拿着它直接向官方发请求。
  // 守卫放在这里(不在路由里)是为了覆盖所有调用方;err.status 让路由回 400 而非 500。
  if (isForeignModelResidue(settings.env?.ANTHROPIC_BASE_URL || '', modelId)) {
    const err = new Error(`当前是 Claude 官方端点,不接受非 claude 模型名 "${modelId}"。切换到对应的第三方 provider 后再选该模型。`);
    err.status = 400;
    throw err;
  }
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
