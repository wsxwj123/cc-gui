// r131 · B 组:缓存版本升级路径 —— r131 把 CACHE_VERSION 从 2 升到 3(多了 byDayModel / ranges 两个根键)。
// 这一组只验**升级语义**,不重复 r130 B 组已有的回放 / tz / 坏文件 / 冷却用例(那套仍在原处跑)。
// 每条用例自己造隔离 HOME、自己起停实例。手法与 r130 B 组一致:先冷扫落盘 → 改文件 → 再起一台观察。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { caseRoot, sessionFile, writeJsonl, assistant, user, sid, tsAgo, cachePath, projectsDir, TZ } from './helpers/fixtures.mjs';
import { startInstance, stopAll, getUsage, waitFor, sleep, wsCapture, readCacheFile, sampleUsage } from './helpers/instance.mjs';

const S1 = sid(1);
test.afterEach(async () => { await stopAll(); });

const fixture = (home) => {
  writeJsonl(sessionFile(home, S1), [user({ ts: tsAgo(1, 10) }), assistant({ ts: tsAgo(1, 10, 1), model: 'r131-C0' })]);
};

async function prime(slug) {
  const { root, home } = caseRoot('b', slug);
  fixture(home);
  const one = await startInstance({ root, home }, {}, { label: `${slug}-prime` });
  const r = await getUsage(one.base);
  expect(r.status, `prime 冷扫应 200:${r.text.slice(0, 200)}`).toBe(200);
  const got = await waitFor(() => { const c = readCacheFile(cachePath(home)); return c?.json?.data ? c : null; }, { timeoutMs: 8000 });
  expect(got, '冷扫后 8 秒内应落盘').toBeTruthy();
  await one.stop();
  return { root, home, cold: r.json, file: cachePath(home), raw: got.raw };
}
const boot = (ctx, env = {}, label = 'second') => startInstance({ root: ctx.root, home: ctx.home }, env, { label });
const rewrite = (file, fn) => { const c = readCacheFile(file); fs.writeFileSync(file, JSON.stringify(fn(c.json))); };

test('B1 冷扫落盘 version 3(带 tz),data 里带 byDayModel / ranges', async () => {
  const ctx = await prime('b1-file-shape');
  const c = readCacheFile(ctx.file).json;
  expect(c.version).toBe(3);
  expect(c.tz).toBe(TZ);
  expect(typeof c.sig).toBe('string');
  expect(typeof c.scannedAt).toBe('number');
  expect(c.data.byDayModel && typeof c.data.byDayModel === 'object').toBe(true);
  expect(Object.keys(c.data.byDayModel).length, '夹具里至少一个真实日期').toBeGreaterThan(0);
  expect(Object.keys(c.data.ranges || {})).toEqual(expect.arrayContaining(['7d', '30d']));
});

test('B2 合法 v2 文件(无 byDayModel / ranges):先回放旧 data 原样 + stale=true,随后**必**重算升级(不看 sig)→ 含新根键、version 3、广播一次', async () => {
  const ctx = await prime('b2-v2-upgrade');
  // 降级成 v2 形状:去掉两个新根键(其余键逐字保留,模拟 r130 落盘的文件)
  rewrite(ctx.file, (j) => {
    const { byDayModel, ranges, ...data } = j.data;
    return { ...j, version: 2, data };
  });
  const v2raw = fs.readFileSync(ctx.file, 'utf8');
  const two = await boot(ctx);
  const cap = await wsCapture(two.port);
  const first = await getUsage(two.base);
  expect(first.status).toBe(200);
  expect(first.json.meta?.stale, 'v2 是回放,不是现算').toBe(true);
  expect('byDayModel' in first.json, '回放 v2 时不该凭空造出新根键').toBe(false);
  expect('ranges' in first.json).toBe(false);
  expect(first.json.total, '旧值原样(精确到四项与 sessionCount)').toEqual(ctx.cold.total);
  expect(first.json.overview).toEqual(ctx.cold.overview);
  // 关键:jsonl 一个字节不动,也必须升级(sig 相同不算"已是最新")
  const settled = await waitFor(async () => {
    const r = await getUsage(two.base);
    return (r.json?.meta?.stale === false && r.json.byDayModel && r.json.ranges) ? r.json : null;
  }, { timeoutMs: 8000 });
  expect(settled, '8 秒内应完成升级重算(fixture 只有一条记录)').toBeTruthy();
  expect(settled.meta.scannedAt, '必重算 → scannedAt 前进').toBeGreaterThan(first.json.meta.scannedAt);
  expect(settled.total).toEqual(ctx.cold.total);
  expect(settled.byDayModel).toEqual(ctx.cold.byDayModel);
  expect(settled.ranges).toEqual(ctx.cold.ranges);
  const c = await waitFor(() => { const x = readCacheFile(ctx.file); return x && x.raw !== v2raw && x.json?.version === 3 ? x.json : null; }, { timeoutMs: 8000 });
  expect(c, '文件应被重写成 version 3').toBeTruthy();
  expect(c.tz).toBe(TZ);
  await sleep(1500);
  expect(cap.ofType('usage-updated').length, '升级落地广播一次').toBe(1);
  cap.close();
});

test('B3 v3 文件但缺 byDayModel / ranges → 走冷路径(不信任),首请求即完整新形状且文件被覆盖', async () => {
  const ctx = await prime('b3-v3-missing-new-keys');
  rewrite(ctx.file, (j) => { const { byDayModel, ranges, ...data } = j.data; return { ...j, version: 3, tz: TZ, data }; });
  const two = await boot(ctx);
  const r = await getUsage(two.base);
  expect(r.json.meta?.stale, '形状不全的 v3 不算回放').toBe(false);
  expect(r.json.byDayModel).toEqual(ctx.cold.byDayModel);
  expect(r.json.ranges).toEqual(ctx.cold.ranges);
  const c = await waitFor(() => { const x = readCacheFile(ctx.file); return x?.json?.version === 3 && x.json.data.ranges ? x.json : null; }, { timeoutMs: 8000 });
  expect(c, '文件应被覆盖成合法 v3').toBeTruthy();
});

test('B4 v3 文件 + tz 不同 → 回放旧值(stale=true,新根键都在)→ 必重算并以新 tz 落盘', async () => {
  const ctx = await prime('b4-v3-tz');
  rewrite(ctx.file, (j) => ({ ...j, tz: 'UTC' }));
  const two = await boot(ctx);
  const first = await getUsage(two.base);
  expect(first.json.meta?.stale).toBe(true);
  expect(first.json.ranges, 'tz 不等只是"必重算",数据仍是完整的 v3 形状').toEqual(ctx.cold.ranges);
  const settled = await waitFor(async () => { const r = await getUsage(two.base); return r.json?.meta?.stale === false ? r.json : null; }, { timeoutMs: 8000 });
  expect(settled.meta.scannedAt).toBeGreaterThan(first.json.meta.scannedAt);
  expect(readCacheFile(ctx.file).json.tz).toBe(TZ);
  expect(readCacheFile(ctx.file).json.version).toBe(3);
});

test('B5 版本史不倒退:v1 文件仍走"回放 + 升级"(不因当前版本是 3 就当成不信任文件走冷路径)', async () => {
  const ctx = await prime('b5-v1-still-replayed');
  rewrite(ctx.file, (j) => {
    const { overview, byDayModel, ranges, ...data } = j.data;
    data.byDay = (data.byDay || []).map(({ sessions, messages, ...rest }) => rest);
    const { tz, ...rest } = j;
    return { ...rest, version: 1, data };
  });
  const two = await boot(ctx);
  const first = await getUsage(two.base);
  expect(first.json.meta?.stale, 'v1 仍是回放(不是冷路径)').toBe(true);
  expect('overview' in first.json).toBe(false);
  expect(first.json.total).toEqual(ctx.cold.total);
  const settled = await waitFor(async () => {
    const r = await getUsage(two.base);
    return (r.json?.meta?.stale === false && r.json.overview && r.json.ranges) ? r.json : null;
  }, { timeoutMs: 8000 });
  expect(settled, '8 秒内升级到 v3 形状').toBeTruthy();
  expect(readCacheFile(ctx.file).json.version).toBe(3);
});

test('B6 projects 目录缺失 + v2 文件:目录缺失期间既不回放升级也不落盘(文件仍 v2),目录恢复后才升级', async () => {
  const ctx = await prime('b6-v2-no-projects');
  rewrite(ctx.file, (j) => { const { byDayModel, ranges, ...data } = j.data; return { ...j, version: 2, data }; });
  const v2raw = fs.readFileSync(ctx.file, 'utf8');
  const away = `${ctx.root}/projects-away`;
  fs.renameSync(projectsDir(ctx.home), away);
  const two = await boot(ctx);
  const samples = await sampleUsage(two.base, { durationMs: 2500, intervalMs: 250 });
  for (const s of samples) {
    expect(s.status).toBe(200);
    expect(s.body.meta?.stale, `t=${s.t}ms 目录读不到时必须一直 stale`).toBe(true);
    expect('ranges' in s.body, '目录读不到 ≠ 可以拿空账升级').toBe(false);
  }
  expect(fs.readFileSync(ctx.file, 'utf8'), '目录缺失期间文件原样(v2)').toBe(v2raw);
  fs.renameSync(away, projectsDir(ctx.home));
  const settled = await waitFor(async () => {
    const r = await getUsage(two.base);
    return (r.json?.meta?.stale === false && r.json.ranges) ? r.json : null;
  }, { timeoutMs: 8000 });
  expect(settled, '目录恢复后 8 秒内升级').toBeTruthy();
  expect(readCacheFile(ctx.file).json.version).toBe(3);
});
