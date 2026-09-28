#!/usr/bin/env node
// r130 · 聚合扩展白盒(server/services/usage-stats.js):小夹具手算 byDay.sessions/messages 与 overview 九键、
// 未来时间戳、v1 → v2 升级回放、tz 不等回放、projects 目录缺失 (a)/(b)、后台重算冷却合并(env=2000)。
// 写法同 check-usage-stats-scope:临时 HOME + 带 query 的动态 import 拿新模块实例;**env(TZ / 冷却)必须在
// import 之前设**(模块顶层只读一次)。黑盒逐条验收在 tests/acceptance/r130-home-usage(A / B 组),这里只钉
// 单进程内看得见的时序与手算。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

process.env.TZ = 'Asia/Shanghai';
assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Shanghai', '自检:进程 TZ 必须已切到 Asia/Shanghai');

const homes = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cachePathOf = (home) => join(home, '.claude-gui', 'usage-stats-cache.json');
const readCache = (home) => JSON.parse(readFileSync(cachePathOf(home), 'utf8'));
function makeHome(tree = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cgui-r130-'));
  homes.push(home);
  for (const [rel, lines] of Object.entries(tree)) writeLines(join(home, '.claude', 'projects', rel), lines);
  return home;
}
function writeLines(abs, lines, append = false) {
  mkdirSync(dirname(abs), { recursive: true });
  (append ? appendFileSync : writeFileSync)(abs, lines.join('\n') + '\n');
}
/** env 只给差异项;null = 删掉。每个 case 都显式给冷却值,防前一个 case 泄漏。 */
async function statsFor(home, tag, env = { CGUI_USAGE_RECOMPUTE_COOLDOWN_MS: null }) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const [k, v] of Object.entries(env)) { if (v == null) delete process.env[k]; else process.env[k] = String(v); }
  const { getUsageStats } = await import(`../../server/services/usage-stats.js?case=${tag}`);
  return getUsageStats;
}
async function waitFor(fn, { timeoutMs = 4000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() >= deadline) return undefined; await sleep(intervalMs); }
}

// ── 夹具:本地日期(+08:00)相对今天生成;timestamp 一律 ISO UTC 串 ──────────────
const pad = (n) => String(n).padStart(2, '0');
const dayAgo = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const isoAt = (day, hh, mm = 0) => new Date(`${day}T${pad(hh)}:${pad(mm)}:00+08:00`).toISOString();
let seq = 0;
const STD = [100, 20, 300, 40];   // 合计 460
const asst = ({ id, model = 'claude-a', ts, u = STD, sidechain = false } = {}) => JSON.stringify({
  type: 'assistant', uuid: `a${++seq}`, isSidechain: sidechain, timestamp: ts,
  message: { id: id === null ? undefined : (id ?? `msg${seq}`), model: model === null ? undefined : model,
    usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] } },
});
const usr = ({ text = 'hi', content, ts, uuid, isMeta = false, sidechain = false } = {}) => JSON.stringify({
  type: 'user', uuid: uuid === null ? undefined : (uuid ?? `u${++seq}`), isMeta, isSidechain: sidechain, timestamp: ts,
  message: { role: 'user', content: content ?? text },
});
const row = (s, day) => { const r = s.byDay.find((x) => x.day === day); assert.ok(r, `byDay 应有 ${day} 行;实际:${s.byDay.map((x) => x.day).join(',')}`); return r; };
const EMPTY_OVERVIEW = { messages: 0, activeDays: 0, firstDay: null, lastActiveDay: null, currentStreak: 0, longestStreak: 0, hourCounts: Array(24).fill(0), peakHour: null, favoriteModel: null };

try {
  // ── ① 小夹具手算:两会话 + 子代理 + workflow 深层 + 无 ts + 坏行 ─────────────────────
  const D0 = dayAgo(0); const D1 = dayAgo(1); const D3 = dayAgo(3);
  const s = await (await statsFor(makeHome({
    'demo/s1.jsonl': [usr({ ts: isoAt(D1, 10, 0) }), asst({ ts: isoAt(D1, 10, 1) }), usr({ ts: isoAt(D1, 10, 2) }),
      asst({ ts: isoAt(D1, 10, 3), model: 'claude-b', u: [10, 0, 200, 0] }), usr({ ts: isoAt(D3, 9) }), '{"type":"assistant","message":{"id":"broken_'],
    'demo/s2.jsonl': [asst({ ts: isoAt(D1, 11, 0) }), asst({ ts: undefined }), asst({ ts: isoAt(D0, 8, 30) })],
    'demo/s1/subagents/agent-x.jsonl': [usr({ ts: isoAt(D1, 10, 5), sidechain: false }), asst({ ts: isoAt(D1, 10, 6), sidechain: true })],
    'demo/s2/subagents/workflows/wf_1/agent-y.jsonl': [asst({ ts: isoAt(D1, 12, 0), model: '<synthetic>', u: [9999, 0, 0, 0] })],
  }), 'manual'))();
  assert.equal(s.total.sessionCount, 2, '会话数仍只数顶层文件');
  assert.deepEqual(s.byDay.map((r) => r.day), ['unknown', D0, D1, D3], "'unknown' 排最前,其余降序;只有 user 的 D3 也成行");
  const d1 = row(s, D1);
  assert.equal(d1.calls, 5, 'D1 calls = s1 2 + s2 1 + 子代理 1 + workflow 1');
  assert.equal(d1.messages, 7, 'D1 messages = 顶层 user 2 + calls 5(子代理文件里的 user 按路径排除)');
  assert.equal(d1.sessions, 2, 'D1 sessions = {s1, s2}(子代理归 s1、workflow 归 s2,按路径推导)');
  assert.deepEqual(row(s, D3), { day: D3, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, sessions: 1, messages: 1 }, '只有 user 的天:token 四项与 calls 为 0,八键齐全');
  assert.deepEqual([s.byDay[0].calls, s.byDay[0].messages, s.byDay[0].sessions], [1, 1, 1], "无 ts 的 assistant 落 'unknown' 行");
  const ov = s.overview;
  assert.equal(ov.messages, 3 + 7, 'overview.messages = 全部 user 3 + Σ calls 7(含 unknown 行的)');
  assert.deepEqual([ov.activeDays, ov.firstDay, ov.lastActiveDay], [3, D3, D0], "activeDays 不含 'unknown'");
  assert.deepEqual([ov.currentStreak, ov.longestStreak], [2, 2], '今天 + 昨天连续 2 天,前天断开');
  const hc = Array(24).fill(0); hc[10] = 3; hc[11] = 1; hc[12] = 1; hc[8] = 1;
  assert.deepEqual(ov.hourCounts, hc, '按本地小时计去重后的 assistant(无 ts 不计;user 不计)');
  assert.equal(ov.peakHour, 10);
  assert.equal(ov.favoriteModel, 'claude-a', "按四项合计:claude-a 1840 > claude-b 210;'<synthetic>' 9999 排除");
  assert.deepEqual(Object.keys(ov).sort(), Object.keys(EMPTY_OVERVIEW).sort(), 'overview 九键齐全');
  assert.deepEqual(Object.keys(s).sort(), ['byDay', 'byModel', 'byProject', 'meta', 'overview', 'total'], '根键只多 overview');
  const file = await waitFor(() => { try { return readCache(homes[0]); } catch { return null; } });
  assert.deepEqual([file.version, file.tz, typeof file.data.overview], [2, 'Asia/Shanghai', 'object'], '落盘头 {version:2, tz} 且 data 带 overview');

  // ── ② 未来时间戳:行留在 byDay,不计活跃 / 连续 ─────────────────────────────────────
  const fut = await (await statsFor(makeHome({ 'demo/s1.jsonl': [usr({ ts: isoAt(dayAgo(-5), 9) }), usr({ ts: isoAt(dayAgo(-4), 9) }), usr({ ts: isoAt(dayAgo(1), 9) })] }), 'future'))();
  assert.equal(row(fut, dayAgo(-5)).messages, 1, '未来日的行仍在 byDay');
  assert.deepEqual([fut.overview.activeDays, fut.overview.lastActiveDay, fut.overview.currentStreak, fut.overview.longestStreak], [1, dayAgo(1), 1, 1], '未来日不计 activeDays / lastActiveDay / 连续段');

  // ── ③ v1 → v2 升级:回放旧 data 原样(无 overview)→ jsonl 一字未动也必重算补全,文件升 v2 带 tz ──
  const upHome = makeHome({ 'demo/s1.jsonl': [usr({ ts: isoAt(D1, 10) }), asst({ ts: isoAt(D1, 10, 1) })] });
  const cold = await (await statsFor(upHome, 'up-prime'))();
  assert.ok(await waitFor(() => { try { return readCache(upHome); } catch { return null; } }), '冷扫应落盘');
  const { tz: _tz, ...v1 } = readCache(upHome);
  v1.version = 1; delete v1.data.overview; v1.data.byDay = v1.data.byDay.map(({ sessions, messages, ...rest }) => rest);
  writeFileSync(cachePathOf(upHome), JSON.stringify(v1));
  const upStats = await statsFor(upHome, 'up-replay');
  const first = await upStats();
  assert.equal(first.meta.stale, true, 'v1 回放先标 stale');
  assert.equal('overview' in first, false, '回放 v1 不凭空造 overview');
  assert.equal('sessions' in first.byDay[0], false, '回放 v1 的 byDay 也是旧形状');
  assert.deepEqual(first.total, cold.total, '回放的旧值原样');
  const upgraded = await waitFor(async () => { const r = await upStats(); return (r.meta.stale === false && r.overview) ? r : null; }, { timeoutMs: 3000 });
  assert.ok(upgraded, "jsonl 一字未动,3 秒内也必须重算补全(needsRecompute:'version')");
  assert.deepEqual(upgraded.overview, cold.overview);
  assert.ok(upgraded.meta.scannedAt > first.meta.scannedAt, 'scannedAt 前进 = 真重算了');
  assert.deepEqual([readCache(upHome).version, readCache(upHome).tz], [2, 'Asia/Shanghai'], '文件重写为 v2 带 tz');

  // ── ④ tz 不等:v2 文件 tz:'UTC' → 回放(overview 在)+ 必重算,以当前 tz 落盘 ──────────
  writeFileSync(cachePathOf(upHome), JSON.stringify({ ...readCache(upHome), tz: 'UTC' }));
  const tzStats = await statsFor(upHome, 'tz-replay');
  const tzFirst = await tzStats();
  assert.equal(tzFirst.meta.stale, true);
  assert.equal(typeof tzFirst.overview, 'object', 'tz 不等的回放仍带 overview(旧时区的值)');
  const tzDone = await waitFor(async () => { const r = await tzStats(); return r.meta.stale === false ? r : null; });
  assert.ok(tzDone && tzDone.meta.scannedAt > tzFirst.meta.scannedAt, "tz 不等必重算(needsRecompute:'tz')");
  assert.equal(readCache(upHome).tz, 'Asia/Shanghai');

  // ── ⑤ projects 目录缺失:(a) 无缓存 → 空账逐字;(b) 有 v1 缓存 → 不升级,目录恢复后才升级 ──
  const noneA = await (await statsFor(makeHome(), 'none-a'))();
  assert.deepEqual(noneA.overview, EMPTY_OVERVIEW, '空账 overview 逐字(hourCounts 24 个 0)');
  assert.deepEqual([noneA.byDay, noneA.meta.stale], [[], false]);
  const bHome = makeHome();
  mkdirSync(join(bHome, '.claude-gui'), { recursive: true });
  writeFileSync(cachePathOf(bHome), JSON.stringify(v1));
  const bStats = await statsFor(bHome, 'none-b');
  await bStats(); await sleep(400);
  const bHeld = await bStats();
  assert.deepEqual([bHeld.meta.stale, 'overview' in bHeld, readCache(bHome).version], [true, false, 1], '目录读不到:一直回放、不升级、文件仍 v1');
  writeLines(join(bHome, '.claude', 'projects', 'demo', 's1.jsonl'), [usr({ ts: isoAt(D1, 10) }), asst({ ts: isoAt(D1, 10, 1) })]);
  await bStats();
  const bUp = await waitFor(async () => { const r = await bStats(); return (r.meta.stale === false && r.overview) ? r : null; });
  assert.ok(bUp, '目录恢复后下一次 GET 触发核对并升级');
  assert.equal(readCache(bHome).version, 2);

  // ── ⑥ 冷却合并(env=2000):冷扫与启动后第一次后台重算不受限;之后 500 ms 内两次追加只重算一次 ──
  const cdHome = makeHome({ 'demo/s1.jsonl': [asst({ ts: isoAt(D1, 10), model: 'r0' })] });
  const cd = await statsFor(cdHome, 'cooldown', { CGUI_USAGE_RECOMPUTE_COOLDOWN_MS: 2000 });
  assert.equal((await cd()).meta.stale, false, '冷路径首扫不受冷却限制');
  const add = (m) => writeLines(join(cdHome, '.claude', 'projects', 'demo', 's1.jsonl'), [asst({ ts: isoAt(D1, 11), model: m })], true);
  const has = (r, m) => r.byModel.some((x) => x.model === m);
  add('r1'); await cd();
  const r1 = await waitFor(async () => { const r = await cd(); return (r.meta.stale === false && has(r, 'r1')) ? r : null; });
  assert.ok(r1, '启动后第一次由后台核对触发的重算不受冷却限制');
  const S1 = r1.meta.scannedAt; const T0 = Date.now();
  add('r2'); await cd(); await sleep(500); add('r3'); await cd();
  const samples = [];
  while (Date.now() - T0 < 3200) { samples.push(await cd()); await sleep(100); }
  const seen = [...new Set(samples.map((x) => x.meta.scannedAt))];
  assert.equal(seen.length, 2, `3.2 秒内 scannedAt 只许前进一次(期间变化合并);实际:${seen.join(',')}`);
  const held = samples.filter((x) => x.meta.scannedAt === S1);
  assert.ok(held.some((x) => x.meta.stale === true), '冷却期内如实标 stale(手上这份已知不是最新)');
  assert.ok(held.every((x) => !has(x, 'r2')), '冷却期内不提前算出 r2');
  const merged = samples.find((x) => x.meta.scannedAt !== S1);
  assert.ok(has(merged, 'r2') && has(merged, 'r3'), '冷却结束后那一次重算同时包含两条追加');

  console.log('check-r130-usage-overview: PASS');
} finally {
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch {} }
}
// 模块顶层有 10s 的预热 setTimeout(未 unref),不显式退出会让进程空等。
process.exit(0);
