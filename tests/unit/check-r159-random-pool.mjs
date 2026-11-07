#!/usr/bin/env node
// r159 D3:「随机」加载动画模式的纯函数(loadingPrefs.js)与设置选项顺序(App.jsx 的 LOADING_OPTIONS)。
//
// 锁的事:
//   R1 默认样式 = random;随机池 = 16 个 id,且都是 ORBIT_VARIANTS 里的变体。
//   R2 pickRandomStyle:池大于 1 时 2000 次抽取没有一次等于 prev;16 个 id 都抽到过;
//      注入 rng 时结果确定;prev 为空(或不在池里)时 16 个都可能取到。
//   R3 shouldReroll:只在进入 thinking / tool(phase 变了,或 tool 换了 key)且距上次 ≥ 1500ms 时为 true;
//      text / stopping / compacting / connecting、同阶段、tool 同 key、1499ms 都为 false;lastRollMs 为空视为可抽。
//   R4 App.jsx 的 LOADING_OPTIONS:前 3 项 random / orbit3 / orbit4,前 17 项 = random + 16 个池内 id,
//      其后接原有的 cli、ring(读源码文本,不 import JSX)。
//   R5 nextRollState(D3b):新 scope 必抽且避开上一回合;同 scope 重新挂载、text 等阶段、不满 1.5 秒都不抽也不补抽。
//
// 跑法:node tests/unit/check-r159-random-pool.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const P = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'loadingPrefs.js')).href);
const V = await import(pathToFileURL(join(ROOT, 'client', 'src', 'utils', 'orbitVariants.js')).href);
const report = makeReport('check-r159-random-pool');

const EXPECTED_POOL = [
  'orbit3', 'orbit4', 'o3-v5', 'o4-v5', 'o3-v6', 'o4-v6', 'o3-tumble', 'o4-tumble',
  'o3-breath', 'o4-breath', 'o3-fig8', 'o3-adj', 'o4-adj', 'o4-diag', 'o4-counter', 'o4-binary',
];

// 确定性伪随机(mulberry32),让分布检查可复现
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

await report.check('R1', '默认样式 random、随机池 16 个', 'red', () => {
  assert.equal(P.DEFAULT_LOADING_STYLE, 'random');
  assert.deepEqual([...V.RANDOM_POOL], EXPECTED_POOL);
  assert.equal(new Set(V.RANDOM_POOL).size, 16);
  for (const id of V.RANDOM_POOL) assert.ok(V.variantOf(id), id);
  assert.equal(P.readLoadingStyle({ getItem: () => null }), 'random');
});

await report.check('R2', 'pickRandomStyle 不重复、覆盖全池、可注入 rng', 'red', () => {
  // 不等于 prev:每个 prev 各抽 2000 次
  for (const prev of EXPECTED_POOL) {
    const rng = seeded(prev.length * 7919 + prev.charCodeAt(prev.length - 1));
    for (let i = 0; i < 2000; i += 1) {
      const id = P.pickRandomStyle(prev, rng);
      assert.notEqual(id, prev, `prev=${prev} 第 ${i} 次`);
      assert.ok(EXPECTED_POOL.includes(id), id);
    }
  }
  // 链式抽取 2000 次:相邻不重样,16 个都抽到,粗检均匀(每个至少 2000/16 的一半)
  const counts = new Map();
  let prev = null;
  const rng = seeded(20261107);
  for (let i = 0; i < 2000; i += 1) {
    const id = P.pickRandomStyle(prev, rng);
    if (prev) assert.notEqual(id, prev);
    counts.set(id, (counts.get(id) || 0) + 1);
    prev = id;
  }
  assert.equal(counts.size, 16, [...counts.keys()].join(','));
  for (const [id, c] of counts) assert.ok(c >= 2000 / 16 / 2, `${id} 只抽到 ${c} 次`);
  // 默认 rng(Math.random)也不重样
  for (let i = 0; i < 500; i += 1) assert.notEqual(P.pickRandomStyle('o4-diag'), 'o4-diag');
  // 注入 rng 结果确定:prev 为空时 rng=0 → 第一个,rng 接近 1 → 最后一个
  assert.equal(P.pickRandomStyle(null, () => 0), 'orbit3');
  assert.equal(P.pickRandomStyle(null, () => 0.999999), 'o4-binary');
  assert.equal(P.pickRandomStyle('orbit3', () => 0), 'orbit4');
  assert.equal(P.pickRandomStyle('o4-binary', () => 0.999999), 'o4-counter');
  const a = seeded(42); const b = seeded(42);
  for (let i = 0; i < 50; i += 1) assert.equal(P.pickRandomStyle('o3-v5', a), P.pickRandomStyle('o3-v5', b));
  // prev 为空 / 不在池里:16 个都可取到
  for (const empty of [null, undefined, '', 'cli', 'random']) {
    const got = new Set(EXPECTED_POOL.map((_, k) => P.pickRandomStyle(empty, () => (k + 0.5) / 16)));
    assert.equal(got.size, 16, String(empty));
  }
});

await report.check('R3', 'shouldReroll 各分支与 1.5 秒边界', 'red', () => {
  const base = { nowMs: 10_000, lastRollMs: 0 };
  const R = (o) => P.shouldReroll({ ...base, ...o });
  // 进入思考 / 进入工具
  assert.equal(R({ prevPhase: 'tool', prevKey: 'tool:Bash', phase: 'thinking', key: 'thinking' }), true);
  assert.equal(R({ prevPhase: 'text', prevKey: 'text', phase: 'thinking', key: 'thinking' }), true);
  assert.equal(R({ prevPhase: 'thinking', prevKey: 'thinking', phase: 'tool', key: 'tool:Read a' }), true);
  assert.equal(R({ prevPhase: 'connecting', prevKey: 'connecting', phase: 'tool', key: 'tool:x' }), true);
  // 工具阶段换 key / 同 key
  assert.equal(R({ prevPhase: 'tool', prevKey: 'tool:A', phase: 'tool', key: 'tool:B' }), true);
  assert.equal(R({ prevPhase: 'tool', prevKey: 'tool:A', phase: 'tool', key: 'tool:A' }), false);
  // 同阶段(思考)
  assert.equal(R({ prevPhase: 'thinking', prevKey: 'thinking', phase: 'thinking', key: 'thinking' }), false);
  assert.equal(R({ prevPhase: 'thinking', prevKey: 'x', phase: 'thinking', key: 'y' }), false);
  // 其它阶段一律不换
  for (const phase of ['text', 'stopping', 'compacting', 'connecting', null, undefined, '']) {
    assert.equal(R({ prevPhase: 'thinking', prevKey: 'thinking', phase, key: phase }), false, String(phase));
    assert.equal(R({ prevPhase: 'tool', prevKey: 'tool:A', phase, key: 'tool:B' }), false, String(phase));
  }
  // lastRollMs 为空视为可抽
  assert.equal(P.shouldReroll({ prevPhase: 'text', prevKey: 'text', phase: 'thinking', key: 'thinking', nowMs: 5, lastRollMs: null }), true);
  assert.equal(P.shouldReroll({ prevPhase: 'text', prevKey: 'text', phase: 'thinking', key: 'thinking', nowMs: 5, lastRollMs: undefined }), true);
  // 1499 / 1500 边界
  const enter = { prevPhase: 'thinking', prevKey: 'thinking', phase: 'tool', key: 'tool:A' };
  assert.equal(P.shouldReroll({ ...enter, nowMs: 11_499, lastRollMs: 10_000 }), false);
  assert.equal(P.shouldReroll({ ...enter, nowMs: 11_500, lastRollMs: 10_000 }), true);
  assert.equal(P.shouldReroll({ ...enter, nowMs: 10_000, lastRollMs: 10_000 }), false);
  assert.equal(P.REROLL_MIN_GAP_MS, 1500);
});

await report.check('R4', 'LOADING_OPTIONS 顺序:random、orbit3、orbit4、其余 14 种、再接原有样式', 'red', () => {
  const src = readFileSync(join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
  const start = src.indexOf('export const LOADING_OPTIONS = [');
  assert.ok(start >= 0, '找不到 LOADING_OPTIONS');
  const body = src.slice(start, src.indexOf('];', start));
  // 字面量 id 按出现顺序;展开的那一段按源码文本替换成 RANDOM_POOL 去掉 orbit3 / orbit4
  const spread = "...RANDOM_POOL.filter((id) => id !== 'orbit3' && id !== 'orbit4')";
  const spreadAt = body.indexOf(spread);
  assert.ok(spreadAt >= 0, '没有按 RANDOM_POOL 展开其余 14 种');
  const idsIn = (text) => [...text.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
  const before = idsIn(body.slice(0, spreadAt));
  const after = idsIn(body.slice(spreadAt + spread.length));
  const rest = EXPECTED_POOL.filter((id) => id !== 'orbit3' && id !== 'orbit4');
  const all = [...before, ...rest, ...after];
  assert.deepEqual(all.slice(0, 3), ['random', 'orbit3', 'orbit4']);
  assert.deepEqual(new Set(all.slice(0, 17)), new Set(['random', ...EXPECTED_POOL]));
  assert.deepEqual(all.slice(3, 17), rest);
  assert.deepEqual(all.slice(17, 19), ['cli', 'ring']);
  assert.equal(new Set(all).size, all.length, 'id 有重复');
  assert.ok(/\{\s*id:\s*'random',\s*label:\s*'随机'\s*\}/.test(body), 'random 的标签不是「随机」');
  assert.ok(body.includes('ORBIT_VARIANTS[id].label'), '其余 14 种的标签没有取自 ORBIT_VARIANTS');
});

await report.check('R5', 'nextRollState 按回合跨挂载连续(D3b)', 'red', () => {
  const N = P.nextRollState;
  const rng = seeded(159);
  // 新 scope 第一次必抽,且不等于上一回合的 current;mem 为空也必抽
  const r0 = N(null, { scope: 1000, phase: 'connecting', key: 'connecting', nowMs: 1000 }, rng);
  assert.equal(r0.rolled, true);
  assert.ok(EXPECTED_POOL.includes(r0.id));
  assert.deepEqual(r0.mem, { scope: 1000, current: r0.id, phase: 'connecting', key: 'connecting', lastRollMs: 1000 });
  for (const prev of EXPECTED_POOL) {
    const old = { scope: 1, current: prev, phase: 'text', key: 'text', lastRollMs: 0 };
    for (let i = 0; i < 50; i += 1) {
      const r = N(old, { scope: 2, phase: 'connecting', key: 'connecting', nowMs: 10 }, rng);
      assert.equal(r.rolled, true);
      assert.notEqual(r.id, prev);
      assert.equal(r.mem.scope, 2);
      assert.equal(r.mem.lastRollMs, 10);
    }
  }
  // current 为空视为没抽过
  assert.equal(N({ scope: 1, current: null, phase: 'thinking', key: 'thinking', lastRollMs: 0 }, { scope: 1, phase: 'thinking', key: 'thinking', nowMs: 5 }, rng).rolled, true);
  // 入参不被改写
  const frozen = Object.freeze({ scope: 1, current: 'o3-v5', phase: 'thinking', key: 'thinking', lastRollMs: 0 });
  N(frozen, { scope: 1, phase: 'tool', key: 'tool:A', nowMs: 5000 }, rng);

  // 同 scope 同 phase 同 key → 不抽、id 不变(模拟重新挂载)
  const m = { scope: 7, current: 'o4-diag', phase: 'thinking', key: 'thinking', lastRollMs: 0 };
  for (const nowMs of [1, 1499, 1500, 99_999]) {
    const r = N(m, { scope: 7, phase: 'thinking', key: 'thinking', nowMs }, rng);
    assert.equal(r.rolled, false); assert.equal(r.id, 'o4-diag');
    assert.equal(r.mem.lastRollMs, 0);
  }
  // text / stopping / compacting / connecting:从思考 / 工具切过来、在组头与底部之间重新挂载(新调用、同一 mem),都不抽
  for (const phase of ['text', 'stopping', 'compacting', 'connecting']) {
    for (const from of [m, { ...m, phase: 'tool', key: 'tool:A' }]) {
      const a = N(from, { scope: 7, phase, key: phase, nowMs: 50_000 }, rng);
      assert.equal(a.rolled, false, phase); assert.equal(a.id, 'o4-diag');
      assert.equal(a.mem.phase, phase); assert.equal(a.mem.key, phase);
      const b = N(a.mem, { scope: 7, phase, key: phase, nowMs: 60_000 }, rng);
      assert.equal(b.rolled, false, phase); assert.equal(b.id, 'o4-diag');
    }
  }
  // 连接中 → 思考:1499ms 不抽,1500ms 抽
  const conn = { scope: 9, current: 'o3-adj', phase: 'connecting', key: 'connecting', lastRollMs: 10_000 };
  const c1 = N(conn, { scope: 9, phase: 'thinking', key: 'thinking', nowMs: 11_499 }, rng);
  assert.equal(c1.rolled, false); assert.equal(c1.id, 'o3-adj');
  assert.equal(c1.mem.phase, 'thinking'); assert.equal(c1.mem.lastRollMs, 10_000);
  const c2 = N(conn, { scope: 9, phase: 'thinking', key: 'thinking', nowMs: 11_500 }, rng);
  assert.equal(c2.rolled, true); assert.notEqual(c2.id, 'o3-adj');
  assert.equal(c2.mem.lastRollMs, 11_500); assert.equal(c2.mem.current, c2.id);

  // thinking → tool → thinking,各自满 1.5 秒都抽,新 id 不等于旧 id
  let s = c2.mem;
  for (const [phase, key, nowMs] of [['tool', 'tool:Bash ls', 13_000], ['thinking', 'thinking', 14_500], ['tool', 'tool:Read a', 16_000]]) {
    const r = N(s, { scope: 9, phase, key, nowMs }, rng);
    assert.equal(r.rolled, true, `${phase}@${nowMs}`); assert.notEqual(r.id, s.current);
    s = r.mem;
  }
  // tool 换 key:满 1.5 秒抽,不满不抽
  const t1 = N(s, { scope: 9, phase: 'tool', key: 'tool:Edit b', nowMs: 17_500 }, rng);
  assert.equal(t1.rolled, true); assert.notEqual(t1.id, s.current);
  const t2 = N(t1.mem, { scope: 9, phase: 'tool', key: 'tool:Grep c', nowMs: 17_900 }, rng);
  assert.equal(t2.rolled, false); assert.equal(t2.id, t1.id); assert.equal(t2.mem.key, 'tool:Grep c');
  // 不满 1.5 秒进入的新阶段,之后同阶段内再来调用(phase / key 不变)也不补抽
  for (const nowMs of [19_000, 25_000, 100_000]) {
    const r = N(t2.mem, { scope: 9, phase: 'tool', key: 'tool:Grep c', nowMs }, rng);
    assert.equal(r.rolled, false, String(nowMs)); assert.equal(r.id, t1.id);
  }
  const th = N(t1.mem, { scope: 9, phase: 'thinking', key: 'thinking', nowMs: 18_000 }, rng);
  assert.equal(th.rolled, false);
  assert.equal(N(th.mem, { scope: 9, phase: 'thinking', key: 'thinking', nowMs: 60_000 }, rng).rolled, false);
  // 注入 rng 结果确定
  assert.equal(N(null, { scope: 1, phase: 'thinking', key: 'thinking', nowMs: 0 }, () => 0).id, 'orbit3');
});

process.exit(report.finish());
