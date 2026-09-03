#!/usr/bin/env node
// r106 开发自测:Windows 上 npm 装的 claude(<prefix>\claude.cmd)要能被 SDK 用上 ——
// 经 npm 布局推出包内真二进制 <prefix>\node_modules\@anthropic-ai\claude-code\bin\claude.exe。
// 旧行为:非 .exe 一律返 null → SDK 回落自带的 2.1.191 → 不认 --system-prompt-snapshot →
// 系统提示每次冷启重算 → 第三方缓存命中率忽高忽低(本轮根因)。
// 变异哨兵:把 resolveSdkClaudeFrom 里的 isWinPeFile 判定删掉 → "文本占位 exe 返 null" 必红。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSdkClaudeFrom, logSdkClaudeOnce } from '../../server/utils/claude-resolver.js';

const root = mkdtempSync(join(tmpdir(), 'cgui-r106-'));
const PE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);          // 真 PE 头
const STUB = '#!/usr/bin/env node\nconsole.error("native binary not installed");\n'; // 壳包初始占位

// npm 全局布局(Windows 平铺):<prefix>\claude.cmd + <prefix>\node_modules\@anthropic-ai\claude-code\
function mkNpmPrefix(name, { binKind, installCjs = true } = {}) {
  const prefix = join(root, name);
  const pkg = join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(prefix, 'claude.cmd'), '@echo off\r\nnode "%~dp0\\node_modules\\...\\cli.js" %*\r\n');
  if (installCjs) writeFileSync(join(pkg, 'install.cjs'), '// bootstrap installer\n');
  if (binKind === 'binary') writeFileSync(join(pkg, 'bin', 'claude.exe'), PE);
  if (binKind === 'text') writeFileSync(join(pkg, 'bin', 'claude.exe'), STUB);
  return { shim: join(prefix, 'claude.cmd'), exe: join(pkg, 'bin', 'claude.exe') };
}

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n       ${e.message}`); }
};

check('① .cmd shim + 包内真 PE → 返回包内 claude.exe(SDK 能直接 spawn)', () => {
  const { shim, exe } = mkNpmPrefix('good', { binKind: 'binary' });
  assert.equal(resolveSdkClaudeFrom(shim, { platform: 'win32' }), exe);
});

check('②a 包内 exe 是文本占位(postinstall 没落真二进制)→ null,保持 SDK 回落', () => {
  const { shim } = mkNpmPrefix('broken-text', { binKind: 'text' });
  assert.equal(resolveSdkClaudeFrom(shim, { platform: 'win32' }), null);
});

check('②b 包目录在但 bin\\claude.exe 缺失 → null', () => {
  const { shim } = mkNpmPrefix('broken-missing', { binKind: null });
  assert.equal(resolveSdkClaudeFrom(shim, { platform: 'win32' }), null);
});

check('②c 非壳包(无 install.cjs)也照样按文件头判:真 PE 认、文本不认', () => {
  const okPkg = mkNpmPrefix('old-good', { binKind: 'binary', installCjs: false });
  assert.equal(resolveSdkClaudeFrom(okPkg.shim, { platform: 'win32' }), okPkg.exe);
  const badPkg = mkNpmPrefix('old-bad', { binKind: 'text', installCjs: false });
  assert.equal(resolveSdkClaudeFrom(badPkg.shim, { platform: 'win32' }), null);
});

check('②d 文件头不是 MZ 一律 null(Mach-O/ELF 在 Windows 上照样起不来)', () => {
  for (const [name, head] of [
    ['macho', Buffer.from([0xCF, 0xFA, 0xED, 0xFE, 0x0C, 0, 0, 1])],
    ['elf', Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0x02, 1, 1, 0])],
    ['empty', Buffer.alloc(0)],
    ['one-byte', Buffer.from('M')],
  ]) {
    const { shim, exe } = mkNpmPrefix(`head-${name}`, { binKind: null, installCjs: false });
    writeFileSync(exe, head);
    assert.equal(resolveSdkClaudeFrom(shim, { platform: 'win32' }), null, `${name} 头被当成可执行`);
  }
  // 注入版同样只认 MZ
  const fake = { platform: 'win32', existsSync: () => true, readFileSync: () => Buffer.from([0x7F, 0x45, 0x4C, 0x46]) };
  assert.equal(resolveSdkClaudeFrom('C:\\npm\\claude.cmd', fake), null);
});

check('③ 压根没有 npm 包目录的裸 shim → null(不瞎编路径)', () => {
  const lone = join(root, 'lonely', 'claude.cmd');
  mkdirSync(join(root, 'lonely'), { recursive: true });
  writeFileSync(lone, '@echo off\r\n');
  assert.equal(resolveSdkClaudeFrom(lone, { platform: 'win32' }), null);
});

check('④ mac/linux 行为不变:原样返回,不去碰 npm 布局', () => {
  assert.equal(resolveSdkClaudeFrom('/opt/homebrew/bin/claude', { platform: 'darwin' }), '/opt/homebrew/bin/claude');
  assert.equal(resolveSdkClaudeFrom('/home/u/.local/bin/claude', { platform: 'linux' }), '/home/u/.local/bin/claude');
  assert.equal(resolveSdkClaudeFrom('', { platform: 'darwin' }), null);
  assert.equal(resolveSdkClaudeFrom(null, { platform: 'darwin' }), null);
});

check('⑤ Windows 上本来就是 .exe(原生安装器)→ 原样返回,不改道', () => {
  assert.equal(resolveSdkClaudeFrom('C:\\Users\\me\\.local\\bin\\claude.exe', { platform: 'win32' }),
    'C:\\Users\\me\\.local\\bin\\claude.exe');
});

check('⑥ existsSync/readFileSync 全注入(不落地任何真文件)也成立', () => {
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
  const pkg = 'C:/Users/me/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code';
  const exe = join(pkg, 'bin', 'claude.exe');
  const fs = { [pkg]: true, [exe]: true };
  assert.equal(resolveSdkClaudeFrom(shim, {
    platform: 'win32', existsSync: (p) => !!fs[p], readFileSync: () => PE,
  }), exe);
  // 同一布局,文件头是文本 → null
  assert.equal(resolveSdkClaudeFrom(shim, {
    platform: 'win32', existsSync: (p) => !!fs[p], readFileSync: () => Buffer.from(STUB),
  }), null);
});

check('⑦ logSdkClaudeOnce:同一路径只打一次;空路径明说走 SDK 自带 CLI', () => {
  const lines = [];
  logSdkClaudeOnce('', (s) => lines.push(s));
  logSdkClaudeOnce('', (s) => lines.push(s));
  assert.equal(lines.length, 1, '同一路径重复打日志(每条消息刷屏)');
  assert.ok(/SDK 自带 CLI/.test(lines[0]), lines[0]);
});

check('⑧ 面板在 Windows 上多给一句可行动指引(端点回 platform,前端据此显示)', () => {
  const settingsSrc = readFileSync(new URL('../../server/routes/settings.js', import.meta.url), 'utf8');
  const panelSrc = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  assert.ok(/platform: process\.platform,/.test(settingsSrc), '/api/prompt-cache 未回 platform');
  assert.ok(/SDK 自带的 claude 运行/.test(panelSrc), '原有成因说明被删');
  assert.ok(/state\.platform === 'win32'/.test(panelSrc), '指引没按平台门控(mac 用户会看到 Windows 路径)');
  assert.ok(panelSrc.includes('npm\\\\node_modules\\\\@anthropic-ai\\\\claude-code\\\\bin\\\\claude.exe'), '指引里缺真二进制路径');
  assert.ok(/npm 安装器重装.*官方原生安装器/.test(panelSrc), '指引没说怎么修');
});

rmSync(root, { recursive: true, force: true });
if (failed) { console.error(`\n❌ r106 resolver 自测 ${failed} 项失败`); process.exit(1); }
console.log('\n✅ r106 resolver 自测全绿');
