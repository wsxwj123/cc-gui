// r128 · A 组:回滚点回收不许拖慢每条消息(INTERFACE §A A1–A6;BRIEF N1)。
// 依据只有 .devflow/BRIEF-r128.md 与 .devflow/INTERFACE-r128.md;没看实现代码。
// 每条用例自己起隔离实例(全新 HOME),夹具是几十字节的小文件;pack / 对象存在性直接看隔离 HOME 里的影子仓。
// 「修前」预期:A1 的耗时比在小夹具上可能也过(它是上界守卫,不是复现);A2 看 pack 名集合;A3/A5/A6 是既有语义的反向守卫,应绿。
import { test, expect } from '@playwright/test';
import { caseRoot, touchNote, writeRandomBlob, sid } from './helpers/fixtures.mjs';
import { startInstance, stopAll, snap, listOf, delOne, seed, LENIENT, sleep } from './helpers/instance.mjs';
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

// ───────────────────────── A2 每条消息不整仓重打包 ─────────────────────────
test('A2 每条消息不整仓重打包:会话在上限 20 时连拍 10 次,过程中出现过的不同 .pack 文件名总数 ≤ 2', async () => {
  const cr = caseRoot('a', 'a2-pack-names');
  const S = sid('a128', 2);
  const h = await startInstance(cr, STRICT20, { label: 'strict' });
  await seed(h.base, cr.ws, S, LIMIT, 'a2');
  const seen = new Set(packNames(cr.home, S));
  const trace = [`初始 packs=${JSON.stringify([...seen])} loose=${looseCount(cr.home, S)}`];
  for (let i = 0; i < 10; i += 1) {
    touchNote(cr.ws, `a2 #${i}`);
    const r = await snap(h.base, S, cr.ws);
    expect(r.status, `第 ${i + 1} 次拍快照应 200:${r.text.slice(0, 160)}`).toBe(200);
    const now = packNames(cr.home, S);
    now.forEach((n) => seen.add(n));
    trace.push(`#${i + 1} ${r.ms}ms packs=${JSON.stringify(now.map((n) => n.slice(0, 12)))} loose=${looseCount(cr.home, S)}`);
  }
  console.log(`[r128] A2 过程记录:\n  ${trace.join('\n  ')}\n  出现过的不同 pack 名:${seen.size} 个 ${JSON.stringify([...seen])}`);
  expect(seen.size, `整个过程中出现过的不同 .pack 文件名应 ≤ 2(初始 1 个 + 至多 1 次重打包),实际 ${seen.size} 个:${JSON.stringify([...seen])}`).toBeLessThanOrEqual(2);
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

// ───────────────────────── A4 空间最终释放 ─────────────────────────
test('A4 空间最终释放:CGUI_CHECKPOINT_REPACK_DEBOUNCE_MS=300,上限 20 连拍 10 次后 ≤5 秒内 objects/pack/ 只剩 1 个 pack,被摘掉的旧 sha 不再 cat-file 得到', async () => {
  const cr = caseRoot('a', 'a4-eventual-release');
  const S = sid('a128', 4);
  const h = await startInstance(cr, { ...STRICT20, CGUI_CHECKPOINT_REPACK_DEBOUNCE_MS: '300' }, { label: 'strict' });
  const seeded = await seed(h.base, cr.ws, S, LIMIT, 'a4');
  const victims = seeded.slice(0, 10);                     // 再拍 10 次后,最旧的这 10 条该被摘掉
  for (let i = 0; i < 10; i += 1) {
    touchNote(cr.ws, `a4 #${i}`);
    const r = await snap(h.base, S, cr.ws);
    expect(r.status, `第 ${i + 1} 次拍快照应 200:${r.text.slice(0, 160)}`).toBe(200);
  }
  const doneAt = Date.now();
  let packs = packNames(cr.home, S); let alive = victims.filter((v) => objectExists(cr.home, S, v));
  while (Date.now() - doneAt < 5_000 && !(packs.length === 1 && alive.length === 0)) {
    await sleep(200);
    packs = packNames(cr.home, S); alive = victims.filter((v) => objectExists(cr.home, S, v));
  }
  console.log(`[r128] A4 等待 ${Date.now() - doneAt}ms 后:packs=${JSON.stringify(packs)} loose=${looseCount(cr.home, S)} 旧 sha 仍可达 ${alive.length}/10`);
  expect.soft(packs.length, `节流窗口过后 objects/pack/ 应只剩 1 个 pack,实际 ${packs.length} 个:${JSON.stringify(packs)}`).toBe(1);
  expect.soft(alive, `被摘掉的 10 条旧 sha 应都 cat-file 不到了,仍可达:${JSON.stringify(alive.map(short))}`).toEqual([]);
  const kept = seeded.slice(10);
  expect(kept.filter((k) => !objectExists(cr.home, S, k)), '仍在列表里的 10 条老快照对象必须还在(反向:不许多删)').toEqual([]);
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
