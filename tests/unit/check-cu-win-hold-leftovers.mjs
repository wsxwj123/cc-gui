#!/usr/bin/env node
// r142-附6 —— watcher 启动时的"把上一次残留的按住键抬起来"(0.2.412 delta 审查 第 2 条)。
//
// 背景:0.2.412 发版说明承诺"强杀之后,下一次启动会把按住的键抬起来"。这句话的实现就在
// `cu-hold-watcher.js` 的 `releaseLeftovers()`(启动时读 hold 文件 → 经 helper 的 release-hold
// 补发抬起 → 清盘)。delta 审查把它的 spawnSync 分支置 false(退化成"只 unlink")时,**20 个
// check-cu-* 与回归 runner 一条都不红** —— 声明没有守门。本用例补上这个守门:
//
//   ① 属主**已死**的 hold 文件:启动时必须**经 helper 发出 release-hold**,并把该文件的键带上;
//   ② 属主**还活着**的 hold 文件(同机另一个会话正在拖拽):不许抬、也不许删它的凭据;
//   ③ 写盘中途留下的 `hold-*.json.tmp` 一并收掉。
//
// 做法:不碰 Windows、不碰真家目录 —— 起一个真的 watcher 子进程,路径全用 env 注入,helper 换成一个
// 记录 argv 的壳脚本;stdin 保持**打开**(不用 EOF 那条路径),这样观察到的只能是"启动时"的行为。
//
// 口径说明(为什么这么写、语义没放宽):新增断言只覆盖 watcher 的启动收尾路径,不改既有用例;
// 它把"删了"和"抬了"区分开(有 release-hold 调用才算抬),这正是发版说明承诺的那件事。
//
// 跑法:node tests/unit/check-cu-win-hold-leftovers.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WATCHER = join(ROOT, 'server', 'computer-use', 'cu-hold-watcher.js');
const HELPER = join(ROOT, 'server', 'computer-use', 'cu_helper_windows.py');
const report = makeReport('check-cu-win-hold-leftovers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = join(HERE, 'r142-helpers', '.artifacts', 't11-leftovers');
fs.rmSync(BASE, { recursive: true, force: true });
const RUNTIME = join(BASE, 'cu-runtime');
const BIN = join(BASE, 'bin');
fs.mkdirSync(RUNTIME, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
const ARGV_LOG = join(BASE, 'release-argv.jsonl');
fs.writeFileSync(ARGV_LOG, '');
// 假解释器:把 argv 记下来,回一行 JSON(内容不被 watcher 使用,只要求能让真 release-hold 的形态可观测)
const SHIM = join(BIN, 'python');
fs.writeFileSync(SHIM, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ARGV_LOG}"\nprintf '%s\\n' '{"ok":true,"released":[]}'\n`);
fs.chmodSync(SHIM, 0o755);

/**
 * "属主已经退出"的 pid。
 * ⚠️ 不用"起一个子进程再等它退出"那种写法:kern.maxproc 是 16000,测试窗口内 pid 会被**回收复用**,
 * 复用到的活进程会让 watcher 判定"属主还活着"⇒ 用例随机变红。取远大于 pid 空间的值(ESRCH)。
 */
const DEAD_PID = 9_999_999;

function writeHold(pid, keys, { tmp = false } = {}) {
  const file = join(RUNTIME, `hold-${pid}.json${tmp ? '.tmp' : ''}`);
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, pid, keys, held: keys, at: Date.now() })}\n`);
  return file;
}

const orphan = writeHold(DEAD_PID, ['CTRL', 'SHIFT']);     // 属主已死(pid 超出进程号空间)⇒ 该抬
const live = writeHold(process.pid, ['ALT']);               // 属主还活着(本测试进程)⇒ 不许动
const tmpFile = writeHold(424242, ['LWIN'], { tmp: true });  // 写盘中途的残留 ⇒ 该清

/**
 * 起一次 watcher,让它只做启动收尾(stdin 保持打开,不走 EOF 路径),然后杀掉。
 * 用**轮询**而不是固定 sleep:启动收尾是同步的(实测 ~105ms),但机器忙时 node 冷启动会慢,
 * 固定等待会让用例随机变红。
 */
async function runWatcherStartup() {
  fs.writeFileSync(ARGV_LOG, '');
  const child = spawn(process.execPath, [WATCHER], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CU_WATCH_VENV_PY: SHIM,
      CU_WATCH_HELPER: HELPER,
      CU_WATCH_RUNTIME_DIR: RUNTIME,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  const readLog = () => fs.readFileSync(ARGV_LOG, 'utf8').split('\n').filter(Boolean);
  for (let i = 0; i < 60 && readLog().length === 0 && !fs.existsSync(tmpFile) === false; i += 1) await sleep(50);
  // 等到"该抬的抬了 + 该删的删了",或最多 3 秒
  for (let i = 0; i < 60; i += 1) {
    if (readLog().length > 0 && !fs.existsSync(orphan) && !fs.existsSync(tmpFile)) break;
    await sleep(50);
  }
  await sleep(100);                                   // 让 .tmp 清理也落定
  child.kill('SIGKILL');
  if (child.exitCode === null) await new Promise((r) => { child.once('exit', r); setTimeout(r, 500); });
  return { calls: readLog(), stderr };
}

const { calls, stderr } = await runWatcherStartup();
const ctx = `(watcher stderr=${JSON.stringify(stderr.slice(0, 300))})`;

await report.check('LFT-01', '启动时:属主已死的 hold 文件必须**经 helper 补发抬起**(不是只删文件)', 'red', () => {
  assert.ok(calls.length >= 1,
    `启动时一次 release-hold 都没发(只删了文件)—— 这就是发版说明承诺的那件事没实现:log=${JSON.stringify(calls)} ${ctx}`);
  const line = calls.join(' | ');
  assert.ok(/release-hold/.test(line), `没有 release-hold 子命令:${line} ${ctx}`);
  assert.ok(/CTRL/.test(line) && /SHIFT/.test(line), `没有把残留文件里的键带上:${line} ${ctx}`);
  assert.equal(fs.existsSync(orphan), false, '残留的 hold 文件没被清掉(下次启动还会读到)');
});

await report.check('LFT-02', '启动时:属主**还活着**的 hold 文件不许被抬、也不许被删(同机另一个会话可能在拖拽)', 'red', () => {
  const line = calls.join(' | ');
  assert.ok(!/\bALT\b/.test(line), `把别人正在按着的键也抬了:${line}`);
  assert.equal(fs.existsSync(live), true, '删掉了活属主的 hold 凭据(层 2/层 3 之后就不知道要抬什么了)');
});

await report.check('LFT-03', '启动时:写盘中途留下的 hold-*.json.tmp 一并清掉', 'red', () => {
  assert.equal(fs.existsSync(tmpFile), false, 'hold-*.json.tmp 残留没清(下次会被当成"还有键按着"或误读)');
});

process.exit(report.finish());
