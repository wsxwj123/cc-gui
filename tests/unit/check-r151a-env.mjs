#!/usr/bin/env node
// r151a T-Y2:GUI 起 CLI 会话进程时的 CLAUDE_CODE_AUTO_MODE_SERVER(INTERFACE Y.3.2 后半)。
//   第三方地址 + 第三方 auto 总开关开 + settings.json 的 env 没写这个键 → 传入 "0"(关掉服务端审核通道:
//   第三方端点用不上,且首个主请求会带 safeguards —— 内含家目录等本机路径);其余情况一律不传
//   (开关关 = 与改动前逐字相同)。宿主自己的同名键先被剥掉。注入值进复用兼容键,只在注入时出现。
// r151j:同一开关下还会把「审核模型」(settings.json 的 ANTHROPIC_DEFAULT_SONNET_MODEL)作为 CLI 的
//   分类器模型显式传下去(CLAUDE_CODE_AUTO_MODE_MODEL),不再依赖 CLI 版本的默认解析;规则见
//   autoModeModelInjection,同样先剥宿主同名键、只在该键没被用户显式写时注入,并进复用兼容键(amm)。
// 另验 H1 的结论不在此处(实测见提交信息):default 档下带不带该变量,主请求体 / 请求头 / init 无差别。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REAL_HOME = process.env.HOME;
const REAL_PROFILE = process.env.USERPROFILE;
const home = mkdtempSync(join(tmpdir(), 'cgui-r151a-env-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, '.claude'), { recursive: true });
mkdirSync(join(home, '.claude-gui'), { recursive: true });

const { cleanChildEnv, chatCompatKey } = await import('../../server/routes/chat.js');
const { autoModeServerInjection, autoModeModelInjection } = await import('../../server/services/auto-audit.js');
const { readThirdPartyAutoSync } = await import('../../server/routes/prefs.js');

const SETTINGS = join(home, '.claude', 'settings.json');
const PREFS = join(home, '.claude-gui', 'prefs.json');
const setSettings = (obj) => { if (obj === null) rmSync(SETTINGS, { force: true }); else writeFileSync(SETTINGS, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const setPrefs = (obj) => { if (obj === null) rmSync(PREFS, { force: true }); else writeFileSync(PREFS, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const TP = 'http://127.0.0.1:8788';
const hasKey = (o) => Object.prototype.hasOwnProperty.call(o, 'CLAUDE_CODE_AUTO_MODE_SERVER');
const hasAmm = (o) => Object.prototype.hasOwnProperty.call(o, 'CLAUDE_CODE_AUTO_MODE_MODEL');

const savedAms = process.env.CLAUDE_CODE_AUTO_MODE_SERVER;
const savedAmm = process.env.CLAUDE_CODE_AUTO_MODE_MODEL;
try {
  // 宿主进程环境故意带着同名键(模拟另一台机器上被解析成 opus 的那份值):所有 cleanChildEnv 用例
  // 都在验证「先剥掉宿主的值,再按规则决定注不注」。
  process.env.CLAUDE_CODE_AUTO_MODE_MODEL = 'claude-opus-4-6[1m]';

  // ── 纯函数:注入规则 ─────────────────────────────────────────────────────────
  for (const [label, se, on, want] of [
    ['第三方 + 开 + 没写', { ANTHROPIC_BASE_URL: TP }, true, '0'],
    ['第三方(https 中转)+ 开', { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, true, '0'],
    ['含 anthropic.com 字样但主机不是官方的中转 + 开', { ANTHROPIC_BASE_URL: 'https://anthropic.com.relay.example/v1' }, true, '0'],
    ['第三方 + 关', { ANTHROPIC_BASE_URL: TP }, false, null],
    ['第三方 + 开关值不是布尔', { ANTHROPIC_BASE_URL: TP }, 'true', null],
    ['没有 BASE_URL + 开', {}, true, null],
    ['BASE_URL 空串 + 开', { ANTHROPIC_BASE_URL: '' }, true, null],
    ['BASE_URL 不是字符串 + 开', { ANTHROPIC_BASE_URL: 42 }, true, null],
    ['官方地址 + 开', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, true, null],
    ['官方子域 + 开', { ANTHROPIC_BASE_URL: 'https://foo.anthropic.com/v1' }, true, null],
    ['env 已写 "1"', { ANTHROPIC_BASE_URL: TP, CLAUDE_CODE_AUTO_MODE_SERVER: '1' }, true, null],
    ['env 已写 "0"', { ANTHROPIC_BASE_URL: TP, CLAUDE_CODE_AUTO_MODE_SERVER: '0' }, true, null],
    ['env 已写空串', { ANTHROPIC_BASE_URL: TP, CLAUDE_CODE_AUTO_MODE_SERVER: '' }, true, null],
    ['env 已写 null', { ANTHROPIC_BASE_URL: TP, CLAUDE_CODE_AUTO_MODE_SERVER: null }, true, null],
    ['env 不是对象', 'x', true, null],
    ['env 为 null', null, true, null],
  ]) {
    assert.equal(autoModeServerInjection(se, on), want, `autoModeServerInjection:${label}`);
  }

  // ── 纯函数:分类器模型注入规则(r151j) ───────────────────────────────────────
  for (const [label, se, on, want] of [
    ['第三方 + 开 + 有 sonnet', { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, true, 'deepseek-flash'],
    ['含 anthropic.com 字样但主机不是官方的中转 + 开 + 有 sonnet',
      { ANTHROPIC_BASE_URL: 'https://anthropic.com.relay.example/v1', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, true, 'deepseek-flash'],
    ['第三方 + 关', { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, false, null],
    ['第三方 + 开关值不是布尔', { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, 'true', null],
    ['没有 BASE_URL + 开', { ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, true, null],
    ['BASE_URL 空串 + 开', { ANTHROPIC_BASE_URL: '', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, true, null],
    ['BASE_URL 不是字符串 + 开', { ANTHROPIC_BASE_URL: 42, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, true, null],
    ['官方地址 + 开', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, true, null],
    ['官方子域 + 开', { ANTHROPIC_BASE_URL: 'https://foo.anthropic.com/v1', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' }, true, null],
    ['sonnet 空串', { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: '' }, true, null],
    ['sonnet 不是字符串', { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 42 }, true, null],
    ['没有 sonnet', { ANTHROPIC_BASE_URL: TP }, true, null],
    // r151q:sonnet 档在不可用名单里不注入(CLI 2.1.306 实测会改用内置 claude-sonnet-5)
    ['sonnet 是 claude-sonnet-5-5', { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5' }, true, null],
    ['sonnet 是 Claude-Opus-5-5[1m]', { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'Claude-Opus-5-5[1m]' }, true, null],
    ['sonnet 是 claude-sonnet-5(不在名单)', { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5' }, true, 'claude-sonnet-5'],
    ['env 已写分类器模型 "user-pick"',
      { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash', CLAUDE_CODE_AUTO_MODE_MODEL: 'user-pick' }, true, null],
    ['env 已写分类器模型空串',
      { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash', CLAUDE_CODE_AUTO_MODE_MODEL: '' }, true, null],
    ['env 已写分类器模型 null',
      { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash', CLAUDE_CODE_AUTO_MODE_MODEL: null }, true, null],
    ['env 不是对象', 'x', true, null],
    ['env 是数组', [], true, null],
    ['env 为 null', null, true, null],
  ]) {
    assert.equal(autoModeModelInjection(se, on), want, `autoModeModelInjection:${label}`);
  }

  // ── 开关的同步读取 ──────────────────────────────────────────────────────────
  for (const [label, prefs, want] of [
    ['文件不存在', null, false], ['键缺失', { a: 1 }, false], ['true', { thirdPartyAuto: true }, true],
    ['false', { thirdPartyAuto: false }, false], ['字符串 "true"', { thirdPartyAuto: 'true' }, false],
    ['1', { thirdPartyAuto: 1 }, false], ['损坏', '{bad', false], ['顶层是数组', '[true]', false], ['顶层是 null', 'null', false],
  ]) {
    setPrefs(prefs);
    assert.equal(readThirdPartyAutoSync(), want, `readThirdPartyAutoSync:${label}`);
  }

  // ── cleanChildEnv 端到端(宿主环境故意带着同名键,验证先剥后判) ─────────────
  process.env.CLAUDE_CODE_AUTO_MODE_SERVER = '1';
  const scenes = [
    ['第三方 + 开 + 没写', { env: { ANTHROPIC_BASE_URL: TP } }, { thirdPartyAuto: true }, '0'],
    ['第三方 + 开 + 已写 "1"', { env: { ANTHROPIC_BASE_URL: TP, CLAUDE_CODE_AUTO_MODE_SERVER: '1' } }, { thirdPartyAuto: true }, undefined],
    ['第三方 + 开 + 已写 "0"', { env: { ANTHROPIC_BASE_URL: TP, CLAUDE_CODE_AUTO_MODE_SERVER: '0' } }, { thirdPartyAuto: true }, undefined],
    ['第三方 + 关', { env: { ANTHROPIC_BASE_URL: TP } }, { thirdPartyAuto: false }, undefined],
    ['第三方 + 没有 prefs.json', { env: { ANTHROPIC_BASE_URL: TP } }, null, undefined],
    ['官方(没有 BASE_URL)+ 开', { env: {} }, { thirdPartyAuto: true }, undefined],
    ['官方地址 + 开', { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }, { thirdPartyAuto: true }, undefined],
    ['settings.json 损坏 + 开', '{bad', { thirdPartyAuto: true }, undefined],
    ['settings.json 不存在 + 开', null, { thirdPartyAuto: true }, undefined],
  ];
  for (const [label, settings, prefs, want] of scenes) {
    setSettings(settings); setPrefs(prefs);
    const env = cleanChildEnv();
    if (want === undefined) assert.ok(!hasKey(env), `cleanChildEnv ${label}:不应有该键(得到 ${env.CLAUDE_CODE_AUTO_MODE_SERVER})`);
    else assert.equal(env.CLAUDE_CODE_AUTO_MODE_SERVER, want, `cleanChildEnv ${label}`);
  }
  // 开过再关:之后新起的进程环境里没有
  setSettings({ env: { ANTHROPIC_BASE_URL: TP } });
  setPrefs({ thirdPartyAuto: true });
  assert.equal(cleanChildEnv().CLAUDE_CODE_AUTO_MODE_SERVER, '0', '开着时注入');
  setPrefs({ thirdPartyAuto: false });
  assert.ok(!hasKey(cleanChildEnv()), '关掉之后不再注入');
  // 归因头的既有规则不受影响
  setSettings({ env: { ANTHROPIC_BASE_URL: TP } }); setPrefs({ thirdPartyAuto: true });
  assert.equal(cleanChildEnv().CLAUDE_CODE_ATTRIBUTION_HEADER, '0', '归因头既有注入照旧');

  // ── 分类器模型端到端(r151j):第三方 + 开 + settings 的 sonnet 档 → 注入为分类器模型 ──────
  // 宿主的同名键(claude-opus-4-6[1m],另一台机器实际拿去做分类器的值)在上面就已设好:
  // 下面每条"没有该键"同时验证它被 stripHostClaudeEnv 先剥掉、不会漏给子进程。
  const ammScenes = [
    ['第三方 + 开 + settings 有 sonnet',
      { env: { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' } }, { thirdPartyAuto: true }, 'deepseek-flash'],
    ['第三方 + 关(宿主同名键不得漏下去)',
      { env: { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' } }, { thirdPartyAuto: false }, undefined],
    ['第三方 + 没有 prefs.json',
      { env: { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' } }, null, undefined],
    ['官方(没有 BASE_URL)+ 开',
      { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' } }, { thirdPartyAuto: true }, undefined],
    ['官方地址 + 开',
      { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash' } }, { thirdPartyAuto: true }, undefined],
    ['第三方 + 开 + 用户显式写了分类器模型',
      { env: { ANTHROPIC_BASE_URL: TP, ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash', CLAUDE_CODE_AUTO_MODE_MODEL: 'user-pick' } }, { thirdPartyAuto: true }, undefined],
    ['第三方 + 开 + 没设 sonnet',
      { env: { ANTHROPIC_BASE_URL: TP } }, { thirdPartyAuto: true }, undefined],
  ];
  for (const [label, settings, prefs, want] of ammScenes) {
    setSettings(settings); setPrefs(prefs);
    const env = cleanChildEnv();
    if (want === undefined) assert.ok(!hasAmm(env), `cleanChildEnv ${label}:不应有分类器模型键(得到 ${env.CLAUDE_CODE_AUTO_MODE_MODEL})`);
    else {
      assert.equal(env.CLAUDE_CODE_AUTO_MODE_MODEL, want, `cleanChildEnv ${label}`);
      // 同一个开关下服务端审核通道照旧关掉(既有规则不受影响)
      assert.equal(env.CLAUDE_CODE_AUTO_MODE_SERVER, '0', `cleanChildEnv ${label}:CLAUDE_CODE_AUTO_MODE_SERVER`);
    }
  }

  // ── 复用兼容键:只在注入时多一项;官方 / 关时与不传该项逐字相同 ────────────
  const base = { workingDir: join(home, 'proj'), effort: 'high', appendSystemPrompt: '', promptSuggestions: false, globalRead: true, dirs: ['/'], maxBudgetUsd: null, acw: null, genui: true };
  const k0 = chatCompatKey({ ...base });
  assert.equal(chatCompatKey({ ...base, ams: undefined }), k0, '没有注入 → 键与改动前相同');
  assert.equal(chatCompatKey({ ...base, ams: null }), k0, 'null 等同没有注入');
  const kOn = chatCompatKey({ ...base, ams: '0' });
  assert.notEqual(kOn, k0, '注入了 → 键不同(开关翻转后下一条消息换新进程)');
  assert.ok(!k0.includes('"ams"'), '没有注入时键里没有这一项');
  assert.ok(kOn.includes('"ams":"0"'), '注入时键里带注入值');
  // r151j:分类器模型进键 —— 审核模型改了必须换新进程,否则旧进程继续用旧审核模型。
  assert.equal(chatCompatKey({ ...base, amm: undefined }), k0, 'amm 缺省 → 键与改动前逐字相同');
  assert.equal(chatCompatKey({ ...base, amm: null }), k0, 'amm null → 键与改动前逐字相同');
  assert.equal(chatCompatKey({ ...base, amm: '' }), k0, 'amm 空串(无值)→ 键与改动前逐字相同');
  const kAmm = chatCompatKey({ ...base, amm: 'deepseek-flash' });
  assert.notEqual(kAmm, k0, '注入了分类器模型 → 键不同');
  assert.ok(!k0.includes('"amm"'), '没注入时键里没有这一项');
  assert.ok(kAmm.includes('"amm":"deepseek-flash"'), '注入时键里带审核模型');
  assert.notEqual(chatCompatKey({ ...base, amm: 'model-a' }), chatCompatKey({ ...base, amm: 'model-b' }),
    '审核模型变了 → 键不同(下一条消息换新进程)');

  console.log('PASS check-r151a-env');
} finally {
  if (savedAms === undefined) delete process.env.CLAUDE_CODE_AUTO_MODE_SERVER; else process.env.CLAUDE_CODE_AUTO_MODE_SERVER = savedAms;
  if (savedAmm === undefined) delete process.env.CLAUDE_CODE_AUTO_MODE_MODEL; else process.env.CLAUDE_CODE_AUTO_MODE_MODEL = savedAmm;
  process.env.HOME = REAL_HOME;
  if (REAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_PROFILE;
  rmSync(home, { recursive: true, force: true });
}
