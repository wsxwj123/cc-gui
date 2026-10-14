#!/usr/bin/env node
// r151a T-Y2:GUI 起 CLI 会话进程时的 CLAUDE_CODE_AUTO_MODE_SERVER(INTERFACE Y.3.2 后半)。
//   第三方地址 + 第三方 auto 总开关开 + settings.json 的 env 没写这个键 → 传入 "0"(关掉服务端审核通道:
//   第三方端点用不上,且首个主请求会带 safeguards —— 内含家目录等本机路径);其余情况一律不传
//   (开关关 = 与改动前逐字相同)。宿主自己的同名键先被剥掉。注入值进复用兼容键,只在注入时出现。
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
const { autoModeServerInjection } = await import('../../server/services/auto-audit.js');
const { readThirdPartyAutoSync } = await import('../../server/routes/prefs.js');

const SETTINGS = join(home, '.claude', 'settings.json');
const PREFS = join(home, '.claude-gui', 'prefs.json');
const setSettings = (obj) => { if (obj === null) rmSync(SETTINGS, { force: true }); else writeFileSync(SETTINGS, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const setPrefs = (obj) => { if (obj === null) rmSync(PREFS, { force: true }); else writeFileSync(PREFS, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const TP = 'http://127.0.0.1:8788';
const hasKey = (o) => Object.prototype.hasOwnProperty.call(o, 'CLAUDE_CODE_AUTO_MODE_SERVER');

const savedAms = process.env.CLAUDE_CODE_AUTO_MODE_SERVER;
try {
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

  // ── 复用兼容键:只在注入时多一项;官方 / 关时与不传该项逐字相同 ────────────
  const base = { workingDir: join(home, 'proj'), effort: 'high', appendSystemPrompt: '', promptSuggestions: false, globalRead: true, dirs: ['/'], maxBudgetUsd: null, acw: null, genui: true };
  const k0 = chatCompatKey({ ...base });
  assert.equal(chatCompatKey({ ...base, ams: undefined }), k0, '没有注入 → 键与改动前相同');
  assert.equal(chatCompatKey({ ...base, ams: null }), k0, 'null 等同没有注入');
  const kOn = chatCompatKey({ ...base, ams: '0' });
  assert.notEqual(kOn, k0, '注入了 → 键不同(开关翻转后下一条消息换新进程)');
  assert.ok(!k0.includes('"ams"'), '没有注入时键里没有这一项');
  assert.ok(kOn.includes('"ams":"0"'), '注入时键里带注入值');

  console.log('PASS check-r151a-env');
} finally {
  if (savedAms === undefined) delete process.env.CLAUDE_CODE_AUTO_MODE_SERVER; else process.env.CLAUDE_CODE_AUTO_MODE_SERVER = savedAms;
  process.env.HOME = REAL_HOME;
  if (REAL_PROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_PROFILE;
  rmSync(home, { recursive: true, force: true });
}
