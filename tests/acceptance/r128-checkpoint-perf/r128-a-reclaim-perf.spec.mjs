// r128 · A 组:回滚点回收不许拖慢每条消息(INTERFACE §A A1–A6;BRIEF N1)。
// 依据只有 .devflow/BRIEF-r128.md 与 .devflow/INTERFACE-r128.md;没看实现代码。
// 每条用例自己起隔离实例(全新 HOME),夹具是几十字节的小文件;pack / 对象存在性直接看隔离 HOME 里的影子仓。
// 「修前」预期:A1 的耗时比在小夹具上可能也过(它是上界守卫,不是复现);A2/A4 按**对象可达性**判(契约修订版:当前拍快照路径不生成 .pack,
//   pack 文件名不是可用观察口)—— A2 判"响应路径不做昂贵回收"(返回后被摘掉的旧 sha 对象仍在),A4 判"后台节流回收最终释放且不伤保留项";
//   A3/A5/A6 是既有语义的反向守卫,应绿。
import { test, expect } from '@playwright/test';
import { caseRoot, touchNote, writeRandomBlob, sid } from './helpers/fixtures.mjs';
import { startInstance, stopAll, snap, listOf, delOne, seed, restore, LENIENT, sleep } from './helpers/instance.mjs';
import { packNames, objectExists, looseCount } from './helpers/git.mjs';

const LIMIT = 20;
const STRICT20 = { ...LENIENT, CGUI_CHECKPOINT_MAX_COUNT: String(LIMIT) };   // 条数上限 20,关掉启动清扫(A 组只看拍快照路径)
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const short = (s) => String(s).slice(0, 7);

test.afterEach(async () => { await stopAll(); });

// ───────────────────────── A1 耗时不随条数增长 ─────────────────────────
test('A1 耗时不随条数增长:同一实例、同一夹具目录,25 条的会话与 1 条的会话各拍 5 次,中位数 t(S25) ≤ 2×t(S1) 且 < 1500ms', async () => {
  const cr = caseRoot('a', 'a1-latency');
  const S1 = sid('a128', 1); const S25 = sid('a128', 25);
  // 先用宽松上限(50)造出 25 条,再换成上限 20 的实例来量(INTERFACE A1 给的造法)
  const lenient = await startInstance(cr, LENIENT, { label: 'lenient' });
  await seed(lenient.base, cr.ws, S25, 25, 'a1');
  await seed(lenient.base, cr.ws, S1, 1, 'a1');
  await lenient.stop();
  const strict = await startInstance(cr, STRICT20, { label: 'strict' });
  expect((await listOf(strict.base, S25)).length, '前提:上限 20 的实例起来时 S25 仍有 25 条(还没拍过,不该动)').toBe(25);

  const t1 = []; const t25 = [];
  for (let i = 0; i < 5; i += 1) {                    // 交替拍,消掉机器忙闲的漂移
    touchNote(cr.ws, `a1 S1 #${i}`);
    const r1 = await snap(strict.base, S1, cr.ws);
    expect(r1.status, `S1 第 ${i + 1} 次拍快照应 200:${r1.text.slice(0, 160)}`).toBe(200);
    t1.push(r1.ms);
    touchNote(cr.ws, `a1 S25 #${i}`);
    const r25 = await snap(strict.base, S25, cr.ws);
    expect(r25.status, `S25 第 ${i + 1} 次拍快照应 200:${r25.text.slice(0, 160)}`).toBe(200);
    t25.push(r25.ms);
  }
  const m1 = median(t1); const m25 = median(t25);
  console.log(`[r128] A1 t(S1)=${JSON.stringify(t1)} 中位数 ${m1}ms | t(S25)=${JSON.stringify(t25)} 中位数 ${m25}ms | 比值 ${(m25 / m1).toFixed(2)}`);
  expect.soft(m25, `t(S25) 中位数 ${m25}ms 应 ≤ 2×t(S1) 中位数(${m1}ms → 上限 ${2 * m1}ms);实测比值 ${(m25 / m1).toFixed(2)}`).toBeLessThanOrEqual(2 * m1);
  expect.soft(m25, `t(S25) 中位数应 < 1500ms,实测 ${m25}ms`).toBeLessThan(1500);
  expect((await listOf(strict.base, S25)).length, '拍过之后 S25 应回到上限 20(既有语义)').toBe(LIMIT);
});

// ───────────────────────── A2 同步不做昂贵回收 ─────────────────────────
// 每次 POST 之前记下列表里最旧的那条(条数上限语义下,它就是本次会被摘掉的);POST 返回后**立即**(不等)看它:
//   列表已经 20 条且它不在列表里(摘掉了,与 A3 同源),但影子仓里它的对象**还在**(cat-file -e 退出码 0)。
// 判的是"响应路径只写 grafts 与 meta,不做对象回收"。实现若选择同步回收,这条红。
test('A2 同步不做昂贵回收:上限 20 的会话连拍 10 次,每次返回后立即看——被摘掉的那条旧 sha 对象仍在影子仓里,且列表立刻是 20 条', async () => {
  const cr = caseRoot('a', 'a2-no-sync-reclaim');
  const S = sid('a128', 2);
  const h = await startInstance(cr, STRICT20, { label: 'strict' });
  await seed(h.base, cr.ws, S, LIMIT, 'a2');
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    const before = await listOf(h.base, S);
    expect(before?.length, `第 ${i + 1} 次之前列表应是 ${LIMIT} 条`).toBe(LIMIT);
    const victim = before[before.length - 1].sha;                   // 最旧的一条 = 本次会被摘掉的
    touchNote(cr.ws, `a2 #${i}`);
    const r = await snap(h.base, S, cr.ws);
    expect(r.status, `第 ${i + 1} 次拍快照应 200:${r.text.slice(0, 160)}`).toBe(200);
    const after = await listOf(h.base, S);                          // 紧接着读,不等
    const stillOnDisk = objectExists(cr.home, S, victim);           // 紧接着查,不等
    rows.push({ i: i + 1, ms: r.ms, victim: short(victim), listLen: after?.length, victimListed: (after || []).some((e) => e.sha === victim), stillOnDisk });
    expect.soft(after?.length, `第 ${i + 1} 次 POST 之后列表应立即是 ${LIMIT} 条,实际 ${after?.length}`).toBe(LIMIT);
    expect.soft((after || []).some((e) => e.sha === victim), `第 ${i + 1} 次之后被摘掉的 ${short(victim)} 不该还在列表里(前提:确实是它被摘掉)`).toBe(false);
    expect.soft(stillOnDisk, `第 ${i + 1} 次 POST 返回后,被摘掉的 ${short(victim)} 的对象应**仍在**影子仓里(响应路径不该同步回收)`).toBe(true);
  }
  console.log(`[r128] A2 逐次记录(stillOnDisk=返回后对象是否仍在):\n  ${rows.map((x) => JSON.stringify(x)).join('\n  ')}`);
});

// ───────────────────────── A3 条数语义不变 ─────────────────────────
test('A3 条数语义不变:上限 20 的会话每次 POST 返回后立即 GET,entries.length === 20 且最新一条 sha 等于刚返回的 sha', async () => {
  const cr = caseRoot('a', 'a3-count-semantics');
  const S = sid('a128', 3);
  const h = await startInstance(cr, STRICT20, { label: 'strict' });
  await seed(h.base, cr.ws, S, LIMIT, 'a3');
  for (let i = 0; i < 10; i += 1) {
    touchNote(cr.ws, `a3 #${i}`);
    const r = await snap(h.base, S, cr.ws);
    expect(r.status, `第 ${i + 1} 次拍快照应 200:${r.text.slice(0, 160)}`).toBe(200);
    const list = await listOf(h.base, S);                 // 紧接着读,不等
    expect(list?.length, `第 ${i + 1} 次 POST 之后立即 GET,条数应恰好 ${LIMIT}(实际 ${list?.length})`).toBe(LIMIT);
    expect(list[0]?.sha, `第 ${i + 1} 次 POST 之后列表最新一条应是刚返回的 ${short(r.json.sha)}`).toBe(r.json.sha);
  }
});

// ───────────────────────── A4 后台最终释放 ─────────────────────────
// 承接 A2 的现场,CGUI_CHECKPOINT_REPACK_DEBOUNCE_MS=300:10 次 POST 之后轮询等待 ≤5 秒,反复对那批被摘掉的 sha 跑 cat-file -e,
// 最终应**全部不存在**;此时列表仍是 20 条、最新一条仍能 restore 成功、列表里每条的对象都还在。
// 判的是"后台节流回收真的跑了、且没伤到保留的快照"。pack 数 / 松散对象数只记录不断言。
test('A4 后台最终释放:REPACK_DEBOUNCE_MS=300,上限 20 连拍 10 次后 ≤5 秒内被摘掉的 10 条 sha 全部 cat-file 不到;列表仍 20 条,最新一条 restore 成功', async () => {
  const cr = caseRoot('a', 'a4-eventual-release');
  const S = sid('a128', 4);
  const h = await startInstance(cr, { ...STRICT20, CGUI_CHECKPOINT_REPACK_DEBOUNCE_MS: '300' }, { label: 'strict' });
  const seeded = await seed(h.base, cr.ws, S, LIMIT, 'a4');
  const victims = [];
  for (let i = 0; i < 10; i += 1) {
    const before = await listOf(h.base, S);
    victims.push(before[before.length - 1].sha);                    // 本次会被摘掉的最旧一条
    touchNote(cr.ws, `a4 #${i}`);
    const r = await snap(h.base, S, cr.ws);
    expect(r.status, `第 ${i + 1} 次拍快照应 200:${r.text.slice(0, 160)}`).toBe(200);
  }
  expect(victims, '前提:被摘掉的正是最早造的 10 条').toEqual(seeded.slice(0, 10));
  const doneAt = Date.now();
  let alive = victims.filter((v) => objectExists(cr.home, S, v));
  const aliveRightAfter = alive.length;
  while (Date.now() - doneAt < 5_000 && alive.length > 0) {
    await sleep(200);
    alive = victims.filter((v) => objectExists(cr.home, S, v));
  }
  const waited = Date.now() - doneAt;
  const list = await listOf(h.base, S);
  const missingKept = (list || []).filter((e) => !objectExists(cr.home, S, e.sha)).map((e) => short(e.sha));
  const rs = list?.[0]?.sha ? await restore(h.base, S, list[0].sha, cr.ws) : { status: 0, text: '列表为空' };
  console.log(`[r128] A4 连拍结束时旧 sha 仍可达 ${aliveRightAfter}/10;等待 ${waited}ms 后仍可达 ${alive.length}/10 ${JSON.stringify(alive.map(short))};`
    + `列表 ${list?.length} 条;保留项对象缺失 ${JSON.stringify(missingKept)};最新一条 restore ${rs.status};观察:packs=${JSON.stringify(packNames(cr.home, S))} loose=${looseCount(cr.home, S)}`);
  expect.soft(alive, `≤5 秒内被摘掉的 10 条 sha 应全部 cat-file 不到,仍可达:${JSON.stringify(alive.map(short))}`).toEqual([]);
  expect.soft(list?.length, `后台回收之后列表仍应是 ${LIMIT} 条,实际 ${list?.length}`).toBe(LIMIT);
  expect.soft(rs.status, `最新一条 ${short(list?.[0]?.sha)} 应仍能 restore(200),实际 ${rs.status} ${String(rs.text).slice(0, 120)}`).toBe(200);
  expect.soft(missingKept, `列表里每条的对象都应还在(不许伤到保留的快照),缺失:${JSON.stringify(missingKept)}`).toEqual([]);
});

// ───────────────────────── A5 删除仍立即释放 ─────────────────────────
test('A5 删除仍立即释放(既有语义反向守卫):DELETE /api/checkpoints/:sid/:sha 返回后立刻 git cat-file -e 失败', async () => {
  const cr = caseRoot('a', 'a5-delete-immediate');
  const S = sid('a128', 5);
  const h = await startInstance(cr, LENIENT, { label: 'lenient' });
  const shas = await seed(h.base, cr.ws, S, 3, 'a5');
  expect(objectExists(cr.home, S, shas[0]), '前提:删之前对象在').toBe(true);
  const r = await delOne(h.base, S, shas[0]);
  expect(r.status, `单条删除应 200:${r.text.slice(0, 160)}`).toBe(200);
  const goneNow = !objectExists(cr.home, S, shas[0]);      // 返回后**立刻**查,不等
  expect(goneNow, `DELETE 返回后对象 ${short(shas[0])} 应立刻不在影子仓里(cat-file -e 应失败)`).toBe(true);
  expect(shas.slice(1).filter((k) => !objectExists(cr.home, S, k)), '其余两条的对象不许被连带删掉').toEqual([]);
  const list = await listOf(h.base, S);
  expect(list.map((e) => e.sha), '列表里只剩那两条(新→旧)').toEqual([shas[2], shas[1]]);
});

// ───────────────────────── A6 体积维仍生效 ─────────────────────────
test('A6 体积维仍生效:CGUI_CHECKPOINT_MAX_TOTAL_BYTES=4096、条数上限放宽,拍 8 次后列表只剩 1–2 条且最新一条保底', async () => {
  const cr = caseRoot('a', 'a6-total-bytes');
  const S = sid('a128', 6);
  const h = await startInstance(cr, { ...LENIENT, CGUI_CHECKPOINT_MAX_TOTAL_BYTES: '4096' }, { label: 'lenient-bytes' });
  let last = null;
  for (let i = 0; i < 8; i += 1) {
    writeRandomBlob(cr.ws, 1536);                          // 每张 ~1.5 KB 不可压缩内容,几张就超 4096
    touchNote(cr.ws, `a6 #${i}`);
    const r = await snap(h.base, S, cr.ws);
    expect(r.status, `第 ${i + 1} 次拍快照应 200:${r.text.slice(0, 160)}`).toBe(200);
    last = r.json.sha;
  }
  const list = await listOf(h.base, S);
  console.log(`[r128] A6 拍 8 次后列表 ${list.length} 条:${JSON.stringify(list.map((e) => short(e.sha)))}`);
  expect(list.length, `总占用维应把列表压到 1–2 条,实际 ${list.length}`).toBeLessThanOrEqual(2);
  expect(list.length, '保底最新一条').toBeGreaterThanOrEqual(1);
  expect(list[0].sha, '留下的最新一条应是刚拍的').toBe(last);
});
