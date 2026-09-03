#!/usr/bin/env node
// r100 开发自测:启动时对**已激活**的 provider 重应用前缀缓存 env。
// 隔离 HOME(mkdtemp),绝不碰真实 ~/.claude / ~/.claude-gui。不起服务、不联网。
// 哨兵:①第三方缺三键 → 写入 + 留 .bak;②再跑一次 → 内容与 mtime 一字不动(幂等,
// settings.json 的 mtime 进 chatCompatKey,每启动改一次 = 每启动冷启常驻进程);
// ③官方 provider → 不写;④偏好 off → 不写;⑤settings.json 损坏/不存在 → 不抛不写。
// Run: node tests/unit/check-r100-dev-reapply.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'cgui-r100-'));
process.env.HOME = home;         // 必须先于 import:路径常量在模块加载期绑定
process.env.USERPROFILE = home;  // Windows 上 homedir() 读 %USERPROFILE%

const { reapplyPromptCacheForActiveProvider } = await import('../../server/routes/settings.js');

const CLAUDE_DIR = join(home, '.claude');
const SETTINGS = join(CLAUDE_DIR, 'settings.json');
const PREFS = join(home, '.claude-gui', 'prefs.json');
await mkdir(CLAUDE_DIR, { recursive: true });
await mkdir(join(home, '.claude-gui'), { recursive: true });

const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (e) { failures.push(`${name}: ${e.message}`); } };
const writeSettings = (obj) => writeFile(SETTINGS, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
const readSettings = async () => JSON.parse(await readFile(SETTINGS, 'utf-8'));
const setMode = (mode) => writeFile(PREFS, JSON.stringify({ promptCache: { mode } }, null, 2));
const baks = async () => (await readdir(CLAUDE_DIR)).filter((f) => f.startsWith('settings.json.') && f.endsWith('.bak'));
const THIRD = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789', ANTHROPIC_AUTH_TOKEN: 'x' }, model: 'deepseek-chat' };

await check('R100-1 第三方缺三键:写入目标值 + 备份 + 其余字段不丢', async () => {
  await setMode('auto');
  await writeSettings(THIRD);
  const r = await reapplyPromptCacheForActiveProvider({ reason: 'boot' });
  assert.equal(r.changed, true, '应写入');
  assert.equal(r.thirdParty, true);
  const s = await readSettings();
  assert.equal(s.env.CLAUDE_CODE_CARVED_SLATE, '1');
  assert.equal(s.env.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(s.env.MCP_CONNECTION_NONBLOCKING, 'false');
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'x', '同层其他 env 被冲掉');
  assert.equal(s.model, 'deepseek-chat', 'settings 顶层其他字段被冲掉');
  assert.equal((await baks()).length >= 1, true, '写前未备份');
});

await check('R100-2 幂等:第二次跑不写文件(内容与 mtime 一字不动)', async () => {
  const before = await readFile(SETTINGS, 'utf-8');
  const mBefore = (await stat(SETTINGS)).mtimeMs;
  const bakBefore = (await baks()).length;
  await new Promise((res) => setTimeout(res, 12)); // 让"没写"与"写了但同毫秒"可区分
  const r = await reapplyPromptCacheForActiveProvider({ reason: 'boot' });
  assert.equal(r.changed, false, '三键已是目标值仍写了文件');
  assert.equal(r.reason, 'already-applied');
  assert.equal(await readFile(SETTINGS, 'utf-8'), before);
  assert.equal((await stat(SETTINGS)).mtimeMs, mBefore, 'mtime 变了 → 每次启动都会冷启常驻进程');
  assert.equal((await baks()).length, bakBefore, '没写也备份了');
});

await check('R100-3 官方 provider:不写', async () => {
  await setMode('auto');
  await writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
  const mBefore = (await stat(SETTINGS)).mtimeMs;
  await new Promise((res) => setTimeout(res, 12));
  const r = await reapplyPromptCacheForActiveProvider({ reason: 'boot' });
  assert.equal(r.changed, false);
  assert.equal(r.thirdParty, false);
  assert.equal((await stat(SETTINGS)).mtimeMs, mBefore);
  assert.equal('CLAUDE_CODE_CARVED_SLATE' in (await readSettings()).env, false);
});

await check('R100-4 无 BASE_URL(官方订阅):不写', async () => {
  await writeSettings({ env: {} });
  const r = await reapplyPromptCacheForActiveProvider({ reason: 'boot' });
  assert.equal(r.changed, false);
  assert.equal(r.thirdParty, false);
  assert.equal('CLAUDE_CODE_CARVED_SLATE' in (await readSettings()).env, false);
});

await check('R100-5 偏好 off + 第三方:不写', async () => {
  await setMode('off');
  await writeSettings(THIRD);
  const mBefore = (await stat(SETTINGS)).mtimeMs;
  await new Promise((res) => setTimeout(res, 12));
  const r = await reapplyPromptCacheForActiveProvider({ reason: 'boot' });
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'not-applicable');
  assert.equal((await stat(SETTINGS)).mtimeMs, mBefore);
  assert.equal('CLAUDE_CODE_CARVED_SLATE' in (await readSettings()).env, false);
});

await check('R100-6 偏好 on + 官方:照写(显式 on 压过 provider 类别)', async () => {
  await setMode('on');
  await writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
  const r = await reapplyPromptCacheForActiveProvider({ reason: 'boot' });
  assert.equal(r.changed, true);
  assert.equal((await readSettings()).env.CLAUDE_CODE_CARVED_SLATE, '1');
});

await check('R100-7 settings.json 损坏:不抛、不写', async () => {
  await setMode('auto');
  await writeSettings('{ 这不是 JSON');
  const r = await reapplyPromptCacheForActiveProvider({ reason: 'boot' });
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'unreadable');
  assert.equal(await readFile(SETTINGS, 'utf-8'), '{ 这不是 JSON', '损坏文件被覆盖 = 用户配置丢失');
});

await check('R100-8 settings.json 不存在:不抛、不创建', async () => {
  await rm(SETTINGS, { force: true });
  const r = await reapplyPromptCacheForActiveProvider({ reason: 'boot' });
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'no-settings');
  assert.equal((await readdir(CLAUDE_DIR)).includes('settings.json'), false);
});

await check('R100-9 备忘记账:第三方重应用后记下用户原值(否则切回官方还不回去)', async () => {
  await rm(PREFS, { force: true });
  await writeSettings({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8789', ENABLE_TOOL_SEARCH: 'true' } });
  await reapplyPromptCacheForActiveProvider({ reason: 'boot' });
  const prefs = JSON.parse(await readFile(PREFS, 'utf-8'));
  assert.equal(prefs.promptCache?.memo?.toolSearch, 'true', '未记账 → 切回官方时用户的 true 还不回去');
});

await rm(home, { recursive: true, force: true });
if (failures.length) {
  console.error(`check-r100-dev-reapply: ${failures.length} FAILED`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('check-r100-dev-reapply: OK');
