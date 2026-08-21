#!/usr/bin/env node
// r26-A1【单测】:安装包清理白名单正则只认旧名 → 新旧名并容。
// 背景:download-update.js 的 INSTALLER_NAME_RE 原为 /^Claude[ ._]GUI[ ._-].../,而
// productName 已是 CC-GUI,CI 产物为 CC-GUI_x.y.z_aarch64.dmg / CC-GUI_x.y.z_x64-setup.exe
// 形态 —— 新名安装包过不了白名单,/update-cleanup/delete 恒 400 且记录被一并吞掉,
// 用户永远清不掉。修复:正则改为 /^(CC-GUI|Claude[ ._]GUI)[ ._-].../ 新旧名并容
// (旧名分支保留:用户 Downloads 里可能躺着改名前下载的旧包)。
// 验收点(PLAN A1):真实文件名字符串矩阵驱动从源码里抽出的真实正则。
// Run: node tests/unit/check-r26-update-cleanup-re.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 从源码抽出真实的 INSTALLER_NAME_RE 字面量(不是复刻 —— 改源码正则这里直接跟着变,
// 防「测试复刻了一份旧正则照样绿」的假哨兵)。
const src = readFileSync(new URL('../../server/routes/download-update.js', import.meta.url), 'utf8');
const m = src.match(/const INSTALLER_NAME_RE = (\/[^\n]+\/[a-z]*);/);
assert.ok(m, 'A1: 未在 download-update.js 找到 INSTALLER_NAME_RE 定义(锚漂移需换锚)');
const INSTALLER_NAME_RE = eval(m[1]);
assert.ok(INSTALLER_NAME_RE instanceof RegExp, 'A1: 抽出的不是正则字面量');

// ── 须过(白名单命中)────────────────────────────────────────────
const ACCEPT = [
  'CC-GUI_0.2.318_aarch64.dmg',        // 新名 mac 包(CI 实际产物形态)
  'CC-GUI_0.2.318_x64-setup.exe',      // 新名 Windows 包
  'CC-GUI_0.2.318_x64_en-US.msi',      // 新名 msi
  'Claude.GUI_0.2.300_aarch64.dmg',    // 旧名 GitHub 资产名(. 分隔)
  'Claude.GUI_0.2.287_x64.exe',        // 旧名 exe
  'Claude GUI_0.2.287_x64-setup.exe',  // 旧名带空格(未 sanitize 的原始名)
  'cc-gui_0.2.318_aarch64.dmg',        // i 旗标:大小写不敏感
  'CC-GUI_0.2.318_aarch64-1.dmg',      // 重名追加 -N 后缀形态
];
for (const name of ACCEPT) {
  assert.ok(INSTALLER_NAME_RE.test(name), `A1: 合法安装包名被拒: ${name}`);
}

// ── 须拒(白名单不命中)──────────────────────────────────────────
const REJECT = [
  'CC-GUI2_x.dmg',          // 钉住 [ ._-] 边界:名字段后必须紧跟分隔符
  'CC-GUI.dmg',             // 无版本段:唯一的 . 被分隔符吃掉后余下无 .dmg 可匹配
  'evil.dmg',               // 无关文件名
  'evil.exe',
  'CC-GUI.dmg.txt',         // 后缀必须是 dmg/exe/msi 结尾
  'CC-GUI_0.2.318.zip',     // 非安装包扩展名
  'xCC-GUI_0.2.318.dmg',    // ^ 锚:前缀不得有杂质
];
for (const name of REJECT) {
  assert.ok(!INSTALLER_NAME_RE.test(name), `A1: 非法文件名被放行: ${name}`);
}

// ── 端点接线哨兵:delete 路由确实用这同一个正则做白名单 ─────────
assert.match(src, /!INSTALLER_NAME_RE\.test\(basename\(rec\.path\)\)/,
  'A1: /update-cleanup/delete 的白名单校验未使用 INSTALLER_NAME_RE(接线被改需换锚)');

console.log('PASS check-r26-update-cleanup-re');
