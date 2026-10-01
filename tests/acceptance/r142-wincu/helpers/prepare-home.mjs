#!/usr/bin/env node
// r142-wincu 夹具:把一个假家目录准备好(隔离实例用它当 HOME)。
//
//   node helpers/prepare-home.mjs <home> <worktree> [--no-venv]
//
// 造什么:
//   · .claude-gui/cu-runtime/<venv 目录>/<解释器>(**按 CGUI_TEST_PLATFORM 决定布局**)+ 依赖戳
//   · .claude.json 里登记 ccgui-computer-use(卡片只在 registered:true 时渲染授权区块)
//   · bin/{py,python,python3} 三个假解释器(让候选表找得到)
//   · scenario.json(假 helper 的剧本)/ argv.jsonl(调用记录)
//
// 平台布局(2026-10-02 修:裁判实测 --platform darwin 时 W-D03 报 CU_RUNTIME_UNAVAILABLE):
//   旧版只造 Windows 布局(venv-win/Scripts/python.exe),darwin 那遍的 runtimeReady() 恒 false ⇒
//   /doctor 直接回 CU_RUNTIME_UNAVAILABLE。现在**目录名/解释器相对路径/戳文件名/依赖表全部从产品
//   自己的纯函数取**(cu-common.js 的 venvDirFor/venvPyFor/stampFileFor/pyDepsFor/depsStampFor),
//   产品改名或换布局时这里自动跟随,不需要再手抄一份。
//
// 依 --no-venv / CU_PREPARE_NO_VENV=1:不预置 venv,用来验「准备环境」按钮与 POST /prepare。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [home, worktree] = process.argv.slice(2);
const noVenv = process.argv.includes('--no-venv') || process.env.CU_PREPARE_NO_VENV === '1';
if (!home || !worktree) { console.error('用法: prepare-home.mjs <home> <worktree> [--no-venv]'); process.exit(2); }

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(here, 'win-helper.mjs');
const platform = process.env.CGUI_TEST_PLATFORM || 'win32';

// 从产品源码取平台相关的四件事(不是从测试里手抄):目录名、解释器相对路径、戳文件名、依赖戳。
const cu = await import(pathToFileURL(path.join(worktree, 'server', 'computer-use', 'cu-common.js')).href);
const venvDirName = path.basename(cu.venvDirFor(platform));
const pyRel = path.relative(cu.venvDirFor(platform), cu.venvPyFor(platform));
const stampName = path.basename(cu.stampFileFor(platform));
const stamp = cu.depsStampFor(platform);

/** 假解释器:统一写成 `#!/bin/sh` 壳脚本(POSIX 可执行;绝不把 .mjs 拷成 .exe —— 那会 ERR_UNKNOWN_FILE_EXTENSION)。 */
function writeShim(file, pyName) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${pyName ? `CU_STUB_PYNAME=${pyName} ` : ''}exec "${process.execPath}" "${stub}" "$@"\n`);
  fs.chmodSync(file, 0o755);
}

fs.rmSync(home, { recursive: true, force: true });
const runtime = path.join(home, '.claude-gui', 'cu-runtime');
fs.mkdirSync(path.join(runtime, 'shots'), { recursive: true });

if (!noVenv) {
  writeShim(path.join(runtime, venvDirName, pyRel));
  fs.writeFileSync(path.join(runtime, venvDirName, 'pyvenv.cfg'), 'home = C:\\Fake\n');
  fs.writeFileSync(path.join(runtime, stampName), `${stamp}\n`);
}

// 候选解释器:win32 是 py -3 / python;posix 是 python3(顺带都放上,免得分支依赖手抄的清单)
const bin = path.join(home, 'bin');
for (const [name, pyName] of [['py', 'py'], ['python', 'python'], ['python3', 'python3']]) {
  writeShim(path.join(bin, name), pyName);
}

fs.writeFileSync(path.join(home, 'scenario.json'), '{}');
fs.writeFileSync(path.join(home, 'argv.jsonl'), '');
fs.writeFileSync(path.join(runtime, 'grants.json'), `${JSON.stringify({
  version: 1,
  screenScope: { granted: true, grantedAt: new Date().toISOString() },
  apps: {
    'C:\\Windows\\System32\\notepad.exe': { name: 'Notepad', grantedAt: new Date().toISOString() },
    'com.apple.TextEdit': { name: 'TextEdit', grantedAt: new Date().toISOString() },
  },
}, null, 2)}\n`);

// 注册项:面板的「应用授权」区块前置条件(MCPPanel 只在 registered 时渲染)
fs.writeFileSync(path.join(home, '.claude.json'), `${JSON.stringify({
  mcpServers: {
    'ccgui-computer-use': {
      type: 'stdio',
      command: process.execPath,
      args: [path.join(worktree, 'server', 'computer-use', 'mcp-server.js')],
    },
  },
}, null, 2)}\n`);

console.log(`[r142-wincu] 夹具家目录就绪:${home}(平台 ${platform}${noVenv ? ',未预置 venv:验「准备环境」' : `,已预置 ${venvDirName}/${pyRel} + ${stampName}`})`);
