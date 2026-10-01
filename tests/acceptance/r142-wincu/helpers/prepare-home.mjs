#!/usr/bin/env node
// r142-wincu 夹具:把一个假家目录准备好(隔离实例用它当 HOME)。
//
//   node helpers/prepare-home.mjs <home> <worktree> [--no-venv]
//
// 造什么:
//   · .claude-gui/cu-runtime/{grants.json, venv-win/Scripts/python.exe, venv-win.stamp, shots/}
//   · .claude.json 里登记 ccgui-computer-use(卡片只在 registered:true 时渲染授权区块)
//   · bin/{py,python} 两个假解释器(让 win32 的候选表找得到)
//   · scenario.json(假 helper 的剧本)/ argv.jsonl(调用记录)
// 依 --no-venv / CU_PREPARE_NO_VENV=1:不预置 venv,用来验「准备环境」按钮与 POST /prepare。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [home, worktree] = process.argv.slice(2);
const noVenv = process.argv.includes('--no-venv') || process.env.CU_PREPARE_NO_VENV === '1';
if (!home || !worktree) { console.error('用法: prepare-home.mjs <home> <worktree> [--no-venv]'); process.exit(2); }

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = path.join(here, 'win-helper.mjs');
const WIN_DEPS = ['mss', 'Pillow', 'comtypes>=1.4.0'];

fs.rmSync(home, { recursive: true, force: true });
const runtime = path.join(home, '.claude-gui', 'cu-runtime');
fs.mkdirSync(path.join(runtime, 'shots'), { recursive: true });

if (!noVenv) {
  const venv = path.join(runtime, 'venv-win');
  fs.mkdirSync(path.join(venv, 'Scripts'), { recursive: true });
  const py = path.join(venv, 'Scripts', 'python.exe');
  fs.writeFileSync(py, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
  fs.chmodSync(py, 0o755);
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = C:\\Fake\n');
  fs.writeFileSync(path.join(runtime, 'venv-win.stamp'),
    `${createHash('sha256').update(WIN_DEPS.join('|')).digest('hex')}\n`);
}

// 候选解释器:win32 的候选表是 py -3 / python
const bin = path.join(home, 'bin');
fs.mkdirSync(bin, { recursive: true });
for (const [name, pyName] of [['py', 'py'], ['python', 'python']]) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\nCU_STUB_PYNAME=${pyName} exec "${process.execPath}" "${stub}" "$@"\n`);
  fs.chmodSync(file, 0o755);
}

fs.writeFileSync(path.join(home, 'scenario.json'), '{}');
fs.writeFileSync(path.join(home, 'argv.jsonl'), '');
fs.writeFileSync(path.join(runtime, 'grants.json'), `${JSON.stringify({
  version: 1,
  screenScope: { granted: true, grantedAt: new Date().toISOString() },
  apps: { 'C:\\Windows\\System32\\notepad.exe': { name: 'Notepad', grantedAt: new Date().toISOString() } },
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

console.log(`[r142-wincu] 夹具家目录就绪:${home}${noVenv ? '(未预置 venv-win:验「准备环境」)' : ''}`);
