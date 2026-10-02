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

/** 属主进程还活着吗(pid 会被回收,但这里的窗口只有一次动作的时长)。 */
function ownsAliveProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;                                   // 存在(且我们有权限)
  } catch (err) {
    return err && err.code === 'EPERM';            // 存在但无权限查
  }
}

/** 读目录里所有 hold 凭据:[{file, pid, keys, stale}]。 */
function holdEntries() {
  const now = Date.now();
  const out = [];
  for (const file of holdFiles()) {
    let body = null;
    try { body = JSON.parse(readFileSync(join(RUNTIME_DIR, file), 'utf8')); } catch { body = null; }
    const list = Array.isArray(body?.keys) ? body.keys : (Array.isArray(body?.held) ? body.held : []);
    let stale = false;
    try { stale = now - statSync(join(RUNTIME_DIR, file)).mtimeMs > STALE_HOLD_MS; } catch { stale = true; }
    out.push({ file, pid: Number(body?.pid), keys: list.filter((k) => typeof k === 'string' && k), stale });
  }
  return out;
}

/**
 * 这份凭据该由我收尾吗:**属主已不在**(或超期/读不出属主)才算。
 *
 * ⚠️ 属主还活着的凭据一律不碰(0.2.412 delta 审查 D-2):`RUNTIME_DIR` 是同一用户共享的,
 * 同机可能同时跑着另一个 cc-gui 会话,它的 helper 正拖拽时会往这个目录里写 `hold-<pid>.json`
 * (`keys` 里有 `MOUSE_LEFT`)—— 我们替它"收尾"就是当场把它的拖拽松开、还删掉它的凭据。
 * 那本侧 helper 若只是"父进程死了但自己还活着",不需要我们救:helper 的层 3(`_start_guard`)
 * 持有父进程的 SYNCHRONIZE 句柄,父进程一死 200ms 内自己补发抬起并 `os._exit`。
 */
function isOrphanEntry(entry) {
  return entry.stale || !ownsAliveProcess(entry.pid);
}

/** 补发抬起 + 清掉这些凭据(venv 缺失时只清不抬:没有执行层可用,是"尽力而为"的边界)。 */
function releaseEntries(entries) {
  if (!entries.length) return false;
  const keys = new Set();
  for (const entry of entries) for (const k of entry.keys) keys.add(k);
  if (VENV_PY && HELPER && existsSync(VENV_PY) && existsSync(HELPER)) {
    try {
      spawnSync(VENV_PY, [HELPER, 'release-hold', ...(keys.size ? ['--keys', [...keys].join(',')] : [])],
        { timeout: 5000, windowsHide: true, stdio: 'ignore' });
    } catch { /* 释放尽力而为:失败也不能让守护进程卡住 */ }
  }
  for (const entry of entries) {
    try { unlinkSync(join(RUNTIME_DIR, entry.file)); } catch { /* 已被并发清理 */ }
  }
  sweepTemp();
  return true;
}

/** 写盘中途崩溃留下的 .tmp(先写 tmp 再 rename)一并收掉。 */
function sweepTemp() {
  try {
    for (const f of readdirSync(RUNTIME_DIR)) {
      if (/^hold-.*\.json\.tmp$/.test(f)) { try { unlinkSync(join(RUNTIME_DIR, f)); } catch { /* 同上 */ } }
    }
  } catch { /* 目录不存在 */ }
}

/**
 * 启动时的收尾:**把上一次会话留下的按住键抬起来**,而不是把凭据一删了之。
 * 发版说明承诺的"下一次启动会把按住的键抬起来"就是这里(0.2.412 审查 建议-2:旧版只 unlink)。
 * 只处理孤儿凭据(判据见 isOrphanEntry)。
 */
function releaseLeftovers() {
  releaseEntries(holdEntries().filter(isOrphanEntry));
}

let released = false;
/** 父进程死掉(管道 EOF)⇒ 收尾:同样只收孤儿凭据。 */
function releaseAndExit() {
  if (released) return;
  released = true;
  releaseEntries(holdEntries().filter(isOrphanEntry));
  process.exit(0);
}

releaseLeftovers();

// 父进程死掉 ⇒ 管道写端关闭 ⇒ 'end'/'close'。stdin 必须 resume 才会流动。
process.stdin.resume();
process.stdin.on('end', releaseAndExit);
process.stdin.on('close', releaseAndExit);
process.stdin.on('error', releaseAndExit);
