// r128 · B 组:拍快照与清扫 / 删除互斥(INTERFACE §B B1–B3;BRIEF N2)。
// 依据只有 .devflow/BRIEF-r128.md 与 .devflow/INTERFACE-r128.md;没看实现代码。
// B1 / B2 是竞态用例:各连跑 5 轮(每轮全新 HOME + 实例),每轮的结果都打在日志里(修前可能时红时绿,如实记)。
// 「每个 sha 都能解析/回滚」的落地口径(INTERFACE 没写死,自行解读并在 TEST-PLAN 里注明):
//   解析接口 GET …/resolve 不接收 sha 参数(探路实测:带 ?sha=/?ts= 都返回同一个),所以"逐个 sha 解析"用
//   POST …/restore {sha,cwd}(回滚接口,对每个 sha 单独打)+ 影子仓 git cat-file -e 双证;resolve 只验一次
//   "200 且给出的 sha 在列表里、磁盘上真实存在"。条数上限 3 会把 20 次里较早的 17 个合法摘掉(N1-3 既有语义),
//   因此"每个 sha"= 结束时**仍在列表里**的每个 sha,且列表必须恰好是最后 3 次返回的 sha(新→旧)。
// B1 连发的起点(首轮实测后的修正):就绪(启动后 ~310ms)就开拍的话,第 1 次 POST 会在清扫延迟 500ms 到点之前把
//   meta.json 写新 → 清扫把该会话当"近期活跃"跳过(汇总行"活跃跳过 1, 回收 0 条"),两者根本没碰上。
//   所以连发从「启动 + 500ms(清扫到点)+ 60ms + 每轮再错开 40ms」开始:清扫刚做完"该回收"的判定、正在回收时,
//   快照请求进来 —— 这才是 BRIEF 说的"清扫恰好扫到用户正在用的会话"。汇总行里"回收 >0 且活跃跳过 0"= 确实重叠了。
// B2 每轮 20 对,DELETE 相对 POST 错开 0/10/20/30/40ms 轮流取样,尽量覆盖 add→commit 之间那几十毫秒的松散对象窗口。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { caseRoot, touchNote, sid, ageMeta, assertIsolated } from './helpers/fixtures.mjs';
import { startInstance, stopAll, req, snap, listOf, delOne, seed, restore, resolveLatest, LENIENT, sleep } from './helpers/instance.mjs';
import { objectExists, fsck, logShas } from './helpers/git.mjs';

const ROUNDS = 5;
const HOUR = 3_600_000;
const short = (s) => String(s).slice(0, 7);
const summaryLines = (log) => log.split('\n').filter((l) => /checkpoints/i.test(l) && /sweep/i.test(l));
/** 每次 POST 之前在工作目录里多放一个几十字节的新文件:任何时刻的工作树都与之前所有提交不同,不会撞上"没有变化"。 */
function bump(ws, tag, i) {
  assertIsolated(ws);
  fs.writeFileSync(path.join(ws, `${tag}-${String(i).padStart(2, '0')}.txt`), `${tag} ${i}\n`);
  touchNote(ws, `${tag} #${i}`);
}
/** 对"仍在列表里"的每个 sha:对象在影子仓里 + restore 200。返回不合格的清单(空 = 全部通过)。 */
async function verifyListed(base, home, ws, s, list) {
  const bad = [];
  for (const e of list) {
    const onDisk = objectExists(home, s, e.sha);
    const r = await restore(base, s, e.sha, ws);
    if (!onDisk || r.status !== 200) bad.push({ sha: short(e.sha), onDisk, restore: `${r.status} ${r.text.slice(0, 100)}` });
  }
  return bad;
}

test.afterEach(async () => { await stopAll(); });

// ───────────────────────── B1 清扫期间拍快照(5 轮) ─────────────────────────
for (let round = 1; round <= ROUNDS; round += 1) {
  test(`B1 第${round}/${ROUNDS}轮 清扫期间连拍 20 次:全部 200 带 sha;仍列出的每个 sha 都能回滚;fsck 干净`, async () => {
    const cr = caseRoot('b', `b1-sweep-race-r${round}`);
    const S = sid('b128', round);
    const lenient = await startInstance(cr, LENIENT, { label: 'lenient' });
    await seed(lenient.base, cr.ws, S, 30, 'b1seed');
    await lenient.stop();
    ageMeta(cr.home, S, HOUR);                                   // 1 小时前活动 → 不在"近期活动"窗口内,清扫会扫它
    const strict = await startInstance(cr, { ...LENIENT, CGUI_CHECKPOINT_SWEEP: '1', CGUI_CHECKPOINT_MAX_COUNT: '3', CGUI_CHECKPOINT_SWEEP_DELAY_MS: '500' }, { label: 'strict' });
    const bootMs = strict.healthyAt - strict.spawnedAt;
    // 要"清扫恰好扫到用户正在用的会话",连发的第 1 次 POST 必须**晚于**清扫读 meta.json mtime 的那一刻
    //(否则它把 mtime 刷新 → 清扫把该会话当"近期活跃"跳过,根本没碰上)。清扫在启动后约 500ms(延迟)读 mtime、
    // 随后做约 250ms 的重打包/删松散对象。各轮把开拍点从启动后 520ms 起、每轮后移 100ms 取样(520/620/720/820/920),
    // 好横跨"读 mtime 之前(→跳过,本轮无重叠、应绿)"到"重打包进行中(→真重叠,才可能红)"整个区间。
    const startAt = strict.spawnedAt + 520 + (round - 1) * 100;
    while (Date.now() < startAt) await sleep(5);
    const sweptBeforeBurst = summaryLines(strict.log()).length > 0;   // 观察即可,不作前提硬断言(否则会红在前提上而非真缺陷上)

    // 连发 20 次(串行,两次之间间隔 ≤ 50ms),同时盯着清扫汇总行什么时候冒出来(= 与拍快照重叠的证据)
    const results = []; let sweepSeenAt = null;
    const burstStart = Date.now();
    for (let i = 0; i < 20; i += 1) {
      bump(cr.ws, 'b1', i);
      const r = await snap(strict.base, S, cr.ws, `b1 #${i}`);
      results.push({ i, status: r.status, sha: r.json?.sha ?? null, ms: r.ms, err: r.status === 200 ? '' : r.text.slice(0, 160) });
      if (sweepSeenAt === null && summaryLines(strict.log()).length) sweepSeenAt = i;
      await sleep(10);
    }
    const burstMs = Date.now() - burstStart;
    for (let k = 0; k < 20 && !summaryLines(strict.log()).length; k += 1) await sleep(250);   // 清扫若还没完,给它最多 5s 落汇总行
    const sweep = summaryLines(strict.log());
    const failed = results.filter((r) => r.status !== 200 || !r.sha);
    const list = await listOf(strict.base, S);
    const last3 = results.slice(-3).map((r) => r.sha).reverse();
    const bad = await verifyListed(strict.base, cr.home, cr.ws, S, list || []);
    const res = await resolveLatest(strict.base, S);
    const f = fsck(cr.home, S);
    const overlapped = sweep.some((l) => /回收\s*[1-9]\d*/.test(l) && /活跃跳过\s*0/.test(l));
    console.log(`[r128] B1 第${round}轮:就绪 ${bootMs}ms(清扫延迟 500ms),开拍于启动后 ${burstStart - strict.spawnedAt}ms(开拍时清扫${sweptBeforeBurst ? '已完成' : '未完成'});20 次 POST 用时 ${burstMs}ms,每次 ${JSON.stringify(results.map((r) => r.ms))};`
      + `清扫与连发${overlapped ? '确实重叠(清扫回收了该会话)' : '未重叠(清扫把它当活跃跳过了)'};`
      + `清扫汇总行首次出现于第 ${sweepSeenAt === null ? '—(连发期间没出现)' : sweepSeenAt + 1} 次 POST 之后;失败 ${failed.length}/20 ${JSON.stringify(failed)};`
      + `结束时列表 ${list?.length} 条 ${JSON.stringify((list || []).map((e) => short(e.sha)))} vs 最后 3 次返回 ${JSON.stringify(last3.map(short))};`
      + `影子仓 log ${logShas(cr.home, S).length} 条;不合格 ${JSON.stringify(bad)};resolve ${res.status} ${res.text.slice(0, 80)};fsck ${f.clean ? '干净' : `脏:${f.out.slice(0, 300)}`};汇总行 ${JSON.stringify(sweep)}`);
    expect.soft(failed, `20 次 POST 应全部 200 且带 sha,失败的:${JSON.stringify(failed)}`).toEqual([]);
    expect.soft((list || []).map((e) => e.sha), '结束时列表应恰好是最后 3 次返回的 sha(新→旧)').toEqual(last3);
    expect.soft(bad, `仍在列表里的每个 sha 都应能回滚且对象在影子仓里,不合格:${JSON.stringify(bad)}`).toEqual([]);
    expect.soft(res.status, `resolve 应 200:${res.text.slice(0, 120)}`).toBe(200);
    expect.soft(res.json?.sha && objectExists(cr.home, S, res.json.sha), `resolve 给出的 sha ${short(res.json?.sha)} 应在磁盘上真实存在`).toBe(true);
    expect.soft(f.clean, `git fsck --strict --no-dangling 应干净(无 error/missing/broken),实际:\n${f.out.slice(0, 600)}`).toBe(true);
  });
}

// ───────────────────────── B2 删除期间拍快照(5 轮) ─────────────────────────
for (let round = 1; round <= ROUNDS; round += 1) {
  test(`B2 第${round}/${ROUNDS}轮 并发 DELETE 旧 sha + POST 共 20 对(错开 0–40ms):两者都不是 500;fsck 干净;列表里每条 sha 都能回滚`, async () => {
    const cr = caseRoot('b', `b2-delete-race-r${round}`);
    const S = sid('b228', round);
    const h = await startInstance(cr, LENIENT, { label: 'lenient' });
    const PAIRS = 20;
    const seeded = await seed(h.base, cr.ws, S, PAIRS + 5, 'b2seed');
    const pairs = [];
    for (let k = 0; k < PAIRS; k += 1) {
      const victim = seeded[k];                                  // 从最旧的开始删
      const delay = (k % 5) * 10;                                // DELETE 相对 POST 错开 0/10/20/30/40ms
      bump(cr.ws, 'b2', k);
      const [p, d] = await Promise.all([snap(h.base, S, cr.ws, `b2 #${k}`), sleep(delay).then(() => delOne(h.base, S, victim))]);
      pairs.push({ k, delay, victim: short(victim), del: d.status, delBody: d.status === 200 ? '' : d.text.slice(0, 120), post: p.status, sha: p.json?.sha ? short(p.json.sha) : null, postBody: p.status === 200 ? '' : p.text.slice(0, 120) });
    }
    const list = await listOf(h.base, S);
    const bad = await verifyListed(h.base, cr.home, cr.ws, S, list || []);
    const f = fsck(cr.home, S);
    const victimsListed = (list || []).filter((e) => seeded.slice(0, PAIRS).includes(e.sha)).map((e) => short(e.sha));
    const abnormal = pairs.filter((x) => x.del !== 200 || x.post !== 200 || !x.sha);
    console.log(`[r128] B2 第${round}轮:${PAIRS} 对里状态异常的 ${abnormal.length} 对 ${JSON.stringify(abnormal)};全部状态 del=${JSON.stringify(pairs.map((x) => x.del))} post=${JSON.stringify(pairs.map((x) => x.post))};`
      + `结束时列表 ${list?.length} 条(应为 ${PAIRS + 5} 条:删 ${PAIRS} 加 ${PAIRS});影子仓 log ${logShas(cr.home, S).length} 条;`
      + `不合格 ${JSON.stringify(bad)};被删的还在列表里 ${JSON.stringify(victimsListed)};fsck ${f.clean ? '干净' : `脏:${f.out.slice(0, 300)}`}`);
    expect.soft(pairs.filter((x) => x.del === 500 || x.post === 500), `DELETE 与 POST 都不许 500,出现了:${JSON.stringify(pairs.filter((x) => x.del === 500 || x.post === 500))}`).toEqual([]);
    expect.soft(pairs.filter((x) => x.post !== 200 || !x.sha), `并发删除期间的每次 POST 仍应 200 带 sha,失败的:${JSON.stringify(pairs.filter((x) => x.post !== 200 || !x.sha))}`).toEqual([]);
    expect.soft(bad, `列表里每条 sha 都应能回滚且对象在,不合格:${JSON.stringify(bad)}`).toEqual([]);
    expect.soft(victimsListed, '已删除的 sha 不该还留在列表里').toEqual([]);
    expect.soft(f.clean, `git fsck --strict --no-dangling 应干净,实际:\n${f.out.slice(0, 600)}`).toBe(true);
  });
}

// ───────────────────────── B3 清扫看得见互斥(日志) ─────────────────────────
test('B3 清扫汇总行里有"活跃跳过"与"占锁跳过"两个计数(含 checkpoints 与 sweep 的既有汇总行)', async () => {
  const cr = caseRoot('b', 'b3-sweep-summary');
  const S = sid('b328', 1);
  const lenient = await startInstance(cr, LENIENT, { label: 'lenient' });
  await seed(lenient.base, cr.ws, S, 8, 'b3seed');
  await lenient.stop();
  ageMeta(cr.home, S, HOUR);
  const strict = await startInstance(cr, { ...LENIENT, CGUI_CHECKPOINT_SWEEP: '1', CGUI_CHECKPOINT_MAX_COUNT: '3', CGUI_CHECKPOINT_SWEEP_DELAY_MS: '500' }, { label: 'strict' });
  for (let k = 0; k < 60 && !summaryLines(strict.log()).length; k += 1) await sleep(250);
  const lines = summaryLines(strict.log());
  console.log(`[r128] B3 汇总行:${JSON.stringify(lines)}`);
  expect(lines.length, `日志里应有含 checkpoints+sweep 的汇总行。日志尾部:\n${strict.log().split('\n').slice(-6).join('\n')}`).toBeGreaterThan(0);
  const line = lines[lines.length - 1];
  expect.soft(line, '汇总行应含"活跃跳过 <数>"').toMatch(/活跃跳过\D{0,6}\d+/);
  expect.soft(line, '汇总行应含"占锁跳过 <数>"(或同义:锁忙/busy/locked + 计数)').toMatch(/(占锁跳过|占锁|锁忙|busy|locked)\D{0,6}\d+/i);
});
