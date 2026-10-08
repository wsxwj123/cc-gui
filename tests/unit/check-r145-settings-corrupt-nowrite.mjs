#!/usr/bin/env node
// r145 F1:~/.claude/settings.json 存在但读不出 / 解析失败(语法错 / 空 / 半截)时,选模型、切 provider、
// 改缓存开关此前都把它当 {},写回去只剩 env —— hooks / permissions / 插件开关全丢。修好后:
//   · 文件不存在(新机器)仍按 {} 正常写;
//   · 存在但读不出 / 解析失败 → 所有写路径一律不写,原文件逐字节不变(也不滚动 .bak),
//     接口按统一出口回 409 { code: CONFIG_CORRUPT … }(读不出时同一出口的 CONFIG_UNREADABLE)。
// 覆盖 BRIEF 列出的全部写点:setDefaultModel(选模型)、PUT /prompt-cache、POST /provider/switch 的
// 官方分支 / cc-switch 直写分支 / openai 上游 / anthropic 上游(custom)/ custom 官方直连。
// PUT /api/model 本身挂在 server/index.js 上:起整套 index.js 会去抢代理固定端口(8788/8789)与 watcher,
// 不可接受 —— 这一条做 setDefaultModel 的函数级行为 + index.js 该路由 catch 的源码断言。
// 写法同 check-r130 / check-r100:临时 HOME(先于 import)+ 动态 import + express 挂路由(端口 6700–6999)。
// 官方分支切完会读钥匙串判登录态:PATH 前挂一个假 security(exit 1),绝不碰真实钥匙串。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateHome, writeFakeCommand, listenInRange, pickPortInRange, assertPortAllowed, makeChecker } from './r145-helpers/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { home, bin, cleanup } = isolateHome('f1');
writeFakeCommand(bin, 'security', 'process.exit(1);\n');
const CLAUDE_DIR = join(home, '.claude');
const GUI_DIR = join(home, '.claude-gui');
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
mkdirSync(CLAUDE_DIR, { recursive: true });
mkdirSync(GUI_DIR, { recursive: true });

// 假上游:代理若被切到它,GET /v1/models 会被转发过来并回 who。
const upstream = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ who: 'UP' })); });
const upPort = await listenInRange(upstream);
writeFileSync(join(GUI_DIR, 'custom-providers.json'), JSON.stringify([
  { id: 'r145-anth', name: 'Anth', type: 'anthropic', baseURL: `http://127.0.0.1:${upPort}`, apiKey: 'sk-r145-anth', models: ['model-anth'] },
  { id: 'r145-oa', name: 'OA', type: 'openai', baseURL: `http://127.0.0.1:${upPort}/v1`, apiKey: 'sk-r145-oa', models: ['gpt-r145'] },
  { id: 'r145-off-direct', name: 'OffDirect', type: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'sk-r145-off', models: ['claude-sonnet-4-6'] },
], null, 2));

// cc-switch 库里一条"非官方、无 token"的 claude provider → 走 /provider/switch 的直写分支。
let ccDirectReady = false;
try {
  mkdirSync(join(home, '.cc-switch'), { recursive: true });
  execFileSync('sqlite3', [join(home, '.cc-switch', 'cc-switch.db'),
    "CREATE TABLE providers(id TEXT, app_type TEXT, name TEXT, category TEXT, settings_config TEXT, is_current INTEGER DEFAULT 0);"
    + "INSERT INTO providers(id, app_type, name, category, settings_config) VALUES('r145-cc-direct','claude','CC Direct','custom','{\"env\":{\"R145_X\":\"1\"}}');"]);
  ccDirectReady = true;
} catch { /* 没有 sqlite3:该分支跳过(下面单独标注) */ }

// 代理先在允许的端口上起好:settings.js 里的 startXProxy() 见已起就复用,不会去碰 8788 / 8789。
const anthProxy = await import('../../server/services/anthropic-proxy.js');
const oaProxy = await import('../../server/services/openai-proxy.js');
const anthPort = await anthProxy.startAnthropicProxy(await pickPortInRange());
assertPortAllowed(anthPort, 'anthropic 代理');
const oaPort = await oaProxy.startOpenAIProxy(await pickPortInRange());
assertPortAllowed(oaPort, 'openai 代理');

const { setDefaultModel } = await import('../../server/services/model-resolver.js');
const settingsRouter = (await import('../../server/routes/settings.js')).default;
const express = (await import('express')).default;
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', settingsRouter);
const httpServer = createServer(app);
const apiPort = await listenInRange(httpServer);
const BASE = `http://127.0.0.1:${apiPort}`;

async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 保持 null */ }
  return { status: r.status, json, text };
}
const anthropicWho = async () => {
  const r = await fetch(`http://127.0.0.1:${anthPort}/v1/models`);
  if (r.status === 503) return null; // 上游从未配置
  try { return (await r.json()).who ?? `status-${r.status}`; } catch { return `status-${r.status}`; }
};
const bakList = () => readdirSync(CLAUDE_DIR).filter((f) => /^settings\.json\..+\.bak$/.test(f)).sort();

const GOOD = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo r145' }] }] }, permissions: { allow: ['Bash(ls:*)'] }, enabledPlugins: { 'p@m': true }, env: { MY_KEY: 'keep' } };
const GOOD_TEXT = JSON.stringify(GOOD, null, 2);
// 三种"存在但解析不了":语法错 / 空 / 写到一半被截断。
const BROKEN = {
  'syntax-error': GOOD_TEXT.replace('"permissions"', ',"permissions"'),
  empty: '',
  truncated: GOOD_TEXT.slice(0, Math.floor(GOOD_TEXT.length / 2)),
};

// 写点:每个都返回 { status, code }(函数级的从抛出的错误上取)。
const WRITERS = {
  'setDefaultModel(选模型)': async () => {
    try { await setDefaultModel('claude-opus-4-1'); return { status: 200, code: null }; }
    catch (e) { return { status: e?.status ?? 500, code: e?.code ?? null, message: e?.message }; }
  },
  'PUT /prompt-cache': async () => { const r = await call('PUT', '/api/prompt-cache', { mode: 'on' }); return { status: r.status, code: r.json?.code ?? null }; },
  'switch 官方分支(builtin-official)': async () => { const r = await call('POST', '/api/provider/switch', { id: 'builtin-official' }); return { status: r.status, code: r.json?.code ?? null }; },
  'switch cc-switch 直写分支': async () => { const r = await call('POST', '/api/provider/switch', { id: 'r145-cc-direct' }); return { status: r.status, code: r.json?.code ?? null }; },
  'switch openai 上游(custom openai)': async () => { const r = await call('POST', '/api/provider/switch', { id: 'r145-oa' }); return { status: r.status, code: r.json?.code ?? null }; },
  'switch anthropic 上游(custom 第三方)': async () => { const r = await call('POST', '/api/provider/switch', { id: 'r145-anth' }); return { status: r.status, code: r.json?.code ?? null }; },
  'switch custom 官方直连': async () => { const r = await call('POST', '/api/provider/switch', { id: 'r145-off-direct' }); return { status: r.status, code: r.json?.code ?? null }; },
};

const { check, finish } = makeChecker('check-r145-settings-corrupt-nowrite');
let exitCode = 1;
try {
  console.log('F1 · settings.json 损坏时所有写路径拒写(409)且原文件逐字节不变');
  for (const [wname, run] of Object.entries(WRITERS)) {
    if (wname.includes('cc-switch') && !ccDirectReady) { console.log(`  - SKIP ${wname}(本机无 sqlite3,建不了 cc-switch 库)`); continue; }
    await check(wname, async () => {
      for (const [kind, text] of Object.entries(BROKEN)) {
        writeFileSync(SETTINGS, text);
        const before = readFileSync(SETTINGS);
        const baksBefore = bakList();
        const whoBefore = await anthropicWho();
        const r = await run();
        assert.equal(r.status, 409, `[${kind}] 应 409,实际 ${r.status}${r.message ? `(${r.message})` : ''}`);
        assert.equal(r.code, 'CONFIG_CORRUPT', `[${kind}] code 应为 CONFIG_CORRUPT,实际 ${r.code}`);
        assert.ok(existsSync(SETTINGS) && readFileSync(SETTINGS).equals(before), `[${kind}] settings.json 被改写了`);
        assert.deepEqual(bakList(), baksBefore, `[${kind}] 拒写时不该新建 / 滚掉 .bak 备份`);
        assert.equal(await anthropicWho(), whoBefore, `[${kind}] 拒写时代理上游不该被改`);
      }
    });
  }

  await check('读不出(无读权限)同样拒写:409 + CONFIG_* code,文件不变', async () => {
    writeFileSync(SETTINGS, GOOD_TEXT);
    const before = readFileSync(SETTINGS);
    chmodSync(SETTINGS, 0o000);
    let r;
    try { r = await call('PUT', '/api/prompt-cache', { mode: 'on' }); }
    finally { chmodSync(SETTINGS, 0o644); }
    assert.equal(r.status, 409, `应 409,实际 ${r.status}`);
    assert.match(String(r.json?.code), /^CONFIG_/, `code 应以 CONFIG_ 开头,实际 ${r.json?.code}`);
    assert.ok(readFileSync(SETTINGS).equals(before), 'settings.json 被改写了');
  });

  console.log('F1 · 不误伤:文件不存在(新机器)照常写;合法文件写后 hooks / permissions / 插件开关都在');
  await check('不存在 → setDefaultModel 照常写出 env.ANTHROPIC_MODEL', async () => {
    rmSync(SETTINGS, { force: true });
    await setDefaultModel('claude-opus-4-1');
    assert.equal(JSON.parse(readFileSync(SETTINGS, 'utf8')).env?.ANTHROPIC_MODEL, 'claude-opus-4-1');
  });
  await check('不存在 → PUT /prompt-cache 200', async () => {
    rmSync(SETTINGS, { force: true });
    const r = await call('PUT', '/api/prompt-cache', { mode: 'on' });
    assert.equal(r.status, 200, `实际 ${r.status} ${r.text.slice(0, 200)}`);
  });
  await check('不存在 → 切到 custom 第三方 200 并写出 settings.json', async () => {
    rmSync(SETTINGS, { force: true });
    const r = await call('POST', '/api/provider/switch', { id: 'r145-anth' });
    assert.equal(r.status, 200, `实际 ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(JSON.parse(readFileSync(SETTINGS, 'utf8')).env?.ANTHROPIC_MODEL, 'model-anth');
  });
  await check('合法文件(带 UTF-8 BOM 也算合法)→ 写路径不丢数据:要么 200 且其它字段都在,要么 409 且文件不变', async () => {
    for (const text of [GOOD_TEXT, `\uFEFF${GOOD_TEXT}`]) {
      writeFileSync(SETTINGS, text);
      const before = readFileSync(SETTINGS);
      const r = await call('POST', '/api/provider/switch', { id: 'r145-anth' });
      if (r.status === 409) { assert.ok(readFileSync(SETTINGS).equals(before), '409 却改了文件'); continue; }
      assert.equal(r.status, 200, `实际 ${r.status} ${r.text.slice(0, 200)}`);
      const after = JSON.parse(readFileSync(SETTINGS, 'utf8').replace(/^\uFEFF/, ''));
      assert.deepEqual([after.hooks, after.permissions, after.enabledPlugins, after.env?.MY_KEY],
        [GOOD.hooks, GOOD.permissions, GOOD.enabledPlugins, 'keep'], `${text.startsWith('\uFEFF') ? '带 BOM 的' : ''}合法文件写后丢了字段`);
    }
  });

  await check('源码:PUT /api/model 的 catch 对配置守卫错误走统一 409 出口(带 code)', () => {
    const src = readFileSync(join(root, 'server', 'index.js'), 'utf8');
    const start = src.indexOf("app.put('/api/model'");
    assert.ok(start >= 0, "找不到 app.put('/api/model'");
    const body = src.slice(start, src.indexOf('\napp.', start + 10));
    assert.match(body, /sendConfigGuardError|isConfigGuardError/, 'PUT /api/model 没有把 ConfigGuardError 映射成 409 { code } —— 前端拿不到 CONFIG_CORRUPT');
  });

  exitCode = finish();
} finally {
  try { chmodSync(SETTINGS, 0o644); } catch { /* 文件可能已删 */ }
  cleanup();
}
// settings.js / 代理模块有未 unref 的定时器与监听:显式退出。
process.exit(exitCode);
