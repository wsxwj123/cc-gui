#!/usr/bin/env node
// 【单测】NSIS 装前钩子杀的进程名必须是真实主程序名。
//
// 事故:此前这里杀的是 "CC-GUI.exe"(和旧名 "Claude GUI.exe"),两个名字机器上从来不存在
// —— Tauri 未设 mainBinaryName 时用 **Cargo 包名** 做二进制名(src-tauri/Cargo.toml 的
// name = claude-gui,自 918cdcd 建壳起没改过),productName(CC-GUI)只决定安装目录与显示名。
// 2026-08-26 Windows 真机取证:%LOCALAPPDATA%\CC-GUI\ 下就是 claude-gui.exe。
// 整条主杀一直空转,覆盖安装报"无法 write"时真正起作用的只有第 2 步的 CommandLine 匹配。
//
// 教训写进断言:名字不再从实现里抄,而是**从 Cargo.toml / tauri.conf.json 推导**——
// 将来谁改了 Cargo 包名或补了 mainBinaryName,这里立刻红,不会再出现"测试全绿但名字全错"。
// NSIS 无法本机跑,其余仍是文本哨兵 + 区段白名单断言。
// Run: node tests/unit/check-r26-installer-hooks.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src-tauri/installer-hooks.nsh', import.meta.url), 'utf8');
const cargo = readFileSync(new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8');
const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

// ⓪事实源:主程序名 = mainBinaryName ?? Cargo 包名。两者都变了这里会自己算出新名字。
const cargoName = (cargo.match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1];
assert.ok(cargoName, '定位 Cargo 包名失败(src-tauri/Cargo.toml 的 [package] name)');
const MAIN_EXE = (conf.mainBinaryName || cargoName) + '.exe';

// NSIS 注释以 ; 开头。注释里为了讲清事故会引用错误的旧名字、也会提到 MessageBox 这类
// 关键词,所以凡是断言"实际会执行什么"的地方一律先剥注释,只留指令行。
const codeOf = (text) => text.split('\n').filter((l) => !l.trim().startsWith(';')).join('\n');

// ①装前钩子区内必须按真实主程序名整树杀。
{
  const start = src.indexOf('!macro NSIS_HOOK_PREINSTALL');
  const end = src.indexOf('!macroend', start);
  assert.ok(start > 0 && end > start, 'PREINSTALL 宏定位失败(锚漂移需换锚)');
  const cmds = codeOf(src.slice(start, end));
  assert.ok(cmds.includes(`taskkill /F /T /IM "${MAIN_EXE}"`),
    `装前钩子应按真实主程序名整树杀:taskkill /F /T /IM "${MAIN_EXE}"\n` +
    '(主程序名来自 Cargo 包名 / mainBinaryName,不是 productName)');
  // 反向哨兵:productName 拼出来的名字是不存在的进程,杀它=空转,不许再出现。
  assert.ok(!cmds.includes(`"${conf.productName}.exe"`),
    `装前钩子不该杀 "${conf.productName}.exe" —— 这是 productName 拼的名字,` +
    '机器上没有这个进程,杀了等于没杀(本文件顶部的事故就是它)');
  assert.ok(!/taskkill[^\n]*"Claude GUI\.exe"/.test(cmds),
    '装前钩子不该杀 "Claude GUI.exe" —— Cargo 包名从未叫过这个,历史上就没存在过');
}

// ②CommandLine 兜底那步仍在(主杀之外唯一真正生效过的一步,别在重构里丢掉)。
{
  const start = src.indexOf('!macro NSIS_HOOK_PREINSTALL');
  const end = src.indexOf('!macroend', start);
  const pre = codeOf(src.slice(start, end));
  assert.match(pre, /Get-CimInstance Win32_Process/,
    '孤儿兜底(按 CommandLine 匹配 server\\index.js 杀残留 node)不能丢');
  assert.match(pre, /\$INSTDIR/, '孤儿兜底应限定在本次安装目录,避免误杀别的实例');
}

// ③MessageBox 区段(cgui_node_missing: 到 cgui_node_ok: 标签定义之间)用产品显示名 CC-GUI。
// 面向用户的文案该用 productName,与进程名无关——两者本就不是一回事,这正是事故的根。
{
  const start = src.indexOf('cgui_node_missing:');
  const end = src.indexOf('\n  cgui_node_ok:');
  assert.ok(start > 0 && end > start, 'MessageBox 区段定位失败(锚漂移需换锚)');
  const section = codeOf(src.slice(start, end));
  assert.ok(!section.includes('Claude GUI'),
    'MessageBox 区段仍残留旧名 "Claude GUI"(用户可见文案应为 CC-GUI)');
  assert.match(section, /CC-GUI 需要 Node\.js/, 'MessageBox 文案应为 CC-GUI 新名');
}

// ④静默安装下不许弹 MessageBox(/S 走 npm 启动器与应用内自动更新,模态框会把进程挂死)。
{
  const start = src.indexOf('cgui_node_missing:');
  const end = src.indexOf('\n  cgui_node_ok:');
  const section = codeOf(src.slice(start, end));
  assert.match(section, /IfSilent\s+cgui_node_ok/,
    '静默安装必须跳过 MessageBox:缺 IfSilent 会挂在用户看不见的模态框上');
  assert.ok(section.indexOf('IfSilent') < section.indexOf('MessageBox'),
    'IfSilent 必须在 MessageBox 之前');
}

// ⑤手工验证注释同步哨兵:让人去查的进程名要和真实名一致,否则验证步骤本身误导人。
{
  const start = src.indexOf('; 本机手工验证');
  const end = src.indexOf('!macro NSIS_HOOK_POSTINSTALL');
  assert.ok(start > 0 && end > start, '手工验证注释段定位失败');
  const section = src.slice(start, end);
  const procName = MAIN_EXE.replace(/\.exe$/i, '');
  assert.ok(section.includes(`Get-Process '${procName}'`),
    `手工验证注释应查真实进程名 Get-Process '${procName}'`);
  assert.ok(!section.includes(`Get-Process '${conf.productName}'`),
    `手工验证注释不该查 Get-Process '${conf.productName}'(该进程不存在,照做只会误判"已清干净")`);
}

console.log('PASS check-r26-installer-hooks');
