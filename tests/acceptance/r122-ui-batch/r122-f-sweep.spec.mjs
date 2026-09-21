// r122 · F 组:回滚点启动清扫(INTERFACE F1–F9 / BRIEF R5)。
// 每条用例自己造现场(互不共享):宽松上限的实例经 POST /api/checkpoints 造回滚点 → 停掉 → 直接改隔离 HOME 里
// meta.json 的修改时间(F1:"活动"以它为准)→ 用严上限 + 短延迟重启 → 之后不再发任何 POST,只观察
// GET /api/checkpoints/:sid、GET /api/checkpoints-stats(F2)与服务日志。夹具极小(一个几十字节的文件,每会话一个 ~30KB 的 git 仓)。
// 「修前」= 当前代码没有启动清扫:超限会话永远不动、日志里没有汇总行。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fHome, startInstance, stopAll, req, listOf, statsOf, metaPath } from './helpers/instance.mjs';

const LIMIT = 3;
const OVER_N = 8;                      // 超限会话的条数 → 应回收 OVER_N - LIMIT = 5 条
const RECLAIM = OVER_N - LIMIT;
const DELAY = 1500;                    // 严实例的清扫延迟(ms)
const HOUR = 3_600_000;
const sid = (n) => `f122${String(n).padStart(4, '0')}-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
const OVER = sid(1); const UNDER_A = sid(2); const UNDER_B = sid(3); const ACTIVE = sid(4); const STALE30 = sid(5);

const LENIENT = { CGUI_CHECKPOINT_SWEEP: '0', CGUI_CHECKPOINT_MAX_COUNT: '50', CGUI_CHECKPOINT_RETENTION_DAYS: '30', CGUI_CHECKPOINT_MAX_TOTAL_BYTES: '104857600', CGUI_ALLOW_TINY_CHECKPOINT_RETENTION: '1' };
const STRICT = { CGUI_CHECKPOINT_MAX_COUNT: String(LIMIT), CGUI_CHECKPOINT_RETENTION_DAYS: '30', CGUI_CHECKPOINT_MAX_TOTAL_BYTES: '104857600', CGUI_ALLOW_TINY_CHECKPOINT_RETENTION: '1', CGUI_CHECKPOINT_SWEEP_DELAY_MS: String(DELAY) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shas = (entries) => (entries || []).map((e) => e.sha);
const bothWords = (line) => /checkpoints/i.test(line) && /sweep/i.test(line);
const summaryLines = (log) => log.split('\n').filter(bothWords);

test.afterEach(async () => { await stopAll(); });

/** 经宽松实例给某会话造 n 条回滚点(每次改一下小文件,和用户回滚了几次等价)。 */
async function seed(base, ws, s, n) {
  for (let i = 0; i < n; i += 1) {
    fs.writeFileSync(path.join(ws, 'note.txt'), `${s.slice(0, 8)} #${i}\n`);
    const r = await req(base, 'POST', '/api/checkpoints', { sessionId: s, cwd: ws });
    expect(r.status, `造回滚点失败:${r.text.slice(0, 200)}`).toBe(200);
  }
}

/**
 * 造现场并起严实例。sessions: [{ s, n, ageMs }],ageMs = 把 meta.json 的修改时间改到多久之前(不给 = 保持刚才的"现在")。
 * 返回:严实例句柄、清扫前各会话的列表、meta.json 的原始字节、HOME 目录。
 */
async function scenario(slug, sessions, strictEnv = {}) {
  const dirs = fHome(slug);
  const lenient = await startInstance(dirs, LENIENT, { label: 'lenient' });
  for (const { s, n } of sessions) await seed(lenient.base, dirs.ws, s, n);
  const before = {};
  for (const { s } of sessions) before[s] = await listOf(lenient.base, s);
  await lenient.stop();
  for (const { s, n, ageMs } of sessions) {
    expect(before[s]?.length, `前提:${s.slice(0, 8)} 造出了 ${n} 条`).toBe(n);
    if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(metaPath(dirs.home, s), t, t); }
  }
  const metaBytes = Object.fromEntries(sessions.map(({ s }) => [s, fs.readFileSync(metaPath(dirs.home, s))]));
  const strict = await startInstance(dirs, { ...STRICT, ...strictEnv }, { label: 'strict' });
  return { dirs, strict, before, metaBytes };
}

/** 等某会话的条数降到 limit(= 清扫确实动过它);超时返回 false,不抛。 */
async function waitReclaimed(base, s, limit, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await listOf(base, s);
    if (Array.isArray(list) && list.length <= limit) return true;
    await sleep(200);
  }
  return false;
}

const MAIN = () => [
  { s: OVER, n: OVER_N, ageMs: HOUR },       // 超限 + 1 小时前活动 → 该被回收
  { s: UNDER_A, n: 1, ageMs: HOUR },         // 未超限 → 一个不动
  { s: UNDER_B, n: 2, ageMs: HOUR },         // 未超限 → 一个不动
  { s: ACTIVE, n: OVER_N },                  // 超限但刚活动过(窗口 10 分钟内)→ 跳过
];

// ───────────────────────── F3 超限会话被回收 ─────────────────────────

test('F3 超限会话被回收:重启后不再 POST,延迟过后条数降到上限、最新几条仍在、stats 同步', async () => {
  const { strict, before } = await scenario('f3-reclaim', MAIN());
  expect(await waitReclaimed(strict.base, OVER, LIMIT), `延迟 ${DELAY}ms 过后,超限会话应从 ${OVER_N} 条降到 ${LIMIT} 条(15s 内没降)`).toBe(true);
  const after = await listOf(strict.base, OVER);
  expect(after.length, '条数应恰好等于上限').toBe(LIMIT);
  expect(shas(after), '保留的应是最新的几条(从最旧开始回收)').toEqual(shas(before[OVER]).slice(0, LIMIT));
  expect(shas(after)[0], '最新一条仍在').toBe(shas(before[OVER])[0]);
  await expect.poll(async () => (await statsOf(strict.base, OVER))?.count, { timeout: 10_000, message: 'checkpoints-stats 里该会话的 count 应同步' }).toBe(LIMIT);
});

test('F3/F1 延迟契约:CGUI_CHECKPOINT_SWEEP_DELAY_MS 未到之前不动,到了才回收', async () => {
  const LONG = 3000;
  const { strict } = await scenario('f3-delay', [{ s: OVER, n: OVER_N, ageMs: HOUR }], { CGUI_CHECKPOINT_SWEEP_DELAY_MS: String(LONG) });
  const sinceSpawn = strict.healthyAt - strict.spawnedAt;
  if (sinceSpawn < LONG - 800) {
    await sleep(200);
    expect((await listOf(strict.base, OVER)).length, `启动后 ${sinceSpawn + 200}ms(延迟 ${LONG}ms 未到)不该动`).toBe(OVER_N);
  } else {
    console.log(`[F3-延迟] 实例 ${sinceSpawn}ms 才就绪,"延迟未到"这一半没法观察,只验"到了才回收"`);
  }
  expect(await waitReclaimed(strict.base, OVER, LIMIT, LONG + 12_000), '延迟到了之后应回收到上限').toBe(true);
});

// ───────────────────────── F4 未超限会话不动 ─────────────────────────

test('F4 未超限会话不动:清扫前后列表逐条相同、meta.json 逐字节相同、stats 不变', async () => {
  const { strict, before, metaBytes, dirs } = await scenario('f4-untouched', MAIN());
  const swept = await waitReclaimed(strict.base, OVER, LIMIT, 12_000);
  console.log(`[F4] 哨兵(超限会话被回收)是否观察到:${swept}(没观察到 = 现状没有清扫,以下断言按固定等待后的状态判)`);
  if (!swept) await sleep(DELAY + 3_000);
  for (const [s, n] of [[UNDER_A, 1], [UNDER_B, 2]]) {
    expect(await listOf(strict.base, s), `${s.slice(0, 8)} 的列表应逐条相同`).toEqual(before[s]);
    expect(fs.readFileSync(metaPath(dirs.home, s)).equals(metaBytes[s]), `${s.slice(0, 8)} 的 meta.json 应逐字节相同`).toBe(true);
    expect((await statsOf(strict.base, s))?.count, `${s.slice(0, 8)} 在 stats 里的 count 不变`).toBe(n);
  }
});

// ───────────────────────── F5 近期活动跳过 / F1 窗口可调 ─────────────────────────

test('F5 近期活动跳过:超限但 meta.json 落在活动窗口内的会话,清扫过后条数不变', async () => {
  const { strict, before, metaBytes, dirs } = await scenario('f5-active', MAIN());
  expect(await waitReclaimed(strict.base, OVER, LIMIT), '前提:清扫确实发生了(超限且不活跃的会话被回收)').toBe(true);
  await sleep(1_000);   // 让同一轮清扫走完
  expect((await listOf(strict.base, ACTIVE)).length, '活动窗口内的超限会话应被跳过,条数不变').toBe(OVER_N);
  expect(await listOf(strict.base, ACTIVE)).toEqual(before[ACTIVE]);
  expect(fs.readFileSync(metaPath(dirs.home, ACTIVE)).equals(metaBytes[ACTIVE]), '被跳过的会话 meta.json 不动').toBe(true);
});

test('F5/F1 窗口可调:CGUI_CHECKPOINT_SWEEP_IDLE_MS=1000 时,30 秒前活动的超限会话不算"近期",会被回收', async () => {
  const { strict } = await scenario('f5-idle', [{ s: STALE30, n: OVER_N, ageMs: 30_000 }], { CGUI_CHECKPOINT_SWEEP_IDLE_MS: '1000' });
  expect(await waitReclaimed(strict.base, STALE30, LIMIT), '窗口缩到 1 秒后,30 秒前活动的会话应被回收到上限').toBe(true);
});

// ───────────────────────── F6 关闭开关 ─────────────────────────

test('F6 CGUI_CHECKPOINT_SWEEP=0:超限会话不被回收,日志里也没有清扫汇总', async () => {
  const { strict, before } = await scenario('f6-off', [{ s: OVER, n: OVER_N, ageMs: HOUR }], { CGUI_CHECKPOINT_SWEEP: '0' });
  await sleep(DELAY + 5_000);
  expect(await listOf(strict.base, OVER), '关闭清扫时列表一条不少').toEqual(before[OVER]);
  expect((await statsOf(strict.base, OVER))?.count).toBe(OVER_N);
  expect(summaryLines(strict.log()), '关闭清扫时不该有含 checkpoints+sweep 的汇总行').toEqual([]);
});

// ───────────────────────── F7 不阻塞 ─────────────────────────

test('F7 不阻塞:清扫窗口内连续探测 health 与列表接口,每次都在 2 秒内返回(6 个超限会话)', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ s: sid(10 + i), n: OVER_N, ageMs: HOUR }));
  const { strict } = await scenario('f7-nonblock', [...many, { s: UNDER_A, n: 1, ageMs: HOUR }]);
  const until = strict.healthyAt + DELAY + 3_000;
  let worst = { health: 0, list: 0 }; let n = 0;
  while (Date.now() < until) {
    const h = await req(strict.base, 'GET', '/api/health');
    const l = await req(strict.base, 'GET', `/api/checkpoints/${many[0].s}`);
    expect(h.status, 'health 应正常响应').toBe(200);
    expect(l.status, '列表接口应正常响应').toBe(200);
    worst = { health: Math.max(worst.health, h.ms), list: Math.max(worst.list, l.ms) };
    n += 1;
    await sleep(30);
  }
  console.log(`[F7] 窗口内探测 ${n} 轮,最慢:health ${worst.health}ms / 列表 ${worst.list}ms`);
  expect(worst.health, 'health 最慢一次也应在 2 秒内').toBeLessThan(2_000);
  expect(worst.list, '列表接口最慢一次也应在 2 秒内').toBeLessThan(2_000);
  for (const { s } of many) expect((await listOf(strict.base, s)).length, `前提:窗口结束时 ${s.slice(0, 8)} 已被回收(否则"期间不阻塞"无从谈起)`).toBe(LIMIT);
});

test('F7 不阻塞启动:延迟设为 0(启动即扫),health 仍很快就绪、列表接口 2 秒内返回', async () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ s: sid(20 + i), n: OVER_N, ageMs: HOUR }));
  const { strict } = await scenario('f7-startup', many, { CGUI_CHECKPOINT_SWEEP_DELAY_MS: '0' });
  const boot = strict.healthyAt - strict.spawnedAt;
  console.log(`[F7-启动] 起进程到 health 就绪 ${boot}ms`);
  expect(boot, '启动即扫也不得拖慢就绪(10 秒内)').toBeLessThan(10_000);
  const l = await req(strict.base, 'GET', `/api/checkpoints/${many[0].s}`);
  expect(l.status).toBe(200);
  expect(l.ms, '就绪后第一次列表请求应在 2 秒内返回').toBeLessThan(2_000);
  expect(await waitReclaimed(strict.base, many[0].s, LIMIT), '前提:清扫确实跑了').toBe(true);
});

// ───────────────────────── F8 日志汇总 ─────────────────────────

test('F8 日志:清扫后服务输出里有一行同时含 checkpoints 与 sweep 的汇总,含扫描会话数与回收条数', async () => {
  const { strict } = await scenario('f8-log', MAIN());
  await waitReclaimed(strict.base, OVER, LIMIT);
  await sleep(1_500);   // 汇总行在清扫结束时写,给它一点落盘时间
  const lines = summaryLines(strict.log());
  expect(lines.length, `日志里应有含 checkpoints+sweep 的汇总行(实际 0 行)。日志尾部:\n${strict.log().split('\n').slice(-8).join('\n')}`).toBeGreaterThan(0);
  const hit = lines.find((l) => new RegExp(`\\b${RECLAIM}\\b`).test(l) && (/\b4\b/.test(l) || /\b3\b/.test(l)));
  expect(hit, `汇总行应含回收条数 ${RECLAIM} 与扫描会话数(4 个目录;若不计被跳过的则为 3)。实际:\n${lines.join('\n')}`).toBeTruthy();
});

// ───────────────────────── F9 只扫一遍 ─────────────────────────

test('F9 只扫一遍:清扫完再等一个延迟周期,不再出现新的汇总行,条数也不再变化', async () => {
  const { strict } = await scenario('f9-once', MAIN());
  await waitReclaimed(strict.base, OVER, LIMIT);
  await sleep(1_500);
  const n1 = summaryLines(strict.log()).length;
  const count1 = (await listOf(strict.base, OVER)).length;
  expect(n1, '前提:第一遍清扫应留下汇总行').toBeGreaterThan(0);
  await sleep(DELAY * 2 + 2_500);
  expect(summaryLines(strict.log()).length, '再等一个延迟周期,不该多出新的 checkpoints+sweep 行(= 没扫第二遍)').toBe(n1);
  expect((await listOf(strict.base, OVER)).length, '条数不再变化').toBe(count1);
});

// ───────────────────────── 自证:严上限与观察口不是空转 ─────────────────────────

test('自证·严上限被实例认了、观察口看得见回收:严实例里再拍一次快照,既有的"拍快照时回收"把超限会话收到上限', async () => {
  // r120 的既有行为:某会话下次拍快照时按上限回收。用它证明 MAX_COUNT=3 这组环境变量确实生效、
  // listOf/statsOf 能观察到"条数降到上限"—— 否则 F3 的红可能只是环境变量名写错。
  const { strict, before, dirs } = await scenario('self-proof', [{ s: OVER, n: OVER_N, ageMs: HOUR }], { CGUI_CHECKPOINT_SWEEP: '0' });
  fs.writeFileSync(path.join(dirs.ws, 'note.txt'), 'self-proof extra snapshot\n');
  const r = await req(strict.base, 'POST', '/api/checkpoints', { sessionId: OVER, cwd: dirs.ws });
  expect(r.status, `严实例里拍快照失败:${r.text.slice(0, 200)}`).toBe(200);
  expect(await waitReclaimed(strict.base, OVER, LIMIT, 10_000), '拍快照路径应把该会话收到上限(证明严上限生效、观察口有效)').toBe(true);
  const after = await listOf(strict.base, OVER);
  expect(after.length).toBe(LIMIT);
  expect(shas(after)[0], '最新一条(刚拍的)在最前').toBe(r.json.sha);
  expect(shas(after).slice(1), '其余保留的是原来最新的几条').toEqual(shas(before[OVER]).slice(0, LIMIT - 1));
  await expect.poll(async () => (await statsOf(strict.base, OVER))?.count, { timeout: 10_000 }).toBe(LIMIT);
});
