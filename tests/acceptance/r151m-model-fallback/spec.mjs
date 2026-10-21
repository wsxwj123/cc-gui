#!/usr/bin/env node
// r151m 全量验收入口:每条用例独立子进程,顺序执行;单条失败不影响后续用例。
// 用法:node spec.mjs [1 4 6 ...]  (不给参数 = 跑行为清单 1–10)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_IDS, CASES } from './lib/cases.mjs';

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

const results = [];
for (const id of ids) {
  console.log(`\n[r151m] ===== 开始 CASE ${id}:${CASES[id].name} =====`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(HERE, 'case.mjs'), String(id)], {
    stdio: 'inherit',
    env: { ...process.env, R151M_ARTIFACT_DIR: artifactDir },
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
