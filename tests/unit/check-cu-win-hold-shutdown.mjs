#!/usr/bin/env node
// r142-附8 —— 关停/超时/watcher-EOF 三条收尾路径**只许抬自己人的凭据**(0.2.412 delta 审查 D-2)。
//
// 背景:`RUNTIME_DIR` 是同一用户共享的,同机可能同时跑着另一个 cc-gui 会话。它的 helper 正拖拽时
// 会在同一个目录里留下 `hold-<pid>.json`(keys 里有 `MOUSE_LEFT`)。任何"我这一侧要收尾"的路径,
// 只要把**别人的**凭据也当成自己的处理,就会当场把别人的拖拽松开、并把它的凭据删掉 ——
// 那正是本轮刚在 exit 路径上修掉的那一类。
//
// D-2 的形态:`shutdown()` 把 `deadPids` 喂成"目录里所有凭据的属主 pid" ⇒ `knownDead` 覆盖全部
// ⇒ 属主过滤退化成 no-op。本文件把三条路径都钉住:
//   SH-01（修前红）关停(SIGTERM 本 mcp):**外部活属主**的凭据不许被抬、不许被删。
//   SH-02（前提自证,修前也应绿）关停时**自己刚 SIGKILL 掉的 helper**那份凭据仍必须被收尾
//        —— 证明过滤没有"过滤过头"（它只覆盖"我们的"那一半；"别人的不受影响"在 SH-01）。
//   SH-03（修前红）watcher 的 EOF 收尾:同一标准 —— 只抬属主已死的,活属主的不动。
//
// 判据只看进程外部可观测的事实:桩记录的 `release-hold` argv + 磁盘上的 hold 文件。
//
// 口径说明(为什么这么写、语义没放宽):新增断言只覆盖"谁该被收尾、谁不许被碰",不改既有用例;
// `deadPids` 的语义固定为"调用方确定已死亡的 pid"(我刚杀的 / 刚退出的),不许塞"所有属主"。
//
// 跑法:node tests/unit/check-cu-win-hold-shutdown.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';
import { GRANTED, grantedWindow, makeWinHome, startWinMcp } from './r142-helpers/win-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WATCHER = join(ROOT, 'server', 'computer-use', 'cu-hold-watcher.js');
const HELPER = join(ROOT, 'server', 'computer-use', 'cu_helper_windows.py');
const report = makeReport('check-cu-win-hold-shutdown');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// pid 空间上限是 kern.maxproc(本机 16000)⇒ 这个值一定"属主已死",且不会被回收复用
const DEAD_PID = 9_999_999;

// ── SH-01 关停时不许碰别人的凭据(修前红)──────────────────────────────
{
  const fake = makeWinHome('t13-shutdown-live');
  fake.setGrants({ apps: [GRANTED.bundleId] });
  fake.setScenario({ windows: { reply: { ok: true, frontmost: null, windows: [grantedWindow()] } } });
  const mcp = await startWinMcp(fake);
  await mcp.call('window_list', {}, 20_000).catch(() => null);   // 确保运行时/watcher 已起来
  const liveFile = fake.writeHoldFile(process.pid, ['ALT']);      // 外部活属主:本测试进程(还活着)
  fake.clearLogs();
  mcp.killParentOnly('SIGTERM');                                  // 关停路径(先杀后释放)
  await mcp.waitExit(3000);
  await sleep(700);                                               // 让 watcher 的 EOF 收尾也跑完
  const argv = fake.helperCalls('release-hold').map((e) => e.args.join(' ')).join(' | ');
  mcp.kill();

  await report.check('SH-01', '关停(SIGTERM 本 mcp):外部活属主的凭据不许被抬、不许被删', 'red', () => {
    assert.ok(!/\bALT\b/.test(argv),
      `关停时抬了另一个会话正按着的键(会把它的拖拽松开):release-hold argv=${JSON.stringify(argv)}`);
    assert.equal(fs.existsSync(liveFile), true,
      '关停时删掉了另一个会话的 hold 凭据(它之后就不知道要抬什么了)');
  });
}

// ── SH-02 前提自证:自己刚杀的 helper 那份仍必须被收尾(修前也应绿)──────
{
  const fake = makeWinHome('t13-shutdown-own');
  fake.setGrants({ apps: [GRANTED.bundleId] });
  fake.setScenario({
    windows: {
      reply: { ok: true, frontmost: null, windows: [grantedWindow()] },
      sleepMs: 26_000,          // 让它一直活着,停在 activeHelpers 里
      hold: ['SHIFT'],          // 并像真 helper 那样"先落盘再按下"
    },
  });
  const mcp = await startWinMcp(fake);
  mcp.call('window_list', {}, 40_000).catch(() => null);          // 不 await:它会一直挂着
  for (let i = 0; i < 60 && fake.holdFiles().length === 0; i += 1) await sleep(50);
  const ownFiles = fake.holdFiles();
  fake.clearLogs();
  mcp.killParentOnly('SIGTERM');
  await mcp.waitExit(3000);
  await sleep(500);
  const argv = fake.helperCalls('release-hold').map((e) => e.args.join(' ')).join(' | ');
  mcp.kill();

  await report.check('SH-02', '前提自证:关停时**自己刚 SIGKILL 的 helper**那份凭据仍被补发抬起并清掉(过滤没有过头)', 'green', () => {
    assert.ok(ownFiles.length >= 1, `前提不成立:没等到 helper 写下的 hold 凭据(holdFiles=${JSON.stringify(fake.holdFiles())})`);
    assert.ok(/SHIFT/.test(argv),
      `自己刚杀掉的 helper 的键没被抬(release-hold argv=${JSON.stringify(argv)})`);
    const left = fake.holdFiles().filter((f) => ownFiles.includes(f));
    assert.deepEqual(left, [], `自己那份凭据没被清掉:${JSON.stringify(left)}`);
  });
}

// ── SH-03 watcher 的 EOF 收尾:同一标准(修前红)────────────────────────
{
  const BASE = join(HERE, 'r142-helpers', '.artifacts', 't13-watcher-eof');
  fs.rmSync(BASE, { recursive: true, force: true });
  const RUNTIME = join(BASE, 'cu-runtime');
  const BIN = join(BASE, 'bin');
  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.mkdirSync(BIN, { recursive: true });
  const ARGV_LOG = join(BASE, 'release-argv.jsonl');
  fs.writeFileSync(ARGV_LOG, '');
  const SHIM = join(BIN, 'python');
  fs.writeFileSync(SHIM, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ARGV_LOG}"\nprintf '%s\\n' '{"ok":true,"released":[]}'\n`);
  fs.chmodSync(SHIM, 0o755);

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
  await sleep(300);                                   // 启动收尾先跑完(此时目录是空的,什么都不该做)
  const orphanFile = join(RUNTIME, `hold-${DEAD_PID}.json`);
  const liveFile = join(RUNTIME, `hold-${process.pid}.json`);
  fs.writeFileSync(orphanFile, `${JSON.stringify({ version: 1, pid: DEAD_PID, keys: ['CTRL'], held: ['CTRL'], at: Date.now() })}\n`);
  fs.writeFileSync(liveFile, `${JSON.stringify({ version: 1, pid: process.pid, keys: ['ALT'], held: ['ALT'], at: Date.now() })}\n`);
  child.stdin.end();                                  // 父进程死亡等价物:管道 EOF
  for (let i = 0; i < 60; i += 1) {
    const txt = fs.readFileSync(ARGV_LOG, 'utf8');
    if (txt.trim() && !fs.existsSync(orphanFile)) break;
    await sleep(50);
  }
  await sleep(200);
  const argv = fs.readFileSync(ARGV_LOG, 'utf8').split('\n').filter(Boolean).join(' | ');
  child.kill('SIGKILL');

  await report.check('SH-03', 'watcher 的 EOF 收尾:只抬属主已死的凭据;活属主的不抬不删(它自己有层 3 收尾)', 'red', () => {
    assert.ok(/CTRL/.test(argv),
      `属主已死的凭据没被补发抬起:argv=${JSON.stringify(argv)}(watcher stderr=${JSON.stringify(stderr.slice(0, 200))})`);
    assert.equal(fs.existsSync(orphanFile), false, '属主已死的凭据没被清掉');
    assert.ok(!/\bALT\b/.test(argv),
      `EOF 收尾抬了活属主(另一个会话)正按着的键:argv=${JSON.stringify(argv)}`);
    assert.equal(fs.existsSync(liveFile), true, 'EOF 收尾删掉了活属主的凭据');
  });
}

process.exit(report.finish());
