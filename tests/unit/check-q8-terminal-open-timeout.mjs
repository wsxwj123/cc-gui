#!/usr/bin/env node
// Q8 审查项 8(内置终端 term-open 15s 超时不取消底层 open):
//   超时已回 TERM_OPEN_TIMEOUT 后,迟到的 spawn 照常 registerTerminal 并发 term-opened —— 客户端已按失败处理,
//   这个 shell 却以 attached 态占一个名额、任何 sweep 都不碰它。
//   a. 超时报错之后不得再收到该 id 的 term-opened(修前应红)
//   b. 超时之后对该 id 发 term-in 必须是 TERM_NOT_FOUND(shell 不存在/已被杀),而不是静默写进一个幽灵 shell(修前应红)
//   c. 15s 超时本身照常触发(修前应绿)
// 测法:把 fs/promises.realpath 对指定 cwd 拖慢 16.5s(product 在 spawn 前 await 它),真 spawn 一个 /bin/sh;
//       HOME 指到本目录 .artifacts 下的假家目录。约 25 秒。
// 跑法:node tests/unit/check-q8-terminal-open-timeout.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport, sleep, waitFor } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = join(HERE, 'q8-helpers', '.artifacts', 'terminal');
fs.rmSync(base, { recursive: true, force: true });
const home = join(base, 'home');
const slowDir = join(home, 'slow-cwd');
fs.mkdirSync(slowDir, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.SHELL = '/bin/sh'; // 登录 shell 用最简的 sh,不读用户 zsh 配置

const SLOW_MS = 16_500;
const realRealpath = fs.promises.realpath;
fs.promises.realpath = async function patched(p, ...rest) {
  if (resolve(String(p)) === slowDir) await sleep(SLOW_MS); // 模拟挂死的网络卷 / 杀软扫描
  return realRealpath.call(this, p, ...rest);
};
syncBuiltinESMExports();

const { handleTerminalMessage } = await import('../../server/routes/terminal.js');
const report = makeReport('check-q8-terminal-open-timeout');

const frames = [];
const ws = { readyState: 1, send(s) { frames.push(JSON.parse(s)); } };
const ID = 'q8slow';
const t0 = Date.now();
handleTerminalMessage(ws, { type: 'term-open', id: ID, cols: 80, rows: 24, cwd: slowDir });

const timeoutFrame = await waitFor(() => frames.find((f) => f.type === 'term-error' && f.id === ID && f.code === 'TERM_OPEN_TIMEOUT'), { timeoutMs: 20_000, stepMs: 50 });
const tTimeout = Date.now() - t0;
// 给迟到的 spawn 留足落地时间(realpath 16.5s + stat + node-pty 加载 + spawn)
const opened = await waitFor(() => frames.find((f) => f.type === 'term-opened' && f.id === ID), { timeoutMs: 8_000, stepMs: 50 });

await report.check('Q8-08c', 'term-open 超过 15s → 客户端收到 TERM_OPEN_TIMEOUT(超时机制本身在)', 'green', async () => {
  assert.ok(timeoutFrame, `20s 内没收到 TERM_OPEN_TIMEOUT;收到的帧: ${JSON.stringify(frames).slice(0, 300)}`);
  assert.ok(tTimeout >= 14_000 && tTimeout <= 17_500, `超时帧到达时刻 ${tTimeout}ms,应在 15s 上下`);
});

await report.check('Q8-08a', '已报 TERM_OPEN_TIMEOUT 之后,迟到的 spawn 不得再登记并发 term-opened', 'red', async () => {
  assert.equal(opened, undefined, `超时之后仍收到 term-opened(pid ${opened?.pid},generation ${opened?.generation}):shell 以 attached 态占名额、无人回收`);
});

await report.check('Q8-08b', '超时之后对该 id 发 term-in → TERM_NOT_FOUND(不存在幽灵 shell 可写)', 'red', async () => {
  const before = frames.length;
  handleTerminalMessage(ws, { type: 'term-in', id: ID, generation: opened?.generation ?? 1, data: '' });
  await sleep(300);
  const err = frames.slice(before).find((f) => f.type === 'term-error' && f.id === ID);
  assert.ok(err, 'term-in 没有任何回帧 = 写进了一个客户端早已放弃的幽灵 shell');
  assert.equal(err.code, 'TERM_NOT_FOUND', `实际 code=${err.code}`);
});

// 收尾:若幽灵 shell 真的登记了,显式关掉它(不留进程)
if (opened) {
  handleTerminalMessage(ws, { type: 'term-close', id: ID, generation: opened.generation });
  await sleep(300);
}
process.exit(report.finish());
