#!/usr/bin/env node
// 把后端 B 的自动清理时间线录下来(run.sh 在 B 起来之后、跑 a-sweep 之前调用,只跑这一次):
// 首轮结束 → 文件快照;第二轮结束 → 文件快照;等「跨 14 天」那份被删 → 记下观察到的时刻;最后再拍一次。写 .artifacts/sweep-timeline.json。
// 每一步等待都有上限:首轮 45 秒、第二轮 25 秒、跨 14 天那份 = 夹具写入后 90 秒;超时只记「没等到」,不抛错。
import fs from 'node:fs';
import { art, stdoutLog, exists } from './common.mjs';

const man = JSON.parse(fs.readFileSync(art('sweep-manifest.json'), 'utf8'));
const cross = man.files.find((f) => f.key === 'cross_14d');
const snapshot = () => Object.fromEntries(man.files.map((f) => [f.key, exists(f.path)]));
const summaryLines = () => { try { return fs.readFileSync(stdoutLog('B'), 'utf8').split('\n').filter((l) => l.startsWith('[histbak] 清理完成')); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, limitMs) {
  const end = Date.now() + limitMs;
  for (;;) { const v = cond(); if (v) return v; if (Date.now() >= end) return null; await sleep(40); }
}
const T = { line1: null, snap1: null, line2: null, snap2: null, crossGoneAtMs: null, snapEnd: null };
const first = await until(() => summaryLines()[0], 45_000);
T.snap1 = snapshot(); T.line1 = first;
if (first) {
  const second = await until(() => summaryLines()[1], 25_000);
  T.snap2 = snapshot(); T.line2 = second;
  T.crossGoneAtMs = await until(() => (!exists(cross.path) ? Date.now() : 0), Math.max(1000, man.G + 90_000 - Date.now()));
}
T.snapEnd = snapshot();
fs.writeFileSync(art('sweep-timeline.json'), `${JSON.stringify(T, null, 2)}\n`);
process.stdout.write(`[R209] 时间线已录:首轮=${first ? '有' : '没等到'} 第二轮=${T.line2 ? '有' : '没等到'} 跨14天删除=${T.crossGoneAtMs ? '有' : '没等到'}\n`);
