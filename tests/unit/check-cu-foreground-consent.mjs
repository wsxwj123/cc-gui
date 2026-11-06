#!/usr/bin/env node
// C2 / 前台授权闸门(MCP 侧):模型直接传 foreground:true 时,只有该应用带未过期的
// 前台授权才放行;否则在登记 actionId 之前零投递地拒绝(C2-T1..T10)。
//
// 全部走 q8-helpers 的假家目录夹具(假 python3 桩),不启动应用、不碰真实 ~/.claude-gui、
// 不做任何前台/鼠标/键盘动作。
//
// 跑法:node tests/unit/check-cu-foreground-consent.mjs
import assert from 'node:assert/strict';
import { makeReport, waitFor } from './q8-helpers/report.mjs';
import { GRANTED, grantedWindow, makeFakeHome, startMcp, TARGET } from './q8-helpers/cu-harness.mjs';

const report = makeReport('check-cu-foreground-consent');
const A = GRANTED.bundleId;
const B = 'com.example.other';
const FUTURE = new Date(Date.now() + 30 * 60_000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

const CLICK = { x: 10, y: 10, foreground: true };
const clickArgs = (actionId, extra = {}) => ({ actionId, target: TARGET, ...CLICK, ...extra });

async function withMcp(fake, fn) {
  const mcp = await startMcp(fake);
  try { return await fn(mcp, fake); } finally { mcp.kill(); }
}

function fakeFor(name, grantsOpts, scenario = {}) {
  const fake = makeFakeHome(name);
  fake.setGrants(grantsOpts);
  fake.setScenario({ windows: { reply: { ok: true, frontmost: null, windows: [grantedWindow()] } }, ...scenario });
  return fake;
}

const consentCode = (r) => r?.sc?.code === 'CU_FOREGROUND_CONSENT_REQUIRED';

// ── C2-T1 模型直接传 foreground:true,只有应用授权 ──
{
  const fake = fakeFor('t1-no-consent', { apps: [A] });
  const r = await withMcp(fake, (mcp) => mcp.call('left_click', clickArgs('c2_t1'), 40_000));
  const argv = fake.argv();
  await report.check('C2-T1', '模型传 foreground:true 而应用无前台授权 → CU_FOREGROUND_CONSENT_REQUIRED,且零投递', 'red', () => {
    assert.equal(r?.isError, true, `回了成功回执:${JSON.stringify(r?.sc)}`);
    assert.equal(r?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', `错误码 ${r?.sc?.code}`);
    assert.equal(argv.length, 0, `被拒绝的请求调了 helper:${JSON.stringify(argv)}`);
  });
}

// ── C2-T2 旧形态 grants.json(没有 foreground 字段)= 默认不允许前台 ──
{
  const fake = fakeFor('t2-legacy', { apps: [A] });
  const r = await withMcp(fake, (mcp) => mcp.call('left_click', clickArgs('c2_t2'), 40_000));
  await report.check('C2-T2', '旧形态授权(无 foreground 字段)默认不允许前台', 'red', () => {
    assert.equal(r?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', `错误码 ${r?.sc?.code}`);
  });
}

// ── C2-T3 前台授权已过期 ──
{
  const fake = fakeFor('t3-expired', { apps: [A], foreground: { [A]: PAST } });
  const r = await withMcp(fake, (mcp) => mcp.call('left_click', clickArgs('c2_t3'), 40_000));
  await report.check('C2-T3', 'foreground.expiresAt 已过期 → 拒绝', 'red', () => {
    assert.equal(r?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', `错误码 ${r?.sc?.code}`);
  });
}

// ── C2-T4 foreground 形状非法(布尔 / 字符串 / 缺 expiresAt / 对象)──
{
  const bad = [true, 'abc', {}, { grantedAt: new Date().toISOString() }, { expiresAt: { x: 1 } }];
  const results = [];
  for (let i = 0; i < bad.length; i += 1) {
    const fake = fakeFor(`t4-bad-${i}`, { apps: [A], foregroundRaw: { [A]: bad[i] } });
    const r = await withMcp(fake, (mcp) => mcp.call('left_click', clickArgs(`c2_t4_${i}`), 40_000));
    results.push({ i, code: r?.sc?.code, isError: r?.isError, argv: fake.argv().length });
  }
  await report.check('C2-T4', 'foreground 形状非法 → 一律按未授权拒绝,进程不崩', 'red', () => {
    for (const x of results) {
      assert.equal(x.code, 'CU_FOREGROUND_CONSENT_REQUIRED', `形状#${x.i} 的错误码是 ${x.code}`);
      assert.equal(x.argv, 0, `形状#${x.i} 竟然调了 helper`);
    }
  });
}

// ── C2-T5 未过期的前台授权 → 闸门放行 ──
{
  const fake = fakeFor('t5-granted', { apps: [A], foreground: { [A]: FUTURE } });
  const r = await withMcp(fake, (mcp) => mcp.call('left_click', clickArgs('c2_t5'), 40_000));
  const clicks = fake.argv().filter((e) => e.subcmd === 'click');
  await report.check('C2-T5', '未过期的前台授权 → 不再返回 consent 码;若走到 helper,不得带后台定向参数', 'green', () => {
    assert.notEqual(r?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', '有前台授权仍被闸门拒绝');
    for (const c of clicks) {
      assert.ok(!c.args.includes('--background-pid'),
        `前台授权放行后仍走了后台定向投递:${JSON.stringify(c.args)}`);
    }
  });
}

// ── C2-T6 按应用隔离 ──
{
  const fake = fakeFor('t6-isolation', { apps: [A, B], foreground: { [A]: FUTURE } });
  const B_TARGET = { bundleId: B, pid: 4243, windowId: 5002 };
  const rB = await withMcp(fake, (mcp) => mcp.call('left_click', { ...clickArgs('c2_t6b'), target: B_TARGET }, 40_000));
  const rA = await withMcp(fake, (mcp) => mcp.call('left_click', clickArgs('c2_t6a'), 40_000));
  await report.check('C2-T6', 'A 有前台授权、B 没有:对 B 拒绝,对 A 放行', 'red', () => {
    assert.equal(rB?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', `B 没被拒:${rB?.sc?.code}`);
    assert.notEqual(rA?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', 'A 被误拒');
  });
}

// ── C2-T7 应用未授权 + foreground:true → 仍是 CU_APP_NOT_ALLOWED ──
{
  const fake = fakeFor('t7-app-not-allowed', { apps: [] });
  const r = await withMcp(fake, (mcp) => mcp.call('left_click', clickArgs('c2_t7'), 40_000));
  await report.check('C2-T7', '应用未授权 + foreground:true → 仍按无权应用处理(不是新码),零投递', 'green', () => {
    assert.notEqual(r?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', '把前台开关暴露给了未授权应用');
    assert.equal(fake.argv().length, 0, `未授权应用被投递了:${JSON.stringify(fake.argv())}`);
  });
}

// ── C2-T8 禁止类别应用即便带 foreground 也拒绝 ──
{
  const FORBIDDEN_ID = 'com.apple.Terminal';
  const fake = fakeFor('t8-forbidden', { apps: [FORBIDDEN_ID], foreground: { [FORBIDDEN_ID]: FUTURE } });
  const r = await withMcp(fake, (mcp) => mcp.call('left_click', {
    ...clickArgs('c2_t8'), target: { bundleId: FORBIDDEN_ID, pid: 4244, windowId: 5003 },
  }, 40_000));
  await report.check('C2-T8', '禁止类别应用带前台授权仍被拒(名单优先于前台授权)', 'green', () => {
    assert.notEqual(r?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', '禁止类别被前台授权放行了');
    assert.equal(fake.argv().length, 0, `禁止类别应用被投递了:${JSON.stringify(fake.argv())}`);
  });
}

// ── C2-T9 拒绝不登记 actionId;写入授权后用新 id 重试成功 ──
{
  const fake = fakeFor('t9-retry', { apps: [A] });
  const first = await withMcp(fake, (mcp) => mcp.call('left_click', clickArgs('c2_t9_old'), 40_000));
  const st = await withMcp(fake, (mcp) => mcp.call('action_status', { actionId: 'c2_t9_old' }));
  fake.setGrants({ apps: [A], foreground: { [A]: FUTURE } });
  const retry = await withMcp(fake, (mcp) => mcp.call('left_click', clickArgs('c2_t9_new'), 40_000));
  await report.check('C2-T9', '拒绝那次不登记 actionId(旧 id 查不到);授权后用新 id 重试不再被拒', 'red', () => {
    assert.equal(first?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', '首次没有被拒');
    assert.equal(st?.sc?.code, 'CU_ACTION_NOT_FOUND', `被拒绝的动作登记了 actionId:${st?.sc?.code}`);
    assert.notEqual(retry?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', '授权后仍被拒');
  });
}

// ── C2-T10 foreground 省略 / false 的后台路径与现状一致 ──
{
  const fake = fakeFor('t10-background', { apps: [A] });
  const r1 = await withMcp(fake, (mcp) => mcp.call('left_click', { actionId: 'c2_t10a', target: TARGET, x: 10, y: 10 }, 40_000));
  const r2 = await withMcp(fake, (mcp) => mcp.call('left_click', { actionId: 'c2_t10b', target: TARGET, x: 10, y: 10, foreground: false }, 40_000));
  const methods = fake.argv().filter((e) => e.subcmd === 'click').flatMap((e) => {
    const i = e.args.indexOf('--method'); return i >= 0 ? [e.args[i + 1]] : [];
  });
  await report.check('C2-T10', 'foreground 省略/false 的后台路径不变:不出现 consent 码,也不出现全局投递', 'green', () => {
    assert.notEqual(r1?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', '省略 foreground 被当成前台请求');
    assert.notEqual(r2?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', 'foreground:false 被当成前台请求');
    assert.ok(!methods.includes('global'), `后台路径出现全局投递:${JSON.stringify(methods)}`);
  });
}

// ── 排队期间的复查(安全审计发现:闸门只在入队时查一次,动作排队等待期间授权变了照样执行)──
// 做法:第一个后台动作(ax-key 假执行层睡 1.8 秒)占着队列,第二个 foreground:true 的动作
// 入队时授权状态合规 → 过入队闸门排在后面;排队期间改授权表,再看第二个动作执行前有没有复查。
const FRONTMOST_A = { pid: GRANTED.pid, name: GRANTED.name, bundleId: GRANTED.bundleId };
const B_WIN = { id: 5002, pid: 4243, app: 'Other', bundleId: B, title: 'Other Doc', bounds: { x: 10, y: 20, w: 300, h: 200 }, displayId: 1 };
const B_TARGET = { bundleId: B, pid: 4243, windowId: 5002 };
const globalKeys = (fake) => fake.argv().filter((e) => e.subcmd === 'key'); // 前台(全局)按键才会调 key 子命令

/** 先发一个慢的后台动作占住队列,等它真的开始执行,再发前台动作入队;等到前台动作确实已登记并在排队
 *  (= 过了入队闸门)才调 duringWait()(改授权表)。不用固定 sleep:机器慢时入队闸门可能晚于改授权表,
 *  用例会靠入队闸门"假绿",根本没测到执行前复查。返回 { r: 前台动作的回执, queued: 它是否真的排上了队 }。 */
async function queuedForegroundCall(fake, { target, actionId, duringWait }) {
  return withMcp(fake, async (mcp) => {
    const slow = mcp.call('key', { actionId: `${actionId}_slow`, target: TARGET, keys: 'a' }, 40_000);
    await waitFor(() => fake.argv().some((e) => e.subcmd === 'ax-key'), { timeoutMs: 15_000 }); // 慢动作已在执行
    const fg = mcp.call('key', { actionId, target, keys: 'b', foreground: true }, 40_000);
    const queued = Boolean(await waitFor(
      async () => (await mcp.call('action_status', { actionId })).sc?.state === 'queued',
      { timeoutMs: 10_000, stepMs: 50 },
    ));
    if (queued) duringWait();
    await slow;
    return { r: await fg, queued };
  });
}

// ── C2-T11 排队期间前台授权被撤销 → 已入队的前台动作执行前复查 ──
{
  const fake = fakeFor('t11-revoke-in-queue', { apps: [A], foreground: { [A]: FUTURE } }, {
    windows: { reply: { ok: true, frontmost: FRONTMOST_A, windows: [grantedWindow()] } },
    'ax-key': { sleepMs: 1800 },
  });
  const { r, queued } = await queuedForegroundCall(fake, {
    target: TARGET, actionId: 'c2_t11', duringWait: () => fake.setGrants({ apps: [A] }), // 用户在面板关掉前台授权,应用授权还在
  });
  await report.check('C2-T11', '排队期间前台授权被撤销:已入队的前台动作执行前复查,CU_FOREGROUND_CONSENT_REQUIRED 且零投递', 'red', () => {
    assert.ok(queued, '前台动作没有排上队(入队闸门已拒绝或没登记),用例没测到执行前复查');
    assert.equal(r?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', `排队的前台动作没有被复查拦下:${r?.sc?.code}`);
    assert.equal(globalKeys(fake).length, 0, `撤销后仍发生了全局按键投递:${JSON.stringify(globalKeys(fake))}`);
  });
}

// ── C2-T12 入队时应用未授权(入队闸门不拦),排队期间只授权了应用、没开前台 → 执行前复查仍拒绝 ──
{
  const fake = fakeFor('t12-grant-app-in-queue', { apps: [A] }, {
    windows: { reply: { ok: true, frontmost: { pid: 4243, name: 'Other', bundleId: B }, windows: [grantedWindow(), B_WIN] } },
    'ax-key': { sleepMs: 1800 },
  });
  const { r, queued } = await queuedForegroundCall(fake, {
    target: B_TARGET, actionId: 'c2_t12', duringWait: () => fake.setGrants({ apps: [A, B] }), // 用户只授权了 B,没开前台
  });
  await report.check('C2-T12', '入队时应用未授权、排队期间只授权应用:执行前复查,没有前台授权就拒绝且零投递', 'red', () => {
    assert.ok(queued, '前台动作没有排上队(入队闸门已拒绝或没登记),用例没测到执行前复查');
    assert.equal(r?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', `没开前台授权的应用被前台投递了:${r?.sc?.code}`);
    assert.equal(globalKeys(fake).length, 0, `没有前台授权却发生了全局按键投递:${JSON.stringify(globalKeys(fake))}`);
  });
}

// ── C2-T13 守卫:排队期间前台授权一直有效 → 已入队的前台动作照常执行(复查不误伤)──
{
  const fake = fakeFor('t13-valid-in-queue', { apps: [A], foreground: { [A]: FUTURE } }, {
    windows: { reply: { ok: true, frontmost: FRONTMOST_A, windows: [grantedWindow()] } },
    'ax-key': { sleepMs: 1200 },
  });
  const { r, queued } = await queuedForegroundCall(fake, { target: TARGET, actionId: 'c2_t13', duringWait: () => {} });
  await report.check('C2-T13', '排队期间前台授权一直有效:已入队的前台动作照常执行', 'green', () => {
    assert.ok(queued, '前台动作没有排上队,用例没测到排队路径');
    assert.notEqual(r?.sc?.code, 'CU_FOREGROUND_CONSENT_REQUIRED', '授权有效却被复查拒绝了');
    assert.equal(globalKeys(fake).length, 1, `授权有效的排队前台动作没有执行:${JSON.stringify(globalKeys(fake))}`);
  });
}

process.exitCode = report.finish();
