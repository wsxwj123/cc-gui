#!/usr/bin/env node
// 单条用例进程:每次只跑一个 case,自己起假上游/代理,退出即释放本进程监听端口。
// 用法:node case.mjs <1..10>
import fs from 'node:fs';
import path from 'node:path';
import { CASES } from './lib/cases.mjs';
import { SUITE_DIR, createContext } from './lib/harness.mjs';

const caseId = Number(process.argv[2]);
const artifactDir = process.env.R151M_ARTIFACT_DIR || path.join(SUITE_DIR, '.artifacts', 'manual');

function finish(code) {
  // 让 stdout/stderr 有机会冲刷(尤其失败时的断言输出)。
  process.exitCode = code;
  setImmediate(() => process.exit(code));
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, `case-${caseId}.pid`), `${process.pid}\n`);

  const def = CASES[caseId];
  if (!def) {
    console.error(`[CASE ${caseId}] 未知用例编号`);
    finish(2);
    return;
  }

  console.log(`\n[CASE ${caseId}] ${def.name}`);
  const ctx = await createContext({ caseId, artifactDir });
  let ok = false;
  let cleanupOk = true;
  try {
    await def.run(ctx, ctx.checker);
    ok = ctx.checker.report();
  } catch (err) {
    // 夹具/请求异常也要明确标成失败,不能当成“通过”;已产生的断言照样打印出来。
    ctx.checker.fail('用例执行异常', err?.stack || String(err), '无异常');
    ok = ctx.checker.report();
  } finally {
    try {
      await ctx.cleanup();
    } catch (err) {
      cleanupOk = false;
      console.error(`[CASE ${caseId}] 清理假上游失败:${err?.message || err}`);
    }
  }
  finish(ok && cleanupOk ? 0 : 1);
}

main().catch((err) => {
  console.error(`[CASE ${caseId}] 启动失败 — ${err?.stack || err}`);
  finish(2);
});
