#!/usr/bin/env node
// cc-gui computer use —— 按键释放的**层 2 常驻守护**(Windows;§3.2 B-2)。
//
// 为什么必须是独立进程:mcp-server 被 SIGKILL / 任务管理器整树强杀时,Windows 上
// `process.on('exit')` 根本不跑,`child.kill('SIGTERM')` 也只是 TerminateProcess ⇒
// "让 helper 自己补发抬起"这条在 Windows 上不成立。本进程由 mcp-server 在 win32 上 spawn,
// 并持有它给的**管道读端**:父进程以任何方式死掉(含整树强杀、蓝屏前的进程清理),
// OS 都会关掉写端 ⇒ 这里读到 EOF ⇒ 读磁盘上最新的 hold-<pid>.json 补发抬起并退出。
//
// 铁规:①只在 win32 被 spawn(macOS 有可捕获的 SIGTERM,不需要多一个进程);②绝不写任何文件,
// 只读 hold 文件 + 调 helper 的 release-hold + 删 hold 文件;③路径全部由 env 传入,
// **不 import cu-common**(本进程的 process.platform 是真实的 Windows,但测试夹具里
// 它跑在 macOS 上、家目录被伪装过;自己算路径会算错)。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const VENV_PY = process.env.CU_WATCH_VENV_PY || '';
const HELPER = process.env.CU_WATCH_HELPER || '';
const RUNTIME_DIR = process.env.CU_WATCH_RUNTIME_DIR || '';
// 与 mcp-server 侧 STALE_SHOT_MS 同款量级:超过这个时长的 hold 文件不可能还在途
// (helper 侧还有 30s 硬上限),只可能是上次异常退出留下的垃圾。
const STALE_HOLD_MS = 10 * 60 * 1000;

const holdFiles = () => {
  try {
    return readdirSync(RUNTIME_DIR).filter((f) => /^hold-.*\.json$/.test(f));
  } catch { return []; }
};

function readKeys() {
  const keys = new Set();
  for (const file of holdFiles()) {
    try {
      const body = JSON.parse(readFileSync(join(RUNTIME_DIR, file), 'utf8'));
      const list = Array.isArray(body?.keys) ? body.keys : (Array.isArray(body?.held) ? body.held : []);
      for (const k of list) if (typeof k === 'string' && k) keys.add(k);
    } catch { /* 半截文件:跳过,释放仍按"尽力而为" */ }
  }
  return [...keys];
}

function clearHoldFiles() {
  for (const file of holdFiles()) {
    try { unlinkSync(join(RUNTIME_DIR, file)); } catch { /* 已被并发清理 */ }
  }
  try {
    for (const f of readdirSync(RUNTIME_DIR)) {
      if (/^hold-.*\.json\.tmp$/.test(f)) { try { unlinkSync(join(RUNTIME_DIR, f)); } catch { /* 同上 */ } }
    }
  } catch { /* 目录不存在 */ }
}

/** 启动时清过期垃圾:上次崩溃留下的 hold 文件不该被当成"还有键按着"。 */
function pruneStale() {
  const now = Date.now();
  for (const file of holdFiles()) {
    try {
      if (now - statSync(join(RUNTIME_DIR, file)).mtimeMs > STALE_HOLD_MS) unlinkSync(join(RUNTIME_DIR, file));
    } catch { /* 已被并发清理 */ }
  }
}

let released = false;
function releaseAndExit() {
  if (released) return;
  released = true;
  const keys = readKeys();
  if (VENV_PY && HELPER && existsSync(VENV_PY) && existsSync(HELPER)) {
    try {
      spawnSync(VENV_PY, [HELPER, 'release-hold', ...(keys.length ? ['--keys', keys.join(',')] : [])],
        { timeout: 5000, windowsHide: true, stdio: 'ignore' });
    } catch { /* 释放尽力而为:失败也不能让守护进程卡住 */ }
  }
  clearHoldFiles();
  process.exit(0);
}

pruneStale();

// 父进程死掉 ⇒ 管道写端关闭 ⇒ 'end'/'close'。stdin 必须 resume 才会流动。
process.stdin.resume();
process.stdin.on('end', releaseAndExit);
process.stdin.on('close', releaseAndExit);
process.stdin.on('error', releaseAndExit);
