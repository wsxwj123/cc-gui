#!/usr/bin/env node
// r151m 全量验收入口:每条用例独立子进程,顺序执行;单条失败不影响后续用例。
// 用法:node spec.mjs [1 4 6 ...]  (不给参数 = 跑行为清单 1–10)
// 家目录隔离(r151q):用例子进程的 HOME 指向 <产物目录>/home 这个本次运行专用的空目录,
// 代理读不到用户真实的 ~/.claude/settings.json(原因见下方 homeDir 处的说明)。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_IDS, CASES } from './lib/cases.mjs';
import { homeIsolationProblem } from './lib/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const artifactDir =
  process.env.R151M_ARTIFACT_DIR || path.join(HERE, '.artifacts', `manual-${process.pid}`);
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(path.join(artifactDir, 'spec.pid'), `${process.pid}\n`);

const requested = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n));
const ids = requested.length > 0 ? requested : CASE_IDS;
const isSubset = requested.length > 0;
for (const id of ids) {
  if (!CASES[id]) {
    console.error(`[r151m] 未知用例编号 ${id}`);
    process.exit(2);
  }
}

console.log(`[r151m] 用例进程逐个执行,产物目录 ${artifactDir}`);
console.log(`[r151m] 本轮用例:${ids.join(', ')}`);

// 子进程环境:家目录换成本次运行专用的空目录 <产物目录>/home(里面不放 settings.json)。
// 原因:代理在"claude 名不在模型列表里"时会读家目录下的 .claude/settings.json 决定映射目标,
// 用空家目录,代理就退回到配置给它的映射目标,结果不随用户真实的 settings 变化。
// 起子进程前先过守卫:HOME(Windows 还有 USERPROFILE)解析后若等于真实家目录(os.userInfo().homedir)就直接退出,不跑用例。
const homeDir = path.resolve(artifactDir, 'home');
const childEnv = {
  ...process.env,
  R151M_ARTIFACT_DIR: artifactDir,
  HOME: homeDir,
  ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
};
const homeProblem = homeIsolationProblem(childEnv);
if (homeProblem) {
  console.error(`[r151m] ${homeProblem}`);
  process.exit(2);
}
fs.mkdirSync(homeDir, { recursive: true });
console.log(`[r151m] 用例进程家目录 ${homeDir}(空目录,无 settings.json)`);

const results = [];
for (const id of ids) {
  console.log(`\n[r151m] ===== 开始 CASE ${id}:${CASES[id].name} =====`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(HERE, 'case.mjs'), String(id)], {
    stdio: 'inherit',
    env: childEnv,
    timeout: 60_000,
  });
  const ms = Date.now() - started;
  let status;
  if (run.error && run.error.code === 'ETIMEDOUT') {
    status = 'FAIL';
    console.error(`[r151m] CASE ${id} 超时(60s),已杀掉该用例进程`);
  } else if (run.signal) {
    status = 'FAIL';
    console.error(`[r151m] CASE ${id} 被信号 ${run.signal} 终止`);
  } else {
    status = run.status === 0 ? 'PASS' : 'FAIL';
  }
  results.push({ id, name: CASES[id].name, status, ms, exit: run.status });
  console.log(`[r151m] ===== 结束 CASE ${id}:${status} (${ms}ms) =====`);
}

const failed = results.filter((r) => r.status !== 'PASS');
const passed = results.filter((r) => r.status === 'PASS');

console.log('\n[r151m] ===== 汇总 =====');
for (const r of results) {
  console.log(`CASE ${String(r.id).padStart(2, '0')} ${r.status}  ${r.name}`);
}
console.log(`绿:${passed.map((r) => r.id).join(',') || '(无)'}`);
console.log(`红:${failed.map((r) => r.id).join(',') || '(无)'}`);

if (failed.length > 0) {
  console.log(`\n[r151m] 结果:FAIL(红 ${failed.length} 条:${failed.map((r) => r.id).join(', ')})`);
  process.exit(1);
}
console.log(
  isSubset
    ? `\n[r151m] 结果:PASS(所选用例全绿:${ids.join(', ')})`
    : '\n[r151m] 结果:PASS(行为清单 1–10 全绿)',
);
process.exit(0);
