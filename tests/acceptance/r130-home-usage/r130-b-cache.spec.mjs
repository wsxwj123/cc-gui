// r130 · B 组:磁盘缓存路径与错误契约(INTERFACE §B 九条逐条)。每条用例自己造隔离 HOME、自己起/停实例;不起浏览器。
// 手法:先用一台实例冷扫把缓存"造"出来(prime)→ 停掉 → 改缓存文件 / 改夹具 / 挪目录 → 再起一台观察首请求与收敛。
// 「修前」= 当前缓存是 version 1、无 tz、无 overview、无冷却 → v2 形状/升级/tz/冷却相关全红;既有行为(回放秒回、坏文件冷路径、写失败仍 200、并发合流)绿。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { caseRoot, sessionFile, writeJsonl, appendJsonl, assistant, user, sid, STD, tsAgo, cachePath, projectsDir,
  EMPTY_OVERVIEW, TZ } from './helpers/fixtures.mjs';
import { startInstance, stopAll, getUsage, waitFor, sampleUsage, wsCapture, readCacheFile, sleep } from './helpers/instance.mjs';

const S1 = sid(1); const S2 = sid(2);
test.afterEach(async () => { await stopAll(); });

const baseFixture = (home) => {
  writeJsonl(sessionFile(home, S1), [user({ ts: tsAgo(1, 10) }), assistant({ ts: tsAgo(1, 10, 1), model: 'r130-R0' })]);
  writeJsonl(sessionFile(home, S2), [assistant({ ts: tsAgo(2, 10), model: 'r130-R0' })]);
};
const hasModel = (body, m) => !!(body?.byModel || []).some((x) => x.model === m);
const appendModel = (home, m) => appendJsonl(sessionFile(home, S1), [assistant({ ts: tsAgo(1, 11), model: m })]);

/** 冷扫一次把缓存造出来,然后停掉。返回 { root, home, cold(冷路径响应体), file, raw(落盘原文) }。 */
async function prime(slug, build = baseFixture, env = {}) {
  const { root, home } = caseRoot('b', slug);
  build(home);
  const one = await startInstance({ root, home }, env, { label: `${slug}-prime` });
  const r = await getUsage(one.base);
  expect(r.status, `prime 冷扫应 200:${r.text.slice(0, 200)}`).toBe(200);
  const file = cachePath(home);
  const got = await waitFor(() => { const c = readCacheFile(file); return c?.json?.data ? c : null; }, { timeoutMs: 8000 });
  expect(got, `冷扫后 8 秒内应落盘 ${file}`).toBeTruthy();
  await one.stop();
  return { root, home, cold: r.json, file, raw: got.raw };
}
const boot = (ctx, env = {}, label = 'second') => startInstance({ root: ctx.root, home: ctx.home }, env, { label });
/** 把落盘文件改写(fn 收 json 返回新 json;返回字符串则原样写)。 */
function rewriteCache(file, fn) {
  const c = readCacheFile(file);
  const out = fn(c.json, c.raw);
  fs.writeFileSync(file, typeof out === 'string' ? out : JSON.stringify(out));
}

// ───────────── B0 / B1 正常回放 ─────────────

test('B0 冷扫落盘的文件是新形状:{version:3, tz:"Asia/Shanghai", sig, scannedAt, data};data 里带 overview / byDayModel / ranges', async () => {
  const ctx = await prime('b0-file-shape');
  const c = readCacheFile(ctx.file).json;
  // r131:CACHE_VERSION 2 → 3。本组用例守的仍是"落盘文件形状合法",只是版本号随常量前进。
  expect(c.version).toBe(3);
  expect(c.tz).toBe(TZ);
  expect(typeof c.sig).toBe('string');
  expect(typeof c.scannedAt).toBe('number');
  expect(c.data && typeof c.data.overview).toBe('object');
  expect(Array.isArray(c.data.byDay) && c.data.byDay.length > 0).toBe(true);
  expect(Object.keys(c.data.byDay[0])).toEqual(expect.arrayContaining(['sessions', 'messages']));
  // r131 新增的两个根键
  expect(c.data.byDayModel && typeof c.data.byDayModel === 'object').toBe(true);
  expect(Object.keys(c.data.ranges || {})).toEqual(expect.arrayContaining(['7d', '30d']));
});

test('B1a 合法 v2 回放且 sig 相同:首请求旧值 stale=true → 随后 stale=false、不重算(scannedAt 不动、文件不动、不广播)', async () => {
  const ctx = await prime('b1a-replay-same-sig');
  const two = await boot(ctx);
  const cap = await wsCapture(two.port);
  const first = await getUsage(two.base);
  expect(first.status).toBe(200);
  expect(first.json.meta?.stale, '首请求必须是磁盘回放').toBe(true);
  expect(first.json.total).toEqual(ctx.cold.total);
  expect(first.json.overview, '回放值里应带 overview').toEqual(ctx.cold.overview);
  const settled = await waitFor(async () => { const r = await getUsage(two.base); return r.json?.meta?.stale === false ? r.json : null; }, { timeoutMs: 5000 });
  expect(settled, '后台核对 sig 相同后 5 秒内应转为 stale=false').toBeTruthy();
  expect(settled.meta.scannedAt, 'sig 相同不重算 → scannedAt 不前进').toBe(ctx.cold.meta.scannedAt);
  await sleep(1500);
  expect(readCacheFile(ctx.file).raw, '文件不该被重写').toBe(ctx.raw);
  expect(cap.ofType('usage-updated').length, '不该广播').toBe(0);
  cap.close();
});

test('B1b 合法 v2 回放但 sig 不同:首请求旧值 stale=true → 重算落盘、新记录出现、广播 usage-updated 恰好一次', async () => {
  const ctx = await prime('b1b-replay-diff-sig');
  appendModel(ctx.home, 'r130-R1');
  const two = await boot(ctx);
  const cap = await wsCapture(two.port);
  const first = await getUsage(two.base);
  expect(first.json.meta?.stale).toBe(true);
  expect(hasModel(first.json, 'r130-R1'), '首请求是旧值,不该已含新记录').toBe(false);
  const settled = await waitFor(async () => { const r = await getUsage(two.base); return (r.json?.meta?.stale === false && hasModel(r.json, 'r130-R1')) ? r.json : null; }, { timeoutMs: 5000 });
  expect(settled, '5 秒内应重算并含 r130-R1、stale=false').toBeTruthy();
  expect(settled.meta.scannedAt).toBeGreaterThan(ctx.cold.meta.scannedAt);
  const c = readCacheFile(ctx.file).json;
  expect(c.version).toBe(3);
  expect(c.scannedAt).toBe(settled.meta.scannedAt);
  await sleep(1500);
  expect(cap.ofType('usage-updated').length, '重算落地广播恰好一次').toBe(1);
  cap.close();
});

// ───────────── B2 / B3 旧版与时区 ─────────────

/** 把落盘文件降级成 r131 之前的形状(去掉 byDayModel / ranges;用于验 v2 → v3 升级路径)。 */
function downgradeToV2(file) {
  rewriteCache(file, (j) => {
    const { byDayModel, ranges, ...data } = j.data;
    return { ...j, version: 2, data };
  });
}
/** 把落盘文件降级成 version 1(保留真实 sig / scannedAt;去掉 overview 与 byDay 的 sessions/messages)。 */
function downgradeToV1(file) {
  rewriteCache(file, (j) => {
    const data = { ...j.data };
    delete data.overview;
    data.byDay = (data.byDay || []).map(({ sessions, messages, ...rest }) => rest);
    const { tz, ...rest } = j;
    return { ...rest, version: 1, data };
  });
}

test('B2 version 1 回放:首请求旧 data 原样(stale=true、无 overview、byDay 无 sessions/messages)→ 自动升级为 v3 并广播一次', async () => {
  const ctx = await prime('b2-v1-upgrade');
  downgradeToV1(ctx.file);
  const two = await boot(ctx);
  const cap = await wsCapture(two.port);
  const first = await getUsage(two.base);
  expect(first.status).toBe(200);
  expect(first.json.meta?.stale).toBe(true);
  expect('overview' in first.json, '回放 v1 时不该凭空造出 overview').toBe(false);
  expect('sessions' in first.json.byDay[0]).toBe(false);
  expect(first.json.total).toEqual(ctx.cold.total);
  const t0 = Date.now();
  // r131:落盘版本已经是 3 —— v1 回放要一路升到 v3(中间不再有 v2 的中间态)
  const settled = await waitFor(async () => {
    const r = await getUsage(two.base);
    return (r.json?.meta?.stale === false && r.json.overview && r.json.ranges) ? r.json : null;
  }, { timeoutMs: 8000 });
  expect(settled, '不改任何 jsonl,8 秒内也必须重算补全 overview / byDayModel / ranges 并 stale=false').toBeTruthy();
  expect(settled.meta.scannedAt).toBeGreaterThan(first.json.meta.scannedAt);
  expect(settled.overview).toEqual(ctx.cold.overview);
  const c = readCacheFile(ctx.file).json;
  expect(c.version).toBe(3);
  expect(c.tz).toBe(TZ);
  await sleep(Math.max(0, 1500 - (Date.now() - t0)) + 1500);
  expect(cap.ofType('usage-updated').length).toBe(1);
  cap.close();
});

test('B3 时区变更:同版本文件 tz=UTC 而进程 tz=Asia/Shanghai → 首请求旧值 stale=true(overview 仍在)→ 必重算并以新 tz 落盘', async () => {
  const ctx = await prime('b3-tz-change');
  rewriteCache(ctx.file, (j) => ({ ...j, version: 3, tz: 'UTC', data: { ...j.data, overview: j.data.overview ?? { ...EMPTY_OVERVIEW, messages: 12345 } } }));
  const two = await boot(ctx);
  const first = await getUsage(two.base);
  expect(first.json.meta?.stale).toBe(true);
  expect(first.json.overview && typeof first.json.overview).toBe('object');
  const settled = await waitFor(async () => { const r = await getUsage(two.base); return r.json?.meta?.stale === false ? r.json : null; }, { timeoutMs: 5000 });
  expect(settled, '5 秒内应重算完成').toBeTruthy();
  expect(settled.meta.scannedAt, 'tz 不等必须重算(scannedAt 前进)').toBeGreaterThan(first.json.meta.scannedAt);
  expect(settled.overview).toEqual(ctx.cold.overview);
  const c = readCacheFile(ctx.file).json;
  expect(c.tz).toBe(TZ);
  expect(c.version).toBe(3);
});

// ───────────── B4 不信任的文件 → 冷路径 ─────────────

const UNTRUSTED = [
  ['version 0', (j) => ({ ...j, version: 0 })],
  ['version 999', (j) => ({ ...j, version: 999 })],
  ['缺 version', (j) => { const { version, ...rest } = j; return rest; }],
  ['半截 JSON', (j, raw) => raw.slice(0, Math.floor(raw.length / 2))],
  ['缺 data', (j) => { const { data, ...rest } = j; return rest; }],
  ['version 3 但缺 overview', (j) => { const data = { ...j.data }; delete data.overview; return { ...j, version: 3, tz: TZ, data }; }],
  // r131:byDayModel / ranges 缺一不可(它们就是"v3 形状"的标志,缺了也得当坏文件)
  ['version 3 但缺 byDayModel', (j) => { const data = { ...j.data }; delete data.byDayModel; return { ...j, version: 3, tz: TZ, data }; }],
  ['version 3 但缺 ranges', (j) => { const data = { ...j.data }; delete data.ranges; return { ...j, version: 3, tz: TZ, data }; }],
];
for (const [name, mutate] of UNTRUSTED) {
  test(`B4 不信任的缓存文件(${name})→ 冷路径:首请求 200 完整新形状 stale=false,文件被覆盖成合法 v2`, async () => {
    const ctx = await prime(`b4-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    rewriteCache(ctx.file, mutate);
    const poisoned = fs.readFileSync(ctx.file, 'utf8');
    const two = await boot(ctx);
    const r = await getUsage(two.base);
    expect(r.status).toBe(200);
    expect(r.json.meta?.stale, '不信任的文件不算回放,必须现算').toBe(false);
    expect(r.json.overview).toEqual(ctx.cold.overview);
    expect(r.json.total).toEqual(ctx.cold.total);
    const c = await waitFor(() => { const x = readCacheFile(ctx.file); return (x && x.raw !== poisoned && x.json?.version === 3) ? x.json : null; }, { timeoutMs: 8000 });
    expect(c, '文件应被覆盖成 version 3').toBeTruthy();
    expect(c.tz).toBe(TZ);
    expect(typeof c.data?.overview).toBe('object');
    expect(c.data?.byDayModel && typeof c.data.byDayModel === 'object').toBe(true);
    expect(Object.keys(c.data?.ranges || {})).toEqual(expect.arrayContaining(['7d', '30d']));
  });
}

// ───────────── B5 projects 目录缺失 ─────────────

test('B5a projects 目录缺失且无缓存 → 冷路径 200 空账(total 全 0、三数组为空、overview 逐字为空账、stale=false)并落盘', async () => {
  const { root, home } = caseRoot('b', 'b5a-no-projects-no-cache');
  expect(fs.existsSync(projectsDir(home))).toBe(false);
  const inst = await startInstance({ root, home }, {}, { label: 'b5a' });
  const r = await getUsage(inst.base);
  expect(r.status).toBe(200);
  expect(r.json.total).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessionCount: 0 });
  expect(r.json.byModel).toEqual([]);
  expect(r.json.byProject).toEqual([]);
  expect(r.json.byDay).toEqual([]);
  expect(r.json.overview).toEqual(EMPTY_OVERVIEW);
  expect(r.json.meta?.stale).toBe(false);
  const c = await waitFor(() => readCacheFile(cachePath(home))?.json ?? null, { timeoutMs: 8000 });
  expect(c?.version, '空账也落盘(既有行为)').toBe(3);
});

test('B5b projects 目录缺失但有当前版本缓存 → 一直回放 stale=true、不重算不落盘不广播;目录恢复后下一次 GET 才核对并转 stale=false', async () => {
  const ctx = await prime('b5b-no-projects-with-cache');
  const away = path.join(ctx.root, 'projects-away');
  fs.renameSync(projectsDir(ctx.home), away);
  const two = await boot(ctx);
  const cap = await wsCapture(two.port);
  const samples = await sampleUsage(two.base, { durationMs: 3000, intervalMs: 250 });
  for (const s of samples) {
    expect(s.status).toBe(200);
    expect(s.body.meta?.stale, `t=${s.t}ms 目录读不到时必须一直报 stale=true`).toBe(true);
    expect(s.body.meta?.scannedAt).toBe(ctx.cold.meta.scannedAt);
    expect(s.body.total, '目录读不到 ≠ 数据变成 0').toEqual(ctx.cold.total);
  }
  expect(readCacheFile(ctx.file).raw, '不落盘').toBe(ctx.raw);
  expect(cap.ofType('usage-updated').length, '不广播').toBe(0);
  fs.renameSync(away, projectsDir(ctx.home));
  const settled = await waitFor(async () => { const r = await getUsage(two.base); return r.json?.meta?.stale === false ? r.json : null; }, { timeoutMs: 5000 });
  expect(settled, '目录恢复后 5 秒内应核对完成转 stale=false').toBeTruthy();
  expect(settled.total).toEqual(ctx.cold.total);
  cap.close();
});

test('B5c projects 目录缺失 + v1 缓存 → 目录缺失期间不升级(文件仍 v1);目录恢复后才重算升级为 v3', async () => {
  const ctx = await prime('b5c-no-projects-v1');
  downgradeToV1(ctx.file);
  const v1raw = fs.readFileSync(ctx.file, 'utf8');
  const away = path.join(ctx.root, 'projects-away');
  fs.renameSync(projectsDir(ctx.home), away);
  const two = await boot(ctx);
  const samples = await sampleUsage(two.base, { durationMs: 3000, intervalMs: 250 });
  for (const s of samples) {
    expect(s.body.meta?.stale, `t=${s.t}ms`).toBe(true);
    expect('overview' in s.body, '目录读不到时不该"升级"出 overview').toBe(false);
  }
  expect(fs.readFileSync(ctx.file, 'utf8'), '目录缺失期间文件必须原样(仍是 v1)').toBe(v1raw);
  fs.renameSync(away, projectsDir(ctx.home));
  const settled = await waitFor(async () => { const r = await getUsage(two.base); return (r.json?.meta?.stale === false && r.json.overview) ? r.json : null; }, { timeoutMs: 5000 });
  expect(settled, '目录恢复后 5 秒内应升级(含 overview / ranges、stale=false)').toBeTruthy();
  expect(readCacheFile(ctx.file).json.version).toBe(3);
});

// ───────────── B6 重算冷却 ─────────────

/** 起实例 → 等启动首核结束(stale=false)→ 追加 R1 并等这次"由后台核对触发的重算"落地。返回 { two, T0, S1 }。 */
async function afterFirstBackgroundRecompute(ctx, env) {
  const two = await boot(ctx, env);
  await getUsage(two.base);
  const idle = await waitFor(async () => { const r = await getUsage(two.base); return r.json?.meta?.stale === false ? r.json : null; }, { timeoutMs: 5000 });
  expect(idle, '启动首核应在 5 秒内结束(stale=false)').toBeTruthy();
  appendModel(ctx.home, 'r130-R1');
  await getUsage(two.base);
  const done = await waitFor(async () => { const r = await getUsage(two.base); return (r.json?.meta?.stale === false && hasModel(r.json, 'r130-R1')) ? r.json : null; }, { timeoutMs: 5000 });
  expect(done, '启动后第一次由后台核对触发的重算不受冷却限制,5 秒内应含 r130-R1').toBeTruthy();
  return { two, T0: Date.now(), S1: done.meta.scannedAt };
}
const distinctScanned = (samples) => [...new Set(samples.map((s) => s.body?.meta?.scannedAt))];

test('B6a 冷却 2000ms:上次后台重算后 500ms 内两次追加 → 2.5 秒内 scannedAt 只前进一次,且那一次两条都计入;冷却期内 stale=true', async () => {
  const ctx = await prime('b6a-cooldown-merge');
  const { two, T0, S1 } = await afterFirstBackgroundRecompute(ctx, { CGUI_USAGE_RECOMPUTE_COOLDOWN_MS: '2000' });
  appendModel(ctx.home, 'r130-R2'); await getUsage(two.base);
  await sleep(500);
  appendModel(ctx.home, 'r130-R3'); await getUsage(two.base);
  const samples = await sampleUsage(two.base, { durationMs: 3200 - (Date.now() - T0), intervalMs: 100 });  const seen = distinctScanned(samples);
  const advanced = samples.find((s) => s.body?.meta?.scannedAt !== S1);
  expect(advanced, '冷却结束后应有一次重算(scannedAt 前进)').toBeTruthy();
  expect(hasModel(advanced.body, 'r130-R2') && hasModel(advanced.body, 'r130-R3'), '合并后的那次重算必须同时包含两条追加').toBe(true);
  expect(seen.length, `2.5 秒内 scannedAt 只许前进一次;实际出现的值:${seen.join(',')}`).toBe(2);
  const beforeAdvance = samples.filter((s) => s.body?.meta?.scannedAt === S1);
  expect(beforeAdvance.some((s) => s.body.meta.stale === true), '冷却期内(签名已变、还没重算)应报 stale=true').toBe(true);
  expect(beforeAdvance.every((s) => !hasModel(s.body, 'r130-R2')), '冷却期内不该提前算出 R2').toBe(true);
});

test('B6b 冷却 60000ms 不限制"启动后第一次核对":带旧缓存 + 已变的夹具起实例,3 秒内仍重算', async () => {
  const ctx = await prime('b6b-startup-not-limited');
  appendModel(ctx.home, 'r130-R1');
  const two = await boot(ctx, { CGUI_USAGE_RECOMPUTE_COOLDOWN_MS: '60000' });
  await getUsage(two.base);
  const done = await waitFor(async () => { const r = await getUsage(two.base); return (r.json?.meta?.stale === false && hasModel(r.json, 'r130-R1')) ? r.json : null; }, { timeoutMs: 3000 });
  expect(done, '启动首核不受冷却限制').toBeTruthy();
});

test('B6c 冷却 0 = 关闭:两次追加相隔 500ms → 各自立即重算(scannedAt 前进两次)', async () => {
  const ctx = await prime('b6c-cooldown-off');
  const { two, S1 } = await afterFirstBackgroundRecompute(ctx, { CGUI_USAGE_RECOMPUTE_COOLDOWN_MS: '0' });
  appendModel(ctx.home, 'r130-R2'); await getUsage(two.base);
  await sleep(500);
  appendModel(ctx.home, 'r130-R3'); await getUsage(two.base);
  const samples = await sampleUsage(two.base, { durationMs: 2500, intervalMs: 100 });
  const seen = distinctScanned(samples).filter((v) => v !== S1);
  expect(seen.length, `关闭冷却时两次追加应各触发一次重算;S1 之外出现的 scannedAt:${seen.join(',')}`).toBeGreaterThanOrEqual(2);
  const last = samples[samples.length - 1].body;
  expect(hasModel(last, 'r130-R2') && hasModel(last, 'r130-R3')).toBe(true);
});

test('B6d 非法冷却值(abc)按默认 30000:后台重算刚落地后再追加 → 3 秒内不重算(scannedAt 不动、stale=true、新记录不出现)', async () => {
  const ctx = await prime('b6d-cooldown-invalid');
  const { two, S1 } = await afterFirstBackgroundRecompute(ctx, { CGUI_USAGE_RECOMPUTE_COOLDOWN_MS: 'abc' });
  appendModel(ctx.home, 'r130-R2'); await getUsage(two.base);
  const samples = await sampleUsage(two.base, { durationMs: 3000, intervalMs: 200 });
  for (const s of samples) {
    expect(s.body.meta.scannedAt, `t=${s.t}ms 冷却期内 scannedAt 不该前进`).toBe(S1);
    expect(hasModel(s.body, 'r130-R2'), `t=${s.t}ms 冷却期内不该算出 R2`).toBe(false);
  }
  expect(samples.some((s) => s.body.meta.stale === true), '签名已变但被冷却压住 → 应报 stale=true').toBe(true);
});

test('B6e 冷路径首扫不受冷却限制:无缓存 + 冷却 60000 → 首请求直接现算 stale=false', async () => {
  const { root, home } = caseRoot('b', 'b6e-cold-not-limited');
  baseFixture(home);
  const inst = await startInstance({ root, home }, { CGUI_USAGE_RECOMPUTE_COOLDOWN_MS: '60000' }, { label: 'b6e' });
  const r = await getUsage(inst.base);
  expect(r.status).toBe(200);
  expect(r.json.meta?.stale).toBe(false);
  expect(hasModel(r.json, 'r130-R0')).toBe(true);
});

// ───────────── B7 / B8 / B9 ─────────────

test('B7 缓存路径被占成目录(写失败):请求仍 200 数据正确、不留 .tmp;重启后无可用缓存 → 冷路径', async () => {
  const { root, home } = caseRoot('b', 'b7-cache-write-fail');
  baseFixture(home);
  fs.mkdirSync(cachePath(home));
  const inst = await startInstance({ root, home }, {}, { label: 'b7' });
  const r1 = await getUsage(inst.base);
  const r2 = await getUsage(inst.base);
  for (const [n, r] of [[1, r1], [2, r2]]) {
    expect(r.status, `第 ${n} 次`).toBe(200);
    expect(r.json.total.input, `第 ${n} 次数据应正确(两条 assistant 各 ${STD[0]})`).toBe(STD[0] * 2);
    expect(r.json.total.sessionCount).toBe(2);
  }
  await sleep(1000);
  const leftovers = fs.readdirSync(path.join(home, '.claude-gui')).filter((f) => f.endsWith('.tmp'));
  expect(leftovers, '写失败不许留下 .tmp').toEqual([]);
  await inst.stop();
  const again = await startInstance({ root, home }, {}, { label: 'b7-restart' });
  const r3 = await getUsage(again.base);
  expect(r3.status).toBe(200);
  expect(r3.json.meta?.stale, '没有可用缓存 → 冷路径 stale=false').toBe(false);
});

test('B8 单个会话文件读失败(chmod 000)被跳过,其它文件照算、请求 200', async () => {
  const { root, home } = caseRoot('b', 'b8-one-file-unreadable');
  writeJsonl(sessionFile(home, S1), [assistant({ ts: tsAgo(1, 10), model: 'r130-bad', u: [7000, 0, 0, 0] })]);
  writeJsonl(sessionFile(home, S2), [assistant({ ts: tsAgo(1, 10), model: 'r130-good', u: STD })]);
  fs.chmodSync(sessionFile(home, S1), 0o000);
  try {
    const inst = await startInstance({ root, home }, {}, { label: 'b8' });
    const r = await getUsage(inst.base);
    expect(r.status).toBe(200);
    expect(hasModel(r.json, 'r130-good'), '可读的文件必须照算').toBe(true);
    expect(hasModel(r.json, 'r130-bad'), '读不到的文件只能跳过,不能算出数').toBe(false);
    expect(r.json.total.input).toBe(STD[0]);
  } finally { fs.chmodSync(sessionFile(home, S1), 0o644); }
});

test('B9 冷态 3 并发请求:全部 200、三份响应逐字节相同(同一份对象、同一个 scannedAt)', async () => {
  const { root, home } = caseRoot('b', 'b9-concurrent');
  baseFixture(home);
  const inst = await startInstance({ root, home }, {}, { label: 'b9' });
  const rs = await Promise.all([getUsage(inst.base), getUsage(inst.base), getUsage(inst.base)]);
  for (const r of rs) expect(r.status).toBe(200);
  expect(rs[1].text).toBe(rs[0].text);
  expect(rs[2].text).toBe(rs[0].text);
  expect(rs[0].json.meta?.stale).toBe(false);
  expect(rs[0].json.total.input).toBe(STD[0] * 2);
});
