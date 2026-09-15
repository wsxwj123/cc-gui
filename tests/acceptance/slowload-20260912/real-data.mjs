#!/usr/bin/env node
// 真实数据口径的测量(可选、只读):用**用户自己的** ~/.claude/projects 量一遍 G1~G4。
//
// 为什么不走 HTTP:真实数据一跑就是几 GB 的读盘,而起一个真实 HOME 的服务端会去写
// ~/.claude-gui(用户的运行态)。这里只在**函数级**直接调 listProjects / listSessions ——
// 与路由调的是同一对函数,不含 HTTP 传输那点开销(几毫秒,量级不影响)。
// 索引一律写到本套件 .artifacts/real-index 下的临时目录,**不碰用户的索引目录**;
// ~/.claude/projects 只读,不写一个字节。
//
// 三种口径(与 slowload.spec.mjs 同定义):
//   A 冷进程·无索引 / B 冷进程·索引已落盘 / C 进程内第二次
//
// 用法(通常由 run-isolated.sh --real 调起):
//   REAL_HOME="$HOME" node real-data.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(import.meta.url);
const worktree = path.resolve(process.env.WORKTREE || path.join(path.dirname(here), '..', '..', '..'));
const REAL_HOME = process.env.REAL_HOME || os.homedir();

const ms = (v) => Math.round(v * 10) / 10;

/** 子进程阶段:一个全新进程里量一轮(先 projects,再每个项目的 sessions,各量两次)。 */
async function runPhase({ indexDir }) {
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_HOME;
  process.env.CGUI_SESSION_INDEX_DIR = indexDir;
  const projectsDir = path.join(REAL_HOME, '.claude', 'projects');
  const reader = await import(pathToFileURL(path.join(worktree, 'server', 'services', 'session-reader.js')).href);

  // 按体积取前 3 个项目(体积算一遍很少:就是 stat)。
  const sizes = [];
  for (const name of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, name);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let bytes = 0; let files = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try { bytes += fs.statSync(path.join(dir, f)).size; files += 1; } catch { /* 跳过 */ }
    }
    if (files) sizes.push({ hash: name, bytes, files });
  }
  sizes.sort((a, b) => b.bytes - a.bytes);
  const top = sizes.slice(0, 3);

  const t0 = performance.now();
  const projects = await reader.listProjects();
  const projectsFirst = performance.now() - t0;
  const t1 = performance.now();
  await reader.listProjects();
  const projectsSecond = performance.now() - t1;

  const sessions = [];
  for (const p of top) {
    const a = performance.now();
    const list = await reader.listSessions(p.hash);
    const first = performance.now() - a;
    const b = performance.now();
    await reader.listSessions(p.hash);
    const second = performance.now() - b;
    sessions.push({ ...p, first, second, listed: list.length });
  }
  return {
    projectsTotal: projects.length,
    projectsFirst, projectsSecond,
    sessions,
  };
}

function spawnPhase(label, indexDir) {
  const r = spawnSync(process.execPath, [here, '--phase', label], {
    encoding: 'utf8',
    env: { ...process.env, WORKTREE: worktree, REAL_HOME, PROBE_INDEX: indexDir, HOME: REAL_HOME },
  });
  if (!r.stdout) throw new Error(`阶段 ${label} 没输出:${r.stderr?.slice(-600)}`);
  return JSON.parse(r.stdout);
}

function main() {
  const projectsDir = path.join(REAL_HOME, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) throw new Error(`没有 ${projectsDir}`);
  const indexDir = process.env.PROBE_INDEX_FIXED || fs.mkdtempSync(path.join(os.tmpdir(), 'cgui-real-index-'));
  process.stdout.write(`[real] 真实数据 ${projectsDir}\n[real] 索引写到 ${indexDir}(用户的索引目录一字未动)\n`);

  const cold = spawnPhase('cold-noindex', indexDir);   // 口径 A:第一次扫,索引目录是空的
  const warm = spawnPhase('cold-index', indexDir);     // 口径 B/C:索引已落盘的新进程

  const rows = [];
  rows.push(['A 冷进程·无索引', 'GET /api/projects(首次)', cold.projectsFirst, null]);
  rows.push(['C 进程内第二次', 'GET /api/projects', cold.projectsSecond, '≤ 100ms']);
  for (const s of cold.sessions) rows.push(['A 冷进程·无索引', `sessions(${s.files} 文件 / ${(s.bytes / 1e6).toFixed(0)}MB)`, s.first, '见 §1.3 不承诺']);
  rows.push(['B 冷进程·索引已落盘', 'GET /api/projects(首次)', warm.projectsFirst, '≤ 250ms']);
  rows.push(['C 进程内第二次', 'GET /api/projects', warm.projectsSecond, '≤ 100ms']);
  for (const s of warm.sessions) rows.push(['B 冷进程·索引已落盘', `sessions(${s.files} 文件 / ${(s.bytes / 1e6).toFixed(0)}MB)`, s.first, '≤ 600ms']);
  for (const s of warm.sessions) rows.push(['C 进程内第二次', `sessions(${s.files} 文件)`, s.second, '≤ 200ms']);

  process.stdout.write(`\n项目 ${warm.projectsTotal} 个;下表为函数级计时(不含 HTTP 传输)\n`);
  process.stdout.write('口径                 场景                                     耗时        门槛\n');
  for (const [phase, what, v, gate] of rows) {
    process.stdout.write(`${phase.padEnd(21)}${what.padEnd(41)}${`${ms(v)} ms`.padEnd(12)}${gate || ''}\n`);
  }

  const fails = [];
  if (warm.projectsSecond > 100) fails.push(`G1 项目列表(进程内第二次)= ${ms(warm.projectsSecond)}ms > 100ms`);
  if (warm.projectsFirst > 250) fails.push(`G2 项目列表(冷进程·索引已落盘)= ${ms(warm.projectsFirst)}ms > 250ms`);
  for (const s of warm.sessions) {
    if (s.first > 600) fails.push(`G3 sessions(${s.hash}, ${s.files} 文件)= ${ms(s.first)}ms > 600ms`);
    if (s.second > 200) fails.push(`G4 sessions(${s.hash}) 第二次 = ${ms(s.second)}ms > 200ms`);
  }
  if (fails.length) {
    process.stdout.write(`\n✘ 真实数据口径未达标(${fails.length} 条):\n${fails.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('\n✓ 真实数据口径:G1/G2/G3/G4 全部达标(A 口径按计划不承诺)\n');
  process.stdout.write(`索引目录留在 ${indexDir}(下一轮想看「已落盘」口径可以 PROBE_INDEX_FIXED=… 复用)\n`);
}

if (process.argv.includes('--phase')) {
  const out = await runPhase({ indexDir: process.env.PROBE_INDEX });
  process.stdout.write(`${JSON.stringify(out)}\n`);
} else {
  main();
}
