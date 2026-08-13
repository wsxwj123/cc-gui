import { Router } from 'express';
import { readFile, writeFile, mkdir, copyFile, unlink, readdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { join, isAbsolute, dirname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { resolveWorkspacePath } from '../utils/safe-path.js';
import { createConnection } from 'node:net';
import { startOpenAIProxy, setOpenAIUpstream, getProxyPort } from '../services/openai-proxy.js';
import { startAnthropicProxy, setAnthropicUpstream, getAnthropicProxyPort } from '../services/anthropic-proxy.js';
import { isOfficialAnthropic, isClaudeModel } from '../services/model-resolver.js';

const execFileP = promisify(execFile);
const CC_SWITCH_DB = join(homedir(), '.cc-switch', 'cc-switch.db');

const router = Router();
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

// BK-8:每次 provider 切换都会备份 settings.json 到 .${ts}.bak。备份后清理旧的,
// 只保留最近 KEEP 个,避免频繁切 provider 在 ~/.claude/ 无限堆积 .bak 文件。
// CQ批次4:用户反馈 5 个还是太多(切换频繁),降到 3 个——回退基本只会用到最近一两份。
const SETTINGS_BAK_KEEP = 3;
async function backupSettings(ts) {
  await copyFile(SETTINGS_PATH, `${SETTINGS_PATH}.${ts}.bak`).catch(() => {});
  try {
    const dir = join(homedir(), '.claude');
    const baks = (await readdir(dir))
      .filter((f) => f.startsWith('settings.json.') && f.endsWith('.bak'))
      .sort(); // 时间戳前缀字典序 = 时间序
    for (const old of baks.slice(0, Math.max(0, baks.length - SETTINGS_BAK_KEEP))) {
      await unlink(join(dir, old)).catch(() => {});
    }
  } catch {}
}
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

// isOfficialAnthropic(官方端点判据)/ isClaudeModel(claude 家族模型名判据)现由
// services/model-resolver.js 单一持有 —— 本文件的 provider 切换、model-resolver 的读取
// 自愈、PUT /api/model 的写入拒绝是同一条"外部模型名残留"防线的三层,判据必须同源,
// 各留一份副本迟早会漂。语义与调用处一字未改(见文件头 import)。

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
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  // A(#50085): only the third-party switch paths re-set this to '0'. Listing it
  // here means every switch first strips it, so switching back to official/native
  // claude never leaves a stale CLAUDE_CODE_ATTRIBUTION_HEADER=0 behind.
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
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
// 全新机器(从未跑过 claude)没有 ~/.claude.json,终端交互式 claude 会进"首次引导向导"
// 强制官方 OAuth 登录——墙内直接撞地区屏蔽"不支持某些国家"(用户新机实报;cc-switch 无此
// 问题正是因为它写了这个标记)。第三方 provider 本就无需登录 → 切换成功后补
// hasCompletedOnboarding=true 跳过向导,终端 claude 直接用 settings env 凭证工作。
// 读-合-写只动这一个键;文件损坏(非 ENOENT)时不动,宁可保留用户数据。
// 仅第三方路径调用,官方订阅路径不写(登录流程由 CLI 自己管)。
async function ensureOnboardingFlag() {
  const p = join(homedir(), '.claude.json');
  let cur = {};
  try { cur = JSON.parse(await readFile(p, 'utf-8')); }
  catch (e) { if (e.code !== 'ENOENT') return; }
  if (cur && cur.hasCompletedOnboarding === true) return;
  try { await writeFile(p, JSON.stringify({ ...(cur || {}), hasCompletedOnboarding: true }, null, 2)); } catch {}
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

// 原子写 + 串行队列:并发 create/edit/delete 各自读-改-写,半截 writeFile 或互相
// 覆盖会丢 provider 条目。tmp 名带 uuid + rename 落地,写操作挂同一条 Promise 链
// (与 sessions.js writeJsonlAtomic 同模式,单文件只需一条链)。
let _customProvidersQueue = Promise.resolve();
async function writeCustomProviders(list) {
  const run = _customProvidersQueue.catch(() => {}).then(async () => {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    const tmp = `${CUSTOM_PROVIDERS_PATH}.tmp-${randomUUID()}`;
    try {
      await writeFile(tmp, JSON.stringify(list, null, 2));
      await rename(tmp, CUSTOM_PROVIDERS_PATH);
    } catch (err) {
      // rename 前抛错会留 tmp-uuid 残留,兜底清掉(文件可能没写成,ENOENT 忽略)。
      try { await unlink(tmp); } catch {}
      throw err;
    }
  });
  _customProvidersQueue = run;
  return run;
}

// BB6: validate a tierModels input against the provider's model list. Returns a
// cleaned { haiku?, sonnet?, opus?, fable? } keeping only ids present in `models`, or null
// when nothing valid remains (caller then omits the field → switch回退 chosen).
function sanitizeTierModels(input, models) {
  if (!input || typeof input !== 'object') return null;
  const allowed = new Set(models || []);
  const out = {};
  for (const tier of ['haiku', 'sonnet', 'opus', 'fable']) {
    const v = input[tier];
    if (typeof v === 'string' && allowed.has(v.trim())) out[tier] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

// R3: 用户自填的每模型单价 modelPrices —— { [modelId]: {in,out,cacheRead,cacheWrite} | {plan:true} },
// 单位【人民币元 / 每百万 token】。内置价表算不准中转站(服务商自定价)和套餐包月,只有用户
// 知道实付多少;前端计价层(client/src/utils/pricing.js)拿它盖过所有内置来源。
// 校验口径与 contextWindow 同族:数字必须有限且 >= 0;上界 PRICE_MAX 挡住笔误/垃圾数据;
// 条目数与 model id 长度都封顶,免得一次 PUT 把配置文件撑爆。全空条目删键,一条不剩返回 null。
// model id **不要求**在 models[] 内:上游/中转返回的真实 id 常与列表里填的不一致,而计价
// 认的是消息里的真实 id。
const PRICE_MAX = 1_000_000;   // ¥100万/百万 token,任何真实定价都远在其下
const PRICE_MAX_ENTRIES = 200;
const PRICE_MAX_ID_LEN = 200;
export function sanitizeModelPrices(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const num = (v) => {
    const x = typeof v === 'string' ? Number(v.trim() || NaN) : v;
    return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= PRICE_MAX ? x : null;
  };
  const out = {};
  for (const [rawId, rawVal] of Object.entries(input)) {
    if (Object.keys(out).length >= PRICE_MAX_ENTRIES) break;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || id.length > PRICE_MAX_ID_LEN) continue;
    if (!rawVal || typeof rawVal !== 'object') continue;
    if (rawVal.plan === true) { out[id] = { plan: true }; continue; }  // 套餐档:价格字段无意义,不存
    const e = {};
    for (const k of ['in', 'out', 'cacheRead', 'cacheWrite']) {
      const n = num(rawVal[k]);
      if (n !== null) e[k] = n;
    }
    // in/out 都没有 = 用户没填价(只填缓存价无法计价)→ 删键,回落内置表。
    if (e.in === undefined && e.out === undefined) continue;
    out[id] = e;
  }
  return Object.keys(out).length ? out : null;
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

// 内置官方 provider 合成行(用户实报:一次性导入后官方条目从列表消失,只能手工加 custom 顶替)。
// 根因:import-from-ccswitch 跳过 category='official'(OAuth 订阅无 key 可导),导入后 GET
// /providers 又不再读 cc-switch.db → 两头都没有官方行。没装过 cc-switch 的机器同理从来就没有。
// 官方订阅不需要任何存储配置——切它就是"清掉路由/鉴权 env、回到 OAuth 登录",逻辑全在
// /provider/switch 的 official 分支里现算。所以这里只在【拿到的行里确实没有 official】时补一条
// 纯响应层的合成行:不落盘、不写 cc-switch.db,settings_config 给 '{}'(official 分支只读
// id/name,env 从当前 settings.json 现算,不碰 snapshot)。
const BUILTIN_OFFICIAL_ID = 'builtin-official';
function withBuiltinOfficial(rows) {
  if (rows.some((r) => r.category === 'official')) return rows; // db 里已有真官方行,不重复
  return [...rows, { id: BUILTIN_OFFICIAL_ID, name: 'Claude 官方', category: 'official', is_current: 0, settings_config: '{}' }];
}

// 用户实报「点 Claude 官方 → provider 不存在」的根因是两端口径不对称:
// GET /providers 在【已导入】时不读 cc-switch.db(rows=[])→ 补合成行,列表里官方的 id
// 恒为 builtin-official;而 POST /provider/switch 不看 imported 直接读 db,db 里若有真官方行
// (装过 cc-switch 的机器都有)withBuiltinOfficial 就不补合成行 → find(builtin-official) 落空
// → 穿到 openai/custom 查找 → 404。这里回落到 db 的真官方行,并【保留请求的 id】:
// 触发本回落 ⇔ 列表展示的就是合成 id,写 activeProviderId 必须用同一个 id,否则切完
// isCurrent 对不上(列表不高亮)。official 分支只读 id/name,行为与合成行一致。
export function findClaudeProviderRow(rows, id) {
  const hit = rows.find((r) => r.id === id);
  if (hit) return hit;
  if (id !== BUILTIN_OFFICIAL_ID) return undefined;
  const official = rows.find((r) => r.category === 'official');
  return official ? { ...official, id: BUILTIN_OFFICIAL_ID } : undefined;
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

// B 方案: per-provider「默认模型 + 档位映射」覆盖层,对【所有】provider 生效
// (含 cc-switch 只读组 / openai marker 组),它们不在 custom-providers.json 里够不着
// CustomProviderForm。Shape: { [providerId]: { defaultModel?, tierModels?{haiku,sonnet,opus,fable} } }。
// 无文件 / 无该 id 条目 = 行为完全不变(向后兼容硬要求)。从不写 cc-switch.db。
const PROVIDER_OVERRIDES_PATH = join(homedir(), '.claude-gui', 'provider-overrides.json');

async function readProviderOverrides() {
  try {
    const d = JSON.parse(await readFile(PROVIDER_OVERRIDES_PATH, 'utf-8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

async function writeProviderOverrides(map) {
  await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
  await writeFile(PROVIDER_OVERRIDES_PATH, JSON.stringify(map, null, 2));
}

// 把某 provider 的 override 合并进将传给 upstream 切换函数的 `up` 对象:
// override.defaultModel / override.tierModels 优先于 provider 自带值(custom-providers.json
// 里的同名字段),override 缺省该字段则保留 provider 自带。两者都按 models[] 校验。
async function applyProviderOverride(up) {
  const ov = (await readProviderOverrides())[up.id];
  if (!ov || typeof ov !== 'object') return up;
  const models = up.models || [];
  const out = { ...up };
  if (typeof ov.defaultModel === 'string' && models.includes(ov.defaultModel)) {
    out.defaultModel = ov.defaultModel;
  }
  const tm = sanitizeTierModels(ov.tierModels, models);
  if (tm) out.tierModels = tm;
  return out;
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
// ── 项目级 hooks(<项目>/.claude/settings.json 的 hooks 字段)──────────────
// 场景:技能自带 hook 但只想在某个项目里生效 → 写项目级而非全局。cwd 必须过
// resolveWorkspacePath 门禁(HOME 内或已知 claude 工作区,拒任意路径);PUT 读-合-写
// 只动 hooks 键,不整文件覆盖(项目 settings.json 里手写的权限/env 等其它字段不能丢)。
router.get('/project-hooks', async (req, res) => {
  try {
    const root = resolveWorkspacePath(String(req.query.cwd || ''));
    const file = join(root, '.claude', 'settings.json');
    if (!existsSync(file)) return res.json({ hooks: {}, exists: false });
    const data = JSON.parse(await readFile(file, 'utf-8'));
    res.json({ hooks: data.hooks || {}, exists: true });
  } catch (e) {
    res.status(e instanceof SyntaxError ? 500 : 400).json({ error: e instanceof SyntaxError ? '项目 settings.json 不是合法 JSON,请先手动修复' : e.message });
  }
});
router.put('/project-hooks', async (req, res) => {
  try {
    const root = resolveWorkspacePath(String(req.body?.cwd || ''));
    const hooks = req.body?.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return res.status(400).json({ error: 'hooks 必须是对象' });
    const dir = join(root, '.claude');
    const file = join(dir, 'settings.json');
    let data = {};
    if (existsSync(file)) {
      try { data = JSON.parse(await readFile(file, 'utf-8')); }
      catch { return res.status(500).json({ error: '项目 settings.json 已损坏(非法 JSON),拒绝写入以免覆盖,请先手动修复' }); }
    }
    if (Object.keys(hooks).length) data.hooks = hooks; else delete data.hooks;
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 全局 hooks 窄端点:HooksTab 保存不再走整文件 PUT /settings(那是"面板打开时快照"的
// 读-改-写,面板开着期间切 provider/装插件/终端改配置的字段会被旧快照带回=丢更新)。
// GET 每次现读磁盘;PUT 现读-合-写只动 hooks 键,其它字段永不触碰。
router.get('/global-hooks', async (_req, res) => {
  try {
    if (!existsSync(SETTINGS_PATH)) return res.json({ hooks: {} });
    const data = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'));
    res.json({ hooks: data.hooks || {} });
  } catch (e) { res.status(500).json({ error: 'settings.json 不是合法 JSON: ' + e.message }); }
});
router.put('/global-hooks', async (req, res) => {
  try {
    const hooks = req.body?.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return res.status(400).json({ error: 'hooks 必须是对象' });
    let data = {};
    if (existsSync(SETTINGS_PATH)) {
      try { data = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8')); }
      catch { return res.status(500).json({ error: 'settings.json 已损坏(非法 JSON),拒绝写入以免覆盖,请先手动修复' }); }
    }
    if (Object.keys(hooks).length) data.hooks = hooks; else delete data.hooks;
    await writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// env 补丁端点:环境变量编辑全是单键操作(改/增/删一个变量),客户端若整包发快照 env,
// 面板开着期间 provider 切换写的 env(BASE_URL/TOKEN/档位映射)会被旧快照顶掉。此端点
// 现读磁盘、只对指定键 set/del,env 其它键与顶层其它字段零触碰。返回整份最新 settings
// 供面板刷新快照(与 PUT /settings 响应同构)。
router.put('/settings-env', async (req, res) => {
  try {
    const set = (req.body?.set && typeof req.body.set === 'object' && !Array.isArray(req.body.set)) ? req.body.set : {};
    const del = Array.isArray(req.body?.del) ? req.body.del : [];
    if (!Object.keys(set).length && !del.length) return res.status(400).json({ error: 'set/del 至少一项' });
    let data = {};
    if (existsSync(SETTINGS_PATH)) {
      try { data = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8')); }
      catch { return res.status(500).json({ error: 'settings.json 已损坏(非法 JSON),拒绝写入以免覆盖,请先手动修复' }); }
    }
    const env = { ...(data.env || {}) };
    for (const [k, v] of Object.entries(set)) env[String(k)] = String(v);
    for (const k of del) delete env[String(k)];
    // SSRF 守卫(与 provider 创建/切换同口径,环回放行):env 面板可直写
    // ANTHROPIC_BASE_URL,绕过 provider 表单的校验 → 在此兜底挡内网地址。
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL']) {
      if (env[k]) {
        try { await assertPublicBaseURL(env[k]); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
      }
    }
    if (Object.keys(env).length) data.env = env; else delete data.env;
    await writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// 合并/替换语义(纯函数,供单测):
// - 补丁模式(默认):浅合并进磁盘现值,body 顶层 null 键 = 删除该配置项。设置页各
//   tab(权限/Hooks/会话开关)每次只发改动的那一项,靠合并保住其余键。
// - 替换模式(replace=true):body 即完整新内容,不与磁盘合并——原始 JSON 编辑器发的
//   是整份全文,合并会把用户删掉的顶层键(hooks 等)用磁盘旧值复活,表现为"一保存就
//   恢复原样"。null 键同样删除(与补丁语义一致,避免写字面 null 进文件)。
export function computeUpdatedSettings(current, body, replace = false) {
  const updated = replace ? { ...body } : { ...current, ...body };
  for (const k of Object.keys(body)) { if (body[k] === null) delete updated[k]; }
  return updated;
}

// POST /api/settings/reveal — 在系统文件管理器中定位 settings.json(macOS/Win 高亮该
// 文件,Linux 打开所在目录)。路径服务端写死、零入参;远程/手机访问时作用在服务器本机
// (与 /worktree/reveal 同预期)。文件不存在时回落打开 ~/.claude 目录。
router.post('/settings/reveal', async (_req, res) => {
  try {
    const hasFile = existsSync(SETTINGS_PATH);
    let cmd, args;
    if (process.platform === 'darwin') {
      cmd = 'open'; args = hasFile ? ['-R', SETTINGS_PATH] : [dirname(SETTINGS_PATH)];
    } else if (process.platform === 'win32') {
      cmd = 'explorer'; args = hasFile ? [`/select,${SETTINGS_PATH}`] : [dirname(SETTINGS_PATH)];
    } else {
      cmd = 'xdg-open'; args = [dirname(SETTINGS_PATH)];
    }
    try {
      await execFileP(cmd, args, { timeout: 10000 });
    } catch (err) {
      // explorer.exe 成功打开也常以非零退出码结束,Win 下不当失败(同 worktree/reveal)。
      if (process.platform !== 'win32') throw err;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 导入项目时的 git 三态判定(纯函数,输入是两次 `git rev-parse` 的失败对象)。
 * 旧实现只跑 `rev-parse HEAD` 且裸 catch:git 没装 / TCC 拒读 / dubious ownership /
 * 超时统统被归成"不是 git 仓库",而"仓库存在但零提交"也报同一句话 —— 用户拿到的
 * 是一条误导且没有出路的提示(Bug7)。
 *   headErr   = `rev-parse HEAD` 的错误(成功传 null)→ 判"有没有提交"
 *   insideErr = `rev-parse --is-inside-work-tree` 的错误(成功传 null)→ 判"在不在仓库里"
 * 只有 git 明确说 "not a git repository" 才算 notRepo(口径同 git.js 的 /git/status,
 * git 2.50 输出本地化,双语正则必需);其余失败一律 gitCheckFailed,不冒称"不是仓库"。
 * @returns {{gitState:'ok'|'repoNoCommit'|'notRepo'|'gitCheckFailed', gitCheckReason?:string, gitCheckDetail?:string}}
 */
export function classifyGitProbe({ headErr = null, insideErr = null } = {}) {
  if (!headErr) return { gitState: 'ok' };
  // HEAD 探测超时时"零提交"这个结论并不成立(第二条命令碰巧成功也只说明在仓库里)。
  // 宣称"仓库没有任何提交"会引导用户去做一次把全部未提交改动打成一个 commit 的写操作,
  // 基于误判的写操作不做 —— 归到 gitCheckFailed。零提交的真实形态是 code 128,不受影响。
  if (headErr.killed) return { gitState: 'gitCheckFailed', gitCheckReason: 'timeout' };
  if (!insideErr) return { gitState: 'repoNoCommit' };
  const msg = String(insideErr.stderr || insideErr.message || '');
  if (/not a git repository|不是.*git\s*仓库/i.test(msg)) return { gitState: 'notRepo' };
  if (insideErr.code === 'ENOENT') return { gitState: 'gitCheckFailed', gitCheckReason: 'gitMissing' };
  if (insideErr.killed) return { gitState: 'gitCheckFailed', gitCheckReason: 'timeout' };
  if (/dubious ownership|可疑所有权/i.test(msg)) return { gitState: 'gitCheckFailed', gitCheckReason: 'ownership' };
  return {
    gitState: 'gitCheckFailed',
    gitCheckReason: 'other',
    gitCheckDetail: msg.split('\n')[0].slice(0, 160) || undefined,
  };
}

/**
 * 跑上面那两条探测命令并归类。路由与单测共用同一个函数(测试复刻路由代码会漂移)。
 * 第二条只在 HEAD 失败时跑 —— 正常仓库仍然只有一次 git 调用。
 */
export async function probeGitState(dir) {
  let headErr = null, insideErr = null;
  try {
    await execFileP('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 4000 });
  } catch (err) { headErr = err; }
  if (headErr) {
    try {
      await execFileP('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeout: 4000 });
    } catch (err) { insideErr = err; }
  }
  return classifyGitProbe({ headErr, insideErr });
}

// PUT /api/settings — update settings.
// SPECIAL KEY: `_addProject` is NOT a real settings field; it's a request to
// register a new project root by creating its hashed dir under
// ~/.claude/projects/. Without this branch the field was being written
// verbatim into settings.json (polluting it) AND the project was never
// actually visible to listProjects, so users would add a folder and watch it
// vanish on every refresh.
// SPECIAL KEY: `_replace` — 原始 JSON 编辑器整份保存标记,见 computeUpdatedSettings。
router.put('/settings', async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    const addPath = typeof body._addProject === 'string' ? body._addProject.trim() : null;
    const createDir = body._createDir === true;
    const replace = body._replace === true;
    delete body._addProject;
    delete body._createDir;
    delete body._replace;

    let addedHash = null;
    let addedPath = null;
    let noGitHead = false;
    let gitProbe = { gitState: 'ok' };
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
      // A6:导入时探测 git 状态(三态见 classifyGitProbe),只作标记随响应返回,不阻断
      // 导入(链路里既有的 rev-parse 检测都在使用时:worktree/git/checkpoints)。
      gitProbe = await probeGitState(clean);
      // 兼容旧前端 bundle(打包版前端与服务端可能不同版):noGitHead 语义不变。
      noGitHead = gitProbe.gitState !== 'ok';
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
    const updated = computeUpdatedSettings(current, body, replace);
    // 原始配置里 model 字段与 env.ANTHROPIC_MODEL 表达同一意图(默认模型),但 env 在
    // model-resolver 里优先级更高。用户只在 JSON 改 model、不改 env 时,env 会覆盖
    // model → "改默认模型看起来没生效"(改 sonnet 顶栏仍 haiku)。官方端点下两者不一致
    // 时以 model 为准对齐 env(与顶栏选模型同时写两者的行为一致)。第三方 provider
    // (base_url 非官方)下 env.ANTHROPIC_MODEL 是上游真实模型,不动。
    {
      const base = String(updated.env?.ANTHROPIC_BASE_URL || '');
      const official = !base || /\/\/api\.anthropic\.com/.test(base);
      if (official && updated.model && updated.env?.ANTHROPIC_MODEL && updated.env.ANTHROPIC_MODEL !== updated.model) {
        updated.env.ANTHROPIC_MODEL = updated.model;
      }
    }
    // SSRF 守卫(同口径,环回放行):整包 JSON 编辑可写入任意 ANTHROPIC_BASE_URL。
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL']) {
      if (updated.env?.[k]) {
        try { await assertPublicBaseURL(updated.env[k]); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
      }
    }
    await writeFile(SETTINGS_PATH, JSON.stringify(updated, null, 2) + '\n');
    res.json({ ...updated, ...(addedHash ? { addedHash, addedPath, noGitHead, ...gitProbe } : {}) });
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
    let apiKeyHelper = '';
    try {
      const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf-8'));
      if (settings && settings.env && typeof settings.env === 'object') env = settings.env;
      if (typeof settings?.apiKeyHelper === 'string') apiKeyHelper = settings.apiKeyHelper;
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

    // 计费口径判据(只回布尔,绝不回令牌本身):官方订阅切换时 /provider/switch 的
    // official 分支会显式删掉 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 回到 OAuth 登录,
    // 所以「providerHint=anthropic 且这两个 key 都没有」= 包月订阅,前端据此对 Claude 系
    // 模型只显示用量不显示价格(第三方模型照常显示,那是另外真金白银付的)。
    // apiKeyHelper 也算有 key:它是 CLI 现取 API key 的钩子,配了它就是按量付费,
    // 漏判会把付费用户的价格藏掉(失败方向必须是"不多藏")。
    // 不看 process.env:server/index.js 启动时 stripInheritedProviderEnv() 已把
    // ANTHROPIC_AUTH_TOKEN/API_KEY 从本进程 env 删掉,写在这里是死代码,徒增误解。
    const hasAuthKey = !!(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || apiKeyHelper);

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

    res.json({ baseUrl, providerHint, model, protocol, hasAuthKey });
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
  const rows = withBuiltinOfficial(imported ? [] : await ccSwitchQuery(
    "SELECT id, name, category, is_current, settings_config FROM providers WHERE app_type='claude' ORDER BY sort_index"
  ));
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
    models: p.models || [], defaultModel: p.defaultModel || '', tierModels: p.tierModels || null,
    // R3: 计价层(pricing.js setUserPrices)与编辑表单预填都读这里。apiKey 永不下发,
    // 边界不变 —— 只多了两个用户自己填的配置字段。
    // contextWindow 原先没回显 → 表单预填恒空 → 每次「更新」都把已存的窗口清掉(PUT 收到
    // null 即删)。补上它顺带修掉这条:同一处遗漏,modelPrices 不补一样会被清空。
    contextWindow: p.contextWindow || null, modelPrices: p.modelPrices || null,
    hasKey: !!p.apiKey, isCustom: true, isCurrent: isCur(p.id, false),
  }));
  // B 方案: claude 只读组的 models[] 从其 snapshot.env 的 _MODEL 值提取(切换/导入路径
  // 同口径),否则档位下拉无选项。official 不给 models(它有真四档,不走 override)。
  const claudeProviders = rows.map((r) => {
    let models = [];
    if (r.category !== 'official') {
      try {
        const env = JSON.parse(r.settings_config)?.env || {};
        models = [...new Set(Object.entries(env)
          .filter(([k, v]) => /_MODEL$/.test(k) && typeof v === 'string' && v)
          .map(([, v]) => v))];
      } catch {}
    }
    return {
      id: r.id, name: r.name, appType: 'claude', format: 'claude',
      category: r.category || null, models,
      isCurrent: isCur(r.id, r.is_current === 1),
    };
  });
  res.json({
    // rows 含合成的内置官方行 → available 恒 true(官方订阅任何时候都可切回),口径与列表一致。
    available: rows.length > 0 || openai.length > 0 || customProviders.length > 0,
    providers: claudeProviders,
    openaiProviders: openai,
    customProviders,
    // 回显所有 override(前端编辑器初始化用);无文件 = {}。
    overrides: await readProviderOverrides(),
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
    // withBuiltinOfficial:db 无官方行时补合成行,使其 id 命中下面【现成的】official 分支。
    const dbRows = await ccSwitchQuery(
      "SELECT id, name, category, settings_config FROM providers WHERE app_type='claude'"
    );
    const rows = withBuiltinOfficial(dbRows);
    const hit = findClaudeProviderRow(rows, id);

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
        const up = await applyProviderOverride({ id: oaHit.id, name: oaHit.name, baseURL: parsed.baseURL, apiKey: parsed.apiKey, models });
        return switchToOpenAIUpstream(up, model, res);
      }
      // GUI custom providers (stored outside cc-switch).
      const custom = (await readCustomProviders()).find((p) => p.id === id);
      if (custom) return switchToCustomProvider(custom, model, res);
      // 503 判据用 dbRows(rows 恒含合成官方行,拿它判会把"db 读不到"误报成 404)。
      if (dbRows.length === 0) return res.status(503).json({ error: 'CC Switch 数据库不可用' });
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
      for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_ATTRIBUTION_HEADER']) delete env[k];
      for (const k of Object.keys(env)) {
        if (/_MODEL$/.test(k) && !isClaudeModel(env[k])) { delete env[k]; delete env[k + '_NAME']; }
      }
      // 主对话模型 env.ANTHROPIC_MODEL:显式 claude 选择优先;否则**官方默认 sonnet**。
      // CQ-fix(用户报"官方默认变 haiku"):绝不拿 settings.json 的 `model` 字段兜底——那个
      // 字段是 *子代理默认档*(cc CLI 写成 haiku 给 Task 用),把它当主对话模型 = 官方主 chat
      // 变 haiku 的根因。已钉的 opus/sonnet 保留;未设 / 非 claude / 被钉成 haiku → 一律回 sonnet。
      if (model && isClaudeModel(model)) {
        env.ANTHROPIC_MODEL = model;
      } else if (!isClaudeModel(env.ANTHROPIC_MODEL) || /haiku/i.test(env.ANTHROPIC_MODEL || '')) {
        env.ANTHROPIC_MODEL = 'claude-sonnet-4-6';
      }
      const next = { ...current, env };
      // `next.model`(子代理默认档,官方下 cc 用 haiku)保持原样,不影响主 chat。
      const curModel = current.model;
      if (model && isClaudeModel(model)) next.model = model;
      else if (isClaudeModel(curModel)) next.model = curModel;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await backupSettings(ts);
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
      const up = await applyProviderOverride(
        { id: hit.id, name: hit.name, baseURL: snapBase, authToken: snapTok, snapshot, models: snapModels },
      );
      return switchToAnthropicUpstream(up, model, res);
    }

    // Back up the current settings.json (timestamped) before overwriting.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // SSRF 守卫(同口径):snapshot.env 的 ANTHROPIC_BASE_URL 将直写 settings 由 CLI 直连。
    if (snapBase) {
      try { await assertPublicBaseURL(snapBase); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    }
    await backupSettings(ts);

    const current = await readCurrentSettings();
    const env = mergeProviderEnv(current.env, snapshot.env || {});
    const next = { ...current, env };
    if (snapshot.model) next.model = snapshot.model;
    await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
    await ensureOnboardingFlag(); // 非官方分支同样无需登录:跳过终端首次向导
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

// BB6: per-provider 档位映射。把子代理/标题/compact 用的 tier alias(haiku/sonnet/
// opus/fable)分别映射到该 provider 的真实模型(简单任务用便宜的,难的用强的)。
// fable 档:CLI 2.1.201 起 ANTHROPIC_DEFAULT_FABLE_MODEL 为原生第四档(agent .md 可写
// model: fable,与 opus 是独立槽位,借 opus 档注入语义是错的)。
// tierModels = { haiku?, sonnet?, opus?, fable? }(每值须 ∈ provider models[],写入时已校验)。
// 缺档回退到 chosen → 维持现 BA1 行为(全档=选中模型),向后兼容。
function resolveTierModels(tierModels, chosen) {
  const tm = (tierModels && typeof tierModels === 'object') ? tierModels : {};
  return {
    haiku:  tm.haiku  || chosen,
    sonnet: tm.sonnet || chosen,
    opus:   tm.opus   || chosen,
    fable:  tm.fable  || chosen,
  };
}

// 常驻 daemon 端口。本机装了 launchd 常驻代理(com.wsxwj.anthropic-proxy)时,它跑
// 的是本仓库同一份 anthropic-proxy / openai-proxy 代码,并自己 watch settings.json 与
// ~/.claude-gui/ 解析上游。把它的端口写进 settings.json 的好处:GUI 关掉之后,共用同一份
// settings.json 的 bot(telegram/微信)仍能转发,不再 ECONNREFUSED。
// 探测不通就回落 GUI 进程内端口 —— 公开版(没这个 daemon)、daemon 未装、daemon 挂掉
// 三种场景统一走这条回落路径,行为与探测前完全一致。
const DAEMON_ANTHROPIC_PORT = 8799;
const DAEMON_OPENAI_PORT = 8798;

// 纯 TCP 连通性探测:能建连即 true,超时/拒绝/异常一律 false,绝不抛。
// 不发送也不读取任何数据(自然不碰 token/key)。
// ponytail: 只判端口在听,不校验对端身份;回环 + 固定端口下够用,要更严就得给代理加健康端点。
export function probeTcpPort(port, { host = '127.0.0.1', timeout = 200 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const sock = createConnection({ host, port, timeout });
      sock.on('connect', () => { sock.destroy(); done(true); });
      sock.on('error', () => { sock.destroy(); done(false); });
      sock.on('timeout', () => { sock.destroy(); done(false); });
    } catch { done(false); }
  });
}

// 写进 settings.json 的代理端口:常驻 daemon 在听就用它,否则用 GUI 进程内代理端口。
export async function pickProxyPort(daemonPort, inProcessPort) {
  return (await probeTcpPort(daemonPort)) ? daemonPort : inProcessPort;
}

// Switch to an OpenAI-compatible provider. Unlike claude providers (whose
// settings_config IS a settings.json), these need the embedded proxy: we point
// the CLI's ANTHROPIC_BASE_URL at the loopback proxy and feed it the real
// upstream. We PRESERVE the current settings.json (hooks/plugins/permissions —
// notably the PreToolUse permission bridge) and only override the env keys.
// Normalized OpenAI-upstream switch — used by both cc-switch openai providers
// and GUI custom providers (type=openai). `up` = { id, name, baseURL, apiKey, models }.
async function switchToOpenAIUpstream(up, requestedModel, res) {
  // SSRF 守卫(与 fetch-models/test 同口径,环回放行):切换后代理会带 apiKey 直连
  // 该 baseURL,创建/编辑之外的切换路径(cc-switch 导入数据)也要挡内网。
  try { await assertPublicBaseURL(up.baseURL); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const models = up.models || [];
  const model = (requestedModel && models.includes(requestedModel))
    ? requestedModel
    : (models[0] || requestedModel);
  if (!model) return res.status(400).json({ error: 'provider 未配置任何模型,需手动指定 model' });

  // Start the proxy (idempotent, fixed port) and point it at this upstream.
  let port = getProxyPort();
  if (!port) port = await startOpenAIProxy();
  setOpenAIUpstream({ baseURL: up.baseURL, apiKey: up.apiKey, model });

  // Start from the live settings.json so hooks/permissions survive the switch.
  const current = await readCurrentSettings();
  const env = { ...(current.env || {}) };
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${await pickProxyPort(DAEMON_OPENAI_PORT, port)}`;
  // The CLI must send *some* token; the proxy ignores it and injects the real
  // upstream key itself, so we never expose the real key to the CLI env file
  // beyond what cc-switch already stores.
  env.ANTHROPIC_AUTH_TOKEN = 'sk-openai-proxy';
  env.ANTHROPIC_MODEL = model;
  // Route subagent aliases (haiku/sonnet/opus/fable) to the provider's tier models so
  // Task subagents work under the OpenAI backend too. BB6: per-tier mapping when
  // configured, else all four = model (current BA1 behavior).
  {
    const t = resolveTierModels(up.tierModels, model);
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = t.haiku;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = t.sonnet;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = t.opus;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = t.fable;
  }
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME;
  delete env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;
  delete env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME;
  // A(#50085/#68900): third-party gateways keyed on the full request body get 0%
  // cache hits because CC prepends a per-request `cch=` nonce to the system prompt.
  // api.anthropic.com strips it; relays don't → set =0 to omit it. OpenAI proxy is
  // always a third-party path, so always set it here.
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';

  const next = { ...current, env };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await backupSettings(ts);
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  await ensureOnboardingFlag(); // 第三方无需登录:跳过终端首次向导(新机地区屏蔽根治)
  // Remember the active provider id (not the key) for restart recovery. Also
  // persist the provider's FULL model list + name so model-resolver can offer
  // every model in the ModelSelector (not just the one we switched to) — the CLI
  // sends whichever model the user picks and the proxy forwards it upstream.
  try {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    // defaultModel(若有)写入 marker,供 model-resolver 在 model-less relay 兜底时
    // 用它而非 models[0]。
    const marker = { providerId: up.id, name: up.name, model, models };
    if (up.defaultModel && models.includes(up.defaultModel)) marker.defaultModel = up.defaultModel;
    await writeFile(OPENAI_ACTIVE_PATH, JSON.stringify(marker));
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
  // SSRF 守卫(同 switchToOpenAIUpstream):passthrough 代理带 authToken 直连该 baseURL。
  try { await assertPublicBaseURL(up.baseURL); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
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
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${await pickProxyPort(DAEMON_ANTHROPIC_PORT, port)}`;
  // 全新机器(从未 /login、无 OAuth、无旧 token)修复:CLI 手里必须有【某个】凭证才会发请求,
  // 否则直接报 "Invalid API key · Please run /login"(用户新机实报)。代理无条件用上游真实
  // 密钥覆盖鉴权头,CLI 侧值无所谓 → 缺失时写占位 token(与 switchToOpenAIUpstream 758 行
  // 的 'sk-openai-proxy' 同构);已有真 token(cc-switch snapshot 带的)保持不动。
  if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_AUTH_TOKEN = 'sk-cgui-anthropic-proxy';
  // Pick the active model: explicit request (if valid) > the snapshot's existing
  // ANTHROPIC_MODEL (if it belongs to THIS provider) > the provider's first model.
  // Without this, clicking a custom provider row (no model arg) would inherit the
  // PREVIOUS provider's stale ANTHROPIC_MODEL.
  const models = up.models || [];
  const chosen = (requestedModel && (!models.length || models.includes(requestedModel)))
    ? requestedModel
    : (models.includes(env.ANTHROPIC_MODEL) ? env.ANTHROPIC_MODEL : (models[0] || env.ANTHROPIC_MODEL));
  if (chosen) env.ANTHROPIC_MODEL = chosen; else delete env.ANTHROPIC_MODEL;
  // BA1:子代理/标题/compact 等内部调用走 tier alias(haiku/sonnet/opus/fable),claude CLI
  // 会把 alias 本地展开成【官方 id】(如 claude-sonnet-4-6)再发给上游;第三方 anthropic
  // 中转没有该 id → 报 "<model> is not a model ... may not exist or no access",还连带
  // 让 bot 的 --resume 失败丢上下文。把四个 DEFAULT_*_MODEL 指向真实选中模型,alias 即
  // 重定向到第三方真实模型(与 switchToOpenAIUpstream 同构)。chosen 缺失时清掉,避免
  // 沿用上一个 provider 的陈旧值。仅 anthropic 第三方路径受影响,官方/openai 不动。
  if (chosen) {
    // BB6: per-tier mapping when configured, else all tiers = chosen (BA1 behavior).
    const t = resolveTierModels(up.tierModels, chosen);
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = t.haiku;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = t.sonnet;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = t.opus;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = t.fable;
  } else {
    delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete env.ANTHROPIC_DEFAULT_FABLE_MODEL;
  }
  // A(#50085/#68900): this path is always a third-party anthropic relay (routed
  // through the loopback passthrough proxy), never api.anthropic.com — so strip the
  // per-request `cch=` nonce that otherwise breaks gateway prompt caching.
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
  const next = { ...current, env };
  if (snapshot.model) next.model = snapshot.model;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await backupSettings(ts);
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  await ensureOnboardingFlag(); // 第三方无需登录:跳过终端首次向导(新机地区屏蔽根治)
  // Persist the active marker (id/name/baseURL/model/models — NEVER the token).
  try {
    await mkdir(join(homedir(), '.claude-gui'), { recursive: true });
    const marker = {
      providerId: up.id, name: up.name, baseURL: up.baseURL,
      model: env.ANTHROPIC_MODEL || null, models: up.models || [],
    };
    if (up.defaultModel && (up.models || []).includes(up.defaultModel)) marker.defaultModel = up.defaultModel;
    await writeFile(ANTHROPIC_ACTIVE_PATH, JSON.stringify(marker));
  } catch {}
  await unlink(OPENAI_ACTIVE_PATH).catch(() => {}); // off the openai proxy
  await writeActiveProviderId(up.id);
  res.json({ ok: true, name: up.name, model: env.ANTHROPIC_MODEL || null, via: 'anthropic-proxy' });
}

// Switch to a GUI custom provider. openai → proxy (reuse upstream switch);
// anthropic → point the CLI straight at the upstream, no proxy.
async function switchToCustomProvider(p, requestedModel, res) {
  // B 方案: provider-overrides.json 优先于 custom-providers.json 自带的 defaultModel/
  // tierModels(统一规则:override ≥ provider 自带)。无 override 条目 = 用 p 原值,行为不变。
  const ov = (await readProviderOverrides())[p.id];
  if (ov && typeof ov === 'object') {
    const models = p.models || [];
    if (typeof ov.defaultModel === 'string' && models.includes(ov.defaultModel)) p = { ...p, defaultModel: ov.defaultModel };
    const tm = sanitizeTierModels(ov.tierModels, models);
    if (tm) p = { ...p, tierModels: tm };
  }
  // AZ8: GUI 主动切 provider 且未显式带 model 时,优先用该 provider 的 defaultModel
  // (仍须在 models[] 内才生效),否则下游回退 models[0]。defaultModel 一并透传给
  // marker 文件,供 model-resolver 兜底用 oa.defaultModel || oa.models[0]。
  const defModel = (typeof p.defaultModel === 'string' && (p.models || []).includes(p.defaultModel))
    ? p.defaultModel : '';
  const effModel = requestedModel || defModel || undefined;
  if (p.type === 'openai') {
    return switchToOpenAIUpstream(
      { id: p.id, name: p.name, baseURL: p.baseURL, apiKey: p.apiKey, models: p.models || [], defaultModel: defModel, tierModels: p.tierModels },
      effModel, res,
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
    delete snapEnv.ANTHROPIC_DEFAULT_FABLE_MODEL;
    return switchToAnthropicUpstream(
      { id: p.id, name: p.name, baseURL: p.baseURL, authToken: p.apiKey, snapshot: { ...cur, env: snapEnv }, models, defaultModel: defModel, tierModels: p.tierModels },
      effModel, res,
    );
  }
  // official-anthropic custom upstream (rare) — direct, uses the CLI OAuth.
  // SSRF 守卫(同口径):该分支把 baseURL 直写 settings.env 由 CLI 直连,不过代理。
  try { await assertPublicBaseURL(p.baseURL); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const model = (effModel && models.includes(effModel))
    ? effModel : (defModel || models[0] || effModel || '');
  const current = await readCurrentSettings();
  const env = { ...(current.env || {}) };
  env.ANTHROPIC_BASE_URL = p.baseURL;
  env.ANTHROPIC_AUTH_TOKEN = p.apiKey;
  if (model) env.ANTHROPIC_MODEL = model; else delete env.ANTHROPIC_MODEL;
  // Drop proxy-era subagent overrides so aliases resolve against THIS upstream.
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete env.ANTHROPIC_DEFAULT_FABLE_MODEL;
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME;
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;
  delete env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME;
  delete env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME;
  // Official-anthropic direct (uses CLI OAuth) → the API strips the nonce itself,
  // so drop any stale attribution-header override left by a prior third-party switch.
  delete env.CLAUDE_CODE_ATTRIBUTION_HEADER;
  const next = { ...current, env };
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await backupSettings(ts);
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
    let skippedInvalid = 0; // baseURL 不过 SSRF 校验被跳过的条数,随响应带回
    // claude-format providers(第三方 anthropic 兼容):env.ANTHROPIC_BASE_URL/TOKEN + _MODEL 列表
    for (const r of claudeRows) {
      if (seen.has(r.id)) continue;
      if (r.category === 'official') continue; // OAuth 订阅不需要 key,不导入
      let snap; try { snap = JSON.parse(r.settings_config); } catch { continue; }
      const env = snap?.env || {};
      const baseURL = env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_URL;
      const apiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
      if (!baseURL || !apiKey) continue;
      // 导入的 baseURL 与手写 POST 同口径过 SSRF 校验:不过就跳过,不与 apiKey 一起落盘。
      try { await assertPublicBaseURL(String(baseURL)); } catch { skippedInvalid++; continue; }
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
      try { await assertPublicBaseURL(String(p.baseURL)); } catch { skippedInvalid++; continue; }
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
    res.json({ ok: true, added, skippedInvalid, total: list.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/custom-providers — list custom providers (never returns apiKey).
router.get('/custom-providers', async (_req, res) => {
  const list = await readCustomProviders();
  res.json({
    providers: list.map((p) => ({
      id: p.id, name: p.name, type: p.type, baseURL: p.baseURL,
      models: p.models || [], defaultModel: p.defaultModel || '',
      tierModels: p.tierModels || null, hasKey: !!p.apiKey,
      contextWindow: p.contextWindow || null, modelPrices: p.modelPrices || null,
    })),
  });
});

// POST /api/custom-providers { name, type, baseURL, apiKey, models } — add one.
router.post('/custom-providers', async (req, res) => {
  try {
    const { name, type, baseURL, apiKey, models, defaultModel } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name 必填' });
    if (type !== 'openai' && type !== 'anthropic') return res.status(400).json({ error: 'type 必须是 openai 或 anthropic' });
    let url; try { url = new URL(baseURL); } catch { return res.status(400).json({ error: 'baseURL 非法' }); }
    if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: 'baseURL 必须是 http(s)' });
    // SSRF 守卫与 fetch-models/test 同口径(本机环回中转放行):创建时挡下内网地址,
    // 否则切换后 server 会带 apiKey 直连它。
    try { await assertPublicBaseURL(baseURL); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const cleanModels = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()) : [];
    const entry = {
      id: randomUUID(),
      name: name.trim(),
      type,
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
      models: cleanModels,
    };
    // AZ8: 可选的 per-provider 默认模型。只接受属于该 provider models[] 的 id;非法/不在
    // 列表内则不写(向后兼容:无此字段时切换/解析回退 models[0])。
    if (typeof defaultModel === 'string' && cleanModels.includes(defaultModel.trim())) {
      entry.defaultModel = defaultModel.trim();
    }
    // BB6: 可选 tierModels。每档只接受属于 models[] 的 id;非法/缺省不写(回退 chosen)。
    {
      const tm = sanitizeTierModels(req.body?.tierModels, cleanModels);
      if (tm) entry.tierModels = tm;
    }
    // 上下文窗口(token,可选):自动压缩窗口联动用(chat.js resolveAutoCompactWindow)。
    {
      const cwNum = Number(req.body?.contextWindow);
      if (Number.isFinite(cwNum) && cwNum >= 1000 && cwNum <= 10_000_000) entry.contextWindow = Math.floor(cwNum);
    }
    // R3: 每模型单价(可选,CNY/百万 token)。非法条目逐条丢弃,一条不剩则不写此键。
    {
      const mp = sanitizeModelPrices(req.body?.modelPrices);
      if (mp) entry.modelPrices = mp;
    }
    const list = await readCustomProviders();
    // 幂等查重(用户新机实报:添加成功但后续 switch 失败被误报"保存失败"→重试 N 次
    // = N 条重复条目)。同 type+name+baseURL 视为同一 provider,返回已存在的 id 而非
    // 再 push;想建同名同址不同 key 的场景走"编辑"更新 key 即可。
    const dup = list.find((p) => p.type === entry.type && p.name === entry.name && p.baseURL === entry.baseURL);
    if (dup) return res.json({ ok: true, id: dup.id, existed: true });
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
    const { name, type, baseURL, apiKey, models, defaultModel, tierModels, contextWindow, modelPrices } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name 必填' });
    if (type !== 'openai' && type !== 'anthropic') return res.status(400).json({ error: 'type 必须是 openai 或 anthropic' });
    let url; try { url = new URL(baseURL); } catch { return res.status(400).json({ error: 'baseURL 非法' }); }
    if (!/^https?:$/.test(url.protocol)) return res.status(400).json({ error: 'baseURL 必须是 http(s)' });
    // SSRF 守卫(同创建路径):编辑可把 baseURL 改指向内网,而存储 apiKey 保留 → 必须挡。
    try { await assertPublicBaseURL(baseURL); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const prev = list[idx];
    // 上下文窗口(token,可选):自动压缩窗口联动用。传 null/'' 清除;传合法数字更新;不传保留。
    const cwNum = Number(contextWindow);
    if (contextWindow === null || contextWindow === '') delete prev.contextWindow;
    else if (Number.isFinite(cwNum) && cwNum >= 1000 && cwNum <= 10_000_000) prev.contextWindow = Math.floor(cwNum);
    // R3: 每模型单价。显式传入则整体覆盖(传 null/空对象/全非法 = 清空);不传则保留旧值。
    // 整体覆盖是对的:表单每次提交都带全量 modelPrices,删掉的行必须真的消失。
    if (modelPrices !== undefined) {
      const mp = sanitizeModelPrices(modelPrices);
      if (mp) prev.modelPrices = mp; else delete prev.modelPrices;
    }
    const nextModels = Array.isArray(models)
      ? models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim())
      : (prev.models || []);
    list[idx] = {
      ...prev,
      id: prev.id, // never change the id
      name: name.trim(),
      type,
      baseURL: baseURL.trim().replace(/\/+$/, ''),
      apiKey: (typeof apiKey === 'string' && apiKey.trim()) ? apiKey.trim() : prev.apiKey,
      models: nextModels,
    };
    // AZ8: 默认模型。显式传入(且在 models[] 内)则更新;传 null/'' 则清除;不传则保留旧值。
    // 同时校验:旧 defaultModel 若已不在新 models[] 内,自动清除(避免指向被删模型)。
    if (defaultModel === null || defaultModel === '') {
      delete list[idx].defaultModel;
    } else if (typeof defaultModel === 'string' && nextModels.includes(defaultModel.trim())) {
      list[idx].defaultModel = defaultModel.trim();
    } else if (list[idx].defaultModel && !nextModels.includes(list[idx].defaultModel)) {
      delete list[idx].defaultModel;
    }
    // BB6: tierModels。显式传入则按 nextModels 校验覆盖(传 null/空对象 = 清除);不传则保留
    // 旧值,但清理其中已不在 nextModels 的档(避免切换写出指向被删模型的 id → 子代理 404)。
    if (tierModels !== undefined) {
      const tm = sanitizeTierModels(tierModels, nextModels);
      if (tm) list[idx].tierModels = tm; else delete list[idx].tierModels;
    } else if (list[idx].tierModels) {
      for (const tier of Object.keys(list[idx].tierModels)) {
        if (!nextModels.includes(list[idx].tierModels[tier])) delete list[idx].tierModels[tier];
      }
      if (!Object.keys(list[idx].tierModels).length) delete list[idx].tierModels;
    }
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
      prev.id, list[idx].models, list[idx].defaultModel,
    );
    // 快照只管 UI 显示;CLI 认的是 settings.json 的 env,得重跑 switch 才写。
    // 少了这一步,用户在编辑表单里改默认模型/档位映射保存后毫无反应(#13)。
    const reapplied = await reapplyIfActive(prev.id);
    res.json({ ok: true, id: prev.id, reapplied });
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

// B 方案: 按 provider id 解析其 models[](与 GET /providers 同口径),供
// PUT /provider-overrides/:id 校验 defaultModel/tierModels。覆盖三组:
// cc-switch claude(snapshot.env 的 _MODEL)/ openai(multi-select 优先,否则 parsed)
// / custom(custom-providers.json)。找不到返回 null。
async function resolveProviderModelsById(id) {
  const imported = await isCCSwitchImported();
  if (!imported) {
    const claudeRows = await ccSwitchQuery(
      "SELECT id, category, settings_config FROM providers WHERE app_type='claude'"
    );
    const c = claudeRows.find((r) => r.id === id);
    if (c) {
      if (c.category === 'official') return [];
      try {
        const env = JSON.parse(c.settings_config)?.env || {};
        return [...new Set(Object.entries(env)
          .filter(([k, v]) => /_MODEL$/.test(k) && typeof v === 'string' && v)
          .map(([, v]) => v))];
      } catch { return []; }
    }
    const oaRows = await ccSwitchQuery(
      "SELECT id, settings_config FROM providers WHERE app_type IN ('codex','opencode')"
    );
    const o = oaRows.find((r) => r.id === id);
    if (o) {
      const sel = await readProviderModels();
      if (sel[id]?.length) return sel[id];
      const p = parseOpenAIProvider(o.settings_config);
      return p ? p.models : [];
    }
  }
  const custom = (await readCustomProviders()).find((p) => p.id === id);
  if (custom) {
    const sel = await readProviderModels();
    if (custom.type === 'openai' && sel[id]?.length) return sel[id];
    return custom.models || [];
  }
  return null;
}

// provider 配置改完后,若它正是【当前激活】的那个,透明重跑一次 switch。
// 存在的理由:CLI 只认 settings.json 的 env(ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL),
// 而这些 env 只在 switch 里生成 —— 光把新配置写进 custom-providers.json /
// provider-overrides.json 对 CLI 是不可见的,用户得手动再切一次 provider 才生效。
// 返回是否真的重写了 settings.json,前端据此提示"已生效"还是"切回该 provider 后生效"。
// 副作用(有意为之):settings.json mtime 变 → chat.js 的 chatCompatKey 变 → 下一条消息
// 不复用常驻 CLI 进程(冷启一次)。新模型必须生效,这个代价是必要的。
// 不传 model:让 switch 按 provider 自己的 defaultModel 重算(它已校验在 models[] 内,
// 拿不到就回落 models[0]),绝不会写出列表外的模型。
// 无递归风险:switch 从不写 custom-providers.json(全部 5 个写入点都是路由处理器)。
async function reapplyIfActive(id) {
  try {
    if ((await readActiveProviderId()) !== id) return false;
    const layer = router.stack.find((l) => l.route && l.route.path === '/provider/switch');
    if (!layer) return false;
    // _status 初始 0(不是 200):handler 异步抛错、根本没碰过 res 时,下面的 catch 吞掉异常,
    // 初值 200 会把"什么都没发生"报成 reapplied:true —— 前端据此显示"已生效",而 settings.json
    // 里还是旧映射。json() 补默认 200 是照 express 语义(成功路径只调 res.json,不调 res.status)。
    const fakeRes = {
      _status: 0, _body: null,
      status(s) { this._status = s; return this; },
      json(b) { if (!this._status) this._status = 200; this._body = b; return this; },
    };
    const fakeReq = { body: { id }, headers: { 'Content-Type': 'application/json' } };
    // 复用 /provider/switch 的实现:它已正确处理 anthropic / openai / custom 三类。
    await Promise.resolve(layer.route.stack[0].handle(fakeReq, fakeRes, () => {})).catch(() => {});
    return fakeRes._status >= 200 && fakeRes._status < 300;
  } catch { return false; }
}

// GET /api/provider-overrides — 回显全部 override(无文件 = {})。
router.get('/provider-overrides', async (_req, res) => {
  res.json(await readProviderOverrides());
});

// PUT /api/provider-overrides/:id { defaultModel?, tierModels? } — 写该 provider 的
// override。defaultModel/tierModels 均按其 models[] 校验;两者皆空 = 删除该条目。
// 从不写 cc-switch.db。
router.put('/provider-overrides/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const models = await resolveProviderModelsById(id);
    if (models == null) return res.status(404).json({ error: 'provider 不存在' });
    const { defaultModel, tierModels } = req.body || {};
    const entry = {};
    if (typeof defaultModel === 'string' && models.includes(defaultModel)) {
      entry.defaultModel = defaultModel;
    }
    const tm = sanitizeTierModels(tierModels, models);
    if (tm) entry.tierModels = tm;

    const map = await readProviderOverrides();
    if (Object.keys(entry).length) map[id] = entry;
    else delete map[id]; // 空 = 清除,恢复无 override 的原始行为
    await writeProviderOverrides(map);
    // BG9:overrides 写入 .claude-gui/provider-overrides.json,但 CLI 只读 settings.json
    // 的 env(ANTHROPIC_DEFAULT_*_MODEL)。所以**用户在 GUI 改完档位映射,仍要去重新点
    // 一次 provider 切换才生效**——很反直觉(用户问"是不是要重启 GUI")。这里若该 provider
    // 正是当前激活的,自动透明重跑一次 switch 把新的 tierModels 注入 settings.json,
    // 让映射立刻生效。若不是激活的就只持久化,等下次切到它再生效。reapplied 字段告诉
    // 前端是否已重写 settings,以提示"立刻生效"或"切回该 provider 后生效"。
    // 清空 override 同样要 reapply:否则旧档位映射还留在 settings.json 里(原来带
    // `Object.keys(entry).length` 条件,清空时静默不生效)。
    const reapplied = await reapplyIfActive(id);
    res.json({ ok: true, id, override: map[id] || null, reapplied });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Live-fetch a provider's model catalogue via GET {baseURL}/v1/models. Tries the
// Anthropic header style first (x-api-key) then OpenAI (Bearer) — some relays
// accept only one. Returns deduped model ids. Single-user local tool, so an
// arbitrary baseURL is the user's own choice (no SSRF guard).
// 对单个 models URL 发请求,轮询两组 header(anthropic x-api-key / openai Bearer)。
// 返回 { ids } (200,可能空数组) 或 { status, body }(非 200);超时抛错。
async function tryFetchModels(url, apiKey) {
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
      // 顺带抓每个模型的上下文窗口(kimi coding 端点/OpenRouter 等返回 context_length;
      // DeepSeek/通义/智谱等不返回=空,由 chat.js 的模型名规则表兜底)。自动压缩联动用。
      const ids = []; const windows = {};
      for (const m of arr) {
        const id = typeof m === 'string' ? m : m?.id;
        if (!id || ids.includes(id)) continue;
        ids.push(id);
        const w = Number(m?.context_length ?? m?.context_window ?? m?.max_context_tokens ?? m?.max_input_tokens);
        if (Number.isFinite(w) && w >= 1000) windows[id] = Math.floor(w);
      }
      return { ids, windows: Object.keys(windows).length ? windows : null };
    }
    lastStatus = r.status;
    lastBody = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return { status: lastStatus, body: lastBody };
}

// SSRF 守卫:provider baseURL 用户可填任意 URL,server 会带【存储的 apiKey】主动
// fetch 并把上游响应反射回来 → 攻击者把 baseURL 指向内网/云元数据(169.254.169.254)
// 探测,或指向自己的服务器把用户 provider 密钥骗出。解析主机名后拒绝环回/私网/链路本地。
// export:mcp.js 的 ping 对 MCP server URL 也用同一口径。
export async function assertPublicBaseURL(baseURL) {
  let host;
  try { host = new URL(baseURL).hostname.replace(/^\[|\]$/g, ''); }
  catch { const e = new Error('baseURL 非法'); e.status = 400; throw e; }
  const { lookup } = await import('dns/promises');
  let addrs;
  try { addrs = await lookup(host, { all: true }); }
  catch { const e = new Error('无法解析 baseURL 主机名'); e.status = 400; throw e; }
  // 环回放行:本机中转(one-api / new-api / claude 自带的回环代理)是合法场景,
  // server 打环回只到达用户自己机器,不构成内网探测面;且编辑态强制 baseURL 与存储
  // key 同源,环回也骗不出已存密钥。私网/链路本地(真 SSRF 目标)仍拒绝。
  const isLoopback = (ip) => /^127\./.test(ip) || ip === '::1' || /^::ffff:127\./i.test(ip);
  if (addrs.length && addrs.every((a) => isLoopback(a.address))) return;
  const isPrivate = (ip) => {
    if (/^127\.|^0\.|^10\.|^169\.254\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd')) return true;
    if (l.startsWith('::ffff:')) return isPrivate(l.slice(7)); // IPv4-mapped
    return false;
  };
  if (addrs.some((a) => isPrivate(a.address))) {
    const e = new Error('baseURL 指向内网/环回地址,已拒绝(SSRF 防护)'); e.status = 400; throw e;
  }
}

async function probeUpstreamModels(baseURL, apiKey) {
  // SSRF 守卫放在这里 = 所有调用点(fetch-models 请求值 / provider/fetch-models 存储
  // baseURL / active provider settings.json baseURL)一次全覆盖,不漏 sibling caller。
  await assertPublicBaseURL(baseURL);
  const b = baseURL.trim().replace(/\/+$/, '');
  // 候选 URL,按命中率排序。多数 provider 走第一个就够;anthropic 中转(只 forward
  // /v1/messages、不实现 /v1/models)回退到「同源 OpenAI 端点」拉(BR-3 调研:DeepSeek
  // 的 https://api.deepseek.com/v1/models 是标准的;anthropic 端点 .../anthropic 没有
  // models 接口)。OpenRouter 的 models 在 /api/v1/models(免 key)。
  const candidates = [];
  candidates.push(/\/v\d+$/.test(b) ? `${b}/models` : `${b}/v1/models`);
  const anthropicRelay = b.match(/^(https?:\/\/.+?)\/anthropic$/);
  if (anthropicRelay) candidates.push(`${anthropicRelay[1]}/v1/models`);
  try {
    if (/(^|\.)openrouter\.ai$/i.test(new URL(b).host)) candidates.push('https://openrouter.ai/api/v1/models');
  } catch {}

  let lastStatus = 0, lastBody = '', lastUrl = '';
  for (const url of [...new Set(candidates)]) {
    const res = await tryFetchModels(url, apiKey); // 超时直接向上抛
    if (res.ids) return res;                       // {ids, windows} 200(空数组也算成功,由前端提示手填)
    lastStatus = res.status; lastBody = res.body; lastUrl = url;
  }
  // 区分鉴权失败 vs 没有 models 接口,后者明确引导手填(anthropic 中转常见)。
  if (lastStatus === 401 || lastStatus === 403) {
    throw new Error(`上游 ${lastUrl} 返回 ${lastStatus}(鉴权失败):请检查 API Key${lastBody ? `。${lastBody}` : ''}`);
  }
  throw new Error(
    `该 provider 未提供模型列表接口(${lastUrl} 返回 ${lastStatus || '错误'})。`
    + `很多 Anthropic 协议中转只支持 /v1/messages、没有模型列表,这是正常的 —— 请在「模型」框手动填模型名`
    + `(如 opus/sonnet/haiku、deepseek-v4-pro、glm-5.2 等)再保存。${lastBody ? `\n上游:${lastBody}` : ''}`,
  );
}

// Read the local Claude Code subscription OAuth token. macOS stores it in the
// login keychain; some setups use ~/.claude/.credentials.json. Returns the
// accessToken or '' (non-macOS, logged out, or unreadable) so callers can fall
// back to the tier aliases.
export async function readClaudeOAuthToken() {
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

// POST /api/custom-providers/fetch-models { type, baseURL, apiKey, id? } — used by the
// add-provider form (client supplies the key being entered).
// 带 id(编辑态)时 apiKey 空则读存储 key 兜底 —— 编辑表单的 key 框留空=「不修改」(GET 从不回传
// 明文 key),此前这里没有 test 端点那样的兜底 → 空 key 直发上游 → 401"API key 有问题",而测试
// 连接(有兜底)却正常(用户实报的矛盾现象根因)。baseURL 同步兜底。
router.post('/custom-providers/fetch-models', async (req, res) => {
  try {
    let { baseURL, apiKey } = req.body || {};
    if (req.body?.id) {
      const stored = (await readCustomProviders()).find((p) => p.id === req.body.id);
      if (stored) {
        if (!apiKey || !String(apiKey).trim()) apiKey = stored.apiKey;
        // 用存储 key 时 baseURL 也强制取存储值:否则攻击者传 {id, baseURL:自己的服务器}
        // 让 server 把该 provider 的真实密钥发去攻击者端点。key 与 baseURL 必须同源。
        baseURL = stored.baseURL;
      }
    }
    let base; try { base = new URL(baseURL); } catch { return res.status(400).json({ error: 'baseURL 非法' }); }
    if (!/^https?:$/.test(base.protocol)) return res.status(400).json({ error: 'baseURL 必须是 http(s)' });
    // SSRF 守卫已在 probeUpstreamModels 内(覆盖全部调用点),此处不再重复。
    const probed = await probeUpstreamModels(baseURL, apiKey);
    // 实抓到窗口且是已存 provider → 持久化 modelWindows(自动压缩联动的最权威数据源)。
    if (req.body?.id && probed.windows) persistModelWindows(req.body.id, probed.windows);
    res.json({ models: probed.ids, windows: probed.windows || undefined });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// 给指定 model 发一个最小请求,验证 provider「鉴权 + 该模型可达」。openai 兼容打
// /chat/completions、anthropic 兼容打 /v1/messages,max_tokens:1 把成本/耗时压到最低。
async function testProviderConnection({ type, baseURL, apiKey, model }) {
  // SSRF 守卫根因覆盖:test 端点不经 probeUpstreamModels,单独在此兜一次。
  await assertPublicBaseURL(baseURL);
  const b = String(baseURL).trim().replace(/\/+$/, '');
  const hasVer = /\/v\d+$/.test(b);
  let url, headers, body;
  if (type === 'anthropic') {
    url = hasVer ? `${b}/messages` : `${b}/v1/messages`;
    headers = { 'content-type': 'application/json', 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01', 'User-Agent': 'claude-gui' };
    body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
  } else {
    url = hasVer ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
    headers = { 'content-type': 'application/json', Authorization: `Bearer ${apiKey || ''}`, 'User-Agent': 'claude-gui' };
    body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) return { ok: true, status: r.status };
    const text = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    return { ok: false, status: r.status, error: text || `HTTP ${r.status}` };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === 'AbortError' ? '请求超时(20s,可能是网络/代理或端点不可达)' : e.message };
  }
}

// POST /api/custom-providers/test { type, baseURL, apiKey, model, id? }
// 编辑态前端不持有 key(apiKey 留空)→ 带 id 时按 id 读存储 key/baseURL 兜底。
router.post('/custom-providers/test', async (req, res) => {
  try {
    const b = req.body || {};
    let baseURL = b.baseURL, apiKey = b.apiKey, type = b.type;
    if (b.id) {
      // 编辑态:缺哪项就用存储值兜底(各维度独立 —— 之前只在 apiKey 空时才读 type/baseURL,
      // 若前端只回传了 apiKey 会让 type/baseURL undefined → URL 拼错/走错协议)。
      const stored = (await readCustomProviders()).find((p) => p.id === b.id);
      if (stored) {
        const usedStoredKey = !apiKey || !apiKey.trim();
        if (usedStoredKey) apiKey = stored.apiKey;
        // 用存储 key 时 baseURL 强制取存储值(防把密钥外传到攻击者 baseURL,同 fetch-models)。
        baseURL = usedStoredKey ? stored.baseURL : (baseURL || stored.baseURL);
        type = type || stored.type;
      }
    }
    if (!baseURL) return res.status(400).json({ ok: false, error: '缺少 Base URL' });
    if (!b.model) return res.status(400).json({ ok: false, error: '请先在「模型」框填一个模型 ID 再测试' });
    try { const u = new URL(baseURL); if (!/^https?:$/.test(u.protocol)) throw 0; }
    catch { return res.status(400).json({ ok: false, error: 'Base URL 必须是 http(s)' }); }
    // SSRF 守卫在 testProviderConnection 内(根因覆盖),此处不再重复。
    res.json(await testProviderConnection({ type, baseURL, apiKey, model: b.model }));
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
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
      const probed = await probeUpstreamModels(up.baseURL, up.apiKey);
      if (probed.windows) persistModelWindows(id, probed.windows);
      return res.json({ models: probed.ids, windows: probed.windows || undefined });
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
    const probed = await probeUpstreamModels(base, token);
    // 当前激活 provider(env base 直连)也持久化窗口:id 从 active-provider.json 反查。
    if (probed.windows) {
      try {
        const activeId = JSON.parse(await readFile(join(homedir(), '.claude-gui', 'active-provider.json'), 'utf-8'))?.id;
        if (activeId) persistModelWindows(activeId, probed.windows);
      } catch {}
    }
    res.json({ models: probed.ids, windows: probed.windows || undefined });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// 把实抓的 per-模型窗口 merge 进 provider 条目(best-effort,失败不影响模型列表返回)。
async function persistModelWindows(providerId, windows) {
  try {
    const list = await readCustomProviders();
    const idx = list.findIndex((p) => p.id === providerId);
    if (idx === -1) return;
    list[idx].modelWindows = { ...(list[idx].modelWindows || {}), ...windows };
    await writeCustomProviders(list);
  } catch { /* 窗口持久化失败不阻塞主流程 */ }
}

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
async function syncActiveProviderSnapshot(activePath, providerId, models, defaultModel) {
  try {
    const active = JSON.parse(await readFile(activePath, 'utf-8'));
    if (active?.providerId !== providerId) return;
    active.models = Array.isArray(models) ? models : [];
    // AZ8: 同步 marker 的 defaultModel(仅当仍在 models[] 内);否则清除,避免兜底解析
    // 指向被删除的模型。
    if (defaultModel && active.models.includes(defaultModel)) active.defaultModel = defaultModel;
    else delete active.defaultModel;
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
              cur.env.ANTHROPIC_DEFAULT_FABLE_MODEL = active.model;
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
  setOpenAIUpstream({ baseURL: upstream.baseURL, apiKey: upstream.apiKey, model: active.model });
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
