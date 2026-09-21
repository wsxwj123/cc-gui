#!/usr/bin/env node
// 单测:r122 R5 回滚点启动清扫(INTERFACE-r122 F1/F3–F9;PLAN R5)。
// 全部在临时根目录里造现场(绝不碰真实 ~/.claude/gui/checkpoints);gc / dirBytes / gitCount 可注入。
//   t1 粗筛三维:条数超 / 天数超 / 总占用超 → 调 gc;三维都没超 → 不调;单条会话总占用维不介入
//   t2 活跃跳过(meta.json mtime 落在窗口内)、非法目录名跳过、根下的普通文件忽略、无 meta 靠 gitCount
//   t3 gc 抛错继续下一个;汇总行含 checkpoints + sweep + 扫描数 + 回收数
//   t4 并发互斥:另一路正占着某会话 → 本次跳过(skippedBusy),不重复调 gc
//   t5 排程判定 checkpointSweepPlan:SWEEP=0 不排;延迟缺省 60000;非法/负数回落
//   t6 真实 gcSession 集成(默认 gc + 默认 gitCount):真影子仓 5 条 + 1 条无 meta 的提交,maxCount=3 → 剩 3 条
//   t7 runStartupSweep 一次进程只跑一遍
// Run: node tests/unit/check-checkpoint-sweep.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'cgui-sweep-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } });
// 隔离 HOME 必须在 import 之前:checkpoint-paths.js 在模块加载期用 homedir() 算 CHECKPOINTS_ROOT,
// 默认 gc(真实 gcSession)只认这个根 —— 绝不读写真实 ~/.claude*(与 check-r120-checkpoint 同一做法)。
const HOME = join(tmp, 'home'); mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
const { sweepAllSessions, runStartupSweep, checkpointSweepPlan } = await import('../../server/routes/checkpoints.js');
const { CHECKPOINTS_ROOT } = await import('../../server/utils/checkpoint-paths.js');
assert.ok(CHECKPOINTS_ROOT.startsWith(HOME), `自证:回滚点根落在隔离 HOME 之下(${CHECKPOINTS_ROOT})`);

const SID = (n) => `u122${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
const HOUR = 3_600_000; const DAY = 86_400_000;
const NOW = Date.parse('2026-09-21T06:00:00.000Z');
let n = 0;
/** 造一个会话目录:entries 条 meta(最旧 ts = NOW - oldestAgeMs),meta.json 的 mtime = NOW - mtimeAgeMs。 */
function makeSession(root, { entries, oldestAgeMs = HOUR, mtimeAgeMs = HOUR, meta = true, name } = {}) {
  n += 1;
  const id = name || SID(n);
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  if (meta) {
    const list = Array.from({ length: entries }, (_, i) => ({
      sha: `${String(i).padStart(2, '0')}`.repeat(20), ts: NOW - oldestAgeMs + i * 1000, label: `#${i}`,
    }));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ entries: list }));
    const t = new Date(NOW - mtimeAgeMs);
    utimesSync(join(dir, 'meta.json'), t, t);
  }
  return id;
}
const recorder = () => { const calls = []; const lines = []; return { calls, lines, gc: async (sid) => { calls.push(sid); return { removed: 2 }; }, log: (l) => lines.push(l) }; };
const base = (root, rec, extra = {}) => ({
  root, now: NOW, idleMs: 600_000, maxCount: 3, maxAgeMs: 30 * DAY, maxTotalBytes: 100 * 1024 * 1024,
  gc: rec.gc, log: rec.log, pauseMs: 0, io: { gitCount: async () => 0, dirBytes: async () => 1024 }, ...extra,
});

// ── t1 粗筛三维 ──────────────────────────────────────────────────────────
{
  const root = join(tmp, 't1'); mkdirSync(root);
  const overCount = makeSession(root, { entries: 5 });
  const under = makeSession(root, { entries: 2 });
  const overAge = makeSession(root, { entries: 2, oldestAgeMs: 40 * DAY });
  const single = makeSession(root, { entries: 1 });
  const rec = recorder();
  const big = new Set([single]);
  const sum = await sweepAllSessions(base(root, rec, { io: { gitCount: async () => 0, dirBytes: async (d) => (big.has(d.split('/').pop()) ? 500 * 1024 * 1024 : 1024) } }));
  assert.deepEqual(rec.calls.sort(), [overCount, overAge].sort(), 't1: 条数超与天数超的会话被调 gc;未超的与单条的不调');
  assert.equal(sum.scanned, 4, 't1: 四个会话都算扫描过');
  assert.equal(sum.gcCalls, 2, 't1: gc 调了两次');
  assert.equal(sum.reclaimed, 4, 't1: 回收条数 = 各次 gc 的 removed 之和');
  assert.equal(sum.skippedActive, 0);
  // 总占用维:两条以上且 dirBytes 超 → 调
  const rec2 = recorder();
  const root2 = join(tmp, 't1b'); mkdirSync(root2);
  const overBytes = makeSession(root2, { entries: 2 });
  await sweepAllSessions(base(root2, rec2, { io: { gitCount: async () => 0, dirBytes: async () => 500 * 1024 * 1024 } }));
  assert.deepEqual(rec2.calls, [overBytes], 't1: 总占用超上限(dirBytes)→ 调 gc');
  // 三维都没超:不调 gc、也不该去量目录(dirBytes 只在条数 >1 时量,这里量了也无妨,但 gc 绝不能调)
  const rec3 = recorder();
  const root3 = join(tmp, 't1c'); mkdirSync(root3);
  makeSession(root3, { entries: 3 }); makeSession(root3, { entries: 2, oldestAgeMs: 10 * DAY });
  const s3 = await sweepAllSessions(base(root3, rec3));
  assert.deepEqual(rec3.calls, [], 't1: 三维都没超一个不动(R5-3)');
  assert.equal(s3.scanned, 2);
}

// ── t2 跳过规则 ──────────────────────────────────────────────────────────
{
  const root = join(tmp, 't2'); mkdirSync(root);
  const active = makeSession(root, { entries: 8, mtimeAgeMs: 60_000 });          // 1 分钟前活动 → 窗口内
  const bad = makeSession(root, { entries: 8, name: 'bad name!' });               // 白名单外
  const noMeta = makeSession(root, { entries: 0, meta: false });                   // 没有 meta:靠 gitCount
  writeFileSync(join(root, 'stray.txt'), 'not a session dir');                    // 根下普通文件
  const rec = recorder();
  const sum = await sweepAllSessions(base(root, rec, { io: { gitCount: async (d) => (d.endsWith(noMeta) ? 6 : 0), dirBytes: async () => 1024 } }));
  assert.deepEqual(rec.calls, [noMeta], 't2: 只有"无 meta 但 git 里 6 条"的会话被调 gc;活跃与非法目录名都跳过');
  assert.equal(sum.skippedActive, 1, 't2: 活跃跳过计 1');
  assert.equal(sum.skippedInvalid, 1, 't2: 非法目录名计 1');
  assert.equal(sum.scanned, 2, `t2: 扫描数只算白名单内的目录(active + noMeta),不算 ${bad} 与普通文件`);
  assert.ok(!rec.calls.includes(active), 't2: 活跃会话不调 gc(F5)');
  // idleMs 可调(F1):窗口缩到 1 秒,1 分钟前活动的就不算近期
  const rec2 = recorder();
  const sum2 = await sweepAllSessions(base(root, rec2, { idleMs: 1000, io: { gitCount: async () => 0, dirBytes: async () => 1024 } }));
  assert.ok(rec2.calls.includes(active), 't2: idleMs=1000 时 1 分钟前活动的超限会话被回收(F5-2)');
  assert.equal(sum2.skippedActive, 0);
  // idleMs=0 = 关闭活跃窗口
  const rec3 = recorder();
  await sweepAllSessions(base(root, rec3, { idleMs: 0, io: { gitCount: async () => 0, dirBytes: async () => 1024 } }));
  assert.ok(rec3.calls.includes(active), 't2: idleMs=0 不跳过任何会话');
  // 根目录不存在:不抛,扫描 0
  const rec4 = recorder();
  const s4 = await sweepAllSessions(base(join(tmp, 'nope'), rec4));
  assert.equal(s4.scanned, 0, 't2: 根目录不存在 → 扫描 0,不抛');
  assert.equal(rec4.lines.length, 1, 't2: 仍留一行汇总');
}

// ── t3 单会话失败继续 + 汇总行 ────────────────────────────────────────────
{
  const root = join(tmp, 't3'); mkdirSync(root);
  const a = makeSession(root, { entries: 5 });
  const b = makeSession(root, { entries: 5 });
  const c = makeSession(root, { entries: 5 });
  makeSession(root, { entries: 5, mtimeAgeMs: 1000 });                             // 活跃 → 跳过
  const calls = []; const lines = [];
  const gc = async (sid) => { calls.push(sid); if (sid === b) throw new Error('boom'); return { removed: 5 }; };
  const sum = await sweepAllSessions(base(root, { gc, log: (l) => lines.push(l) }, { gc, log: (l) => lines.push(l) }));
  assert.deepEqual(calls.sort(), [a, b, c].sort(), 't3: 一个会话 gc 抛错,其余照常处理');
  assert.equal(sum.failed, 1, 't3: 失败计 1');
  assert.equal(sum.reclaimed, 10, 't3: 抛错的那个不计回收');
  assert.equal(lines.length, 1, 't3: 恰好一行汇总');
  assert.ok(/checkpoints/.test(lines[0]) && /sweep/.test(lines[0]), `t3: 汇总行含 checkpoints 与 sweep(F8):${lines[0]}`);
  assert.ok(/扫描 4 个会话/.test(lines[0]), `t3: 含扫描会话数:${lines[0]}`);
  assert.ok(/回收 10 条/.test(lines[0]), `t3: 含回收条数:${lines[0]}`);
  assert.ok(/活跃跳过 1/.test(lines[0]), `t3: 含活跃跳过数:${lines[0]}`);
  assert.ok(/耗时 \d+ ms/.test(lines[0]), `t3: 含耗时:${lines[0]}`);
  assert.ok(/失败 1/.test(lines[0]), `t3: 有失败时汇总里能看到:${lines[0]}`);
}

// ── t4 并发互斥:另一路正占着 → 跳过,不重复调 ─────────────────────────────
{
  const root = join(tmp, 't4'); mkdirSync(root);
  const only = makeSession(root, { entries: 5 });
  let release = null;
  const gcA = () => new Promise((resolve) => { release = () => resolve({ removed: 2 }); });
  const recA = { lines: [] };
  const pA = sweepAllSessions(base(root, { gc: gcA, log: (l) => recA.lines.push(l) }, { gc: gcA, log: (l) => recA.lines.push(l) }));
  for (let i = 0; i < 200 && !release; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.ok(release, 't4: 第一路已进入 gc(占着锁)');
  const recB = recorder();
  const sumB = await sweepAllSessions(base(root, recB));
  assert.deepEqual(recB.calls, [], 't4: 第二路占不到锁 → 不调 gc');
  assert.equal(sumB.skippedBusy, 1, 't4: 记为占用跳过');
  assert.ok(/占用跳过 1/.test(recB.lines[0]), `t4: 汇总里可见:${recB.lines[0]}`);
  release();
  const sumA = await pA;
  assert.equal(sumA.gcCalls, 1, 't4: 第一路照常完成');
  assert.equal(sumA.reclaimed, 2);
  // 锁已放:再来一路能正常调
  const recC = recorder();
  await sweepAllSessions(base(root, recC));
  assert.deepEqual(recC.calls, [only], 't4: 释放后下一路能拿到锁');
}

// ── t5 排程判定 ──────────────────────────────────────────────────────────
{
  assert.deepEqual(checkpointSweepPlan({ CGUI_CHECKPOINT_SWEEP: '0' }), { enabled: false, delayMs: 60_000 }, 't5: SWEEP=0 不排程(F6)');
  assert.deepEqual(checkpointSweepPlan({}), { enabled: true, delayMs: 60_000 }, 't5: 默认开、延迟 60 秒(F1)');
  assert.deepEqual(checkpointSweepPlan({ CGUI_CHECKPOINT_SWEEP: '1', CGUI_CHECKPOINT_SWEEP_DELAY_MS: '1500' }), { enabled: true, delayMs: 1500 }, 't5: 延迟可调');
  assert.equal(checkpointSweepPlan({ CGUI_CHECKPOINT_SWEEP_DELAY_MS: '0' }).delayMs, 0, 't5: 0 = 启动即扫(F7-2)');
  assert.equal(checkpointSweepPlan({ CGUI_CHECKPOINT_SWEEP_DELAY_MS: 'abc' }).delayMs, 60_000, 't5: 非法值回落默认');
  assert.equal(checkpointSweepPlan({ CGUI_CHECKPOINT_SWEEP_DELAY_MS: '-5' }).delayMs, 60_000, 't5: 负数回落默认');
  assert.equal(checkpointSweepPlan({ CGUI_CHECKPOINT_SWEEP_DELAY_MS: '' }).delayMs, 60_000, 't5: 空串回落默认');
  assert.equal(checkpointSweepPlan({ CGUI_CHECKPOINT_SWEEP: 'off' }).enabled, true, 't5: 只有字面 0 才算关(与既有 envNum 家族一致:不猜别的写法)');
}

// ── t6 真实 gcSession 集成(默认 gc + 默认 gitCount + 默认 dirBytes)──────────
{
  let hasGit = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
  if (!hasGit) {
    console.log('t6: 本机没有 git,跳过真实集成(F 组验收覆盖)');
  } else {
    // 用默认根(隔离 HOME 下的 CHECKPOINTS_ROOT):真实 gcSession 只认它
    const root = CHECKPOINTS_ROOT; mkdirSync(root, { recursive: true });
    const id = SID(600);
    const gitDir = join(root, id);
    const wt = join(tmp, 't6-wt'); mkdirSync(wt);
    const env = { ...process.env, LC_ALL: 'C', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
    const git = (args) => execFileSync('git', ['--git-dir', gitDir, '--work-tree', wt, ...args], { env, cwd: wt, encoding: 'utf8' });
    mkdirSync(gitDir, { recursive: true });
    execFileSync('git', ['--git-dir', gitDir, 'init', '--bare', '-q'], { env });
    const shas = [];
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(wt, 'note.txt'), `v${i}\n`);
      git(['add', '-A']); git(['commit', '-q', '--allow-empty', '-m', `cp ${i}`]);
      shas.push(git(['rev-parse', 'HEAD']).trim());
    }
    // meta 只登记 3 条(条数按 meta 看没超),但影子仓里有 5 条 + 下面这 1 条 pre-restore 式的无 meta 提交 → 靠 gitCount 判超
    writeFileSync(join(wt, 'note.txt'), 'pre-restore\n'); git(['add', '-A']); git(['commit', '-q', '-m', 'pre-restore x']);
    writeFileSync(join(gitDir, 'meta.json'), JSON.stringify({ entries: shas.slice(2).map((sha, i) => ({ sha, ts: NOW - HOUR + i, label: `#${i}` })) }));
    const t = new Date(NOW - HOUR); utimesSync(join(gitDir, 'meta.json'), t, t);
    const lines = [];
    const sum = await sweepAllSessions({ root, now: NOW, idleMs: 600_000, maxCount: 3, maxAgeMs: 30 * DAY, maxTotalBytes: 100 * 1024 * 1024, pauseMs: 0, log: (l) => lines.push(l) });
    assert.equal(sum.gcCalls, 1, 't6: 真实 gcSession 被调了一次');
    assert.equal(sum.reclaimed, 3, 't6: 6 条(含 1 条无 meta 的)按 maxCount=3 回收 3 条');
    const left = execFileSync('git', ['--git-dir', gitDir, '-c', 'advice.graftFileDeprecated=false', 'log', '--format=%H'], { env, encoding: 'utf8' }).trim().split('\n');
    assert.equal(left.length, 3, 't6: 影子仓 git log 剩 3 条');
    assert.equal(left[0], git(['rev-parse', 'HEAD']).trim(), 't6: 最新一条(保底)仍在且是 HEAD');
    // 再扫一遍:已经在上限内 → 不再调 gc(R5-3 幂等)
    const sum2 = await sweepAllSessions({ root, now: NOW, idleMs: 0, maxCount: 3, maxAgeMs: 30 * DAY, maxTotalBytes: 100 * 1024 * 1024, pauseMs: 0, log: () => {} });
    assert.equal(sum2.gcCalls, 0, 't6: 收过一遍后再扫不再调 gc');
  }
}

// ── t7 一次进程只跑一遍(放最后:它改的是模块级标志)──────────────────────
{
  const root = join(tmp, 't7'); mkdirSync(root);
  makeSession(root, { entries: 5 });
  const rec = recorder();
  const first = await runStartupSweep(base(root, rec));
  assert.ok(first && first.gcCalls === 1, 't7: 第一遍真的跑了');
  const second = await runStartupSweep(base(root, rec));
  assert.equal(second, null, 't7: 第二遍不跑(F9 只扫一遍)');
  assert.equal(rec.calls.length, 1, 't7: gc 没被第二次调用');
}

console.log('check-checkpoint-sweep: all passed');
