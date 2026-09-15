#!/usr/bin/env node
// cu-stub.mjs 的薄包装(原桩一字不改),给剧本加两个能力,供"回退投递失败/超时"类用例用:
//   "*"  通配:剧本里没点名的子命令一律按 "*" 的剧本应答 —— 回退投递不管走 ax-key、分块多次还是改名的新子命令都会被命中
//   raw  "*" 里写 raw:原样输出这段(不可解析的)stdout,再按 exitCode 退出
// 用法:夹具建好假家目录后,把 venv/bin/python3 改成 exec 本文件(见 check-q8-cu-fallback-failure.mjs)。
import fs from 'node:fs';

const [, , first, subcmd] = process.argv; // [node, 本文件, <HELPER 路径>|-m, <子命令>, ...]
const file = process.env.CU_STUB_SCENARIO;
let scenario = {};
try { scenario = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 无剧本 = 原桩默认行为 */ }
const wild = first !== '-m' && !(subcmd in scenario) ? scenario['*'] : undefined;

if (wild && wild.raw !== undefined) {
  const log = process.env.CU_STUB_LOG;
  if (log) fs.appendFileSync(log, `${JSON.stringify({ subcmd, args: process.argv.slice(4), helper: first, at: Date.now() })}\n`);
  process.stdout.write(wild.raw);
  process.exit(wild.exitCode ?? 0);
}
if (wild) {
  const own = `${file}.${process.pid}`; // 只含本子命令的派生剧本,交给原桩按常规逻辑(记 argv / 睡眠 / 记信号 / 退出码)执行
  fs.writeFileSync(own, JSON.stringify({ [subcmd]: wild }));
  process.env.CU_STUB_SCENARIO = own;
}
await import('./cu-stub.mjs');
