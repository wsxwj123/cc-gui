#!/usr/bin/env node
// r154 —— 电脑操控「禁止操控」名单 + 授权 id 校验(纯函数,平台参数注入;不碰家目录、不起进程)。
//
// 锁的是:
//   M7 win32 下终端 / CC-GUI 自身的 exe 路径(大小写、分隔符各种写法)被判禁止,notepad 不被判;
//      darwin 下同样的 exe 路径不被判(Windows 口径不外溢到 mac);
//      名单里的 CC-GUI 身份与打包配置对齐(tauri.conf.json identifier、Cargo 包名 + .exe),改名即红;
//   macOS bundleId 不区分大小写 + 变体前缀;授权 id 的输入校验(逗号 / 控制符 / 零宽 / 字符集)。
//
// 跑法:node tests/unit/check-r154-forbidden-apps.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_CATEGORIES, forbiddenAppReason, forbiddenCategoryLabels,
} from '../../server/computer-use/forbidden-apps.js';
import { appGranted, effectiveGrants, normalizeAppIdForGrant } from '../../server/computer-use/cu-common.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
let failed = 0;
function check(id, title, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${id} ${title}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${id} ${title}\n     ${e.message}`);
  }
}

const WIN_FORBIDDEN = [
  'C:\\WINDOWS\\System32\\CMD.EXE',
  'c:/windows/system32/WindowsPowerShell/v1.0/powershell.exe',
  'C:\\Program Files\\CC-GUI\\claude-gui.exe',
];
const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';

check('M7-1', 'win32:cmd / powershell / claude-gui.exe 的各种写法被判禁止', () => {
  for (const p of WIN_FORBIDDEN) assert.ok(forbiddenAppReason(p, 'win32'), `${p} 应被判禁止`);
  assert.equal(forbiddenAppReason(WIN_FORBIDDEN[0], 'win32').category, 'terminal');
  assert.equal(forbiddenAppReason(WIN_FORBIDDEN[2], 'win32').category, 'self');
  assert.equal(forbiddenAppReason('c:\\\\windows\\\\system32\\\\cmd.exe\\', 'win32')?.category, 'terminal', '重复分隔符 / 尾分隔符');
});

check('M7-2', 'win32:notepad.exe 不被判禁止', () => {
  assert.equal(forbiddenAppReason(NOTEPAD, 'win32'), null);
  assert.equal(forbiddenAppReason('C:\\tools\\cmdline-helper.exe', 'win32'), null, '只按完整文件名比,不按子串');
});

check('M7-3', 'darwin:同样的 exe 路径不被判禁止', () => {
  for (const p of [...WIN_FORBIDDEN, NOTEPAD]) assert.equal(forbiddenAppReason(p, 'darwin'), null, p);
});

check('M7-4', 'CC-GUI 身份与 tauri.conf.json identifier、Cargo 包名对齐', () => {
  const conf = JSON.parse(fs.readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.ok(FORBIDDEN_CATEGORIES.self.macIds.includes(conf.identifier), `名单须含 identifier ${conf.identifier}`);
  assert.ok(FORBIDDEN_CATEGORIES.self.macPrefixes.includes(`${conf.identifier}.`), '变体前缀须是 identifier + "."');
  const cargo = fs.readFileSync(join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8');
  const pkgName = cargo.split(/\[package\]/)[1]?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(pkgName, 'Cargo.toml 里应能读到 [package] name');
  assert.ok(FORBIDDEN_CATEGORIES.self.winExeNames.includes(pkgName), `Windows 名单须含 ${pkgName}`);
  assert.equal(forbiddenAppReason(`C:\\x\\${pkgName}.exe`, 'win32')?.category, 'self');
});

check('MAC-1', 'darwin:bundleId 不区分大小写、去首尾空白;CC-GUI 变体按前缀', () => {
  assert.equal(forbiddenAppReason('com.apple.Terminal', 'darwin')?.category, 'terminal');
  assert.equal(forbiddenAppReason('COM.APPLE.TERMINAL', 'darwin')?.category, 'terminal');
  assert.equal(forbiddenAppReason('  com.apple.terminal ', 'darwin')?.category, 'terminal');
  assert.equal(forbiddenAppReason('com.claudegui.desktop', 'darwin')?.category, 'self');
  assert.equal(forbiddenAppReason('com.claudegui.desktop.ds', 'darwin')?.category, 'self');
  assert.equal(forbiddenAppReason('com.apple.systempreferences', 'darwin')?.category, 'system');
  assert.equal(forbiddenAppReason('com.1password.1password', 'darwin')?.category, 'secrets');
  assert.equal(forbiddenAppReason('com.claudegui.desktopx', 'darwin'), null, '前缀必须带点');
  assert.equal(forbiddenAppReason('com.apple.TextEdit', 'darwin'), null);
  assert.equal(forbiddenAppReason('', 'darwin'), null);
  assert.equal(forbiddenAppReason(null, 'darwin'), null);
  assert.equal(forbiddenAppReason(123, 'win32'), null);
});

check('MAC-2', '类别标签文案:四类都在,结果带 label', () => {
  const labels = forbiddenCategoryLabels();
  for (const def of Object.values(FORBIDDEN_CATEGORIES)) assert.ok(labels.includes(def.label));
  assert.equal(forbiddenAppReason('com.apple.Terminal', 'darwin').label, FORBIDDEN_CATEGORIES.terminal.label);
});

check('ID-1', 'normalizeAppIdForGrant:合法 id 去空白 + NFC', () => {
  assert.deepEqual(normalizeAppIdForGrant('  com.apple.TextEdit ', 'darwin'), { ok: true, id: 'com.apple.TextEdit' });
  assert.deepEqual(normalizeAppIdForGrant(NOTEPAD, 'win32'), { ok: true, id: NOTEPAD });
  const decomposed = 'C:\\Apps\\cafe\u0301.exe';
  assert.equal(normalizeAppIdForGrant(decomposed, 'win32').id, decomposed.normalize('NFC'));
  assert.equal(normalizeAppIdForGrant('C:\\Program Files (x86)\\App\\a.exe', 'win32').ok, true, 'Windows 不套字符集');
});

check('ID-2', 'normalizeAppIdForGrant:非法输入拒绝', () => {
  const bad = [
    [123, 'darwin'], ['', 'darwin'], ['   ', 'darwin'], ['a'.repeat(201), 'darwin'],
    ['a,b', 'darwin'], ['a,b', 'win32'], ['a\nb', 'darwin'], ['a\nb', 'win32'], ['a\u0000b', 'win32'],
    ['a\u200bb', 'darwin'], ['a\u200bb', 'win32'], ['a\u2028b', 'win32'], ['a\ufeffb', 'win32'],
    ['com.apple.Text Edit', 'darwin'], ['com.apple/TextEdit', 'darwin'], ['cömpany.app', 'darwin'],
  ];
  for (const [input, platformName] of bad) {
    const r = normalizeAppIdForGrant(input, platformName);
    assert.equal(r.ok, false, `${JSON.stringify(input)}@${platformName} 应被拒`);
    assert.equal(typeof r.error, 'string');
  }
  assert.equal(normalizeAppIdForGrant('a'.repeat(200), 'darwin').ok, true, '200 字符恰好允许');
});

check('EG-1', 'effectiveGrants 去掉禁止类别、不改原对象;appGranted 对禁止类别恒 false', () => {
  const grants = {
    version: 1, screenScope: { granted: true, grantedAt: 't' },
    apps: {
      'com.apple.Terminal': { name: 'Terminal', grantedAt: 't' },
      'com.claudegui.desktop.ds': { name: 'DS', grantedAt: 't' },
      'com.apple.TextEdit': { name: 'TextEdit', grantedAt: 't' },
    },
  };
  const eff = effectiveGrants(grants, 'darwin');
  assert.deepEqual(Object.keys(eff.apps), ['com.apple.TextEdit']);
  assert.equal(eff.screenScope.granted, true);
  assert.equal(Object.keys(grants.apps).length, 3, '原对象不变');
  assert.equal(appGranted(grants, 'com.apple.Terminal', 'darwin'), false);
  assert.equal(appGranted(grants, 'COM.APPLE.TERMINAL', 'darwin'), false);
  assert.equal(appGranted(grants, 'com.claudegui.desktop.ds', 'darwin'), false);
  assert.equal(appGranted(grants, 'com.apple.TextEdit', 'darwin'), true);
  const win = { apps: { 'C:\\Windows\\System32\\cmd.exe': {}, 'C:\\Windows\\System32\\notepad.exe': {} } };
  assert.deepEqual(Object.keys(effectiveGrants(win, 'win32').apps), ['C:\\Windows\\System32\\notepad.exe']);
  assert.equal(appGranted(win, 'c:/windows/system32/CMD.exe', 'win32'), false);
  assert.equal(appGranted(win, 'c:/windows/system32/notepad.exe', 'win32'), true);
  assert.deepEqual(effectiveGrants(null).apps, {});
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
