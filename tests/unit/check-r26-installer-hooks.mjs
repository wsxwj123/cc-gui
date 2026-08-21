#!/usr/bin/env node
// r26-A2【单测】:NSIS 钩子杀旧进程名恒落空 → 新旧名双杀 + 文案同步。
// 背景:installer-hooks.nsh 的 taskkill /IM "Claude GUI.exe" 针对的是旧名;productName
// 已是 CC-GUI 且未设 mainBinaryName,主程序是 CC-GUI.exe,旧名恒落空 → 残留进程树
// 占着安装目录的 cwd(node),Windows 覆盖安装报"无法 write"。
// 修复(PLAN A2):①装前钩子新旧名都杀(升级路径正是从旧名版本来,旧机器可能还跑着
// "Claude GUI.exe";杀不到 = 没残留,幂等无害);②MessageBox 文案 "Claude GUI" →
// "CC-GUI";③:40 注释的 Get-Process 手工验证步骤同步改。
// NSIS 无法本机跑,按 PLAN 口径做文本哨兵 + 区段白名单断言。
// Run: node tests/unit/check-r26-installer-hooks.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src-tauri/installer-hooks.nsh', import.meta.url), 'utf8');

// ①②装前钩子区内:CC-GUI.exe 与 Claude GUI.exe 两条 taskkill 同时在(漏一行即红)。
{
  const start = src.indexOf('!macro NSIS_HOOK_PREINSTALL');
  const end = src.indexOf('!macroend', start);
  assert.ok(start > 0 && end > start, 'A2: PREINSTALL 宏定位失败(锚漂移需换锚)');
  const pre = src.slice(start, end);
  assert.match(pre, /taskkill \/F \/T \/IM "CC-GUI\.exe"/,
    'A2: 缺少 taskkill /F /T /IM "CC-GUI.exe"(新名主程序,改名前此行恒落空)');
  assert.match(pre, /taskkill \/F \/T \/IM "Claude GUI\.exe"/,
    'A2: 缺少 taskkill /F /T /IM "Claude GUI.exe"(旧名须保留:升级路径正从旧版本来)');
  // 新名在前旧名在后(顺序哨兵:先杀现行名)
  assert.ok(pre.indexOf('"CC-GUI.exe"') < pre.indexOf('"Claude GUI.exe"'),
    'A2: 应先杀新名 CC-GUI.exe 再杀旧名');
}

// ③MessageBox 区段(cgui_node_missing: 到 cgui_node_ok: 标签定义之间)零出现旧名。
{
  const start = src.indexOf('cgui_node_missing:');
  const end = src.indexOf('\n  cgui_node_ok:');
  assert.ok(start > 0 && end > start, 'A2: MessageBox 区段定位失败(锚漂移需换锚)');
  const section = src.slice(start, end);
  assert.ok(!section.includes('Claude GUI'),
    'A2: MessageBox 区段仍残留旧名 "Claude GUI"(文案应同步为 CC-GUI)');
  assert.match(section, /CC-GUI 需要 Node\.js/, 'A2: MessageBox 文案应为 CC-GUI 新名');
}

// ④整文件其余位置的 "Claude GUI" 仅允许出现在:杀旧名行 或 注释区(; 开头)。
// 区段外新出现即红。
{
  const offenders = [];
  src.split('\n').forEach((line, i) => {
    if (!line.includes('Claude GUI')) return;
    const trimmed = line.trim();
    const isComment = trimmed.startsWith(';');
    const isKillOldName = /taskkill \/F \/T \/IM "Claude GUI\.exe"/.test(line);
    if (!isComment && !isKillOldName) offenders.push(`L${i + 1}: ${trimmed}`);
  });
  assert.deepEqual(offenders, [],
    'A2: 旧名 "Claude GUI" 只允许出现在杀旧名 taskkill 行与注释区,越界出现:\n' + offenders.join('\n'));
}

// ⑤手工验证注释同步哨兵::40 附近的 Get-Process 验证步骤应查新名。
{
  const start = src.indexOf('; 本机手工验证');
  const end = src.indexOf('!macro NSIS_HOOK_POSTINSTALL');
  assert.ok(start > 0 && end > start, 'A2: 手工验证注释段定位失败');
  const section = src.slice(start, end);
  assert.match(section, /Get-Process 'CC-GUI'/, 'A2: 手工验证注释的 Get-Process 应同步为新名 CC-GUI');
  assert.ok(!section.includes("Get-Process 'Claude GUI'"),
    'A2: 手工验证注释仍让查旧名进程(验证步骤会误导)');
}

console.log('PASS check-r26-installer-hooks');
