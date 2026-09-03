// r96 #8 自测:GUI「始终允许」经 CLI 落盘 ~/.claude/settings.json 的 permissions 不再触发
// chatCompatKey 冷启;外部权限改动与任何非权限字段变化照旧冷启。
// 临时 HOME 隔离(照抄 check-compat-key-model.mjs),全程不读写真实 ~/.claude。
// 跑法:node tests/unit/check-r96-dev-compat-key.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, utimesSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REAL_HOME = process.env.HOME;
const REAL_PROFILE = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), 'cgui-r96-perm-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const proj = mkdtempSync(join(tmpdir(), 'cgui-r96-proj-'));
mkdirSync(join(home, '.claude'), { recursive: true });
const SETTINGS = join(home, '.claude', 'settings.json');

const { chatCompatKey, noteSelfPermissionWrite } = await import('../../server/routes/chat.js');

const base = {
  workingDir: proj, effort: 'high', appendSystemPrompt: '', promptSuggestions: false,
  excludeDynamicSystemPrompt: 'auto', globalRead: true, dirs: ['/'], maxBudgetUsd: null,
};
// mtime 必须显式推进:同毫秒内连写两次会被 readSettingsSplit 的 mtime 快路吃掉(既有天花板)。
let clock = Math.floor(Date.now() / 1000) - 1000;
const write = (path, text) => { writeFileSync(path, text); clock += 10; utimesSync(path, clock, clock); };
const settings = (perm, env = { ANTHROPIC_BASE_URL: 'https://a/v1' }) =>
  write(SETTINGS, JSON.stringify({ env, permissions: { allow: perm } }));

try {
  assert.equal(typeof noteSelfPermissionWrite, 'function', 'R5 必须导出 noteSelfPermissionWrite');

  // ── K0–K7 时间线(顺序执行,模块级状态跨调用累积) ─────────────────────────
  settings(['Bash(ls)']);
  const K0 = chatCompatKey(base);                       // K0 建基线
  const K1 = chatCompatKey(base);
  assert.equal(K1, K0, 'K1 同一状态重复调用必须恒等');

  settings(['Bash(ls)', 'Bash(pwd)']);                  // 外部权限改动
  const K2 = chatCompatKey(base);
  assert.notEqual(K2, K0, 'K2 外部权限改动必须冷启');

  noteSelfPermissionWrite();                            // GUI 自写
  settings(['Bash(ls)', 'Bash(pwd)', 'Bash(cat)']);
  const K3 = chatCompatKey(base);
  assert.equal(K3, K2, 'K3【核心】GUI 自写权限 → 键不变 → 不冷启');

  settings(['Bash(ls)', 'Bash(pwd)', 'Bash(cat)', 'Bash(echo)']);
  const K4 = chatCompatKey(base);
  assert.notEqual(K4, K3, 'K4 标记已消费,下一次外部权限改动必须冷启(有界性)');

  noteSelfPermissionWrite();                            // 自写标记 + 非权限字段同时变
  settings(['Bash(ls)', 'Bash(rm)'], { ANTHROPIC_BASE_URL: 'https://b/v1' });
  const K5 = chatCompatKey(base);
  assert.notEqual(K5, K4, 'K5【护栏】env 变了必须冷启,标记不得吞掉 provider 切换');

  write(SETTINGS, readFileSync(SETTINGS, 'utf8'));      // 原样重写:仅 mtime 变
  const K6 = chatCompatKey(base);
  assert.equal(K6, K5, 'K6 内容指纹口径:mtime 变而字节没变不冷启');

  unlinkSync(SETTINGS);
  const K7 = chatCompatKey(base);
  assert.notEqual(K7, K6, 'K7 删掉 settings.json 必须换键且不抛错');

  // ── 判官修:settingsFp 是摘要,原文(含明文 API key)不得进键 ──────────────
  settings(['Bash(ls)'], { ANTHROPIC_BASE_URL: 'https://a/v1', ANTHROPIC_AUTH_TOKEN: 'sk-LEAK-CANARY-123' });
  const kSecret = chatCompatKey(base);
  assert.ok(!kSecret.includes('sk-LEAK-CANARY-123'), 'settingsFp 不得把明文凭证塞进复用键');
  assert.ok(!kSecret.includes('ANTHROPIC_AUTH_TOKEN'), 'settingsFp 不得把 settings.json 原文塞进复用键');
  settings(['Bash(ls)'], { ANTHROPIC_BASE_URL: 'https://a/v1', ANTHROPIC_AUTH_TOKEN: 'sk-OTHER-456' });
  assert.notEqual(chatCompatKey(base), kSecret, '摘要仍须随内容改变(否则换 key 失效)');

  // ── C1 其余字段照旧生效 ──────────────────────────────────────────────────
  settings(['Bash(ls)']);
  chatCompatKey(base);                                  // 吸收这次外部改动,后面只比同一状态
  const K = chatCompatKey(base);
  for (const [name, over] of [['effort', { effort: 'low' }], ['cwd', { workingDir: '/tmp/other-r96' }],
    ['budget', { maxBudgetUsd: 5 }], ['genui', { genui: false }]]) {
    assert.notEqual(chatCompatKey({ ...base, ...over }), K, `C1 ${name} 变化仍须换键`);
  }
  // ── C2 项目级 settings 仍进键 ────────────────────────────────────────────
  mkdirSync(join(proj, '.claude'), { recursive: true });
  write(join(proj, '.claude', 'settings.json'), '{"hooks":{}}');
  assert.notEqual(chatCompatKey(base), K, 'C2 项目级 settings 变化仍须换键');
  // ── C3 坏 JSON → 不抛错且保守冷启 ────────────────────────────────────────
  const kBefore = chatCompatKey(base);
  write(SETTINGS, '{oops');
  const kBad = chatCompatKey(base);
  assert.notEqual(kBad, kBefore, 'C3 坏 JSON 必须保守冷启');
  // ── C4 标记不累积成计数 ──────────────────────────────────────────────────
  settings(['Bash(ls)']); chatCompatKey(base);          // 回到可读状态并吸收
  noteSelfPermissionWrite(); noteSelfPermissionWrite(); noteSelfPermissionWrite();
  settings(['Bash(ls)', 'Bash(a)']);
  const c4a = chatCompatKey(base);
  settings(['Bash(ls)', 'Bash(a)', 'Bash(b)']);
  assert.notEqual(chatCompatKey(base), c4a, 'C4 连调 3 次标记也只吞一次');
  // ── M20 哨兵:标记是全局的,不同 workingDir 共享同一次吞并 ────────────────
  settings(['Bash(ls)']); chatCompatKey(base); chatCompatKey({ ...base, workingDir: '/tmp/other-r96' });
  const other = { ...base, workingDir: '/tmp/other-r96' };
  const kOther = chatCompatKey(other);
  noteSelfPermissionWrite();
  settings(['Bash(ls)', 'Bash(c)']);
  assert.equal(chatCompatKey(other), kOther, 'M20 自写标记必须是模块级全局,不做 per-session');

  // ── 源码锁 ───────────────────────────────────────────────────────────────
  const CH = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  const KEY = CH.slice(CH.indexOf('export function chatCompatKey'), CH.indexOf('export function closePersistentForSession'));
  const RET = KEY.slice(KEY.indexOf('return JSON.stringify'));
  assert.ok(/export function noteSelfPermissionWrite/.test(CH), '缺 noteSelfPermissionWrite 导出');
  for (const f of ['settingsFp', 'permEpoch', 'projSettingsMtime', 'disToolsMtime', 'mcpStampMtime']) {
    assert.ok(RET.includes(f), `键里必须含 ${f}`);
  }
  assert.ok(!RET.includes('model'), '键里仍不得含 model(check-compat-key-model 既有锁)');
  assert.ok(!RET.includes('settingsMtime'), '用户级 settingsMtime 必须已被换掉');
  assert.ok(!/Date\.now\(\)/.test(KEY), 'chatCompatKey 内不许用时间窗');
  assert.ok(!/pendingSelfPermWrite\s*=\s*true/.test(KEY), '只允许 noteSelfPermissionWrite 置位');
  assert.ok(/delete s\.permissions/.test(CH), '指纹必须排除 permissions');
  assert.ok(/destination === 'userSettings'[\s\S]{0,80}noteSelfPermissionWrite\(\)/.test(CH), '只有 userSettings 更新才置标记');
  assert.ok(/ponytail:[\s\S]{0,300}始终允许[\s\S]{0,300}deny/.test(CH), '天花板注释必须在位');

  console.log('✅ r96-dev-compat-key: K0–K7 + C1–C4 + M20 + 源码锁 全部通过');
} finally {
  process.env.HOME = REAL_HOME;
  if (REAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_PROFILE;
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
}
process.exit(0);
