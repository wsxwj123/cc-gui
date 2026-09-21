#!/usr/bin/env node
// r128 白盒单测:回滚点回收"便宜同步 + 昂贵后台"、会话锁、松散对象宽限、带 BOM 的 JSON(BRIEF-r128 N1–N4)。
//  ① guarded-json:开头 U+FEFF 的合法 JSON 正常读、不备份、可写;只有 BOM 的文件按 missing;真损坏文案提「BOM / 不可见字符」
//  ② scheduleRepack:同一会话短时间内多次触发只跑一次(重复触发只重置定时器);不同会话各跑各的;cancelRepack 取消
//  ③ 粗筛短路:dirBytes 说没超 → 一个 shaBytes 都不跑、一条不删;说超了 → 才精算并按总占用维回收
//  ④ opts.bytesOf 存在 = 强制精算(粗筛说没超也跑;锁定单测 check-checkpoint-total-bytes 靠它)
//  ⑤ 便宜同步路径:摘掉的提交对象仍在盘上、待回收标记 + graft root 行都有、fsck 干净;reclaimSpace 之后对象没了、标记与 root 行清掉、fsck 仍干净
//  ⑥ 会话锁:waitGc 超时返回 false 且**不**释放别人的锁;acquireGc 拿到为止
//  ⑦ 松散对象宽限:不可达但刚写入的不删;mtime 早于 2 分钟的删;在 exempt 集里的立即删
// 隔离:HOME 指到 mktemp(import 之前设,CHECKPOINTS_ROOT 在模块加载期用 homedir() 算),绝不碰真实 ~/.claude*。
// Run: node tests/unit/check-r128-checkpoint-reclaim.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'cgui-r128-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } });
const HOME = join(tmp, 'home'); mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME;

const { _internalsForTests: I } = await import('../../server/routes/checkpoints.js');
const { CHECKPOINTS_ROOT } = await import('../../server/utils/checkpoint-paths.js');
const { readJsonGuarded, assertWritable, guardError, corruptWarning } = await import('../../server/utils/guarded-json.js');
assert.ok(CHECKPOINTS_ROOT.startsWith(HOME), `自证:回滚点根落在隔离 HOME 之下(${CHECKPOINTS_ROOT})`);

let n = 0;
const ok = (v, m) => { assert.ok(v, m); n += 1; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = (k) => `r1280000-0000-4000-8000-${String(k).padStart(12, '0')}`;
const ENV = { ...process.env, LC_ALL: 'C', GIT_AUTHOR_NAME: 'u', GIT_AUTHOR_EMAIL: 'u@x', GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@x' };
const git = (gitDir, args, extra = {}) => execFileSync('git', ['--git-dir', gitDir, '-c', 'advice.graftFileDeprecated=false', ...args], { env: ENV, encoding: 'utf8', ...extra }).trim();
// stderr 吞掉:探测"已被回收的对象"时 git 必然打 `fatal: Not a valid object name`,那正是期望结果,
// 别让它印在通过的用例上方让人误以为测试炸了。
const objectExists = (gitDir, sha) => { try { git(gitDir, ['cat-file', '-e', `${sha}^{commit}`], { stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch { return false; } };
const fsckClean = (gitDir) => {
  try { const out = execFileSync('git', ['--git-dir', gitDir, '-c', 'advice.graftFileDeprecated=false', 'fsck', '--strict', '--no-dangling'], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return !/\b(error|missing|broken)\b/i.test(out); }
  catch (e) { return !/\b(error|missing|broken)\b/i.test(`${e.stdout}\n${e.stderr}`) && e.status === 0; }
};
/** 造一个会话影子仓:k 条提交(每条改一下 note.txt),meta.json 同步登记(ts=现在)。返回 { gitDir, shas(旧→新) }。 */
function makeSession(sid, k) {
  const gitDir = join(CHECKPOINTS_ROOT, sid);
  const wt = join(tmp, `wt-${sid.slice(-4)}`); mkdirSync(wt, { recursive: true }); mkdirSync(gitDir, { recursive: true });
  execFileSync('git', ['--git-dir', gitDir, 'init', '--bare', '-q'], { env: ENV });
  const shas = [];
  for (let i = 0; i < k; i += 1) {
    writeFileSync(join(wt, 'note.txt'), `v${i} ${sid}\n`);
    git(gitDir, ['--work-tree', wt, 'add', '-A'], { cwd: wt });
    git(gitDir, ['--work-tree', wt, 'commit', '-q', '-m', `cp ${i}`], { cwd: wt });
    shas.push(git(gitDir, ['rev-parse', 'HEAD']));
  }
  writeFileSync(join(gitDir, 'meta.json'), JSON.stringify({ entries: shas.map((sha, i) => ({ sha, ts: Date.now() - (k - i) * 1000, label: `#${i}` })) }));
  return { gitDir, shas };
}
const logShas = (gitDir) => git(gitDir, ['log', '--format=%H']).split('\n').filter(Boolean);

let failure = null;
try {
  // ─── ① BOM ───
  {
    const dir = join(HOME, '.claude-gui'); mkdirSync(dir, { recursive: true });
    const f = join(dir, 'custom-providers.json');
    const good = [{ id: 'p1', name: 'P1', apiKey: 'sk-r128-unit-not-real' }];
    writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(good), 'utf8')]));
    const r = await readJsonGuarded(f);
    eq({ corrupt: r.corrupt, missing: r.missing, value: r.value, backup: r.backup }, { corrupt: false, missing: false, value: good, backup: null }, 't1: 带 BOM 的合法 JSON 正常解析、不算损坏、不备份');
    ok((await assertWritable(f)).corrupt === false, 't1: 带 BOM 的文件可写');
    eq(readdirSync(dir).filter((x) => /\.corrupt-\d+$/.test(x)), [], 't1: 目录里没有 .corrupt- 备份');
    writeFileSync(f, Buffer.from([0xef, 0xbb, 0xbf]));
    ok((await readJsonGuarded(f)).missing === true, 't1: 只有一个 BOM 的文件按 missing(没有数据可保护)');
    writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[{"id":"half"', 'utf8')]));
    const bad = await readJsonGuarded(f);
    ok(bad.corrupt === true, 't1: BOM 后面是半截 JSON 仍算损坏');
    ok(/BOM|不可见字符/.test(corruptWarning(bad).message) && /BOM|不可见字符/.test(guardError(bad).message), 't1: 损坏文案提示 BOM / 不可见字符');
    rmSync(dir, { recursive: true, force: true });
  }

  // ─── ② scheduleRepack 节流与合并 ───
  {
    const before = I.gcStats.repackFired;
    const s = SID(1); const s2 = SID(2);
    for (let i = 0; i < 5; i += 1) { I.scheduleRepack(s, 60); await sleep(10); }   // 5 次触发落在 60ms 窗口内(每次都重置)
    I.scheduleRepack(s2, 60);
    ok(I.repackTimers.has(s) && I.repackTimers.has(s2), 't2: 两个会话各挂一个定时器');
    eq(I.repackTimers.size >= 2, true, 't2: 定时器按会话记,同会话重复触发不叠加');
    await sleep(250);
    eq(I.gcStats.repackFired - before, 2, 't2: 同一会话 5 次触发只跑 1 次,另一个会话 1 次 → 共 2 次');
    ok(!I.repackTimers.has(s) && !I.repackTimers.has(s2), 't2: 跑完定时器登记清掉');
    const before2 = I.gcStats.repackFired;
    I.scheduleRepack(SID(3), 40); I.cancelRepack(SID(3));
    await sleep(120);
    eq(I.gcStats.repackFired - before2, 0, 't2: cancelRepack 之后不跑');
  }

  // ─── ③ 粗筛短路 / ⑤ 便宜同步路径 + reclaimSpace ───
  {
    const s = SID(10);
    const { gitDir, shas } = makeSession(s, 4);
    const calls0 = I.gcStats.shaBytesCalls; const precise0 = I.gcStats.preciseRuns;
    const r1 = await I.gcSession(s, { maxCount: 50, maxAgeMs: 0, maxTotalBytes: 1, dirBytes: async () => 0 });
    eq(r1, { removed: 0 }, 't3: 粗筛说没超(dirBytes=0 ≤ 上限)→ 一条不删');
    eq(I.gcStats.shaBytesCalls - calls0, 0, 't3: 粗筛没超时一个 shaBytes 都不跑');
    eq(I.gcStats.preciseRuns - precise0, 0, 't3: 也没进精算');
    eq(logShas(gitDir).length, 4, 't3: 4 条原样在');
    // 缓存:同会话 30 秒内再问粗筛不重新量(第二次注入的 dirBytes 不会被调)
    let measured = 0;
    await I.gcSession(s, { maxCount: 50, maxAgeMs: 0, maxTotalBytes: 1, dirBytes: async () => { measured += 1; return 1e9; } });
    eq(measured, 0, 't3: 粗筛读数按会话缓存,30 秒内不重新遍历目录');
    I.forgetCoarse(s);
    // 超了 → 精算(每条都量)→ 总占用维只留保底那条;默认路径回收是后台的:对象还在、标记 + graft root 都有
    const r2 = await I.gcSession(s, { maxCount: 50, maxAgeMs: 0, maxTotalBytes: 1, dirBytes: async () => 1e9 });
    eq(r2, { removed: 3 }, 't3: 粗筛说超了 → 精算 → 上限 1 字节只留最新一条');
    eq(I.gcStats.preciseRuns - precise0, 1, 't3: 精算跑了一次');
    ok(I.gcStats.shaBytesCalls - calls0 >= 4, `t3: 精算时每条都量了(shaBytes 调用 ${I.gcStats.shaBytesCalls - calls0} 次)`);
    eq(logShas(gitDir), [shas[3]], 't5: git log 立即只剩最新一条(grafts 生效)');
    const dropped = shas.slice(0, 3);
    ok(dropped.every((x) => objectExists(gitDir, x)), 't5: 便宜同步路径不回收对象:摘掉的 3 条对象仍在盘上');
    // 待回收标记是个去重集合,不是时间线:markPending 写 union、writeGrafts 按 new Set 逐条写无父 graft
    // (grafts 是 sha 查找表,行序无关)、reclaimSpace 把它拼进 rev-list 参数并用 Set 对账,全仓再没有
    // 第二个读它的地方(见 grep readPending)→ 这里只比集合,顺序无语义。
    eq([...(await I.readPending(gitDir))].sort(), [...dropped].sort(), 't5: 待回收标记正好记着摘掉的这 3 条(只比集合,顺序无语义)');
    const grafts = readFileSync(join(gitDir, 'info', 'grafts'), 'utf8').split('\n').filter(Boolean);
    ok(dropped.every((x) => grafts.includes(x)), `t5: 摘掉的每条都有一行无父 graft(root):\n${grafts.join('\n')}`);
    ok(grafts.includes(shas[3]), 't5: 保底那条(最后一个 keep)是 root');
    ok(I.repackTimers.has(s), 't5: 排了后台回收定时器');
    I.cancelRepack(s);
    ok(fsckClean(gitDir), 't5: 回收前 fsck 干净(摘掉的提交 graft 成 root,无 broken link)');
    const meta = JSON.parse(readFileSync(join(gitDir, 'meta.json'), 'utf8')).entries.map((e) => e.sha);
    eq(meta, [shas[3]], 't5: meta.json 已对账');
    await I.reclaimSpace(gitDir);
    ok(dropped.every((x) => !objectExists(gitDir, x)), 't5: reclaimSpace 之后摘掉的 3 条对象真的没了(exempt 集不等宽限)');
    ok(objectExists(gitDir, shas[3]), 't5: 保留的那条对象还在');
    ok(!existsSync(join(gitDir, I.PENDING_FILE)), 't5: 待回收标记清掉');
    const grafts2 = readFileSync(join(gitDir, 'info', 'grafts'), 'utf8').split('\n').filter(Boolean);
    eq(grafts2, [shas[3]], 't5: 已删提交的 graft 行清掉,只剩 keep 链');
    ok(fsckClean(gitDir), 't5: 回收后 fsck 仍干净');
    eq(logShas(gitDir), [shas[3]], 't5: log 不变');
  }

  // ─── ④ bytesOf 强制精算 ───
  {
    const s = SID(11);
    const { gitDir, shas } = makeSession(s, 4);
    const precise0 = I.gcStats.preciseRuns;
    let measured = 0;
    const r = await I.gcSession(s, { maxCount: 50, maxAgeMs: 0, maxTotalBytes: 150, dirBytes: async () => { measured += 1; return 0; }, bytesOf: async () => 100, reclaim: 'now' });
    eq(measured, 0, 't4: 注入 bytesOf 时不问粗筛');
    eq(I.gcStats.preciseRuns - precise0, 1, 't4: 直接精算');
    eq(r, { removed: 3 }, 't4: 每条 100、上限 150 → 保底最新一条占 100,次新起都装不下 → 丢 3 条');
    eq(logShas(gitDir).length, 1, 't4: 影子仓 log 剩 1 条');
    ok(objectExists(gitDir, shas[3]) && !objectExists(gitDir, shas[0]), 't4: reclaim:now 时被丢的对象立即没了、保底的还在');
  }
} catch (e) {
  failure = e;
}
try {
  if (!failure) {
    // ─── ⑥ 会话锁 ───
    {
      const s = SID(20);
      ok(I.tryAcquireGc(s), 't6: 空闲时拿得到');
      ok(!I.tryAcquireGc(s), 't6: 已被占时 tryAcquire 失败');
      const t0 = Date.now();
      const got = await I.waitGc(s, 120);
      ok(got === false && Date.now() - t0 >= 100, 't6: waitGc 超时返回 false(不是抛错、不是 true)');
      ok(!I.tryAcquireGc(s), 't6: 超时放行**没有**把别人的锁放掉(锁仍被占)');
      I.releaseGc(s);
      ok(await I.waitGc(s, 100), 't6: 释放后 waitGc 拿到返回 true');
      let acquired = false;
      const p = I.acquireGc(s).then(() => { acquired = true; });
      await sleep(120);
      ok(!acquired, 't6: acquireGc 在锁被占时一直等(120ms 后仍没拿到)');
      I.releaseGc(s);
      await p;
      ok(acquired, 't6: 释放后 acquireGc 立刻拿到');
      I.releaseGc(s);
    }

    // ─── ⑦ 松散对象宽限 ───
    {
      const s = SID(30);
      const { gitDir } = makeSession(s, 2);
      const mk = (txt) => execFileSync('git', ['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], { env: ENV, encoding: 'utf8', input: txt }).trim();
      const loosePath = (sha) => join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2));
      const fresh = mk('fresh unreferenced blob r128\n');
      ok(existsSync(loosePath(fresh)), 't7: 前提:不可达的松散 blob 已写入');
      await I.repackHonest(gitDir);
      ok(existsSync(loosePath(fresh)), 't7: 刚写入(2 分钟内)的不可达松散对象不删');
      const old = new Date(Date.now() - 3 * 60_000);
      utimesSync(loosePath(fresh), old, old);
      await I.repackHonest(gitDir);
      ok(!existsSync(loosePath(fresh)), 't7: mtime 早于 2 分钟的不可达松散对象删掉');
      const fresh2 = mk('fresh but exempt blob r128\n');
      await I.repackHonest(gitDir, { exempt: new Set([fresh2]) });
      ok(!existsSync(loosePath(fresh2)), 't7: 在 exempt 集里(本轮明确摘掉的)刚写入也立即删');
      eq(logShas(gitDir).length, 2, 't7: 可达的提交一条不少');
      ok(fsckClean(gitDir), 't7: fsck 干净');
    }
  }
} catch (e) {
  failure = e;
}
for (const t of I.repackTimers.values()) clearTimeout(t);
if (failure) throw failure;
console.log(`✓ check-r128-checkpoint-reclaim: ${n} 条断言通过(BOM / 节流合并 / 粗筛短路 / 强制精算 / 便宜同步 + 后台回收对账 / 锁只放自己 / 松散对象宽限)`);
