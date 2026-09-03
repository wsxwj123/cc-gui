#!/usr/bin/env node
// r100:升级后未重新切换 provider 的用户拿不到 r89 缓存修复 —— 启动时自动重应用。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/BRIEF-r100-cache-env-reapply.md 与主会话
// 定下的契约写,**不看 server/routes/settings.js 的实现**。四段:
//   A. 函数契约(reapplyPromptCacheForActiveProvider):真 import 真跑,临时 HOME 里
//      对真实的 ~/.claude/settings.json 做读写,断言文件的真实变化(含"不该变的没变")。
//   B. boot 源码锁(server/index.js):位置 + 失败不阻断。
//   C. GET /api/prompt-cache 响应字段锁:express + listen(0),不起常驻服务。
//   D. 面板文案锁(SettingsPanel.jsx 进不了 node,只能读文件做结构断言)。
//
// 设计要点:
//   ① HOME 隔离必须先于第一次 import —— settings.js 的路径常量在模块加载期绑定
//      (join(homedir(),...)),import 之后再改 $HOME 就来不及了,会打到真实 ~/.claude。
//   ② 函数用【动态 import + 每条各自 needFn()】。静态 import 一个还不存在的导出会在
//      ESM 链接阶段整文件炸掉,一条断言都跑不到;改前必须"每条各自红"。
//   ③ 所有场景共用同一个临时 HOME(路径常量只能绑定一次),故每条用例开头都**自己
//      重新播种** settings.json + 通过 PUT 端点设偏好,不依赖上一条留下的状态。
//   ④ settings.json 里埋了哨兵密钥,反向断言它不进日志、不进 HTTP 响应体。
//
// Run: node tests/unit/check-r100-cache-env-reapply.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSrc = (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; } };
const countStr = (s, sub) => s.split(sub).length - 1;

// ── ① HOME 隔离:必须先于 server/routes/settings.js 的第一次 import ──────────
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const home = await mkdtemp(join(tmpdir(), 'cgui-r100-'));
process.env.HOME = home;            // POSIX:os.homedir() 优先读 $HOME
process.env.USERPROFILE = home;     // Windows:homedir() 读 %USERPROFILE%
const CLAUDE_DIR = join(home, '.claude');
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
await mkdir(CLAUDE_DIR, { recursive: true });

let PASS = 0;
let FAILS = 0;
const failed = [];
async function check(name, fn) {
  try {
    await fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

// ── 夹具 ────────────────────────────────────────────────────────────────────
const SECRET = 'sk-r100-SENTINEL-DO-NOT-LOG-0xdeadbeef';
const THIRD = 'https://api.deepseek.com/anthropic';
const OFFICIAL = 'https://api.anthropic.com';
const K = { slate: 'CLAUDE_CODE_CARVED_SLATE', ts: 'ENABLE_TOOL_SEARCH', mcp: 'MCP_CONNECTION_NONBLOCKING' };
const ALL_KEYS = [K.slate, K.ts, K.mcp];

const fixture = (baseURL, extraEnv = {}) => ({
  model: 'deepseek-v4-flash-vision-exp',
  env: {
    ...(baseURL ? { ANTHROPIC_BASE_URL: baseURL } : {}),
    ANTHROPIC_AUTH_TOKEN: SECRET,
    MY_OWN_KEY: 'keep-me',
    ...extraEnv,
  },
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: { PreToolUse: [] },
});
const seed = (obj) => writeFile(SETTINGS, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const rawSettings = () => readFile(SETTINGS, 'utf8');
const jsonSettings = async () => JSON.parse(await rawSettings());
const bakList = async () => (await readdir(CLAUDE_DIR)).filter((f) => /^settings\.json\..+\.bak$/.test(f));
const mtimeMs = async () => (await stat(SETTINGS)).mtimeMs;
const settingsExists = () => stat(SETTINGS).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stdout/stderr/console 全captureL:反向断言密钥不外泄
async function capture(fn) {
  const out = [];
  const oc = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const ow = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  for (const k of Object.keys(oc)) console[k] = (...a) => { out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { out.push(String(c)); return true; };
  try {
    const ret = await fn();
    return { ret, out: out.join('\n') };
  } finally {
    Object.assign(console, oc);
    process.stdout.write = ow;
    process.stderr.write = oe;
  }
}

// ── ② 动态 import:导出不存在时不许整文件炸 ─────────────────────────────────
let MOD = null;
let MODERR = '';
try {
  MOD = await import('../../server/routes/settings.js');
} catch (e) {
  MODERR = String((e && e.message) || e);
}
const reapply = MOD?.reapplyPromptCacheForActiveProvider;
const needFn = () => {
  assert.equal(typeof reapply, 'function',
    `server/routes/settings.js 必须导出 reapplyPromptCacheForActiveProvider(import 错误:${MODERR || '无'})`);
};

// ── ③ 端点:express + listen(0),用完即关,不起常驻服务 ─────────────────────
let server = null;
let BASE = '';
let SRVERR = '';
try {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use('/api', MOD.default);
  server = await new Promise((res, rej) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
    s.once('error', rej);
  });
  BASE = `http://127.0.0.1:${server.address().port}`;
} catch (e) {
  SRVERR = String((e && e.message) || e);
}
const getState = async () => {
  assert.ok(BASE, `测试用 express 起不来:${SRVERR}`);
  const r = await fetch(`${BASE}/api/prompt-cache`);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保持 null,由断言报 */ }
  return { status: r.status, text, json };
};
const setMode = async (mode) => {
  assert.ok(BASE, `测试用 express 起不来:${SRVERR}`);
  const r = await fetch(`${BASE}/api/prompt-cache`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  assert.equal(r.status, 200, `PUT /api/prompt-cache {mode:${mode}} 应 200,实际 ${r.status}`);
};

try {

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] 函数契约 reapplyPromptCacheForActiveProvider()(BRIEF 需求 1)');
// ══════════════════════════════════════════════════════════════════════════

await check('A0 settings.js 导出 reapplyPromptCacheForActiveProvider(且是函数)', () => {
  needFn();
});

await check('S1 第三方 + 三键缺失 + 偏好 auto:写入三键,返回 changed=true/thirdParty=true,并留 .bak', async () => {
  needFn();
  await setMode('auto');
  await seed(fixture(THIRD));
  const bak0 = (await bakList()).length;
  const r = await reapply();
  assert.ok(r && typeof r === 'object', '返回值必须是对象 { changed, thirdParty, keys }');
  assert.strictEqual(r.changed, true, 'changed 必须为 true(这一次确实写了 settings.json)');
  assert.strictEqual(r.thirdParty, true, 'thirdParty 必须为 true(BASE_URL 是第三方)');
  const env = (await jsonSettings()).env;
  assert.strictEqual(env[K.slate], '1', `settings.json env.${K.slate} 应为 '1'`);
  assert.strictEqual(env[K.ts], 'false', `settings.json env.${K.ts} 应为 'false'`);
  assert.strictEqual(env[K.mcp], 'false', `settings.json env.${K.mcp} 应为 'false'`);
  assert.ok(r.keys && typeof r.keys === 'object', '返回值缺 keys 对象');
  // 主会话 2026-09-03 裁定:keys 字段名用 camelCase,与 GET 的 actual 同名
  //(BRIEF 里"以 env 键名为字段名"的口径作废)。值仍是 settings.json 的原始字符串。
  const shape = `(实际 keys 字段:${Object.keys(r.keys).join(',') || '空'})`;
  assert.strictEqual(r.keys.carvedSlate, '1', `keys.carvedSlate 应回显 '1' ${shape}`);
  assert.strictEqual(r.keys.toolSearch, 'false', `keys.toolSearch 应回显 'false' ${shape}`);
  assert.strictEqual(r.keys.mcpNonblocking, 'false', `keys.mcpNonblocking 应回显 'false' ${shape}`);
  assert.strictEqual((await bakList()).length, bak0 + 1, '写前必须 backupSettings:应新增一个 settings.json.<时间戳>.bak');
});

await check('S1b 写入只碰三键:顶层字段与用户自有 env 键逐字保留', async () => {
  needFn();
  await setMode('auto');
  const fx = fixture(THIRD);
  await seed(fx);
  await reapply();
  const after = await jsonSettings();
  assert.deepEqual(after.permissions, fx.permissions, 'permissions 不许被动到');
  assert.deepEqual(after.hooks, fx.hooks, 'hooks 不许被动到');
  assert.strictEqual(after.model, fx.model, '顶层 model 不许被动到');
  assert.strictEqual(after.env.ANTHROPIC_BASE_URL, THIRD, 'ANTHROPIC_BASE_URL 不许被动到');
  assert.strictEqual(after.env.ANTHROPIC_AUTH_TOKEN, SECRET, '凭证不许被动到/清空');
  assert.strictEqual(after.env.MY_OWN_KEY, 'keep-me', '用户自有 env 键不许被动到');
  const extra = Object.keys(after.env).filter((k) => !(k in fx.env) && !ALL_KEYS.includes(k));
  assert.deepEqual(extra, [], `除三键外不许新增 env 键,发现:${extra.join(',')}`);
});

await check('S2 幂等:三键已是目标值时再跑,文件内容与 mtime 都不变,changed=false', async () => {
  needFn();
  await setMode('auto');
  await seed(fixture(THIRD, { [K.slate]: '1', [K.ts]: 'false', [K.mcp]: 'false' }));
  const before = await rawSettings();
  const m0 = await mtimeMs();
  const bak0 = (await bakList()).length;
  await sleep(30);
  const r = await reapply();
  assert.strictEqual(r.changed, false, '三键已是目标值 → 不该写文件,changed 必须 false');
  assert.strictEqual(r.thirdParty, true);
  assert.strictEqual(await rawSettings(), before, 'settings.json 内容必须逐字不变');
  assert.strictEqual(await mtimeMs(), m0,
    'mtime 必须不变:每次启动都改 mtime 会让 chatCompatKey 换键,白白冷启一次进程');
  assert.strictEqual((await bakList()).length, bak0, '没写文件就不该产生新 .bak');
});

await check('S2b 三键只写对了一个(另两个缺失):补齐两个并 changed=true', async () => {
  needFn();
  await setMode('auto');
  await seed(fixture(THIRD, { [K.slate]: '1' }));
  const r = await reapply();
  assert.strictEqual(r.changed, true, '还差两个键 → 必须写');
  const env = (await jsonSettings()).env;
  assert.strictEqual(env[K.slate], '1');
  assert.strictEqual(env[K.ts], 'false', `缺的 ${K.ts} 必须补上`);
  assert.strictEqual(env[K.mcp], 'false', `缺的 ${K.mcp} 必须补上`);
});

await check('S2c 三键存在但值被改坏(true/1/x):必须纠回目标值', async () => {
  needFn();
  await setMode('auto');
  await seed(fixture(THIRD, { [K.slate]: '0', [K.ts]: 'true', [K.mcp]: 'true' }));
  const r = await reapply();
  assert.strictEqual(r.changed, true, '值不对 → 必须写');
  const env = (await jsonSettings()).env;
  assert.strictEqual(env[K.slate], '1');
  assert.strictEqual(env[K.ts], 'false', '第三方下 ToolSearch 必须关(r89 既有语义)');
  assert.strictEqual(env[K.mcp], 'false');
});

await check('S3 官方 BASE_URL + 偏好 auto:一个字不写,thirdParty=false', async () => {
  needFn();
  await setMode('auto');
  await seed(fixture(OFFICIAL));
  const before = await rawSettings();
  const m0 = await mtimeMs();
  const bak0 = (await bakList()).length;
  await sleep(30);
  const r = await reapply();
  assert.strictEqual(r.thirdParty, false, '官方 BASE_URL 判定必须是 false');
  assert.strictEqual(r.changed, false, '官方 provider + auto 不许写');
  const env = (await jsonSettings()).env;
  for (const k of ALL_KEYS) assert.ok(!(k in env), `官方 provider 下不许写 ${k}`);
  assert.strictEqual(await rawSettings(), before, 'settings.json 必须逐字不变');
  assert.strictEqual(await mtimeMs(), m0, 'mtime 必须不变');
  assert.strictEqual((await bakList()).length, bak0, '不写文件就不该产生新 .bak');
});

await check('S3b 完全没有 ANTHROPIC_BASE_URL(官方登录态):不写,thirdParty=false', async () => {
  needFn();
  await setMode('auto');
  await seed(fixture(null));
  const before = await rawSettings();
  const r = await reapply();
  assert.strictEqual(r.thirdParty, false);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(await rawSettings(), before, '没配 BASE_URL 时 settings.json 必须逐字不变');
});

await check('S4 偏好 off + 第三方:不写(用户显式关掉的东西不许启动时偷偷打开)', async () => {
  needFn();
  await setMode('off');
  await seed(fixture(THIRD));
  const before = await rawSettings();
  const m0 = await mtimeMs();
  const bak0 = (await bakList()).length;
  await sleep(30);
  const r = await reapply();
  assert.strictEqual(r.changed, false, '偏好 off → 不许写');
  assert.strictEqual(r.thirdParty, true, 'thirdParty 描述的是 provider 判定,与偏好无关(与 GET 同口径)');
  const env = (await jsonSettings()).env;
  for (const k of ALL_KEYS) assert.ok(!(k in env), `偏好 off 时不许写 ${k}`);
  assert.strictEqual(await rawSettings(), before, 'settings.json 必须逐字不变');
  assert.strictEqual(await mtimeMs(), m0, 'mtime 必须不变');
  assert.strictEqual((await bakList()).length, bak0, '不写文件就不该产生新 .bak');
});

await check('S5 偏好 on + 官方:与切换路径同语义(切换路径写就写,不写就不写)', async () => {
  needFn();
  // 主会话裁定①:这一格不写死"写/不写",而是**跟切换路径对齐**。
  // 做法:先让 PUT 端点(与 provider 切换同一套 applyProviderPromptCache 语义)在官方+on
  // 下跑一遍,把它留下的三键状态当作参照;再把文件复位,让 reapply 跑同样的局面,
  // 两边结果必须一模一样。日后切换路径极性变了,这条自动跟着变,不会变成假绿/假红。
  await seed(fixture(OFFICIAL));
  await setMode('on');
  const ref = (await jsonSettings()).env;
  const refState = ALL_KEYS.map((k) => (k in ref ? ref[k] : null));

  await seed(fixture(OFFICIAL));            // 复位:官方 + 三键缺失,偏好仍是 on
  const r = await reapply();
  assert.strictEqual(r.thirdParty, false, '官方 BASE_URL 的 thirdParty 恒为 false');
  const env = (await jsonSettings()).env;
  const gotState = ALL_KEYS.map((k) => (k in env ? env[k] : null));
  assert.deepEqual(gotState, refState,
    `启动重应用在「官方 + 偏好 on」下的结果必须与切换路径一致:切换路径留下 ${JSON.stringify(refState)},重应用留下 ${JSON.stringify(gotState)}`);
  assert.strictEqual(r.changed, refState.some((v) => v !== null),
    'changed 必须与"这一局面下到底写没写文件"一致');
});

await check('S6 settings.json 是损坏 JSON:不抛,不写,原文件逐字留着', async () => {
  needFn();
  await setMode('auto');
  const broken = '{ "env": { "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic" ,,, ';
  await seed(broken);
  const bak0 = (await bakList()).length;
  const r = await reapply();   // 抛了就由 check() 记红
  assert.ok(r && typeof r === 'object', '损坏输入下仍须返回 { changed, thirdParty, keys } 而不是 undefined');
  assert.strictEqual(r.changed, false, '解析不了就不该声称写过');
  assert.strictEqual(await rawSettings(), broken,
    '解析不了的 settings.json 必须原样留着 —— 绝不许被当成 {} 覆盖成新文件(会抹掉用户全部配置)');
  assert.strictEqual((await bakList()).length, bak0, '没写文件就不该产生新 .bak');
});

await check('S7 settings.json 不存在:不抛,也不凭空创建文件', async () => {
  needFn();
  await rm(SETTINGS, { force: true });
  const r = await reapply();
  assert.ok(r && typeof r === 'object', '文件缺失时仍须返回对象');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(await settingsExists(), false, '没有 settings.json 时不许凭空造一个');
});

await check('S8 密钥不进日志:reapply 全程的 stdout/stderr/console 都不含 settings.json 里的凭证', async () => {
  needFn();
  await setMode('auto');
  await seed(fixture(THIRD));
  const { ret, out } = await capture(() => reapply());
  assert.strictEqual(ret.changed, true, '本条前提:这一次必须真的写了(否则日志断言等于没测)');
  assert.ok(!out.includes(SECRET), `凭证泄漏进日志:\n      ${out.split('\n').filter((l) => l.includes(SECRET)).slice(0, 2).join('\n      ')}`);
  assert.ok(!out.includes('ANTHROPIC_AUTH_TOKEN'), '日志里不许打印凭证键名(容易连值一起带出来)');
});

await check('S9 用户手动把 ENABLE_TOOL_SEARCH 设成 true:第三方下必须压成 false,其它键不动', async () => {
  needFn();
  await setMode('auto');
  await seed(fixture(THIRD, { [K.ts]: 'true' }));
  const r = await reapply();
  assert.strictEqual(r.changed, true);
  const env = (await jsonSettings()).env;
  assert.strictEqual(env[K.ts], 'false');
  assert.strictEqual(env.MY_OWN_KEY, 'keep-me');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[B] boot 源码锁 server/index.js(BRIEF 需求 1:stripInheritedProviderEnv 之后)');
// ══════════════════════════════════════════════════════════════════════════
const IDX = readSrc('server/index.js');

await check('B0 server/index.js 可读', () => {
  assert.ok(IDX.length > 0, '文件读不到或为空');
});

await check('B1 index.js 调用 reapplyPromptCacheForActiveProvider( 恰好 1 次(每次启动只重应用一次)', () => {
  assert.strictEqual(countStr(IDX, 'reapplyPromptCacheForActiveProvider('), 1,
    `实得 ${countStr(IDX, 'reapplyPromptCacheForActiveProvider(')} 处;0 = 没接线(本轮 bug 原样还在),≥2 = 每次启动多写一遍`);
});

await check('B2 调用点位于 stripInheritedProviderEnv(); 之后', () => {
  const strip = IDX.indexOf('stripInheritedProviderEnv();');
  const call = IDX.indexOf('reapplyPromptCacheForActiveProvider(');
  assert.ok(strip > 0, '找不到 stripInheritedProviderEnv(); 调用(锚点被改名了?)');
  assert.ok(call > 0, '找不到 reapplyPromptCacheForActiveProvider( 调用');
  assert.ok(call > strip,
    '必须在 stripInheritedProviderEnv() 之后:之前跑会读到宿主继承来的 ANTHROPIC_* 污染值,判错 provider');
});

await check('B3 调用失败不阻断启动(try/catch 或 .catch())', () => {
  const call = IDX.indexOf('reapplyPromptCacheForActiveProvider(');
  assert.ok(call > 0, '找不到调用点');
  const after = IDX.slice(call, call + 260);
  const before = IDX.slice(Math.max(0, call - 400), call);
  const guarded = /\.catch\(/.test(after) || (/\btry\s*\{/.test(before) && /\bcatch\s*\(/.test(IDX.slice(call, call + 700)));
  assert.ok(guarded,
    '重应用失败(磁盘只读/文件被占)不许让整个后端起不来 —— 调用点必须包 try/catch 或挂 .catch()');
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[C] GET /api/prompt-cache 响应字段锁(BRIEF 需求 2)');
// ══════════════════════════════════════════════════════════════════════════

await check('C1 GET 200 且响应含 actual 对象,三项字段齐(carvedSlate/toolSearch/mcpNonblocking)', async () => {
  await setMode('auto');
  await seed(fixture(THIRD));
  const { status, json } = await getState();
  assert.strictEqual(status, 200);
  assert.ok(json && typeof json.actual === 'object' && json.actual !== null,
    `响应缺 actual 对象,实得 ${JSON.stringify(json?.actual)}`);
  for (const k of ['carvedSlate', 'toolSearch', 'mcpNonblocking']) {
    assert.ok(k in json.actual, `actual 缺字段 ${k}`);
  }
});

await check('C2 actual 反映 settings.json 的真实值(已写入三键 → 1/false/false)', async () => {
  needFn();
  await setMode('auto');
  await seed(fixture(THIRD));
  await reapply();
  const { json } = await getState();
  assert.ok(json?.actual, '响应缺 actual');
  // 主会话裁定②:actual 三项 = settings.json 里的**原始字符串**,不是布尔。
  assert.strictEqual(json.actual.carvedSlate, '1',
    `actual.carvedSlate 应是原始字符串 '1',实得 ${JSON.stringify(json.actual.carvedSlate)}`);
  assert.strictEqual(json.actual.toolSearch, 'false',
    `actual.toolSearch 应是原始字符串 'false',实得 ${JSON.stringify(json.actual.toolSearch)}`);
  assert.strictEqual(json.actual.mcpNonblocking, 'false',
    `actual.mcpNonblocking 应是原始字符串 'false',实得 ${JSON.stringify(json.actual.mcpNonblocking)}`);
});

await check('C3 actual 反映"没写"(官方 provider,三键缺失 → 三项皆 null)', async () => {
  await setMode('auto');
  await seed(fixture(OFFICIAL));
  const { json } = await getState();
  assert.ok(json?.actual, '响应缺 actual');
  // 主会话裁定②:缺失一律 null(不是 undefined / '' / false)。
  for (const k of ['carvedSlate', 'toolSearch', 'mcpNonblocking']) {
    assert.strictEqual(json.actual[k], null,
      `三键不在 settings.json 时 actual.${k} 必须是 null(与既有 snapshotEnv 同口径),实得 ${JSON.stringify(json.actual[k])}`);
  }
});

await check('C4 GET thirdParty 与 BASE_URL 判定一致(第三方 true / 官方 false)', async () => {
  await seed(fixture(THIRD));
  assert.strictEqual((await getState()).json?.thirdParty, true, '第三方 BASE_URL 应回 true');
  await seed(fixture(OFFICIAL));
  assert.strictEqual((await getState()).json?.thirdParty, false, 'api.anthropic.com 应回 false');
});

await check('C5 回归锁:r89 既有字段一个都不许被顶掉(mode/on/snapshotEnv/toolSearchEnv/mcpNonblockingEnv/cliSnapshotSupported)', async () => {
  await seed(fixture(THIRD));
  const { json } = await getState();
  for (const k of ['mode', 'on', 'thirdParty', 'snapshotEnv', 'toolSearchEnv', 'mcpNonblockingEnv', 'cliSnapshotSupported']) {
    assert.ok(json && k in json, `响应缺既有字段 ${k}(新增 actual 不等于可以把旧字段改名/删掉,面板还在用)`);
  }
});

await check('C6 GET 响应体不含 settings.json 里的凭证(不许把整个 env 塞进 actual)', async () => {
  await seed(fixture(THIRD));
  const { text } = await getState();
  assert.ok(!text.includes(SECRET), `响应体里出现了凭证:${text.slice(0, 300)}`);
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n[D] 面板文案锁 client/src/components/SettingsPanel.jsx(BRIEF 需求 2/3)');
// ══════════════════════════════════════════════════════════════════════════
const PANEL = readSrc('client/src/components/SettingsPanel.jsx');

await check('D0 SettingsPanel.jsx 可读', () => {
  assert.ok(PANEL.length > 0, '文件读不到或为空');
});

await check('D1 面板消费 actual 的三项(carvedSlate / toolSearch / mcpNonblocking 各自出现)', () => {
  assert.ok(/\bactual\b/.test(PANEL), '面板未引用 actual —— 端点加了字段但没人渲染 = 用户还是看不到');
  for (const k of ['carvedSlate', 'toolSearch', 'mcpNonblocking']) {
    assert.ok(PANEL.includes(k), `面板未渲染 actual.${k}`);
  }
});

await check('D2 面板写明这是 settings.json 的实际状态', () => {
  assert.ok(/实际|当前\s*settings\.json/.test(PANEL),
    '缺"实际状态"这层意思 —— 用户要一眼看出配置有没有真的落到 settings.json');
});

await check('D3 面板给出补救动作:重新选择一次 provider 或重启应用', () => {
  assert.ok(/(重新选择|重新切换)[^。\n]{0,16}provider/i.test(PANEL),
    '缺"重新选择一次 provider"这句补救指引(BRIEF 需求 3)');
  assert.ok(/重启/.test(PANEL), '缺"重启应用"这条补救路径');
});

await check('D4 回归锁:r89 既有文案不许被本轮改掉', () => {
  // r104:条目改名「缓存优化」(面板上只剩这一个缓存条目),id 与组件不变。
  assert.ok(/\{ id: 'set-prompt-snapshot', tab: 'session', title: '缓存优化'/.test(PANEL),
    'r89 的开关条目丢了(r104 起标题为「缓存优化」)');
  assert.ok(/ENABLE_TOOL_SEARCH=false/.test(PANEL), 'r89"关 ToolSearch 的代价"说明丢了');
  assert.ok(/当前不启用系统提示快照/.test(PANEL), 'r89 的 CLI 不支持分支文案丢了');
});

} finally {
  if (server) await new Promise((r) => server.close(r));
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  await rm(home, { recursive: true, force: true });
}

console.log(`\n—— check-r100-cache-env-reapply: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r100-cache-env-reapply: 启动重应用函数契约 + boot 接线 + 端点字段 + 面板文案 全绿');
