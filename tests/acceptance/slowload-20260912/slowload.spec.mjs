#!/usr/bin/env node
// 「打开 app 慢 / 点开项目慢」那批改动(会话画像 + 索引落盘 + 增量读)的验收套件。
//
// 判据来源:.devflow/PLAN-20260912-slowload.md §1.2(G1~G6 门槛)、§9.3(怎么量)、
//           §9.4(反向用例)、.devflow/INTERFACE-20260912-slowload.md §D.3/§D.4/§F。
//
// ── 三种口径(必须分开念,它们永远不该混着比)──
//   A「冷进程 · 无索引」   : 索引目录空 + 新进程 → 全量扫一遍。计划里明确**不承诺**(§1.3),只记录。
//   B「冷进程 · 索引已落盘」: 索引在磁盘上 + 新进程 → G2 / G3 / G5 / G6 的口径。
//   C「进程内第二次」       : 同一进程连续请求 → G1 / G4 的口径。
//   (历史上两套数字打架的根因就是 A 与 B 混着比 —— 差着一个数量级。)
//
// 跑法:./run-isolated.sh(负责挑 6700+ 的空闲端口、铺夹具、把本文件跑起来)。
// 不许手工起实例:端口/HOME/索引目录三者不对齐,跑出来的红全是假的。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as R from './helpers/runtime.mjs';
import { ensureFixtures, resetMutatedFiles, projectDir, workspaceDir } from './helpers/fixtures.mjs';

const suiteDir = path.dirname(fileURLToPath(import.meta.url));
const timings = [];   // { phase, what, ms, gate }
const failures = [];
const record = (phase, what, ms, gate = null) => timings.push({ phase, what, ms: Math.round(ms * 10) / 10, gate });

async function test(name, fn) {
  try {
    const detail = await fn();
    process.stdout.write(`  ✓ ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (err) {
    failures.push({ name, message: err.message });
    process.stdout.write(`  ✘ ${name} — ${err.message}\n`);
  }
}

const S = (arr) => arr.map((v) => `${v.toFixed(1)}ms`).join(' / ');
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const appendLine = (file, rec) => fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);

const userLine = (sid, text, minute, cwd) => ({
  parentUuid: null, isSidechain: false, type: 'user', userType: 'external', entrypoint: 'cli',
  message: { role: 'user', content: [{ type: 'text', text }] },
  uuid: `5fed0000-0000-4000-8000-9${String(minute).padStart(11, '0')}`,
  timestamp: new Date(Date.UTC(2026, 8, 13, 9, minute % 60, 0)).toISOString(),
  cwd, sessionId: sid, version: '2.1.267', gitBranch: 'HEAD',
});

const asstLine = (sid, text, minute, cwd) => ({
  parentUuid: null, isSidechain: false, type: 'assistant', userType: 'external', entrypoint: 'cli',
  message: {
    id: `msg_slowload_a${minute}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 34 },
  },
  requestId: `req_slowload_a${minute}`, uuid: `5fed0000-0000-4000-8000-8${String(minute).padStart(11, '0')}`,
  timestamp: new Date(Date.UTC(2026, 8, 13, 9, minute % 60, 0)).toISOString(),
  cwd, sessionId: sid,
});

const m = ensureFixtures();
const BIG = m.projects.big.hash;
const MID = m.projects.mid.hash;
const bigDir = projectDir(BIG);
const activeFile = path.join(bigDir, `${m.sessions.active}.jsonl`);
const midFile = path.join(projectDir(MID), `${m.sessions.mid}.jsonl`);
const bigCwd = workspaceDir('big');

/** 把 mid 那条会话整份重写成 n 轮问答(每轮 2 行,保证 ≥3 行不被 totalLines 门槛丢掉)。 */
function writeMidSession(texts) {
  const cwd = workspaceDir('mid');
  const lines = [];
  texts.forEach((t, i) => {
    lines.push(JSON.stringify(userLine(m.sessions.mid, t, 10 + i * 2, cwd)));
    lines.push(JSON.stringify(asstLine(m.sessions.mid, `${t} 的回复`, 11 + i * 2, cwd)));
  });
  fs.writeFileSync(midFile, `${lines.join('\n')}\n`);
}
const pickMid = (arr) => arr.find((s) => s.sessionId === m.sessions.mid);

let inst = null;

async function main() {
  resetMutatedFiles(); // 上一轮被追加/替换/截断过的夹具铺回原样(幂等)
  process.stdout.write(`\n[slowload] 大项目 ${m.projects.big.files} 个 jsonl、其中一条 ${Math.round(m.bigFileBytes / 1024 / 1024)} MB\n`);
  process.stdout.write(`[slowload] 端口 ${R.resolvePort()}、HOME ${m.home}\n[slowload] 本轮索引目录 ${R.activeIndexDir()}（全新空目录 = 「无索引」那一档每轮都成立）\n`);

  await test('0. 索引落点在本套件目录内(不碰真实 ~/.claude-gui)', () => {
    assert.ok(R.activeIndexDir().startsWith(m.dataRoot), `索引目录 ${R.activeIndexDir()} 不在夹具目录内`);
  });

  inst = await R.startInstance({ indexOn: true });

  // ── 口径 A:冷进程 · 无索引(只记录,不设门槛)──
  const baseProjects = R.indexFileMtime(BIG);
  const first = await R.hit(R.projectsPath);
  record('A 冷进程·无索引', 'GET /api/projects', first.ms, null);
  const firstBody = first.body;
  await R.waitForIndexFlush(BIG, { baseline: baseProjects });   // 等 listProjects 那份画像落盘
  const baseSessions = R.indexFileMtime(BIG);
  record('A 冷进程·无索引', `GET sessions(大项目)`, (await R.hit(R.sessionsPath(BIG))).ms, null);
  await R.waitForIndexFlush(BIG, { baseline: baseSessions });   // 等**全量画像**落盘(基线必须前进)

  // ── 1. 数据正确性对拍:旧实现(全量扫描) vs 新实现(画像+索引),逐字节 ──
  await test('1. 同一份数据,旧实现与新实现的响应体逐字节相同(最要紧的一条)', () => {
    const r = spawnSync(process.execPath, [path.join(suiteDir, 'helpers', 'crosscheck.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: m.home, USERPROFILE: m.home, WORKTREE: R.worktree },
    });
    if (!r.stdout) throw new Error(`对拍脚本没输出:${r.stderr?.slice(-400)}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.diffs, [], `对拍出现差异:${JSON.stringify(out.diffs).slice(0, 600)}`);
    return `${out.comparisons.length} 组(项目列表 + 各项目会话列表)、基线 ${out.baseCommit}`;
  });

  // ── 2. G1:进程内第二次起 ≤ 100 ms ──
  const g1 = await R.timed(R.projectsPath, { samples: 3 });
  record('C 进程内第二次', 'GET /api/projects', g1.median, '≤ 100ms');
  await test('2. G1 项目列表(进程内第二次起)≤ 100 ms', () => {
    assert.equal(g1.body, firstBody, '两次响应体必须逐字节相同(不许用缓存换掉内容)');
    assert.ok(g1.median <= 100, `中位 ${g1.median.toFixed(1)}ms > 100ms(${S(g1.samples)})`);
    return `中位 ${g1.median.toFixed(1)}ms(${S(g1.samples)})`;
  });

  // ── 3. G4:同一进程内第二次 ≤ 200 ms ──
  // 口径 A 那一步已经把全量画像扫完并落盘,这里再请求就是纯粹的「进程内第二次起」。
  const g4 = await R.timed(R.sessionsPath(BIG), { samples: 3 });
  record('C 进程内第二次', 'GET sessions(大项目)', g4.median, '≤ 200ms');
  await test('3. G4 大项目会话列表(进程内第二次起)≤ 200 ms', () => {
    assert.ok(g4.median <= 200, `中位 ${g4.median.toFixed(1)}ms > 200ms(${S(g4.samples)})`);
    return `中位 ${g4.median.toFixed(1)}ms(${S(g4.samples)})`;
  });

  // ── 4. G2 + G5:重启三次,每次先 projects 再 sessions(索引都在磁盘上)──
  const g2 = [];
  const g5s = [];
  for (let i = 0; i < 3; i += 1) {
    inst = await R.restartInstance(inst, { indexOn: true });
    const p = await R.hit(R.projectsPath);
    const s = await R.hit(R.sessionsPath(BIG));
    g2.push(p.ms);
    g5s.push(s.ms);
  }
  record('B 冷进程·索引已落盘', 'GET /api/projects', median(g2), '≤ 250ms');
  record('B 冷进程·索引已落盘', 'GET sessions(大项目)', median(g5s), 'G5 的一部分');
  await test('4. G2 项目列表(冷进程、索引已落盘)≤ 250 ms', () => {
    assert.ok(median(g2) <= 250, `中位 ${median(g2).toFixed(1)}ms > 250ms(${S(g2)})`);
    return `中位 ${median(g2).toFixed(1)}ms(${S(g2)})`;
  });
  await test('5. G5 开 app 到「项目列表 + 会话列表」都返回 ≤ 1.2 s', () => {
    const sums = g2.map((v, i) => v + g5s[i]);
    assert.ok(median(sums) <= 1200, `中位 ${median(sums).toFixed(1)}ms > 1200ms(${S(sums)})`);
    return `中位 ${median(sums).toFixed(1)}ms(${S(sums)})`;
  });

  // ── 5. G3:索引命中(重启后第一次)≤ 600 ms,且走的是「从索引载入」而不是重扫 ──
  const g3 = [];
  let loadedDelta = null;
  for (let i = 0; i < 3; i += 1) {
    inst = await R.restartInstance(inst, { indexOn: true });
    const before = await R.stats();
    const h = await R.hit(R.sessionsPath(BIG));
    const after = await R.stats();
    g3.push(h.ms);
    if (i === 0) {
      loadedDelta = {
        loaded: after.counters.loaded - before.counters.loaded,
        scanned: after.counters.scanned - before.counters.scanned,
        rescanned: after.counters.rescanned - before.counters.rescanned,
        files: after.projects[BIG]?.files ?? null,
      };
    }
  }
  record('B 冷进程·索引已落盘', 'GET sessions(重启后首次)', median(g3), '≤ 600ms');
  await test('6. G3 大项目会话列表(索引命中、重启后首次)≤ 600 ms', () => {
    assert.ok(median(g3) <= 600, `中位 ${median(g3).toFixed(1)}ms > 600ms(${S(g3)})`);
    return `中位 ${median(g3).toFixed(1)}ms(${S(g3)})`;
  });
  await test('7. G3 配套:重启后第一次是「载入索引」而不是「重新扫盘」', () => {
    assert.ok(loadedDelta.loaded > 0, `loaded 没有增长(${JSON.stringify(loadedDelta)})`);
    assert.equal(loadedDelta.scanned, 0, `scanned 增长了 ${loadedDelta.scanned} —— 索引没被用上`);
    return `loaded +${loadedDelta.loaded} / scanned +${loadedDelta.scanned} / rescanned +${loadedDelta.rescanned}(项目共 ${loadedDelta.files} 个文件)`;
  });

  // ── 6. G6:会话进行中(文件持续写入)第二次请求 ≤ 250 ms,且走增量而不是全量重扫 ──
  await test('8. G6 会话进行中的第二次请求 ≤ 250 ms,且走增量而非首次全扫', async () => {
    const baseline = await R.stats();
    appendLine(activeFile, userLine(m.sessions.active, 'G6 追加的第一行', 1, bigCwd));
    await R.hit(R.sessionsPath(BIG));
    appendLine(activeFile, userLine(m.sessions.active, 'G6 追加的第二行', 2, bigCwd));
    const h = await R.hit(R.sessionsPath(BIG));
    const after = await R.stats();
    record('B 冷进程·索引已落盘', 'GET sessions(活跃写入中)', h.ms, '≤ 250ms');
    const inc = after.counters.incremental - baseline.counters.incremental;
    const rescan = after.counters.rescanned - baseline.counters.rescanned;
    const scanned = after.counters.scanned - baseline.counters.scanned;
    assert.ok(h.ms <= 250, `耗时 ${h.ms.toFixed(1)}ms > 250ms`);
    assert.ok(inc + rescan >= 1, `追加后既没走 incremental 也没走 rescanned(incremental +${inc} / rescanned +${rescan})`);
    assert.equal(scanned, 0, `走了 ${scanned} 次首次全扫 —— 增量路径没生效`);
    return `${h.ms.toFixed(1)}ms、incremental +${inc} / rescanned +${rescan} / scanned +${scanned}`;
  });

  // ── 7. 反向用例(真跑,不只看代码)──
  await test('9. 追加一行:条数 +1、首条与标题不变、lastActivity 前进', async () => {
    const before = pickMid(await R.getJson(R.sessionsPath(MID)));
    appendLine(midFile, userLine(m.sessions.mid, '追加的新一轮提问', 3, workspaceDir('mid')));
    const after = pickMid(await R.getJson(R.sessionsPath(MID)));
    assert.equal(after.messageCount, before.messageCount + 1, `messageCount ${before.messageCount} → ${after.messageCount}`);
    assert.equal(after.firstPrompt, before.firstPrompt, 'firstPrompt 不许被追加影响');
    assert.equal(after.customTitle, before.customTitle, 'customTitle 不许被追加影响');
    assert.ok(new Date(after.lastActivity) > new Date(before.lastActivity), 'lastActivity 必须前进');
    return `messageCount ${before.messageCount} → ${after.messageCount}`;
  });

  await test('10. 尾部追加标题行:立即生效(证明增量确实扫了新区段)', async () => {
    appendLine(midFile, { type: 'custom-title', customTitle: '尾部改的标题', sessionId: m.sessions.mid });
    const s = pickMid(await R.getJson(R.sessionsPath(MID)));
    assert.equal(s.customTitle, '尾部改的标题');
  });

  await test('11. 原子替换(写 tmp + rename,换成别的一段):必须返回新内容', async () => {
    const tmp = `${midFile}.tmp-rename`;
    writeMidSession(['替换后的唯一一条', '替换后的第二条']);   // 先写进 midFile,再整份搬过去
    fs.renameSync(midFile, tmp);
    fs.renameSync(tmp, midFile);                                // 同名字替换 → inode 变
    const s = pickMid(await R.getJson(R.sessionsPath(MID)));
    assert.ok(s, '替换后会话仍在列表里');
    assert.equal(s.firstPrompt, '替换后的唯一一条', `首条还是旧的:${s.firstPrompt}`);
    assert.equal(s.messageCount, 4, `条数没换成新文件的口径:${s.messageCount}`);
    return `firstPrompt = 替换后的唯一一条、messageCount ${s.messageCount}`;
  });

  await test('12. 截短到一半:必须扫出新内容(不许吃旧画像)', async () => {
    writeMidSession(['截断前第一轮', '截断前第二轮', '截断前第三轮']);
    const countBefore = pickMid(await R.getJson(R.sessionsPath(MID))).messageCount;
    const rescansBefore = (await R.stats()).counters.rescanned;
    writeMidSession(['截断后只剩两轮', '截断后第二轮']);         // 行数变少 → size 回退闸门
    const s = pickMid(await R.getJson(R.sessionsPath(MID)));
    const rescansAfter = (await R.stats()).counters.rescanned;
    assert.ok(s, '截短后会话仍在列表里');
    assert.equal(s.firstPrompt, '截断后只剩两轮', `首条没有跟着新内容走:${s.firstPrompt}`);
    assert.ok(s.messageCount < countBefore, `条数没下降:${countBefore} → ${s.messageCount}`);
    assert.ok(rescansAfter > rescansBefore, `rescanned 没增长(${rescansBefore} → ${rescansAfter})`);
    return `messageCount ${countBefore} → ${s.messageCount}、rescanned ${rescansBefore} → ${rescansAfter}`;
  });

  // ── 8. 索引坏掉 / 开关关掉,结果都不许变 ──
  inst = await R.restartInstance(inst, { indexOn: true });
  await R.hit(R.sessionsPath(MID));
  await R.waitForIndexFlush(MID);
  inst = await R.restartInstance(inst, { indexOn: true });
  const goodBody = JSON.stringify(await R.getJson(R.sessionsPath(MID)));
  inst = await R.restartInstance(inst, { indexOn: true }); // 内存空 + 索引在盘上,下面再把它写坏
  fs.writeFileSync(path.join(R.activeIndexDir(), `${MID}.json`), '{"v":1,"files":[{"oops"'); // 半截 JSON
  await test('13. 索引文件坏掉:接口仍然正确,只是重扫(indexReadFailed 增长)', async () => {
    const before = (await R.stats()).counters.indexReadFailed;
    const body = JSON.stringify(await R.getJson(R.sessionsPath(MID)));
    const after = (await R.stats()).counters.indexReadFailed;
    assert.equal(body, goodBody, '坏索引下的响应体必须与好索引时逐字节相同');
    assert.ok(after > before, `indexReadFailed 没增长(${before} → ${after})`);
    return `indexReadFailed ${before} → ${after}、响应体一致`;
  });

  inst = await R.restartInstance(inst, { indexOn: false });
  await test('14. CGUI_SESSION_INDEX=off:响应体与开启时逐字节相同(只是慢)', async () => {
    const st = await R.stats();
    assert.equal(st.enabled, false, 'off 时 stats.enabled 必须是 false');
    const body = JSON.stringify(await R.getJson(R.sessionsPath(MID)));
    assert.equal(body, goodBody, '关掉索引后响应体变了 —— 索引层不该改变内容');
    return `${body.length} 字节逐字节相同`;
  });

  // ── 9. fd 不泄漏(连续 50 次请求)──
  inst = await R.restartInstance(inst, { indexOn: true });
  await test('15. 连续 50 次请求后 fd 数不增长(±5 以内)', async () => {
    const pid = inst.pid;
    await R.hit(R.sessionsPath(BIG));
    const before = await R.fdCount(pid);
    if (before === null) return 'lsof 不可用 → 记 EnvironmentBlocked,不算产品红';
    for (let i = 0; i < 50; i += 1) await R.hit(R.sessionsPath(BIG));
    const after = await R.fdCount(pid);
    assert.ok(Math.abs(after - before) <= 5, `fd ${before} → ${after}(超过 ±5)`);
    return `${before} → ${after}`;
  });
}

await main().finally(() => R.stopInstance(inst));

// 落盘一份机器可读的结果(口径 / 数字 / 失败原因),供复核与事后对照。
fs.writeFileSync(path.join(suiteDir, '.artifacts', 'last-run.json'), `${JSON.stringify({
  ranAt: new Date().toISOString(),
  fixture: { bigFiles: m.projects.big.files, bigFileBytes: m.bigFileBytes, projects: m.projects },
  indexDir: R.activeIndexDir(),
  timings,
  failures,
}, null, 2)}\n`);

// ── 汇总(口径与门槛并排写出来,免得下次又把 A 和 B 混着比)──
process.stdout.write('\n口径                 场景                          中位/单次      门槛\n');
for (const t of timings) {
  process.stdout.write(`${t.phase.padEnd(21)}${t.what.padEnd(30)}${`${t.ms} ms`.padEnd(14)}${t.gate || ''}\n`);
}
const gated = timings.filter((t) => t.gate).length;
process.stdout.write(`\n${timings.length} 项计时(${gated} 项有门槛、${timings.length - gated} 项只记录口径 A)、${failures.length} 条断言失败\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  ✘ ${f.name}: ${f.message}\n`);
  process.exit(1);
}
process.stdout.write('slowload-20260912: 全绿\n');
