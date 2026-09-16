#!/usr/bin/env node
// 白盒补充单测:回滚点的**第三回收维 —— 每会话总占用上限**。
// 它治的是"条数(20)+ 天数(30)两维管不住大目录"这个遗留风险:用户在大目录上点过一次
// 「保存」后后续快照一路放行,峰值 = 20 × 目录体积(45 GB 的目录 ≈ 900 GB)。
// 本文件只在真实 HTTP + 真实影子仓上验证行为,不 import 实现内部函数:
//   1) 总占用超限时**从最旧开始丢**,最新的留在列表里
//   2) 条数 / 天数 / 总占用三维**取最严**(分别让其中一维成为瓶颈,看谁说了算)
//   3) **保底**:哪怕把总占用上限压到 1 字节,也必须留最新一条
//   4) 反向守卫:远未超限时**一条都不许删**
//   5) 清理后 meta.json / git log / 可达对象三方一致(总占用维不许只从列表里抹)
// 隔离:自建 HOME(绝不碰真实 ~/.claude/gui/checkpoints),端口只在 6041–6049 里挑。
// 夹具克制:每条快照一个 64 KiB 的**随机**文件(不可压缩 → git 对象大小可预期),
// 单次运行总写 < 4 MB。
//
// Run: node tests/unit/check-checkpoint-total-bytes.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = '/private/tmp/claude-501';
mkdirSync(SCRATCH, { recursive: true });
const TMP = mkdtempSync(join(SCRATCH, 'cgui-cptotal-'));
const HOME = join(TMP, 'home');
const WORK = join(HOME, 'work');
mkdirSync(WORK, { recursive: true });

const SNAP_BYTES = 64 * 1024;                 // 每条快照 ≈ 64 KiB(随机 → 基本不可压缩)
const MiB = 1024 * 1024;

let PASS = 0; let FAILS = 0; const failed = [];
async function check(name, fn) {
  try { await fn(); PASS += 1; console.log(`  ✓ ${name}`); }
  catch (e) {
    FAILS += 1; failed.push(name);
    console.log(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const CHECKPOINTS_DIR = join(HOME, '.claude', 'gui', 'checkpoints');
const snapDir = (id) => join(CHECKPOINTS_DIR, id);

/** 磁盘上真实存在的快照 sha(新→旧,直接问影子仓 —— 用户"打开得快照"的口径)。 */
function realShas(id) {
  const dir = snapDir(id);
  if (!existsSync(dir)) return [];
  const r = spawnSync('git', ['--git-dir', dir, 'log', '--format=%H'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}
/** 可达对象里真实的提交条数:与 log 条数不等 = 有孤儿提交没回收(只从列表里抹掉)。 */
function reachableShas(id) {
  const r = spawnSync('git', ['--git-dir', snapDir(id), 'rev-list', '--all', '--count'], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim()) : -1;
}
function metaShas(id) {
  try { return (JSON.parse(readFileSync(join(snapDir(id), 'meta.json'), 'utf8')).entries || []).map((e) => e.sha); }
  catch { return []; }
}

/** 每个配置一个隔离实例:上限是进程启动时读的环境变量,改配置就换一个实例(数据在同一个 HOME 里)。 */
let child = null;
async function boot(port, env) {
  if (child) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退 */ } child = null; }
  child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: TMP,
    env: {
      ...process.env, HOME, USERPROFILE: HOME, PORT: String(port), CGUI_DISABLE_FILE_WATCHER: '1',
      CGUI_CHECKPOINT_MAX_BYTES: String(16 * MiB),        // 单次上限放宽,别让体积安全阀先拦
      CGUI_CHECKPOINTS_MAX_COUNT: '20',
      CGUI_CHECKPOINTS_RETENTION_DAYS: '30',
      CGUI_ALLOW_TINY_CHECKPOINT_RETENTION: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })).ok) return base; }
    catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`隔离实例没起来(端口 ${port})\n${log.slice(-1500)}`);
}
async function post(base, body) {
  const res = await fetch(`${base}/api/checkpoints`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json };
}
async function list(base, sid) {
  const res = await fetch(`${base}/api/checkpoints/${sid}`, { signal: AbortSignal.timeout(30_000) });
  return (await res.json()).entries.map((e) => e.sha);
}
async function del(base, sid) {
  const res = await fetch(`${base}/api/checkpoints/${sid}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) });
  return res.status;
}

let portSeq = 6750;                                    // 只在 6700–6999 里挑,避开 6677/6689/6710
const sid = (n) => `12000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造 N 条各 ≈ SNAP_BYTES 的快照,返回 sha 列表(拍快照顺序 = 旧→新)。 */
async function shoot(base, sidStr, n) {
  const dir = join(WORK, sidStr);
  mkdirSync(dir, { recursive: true });
  const shas = [];
  for (let i = 0; i < n; i += 1) {
    writeFileSync(join(dir, 'payload.bin'), randomBytes(SNAP_BYTES));   // 内容全换 → 每条一份新对象
    const r = await post(base, { sessionId: sidStr, cwd: dir });
    assert.equal(r.status, 200, `第 ${i + 1} 次拍快照应成功:${r.text.slice(0, 200)}`);
    assert.ok(r.json.sha, '应返回 sha');
    shas.push(r.json.sha);
  }
  return shas;
}

const N = 6;

// ══════════════════════════════════════════════════════════════════════════
// C1 总占用维生效:超限时从最旧开始丢
// ══════════════════════════════════════════════════════════════════════════
console.log('\nC1 每会话总占用上限:超限丢最旧的');
{
  const S = sid(1);
  const base = await boot(portSeq += 1, { CGUI_CHECKPOINTS_MAX_TOTAL_BYTES: String(150 * 1024) });
  const shas = await shoot(base, S, N);
  // 150 KiB ≈ 2.3 条 × 64 KiB → 天花板是 2 条(3 条 ≈ 192 KiB 必超)
  const live = await list(base, S);
  await check('C1-1 总量超过每会话上限后,条数被压到上限以内(不再是"只涨不跌")', () => {
    assert.ok(live.length <= 2, `上限 150 KiB ≈ 2 条 × 64 KiB,实际留了 ${live.length} 条`);
    assert.ok(live.length >= 1, '不该被清空');
  });
  await check('C1-2 丢的是最旧的:活下来的必须是拍得最晚的那几条(最新一条必在)', () => {
    assert.ok(live.includes(shas[shas.length - 1]), '最新一条必须在');
    for (const sha of live) {
      assert.ok(shas.indexOf(sha) >= shas.length - live.length, `被留下的 ${sha.slice(0, 8)} 不是最新的那几条`);
    }
    assert.ok(!live.includes(shas[0]), `最旧的 ${shas[0].slice(0, 8)} 必须被回收`);
  });
  await check('C1-3 回收是真的(可达对象一起少),不是只从列表里抹掉', () => {
    assert.equal(reachableShas(S), live.length,
      `rev-list --all 数出来的提交数与列表不符 → 有孤儿提交没回收(${reachableShas(S)} vs ${live.length})`);
    assert.deepEqual([...realShas(S)].sort(), [...live].sort(), '磁盘 log 与列表必须逐条对齐');
    assert.deepEqual([...metaShas(S)].sort(), [...live].sort(), 'meta.json 也必须与 git 一致');
  });
  await check('C1-4 留下的快照照常能回滚(清理没把窗口内的删坏)', async () => {
    // 同步断言 + 异步请求:这里只做可达性确认,真正的回滚语义由 r120 验收覆盖
    for (const sha of live) {
      const r = spawnSync('git', ['--git-dir', snapDir(S), 'cat-file', '-e', `${sha}^{commit}`], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${sha.slice(0, 8)} 列出来了却打不开`);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// C2 三维取最严
// ══════════════════════════════════════════════════════════════════════════
console.log('\nC2 条数 / 天数 / 总占用 三维取最严');
{
  // 前提:同样的 6 条快照,条数维与总占用维单独放开时谁都不动手
  const S = sid(2);
  const base = await boot(portSeq += 1, {
    CGUI_CHECKPOINTS_MAX_COUNT: '20', CGUI_CHECKPOINTS_MAX_TOTAL_BYTES: String(MiB),
  });
  const shas = await shoot(base, S, N);
  await check('C2-1 三维都远未触顶 → 一条都不许删(6 条原样在)', () => {
    const live = realShas(S);
    assert.equal(live.length, N, `远未超限却只剩 ${live.length} 条`);
    assert.deepEqual([...live].sort(), [...shas].sort(), '6 条应逐条一致');
  });

  // 总占用维成为瓶颈(条数上限 4 但总量只够 2 条)→ 取更严的那个 = 2
  const baseB = await boot(portSeq += 1, {
    CGUI_CHECKPOINTS_MAX_COUNT: '4', CGUI_CHECKPOINTS_MAX_TOTAL_BYTES: String(150 * 1024),
  });
  // 触发一次清理。内容要换新的:内容不变 = blob 复用,那条快照只多出百来字节(几乎免费),
  // "总量只够 2 条"的前提就不成立了。
  writeFileSync(join(WORK, S, 'payload.bin'), randomBytes(SNAP_BYTES));
  await post(baseB, { sessionId: S, cwd: join(WORK, S) });
  await check('C2-2 条数上限 4、总量只够 2 条 → 取更严的:留 2 条', () => {
    const n = realShas(S).length;
    assert.ok(n <= 2, `应被总占用维压到 2 条(条数维只要求 ≤4),实际 ${n} 条`);
    assert.ok(n >= 1, '不该被清空');
  });

  // 条数维成为瓶颈(总量给足 1 MiB,条数上限 2)→ 取更严的那个 = 2
  const S2 = sid(3);
  const baseC = await boot(portSeq += 1, {
    CGUI_CHECKPOINTS_MAX_COUNT: '2', CGUI_CHECKPOINTS_MAX_TOTAL_BYTES: String(MiB),
  });
  const shas2 = await shoot(baseC, S2, N);
  await check('C2-3 总量给足、条数上限 2 → 取更严的:留 2 条且是最新的', () => {
    const live = realShas(S2);
    assert.equal(live.length, 2, `条数维说 2 条,实际 ${live.length} 条`);
    assert.deepEqual([...live].sort(), [...shas2.slice(-2)].sort(), '留下的必须是最新两条');
  });

  // 天数维成为瓶颈(保留时长 1 ms,总量与条数都给足)→ 只剩保底那一条
  const S3 = sid(4);
  const baseD = await boot(portSeq += 1, {
    CGUI_CHECKPOINTS_MAX_COUNT: '20', CGUI_CHECKPOINTS_MAX_TOTAL_BYTES: String(MiB),
    CGUI_CHECKPOINTS_RETENTION_DAYS: String(1 / 86400_000),
  });
  await shoot(baseD, S3, 3);
  await sleep(50);                                                   // 让那 3 条都超过 1 ms
  writeFileSync(join(WORK, S3, 'payload.bin'), randomBytes(SNAP_BYTES));
  await post(baseD, { sessionId: S3, cwd: join(WORK, S3) });          // 触发清理
  await check('C2-4 天数维最严(保留 1 ms)→ 走保底,只剩最新一条', () => {
    const n = realShas(S3).length;
    assert.equal(n, 1, `时间维该把旧的都判死、保底留 1 条,实际 ${n} 条`);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// C3 保底:至少留最新一条
// ══════════════════════════════════════════════════════════════════════════
console.log('\nC3 保底不变:至少留最新一条');
{
  const S = sid(5);
  const base = await boot(portSeq += 1, { CGUI_CHECKPOINTS_MAX_TOTAL_BYTES: '1' });   // 荒谬的小上限
  const shas = await shoot(base, S, 3);
  await check('C3-1 总占用上限压到 1 字节 → 会话不被清空,最新一条必须留着', () => {
    const live = realShas(S);
    assert.equal(live.length, 1, `保底应留 1 条,实际 ${live.length} 条`);
    assert.equal(live[0], shas[shas.length - 1], '留下来的必须是**最新**那条,不是最旧的');
    assert.deepEqual(metaShas(S), live, 'meta 也要跟着收敛到那一条');
  });
  await check('C3-2 保底留下的那条仍能列出来、仍打得开', () => {
    const r = spawnSync('git', ['--git-dir', snapDir(S), 'cat-file', '-e', `${realShas(S)[0]}^{commit}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, '保底留下的提交打不开 —— 回滚会失败');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// C4 反向守卫:未超限不动 + 删整会话仍彻底
// ══════════════════════════════════════════════════════════════════════════
console.log('\nC4 反向守卫');
{
  const S = sid(6);
  const base = await boot(portSeq += 1, { CGUI_CHECKPOINTS_MAX_TOTAL_BYTES: String(64 * MiB) });
  await shoot(base, S, 4);
  await check('C4-1 总占用远低于上限 → 4 条一条不少(正常项目不许被误伤)', () => {
    const n = realShas(S).length;
    assert.equal(n, 4, `4 × 64 KiB 远低于 64 MiB 上限,不该删;实际剩 ${n} 条`);
  });
  await check('C4-2 DELETE 整会话仍然彻底(第三维没改动既有删除语义)', async () => {
    const st = await del(base, S);
    assert.ok(st === 200 || st === 204, `删整会话应 200/204,实际 ${st}`);
    assert.equal(existsSync(snapDir(S)), false, '目录该消失');
  });
}

// ══════════════════════════════════════════════════════════════════════════
if (child) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退 */ } }
console.log(`\n—— check-checkpoint-total-bytes:${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) { console.log('红的条目:'); for (const n of failed) console.log(`  ✗ ${n}`); }
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(FAILS ? 1 : 0);
