#!/usr/bin/env node
// r142-附1 —— Windows 显式前台(全局投递)的**回执按事实分叉**(裁定 2 的配套验收)。
//
// 背景(为什么必须有这条):Windows 上 `GetForegroundWindow` 在某些场景拿不到前台窗口,所以显式
// 前台动作的判据放宽成"拿得到就严格比对 pid,拿不到就按用户显式同意执行"。放宽本身没问题,
// **但回执不能把没核验的事写成结论**:原来的实现无论有没有核验过,都写"目标窗口被切到前台 /
// 向当前前台目标 X 输入"。用户据此会以为目标真的在前台,而实际可能不是。
//
// 这条用例锁三件事(都有牙):
//   ① 拿不到 frontmost 时:5 个副作用工具仍然成功走 `--method global`,但回执必须明说
//      「未能核验目标是否为当前前台(全局投递已按你的显式同意执行)」,且**不得**出现
//      「目标窗口被切到前台 / 当前前台目标 / 已影响用户前台」这类确定性措辞。
//      ⇒ 删掉 `foregroundTargetOk` 的 Windows 分支会红(那时回执变成 CU_TARGET_CHANGED);
//        只把文案改回确定性措辞也会红(否定断言)。
//   ② 拿得到 frontmost 且匹配时:回执写「已核验:目标就是当前前台窗口」,不写"未能核验"。
//   ③ 拿得到 frontmost 但不匹配时:仍然 CU_TARGET_CHANGED,零全局投递
//      —— 证明"放宽"没有把校验整个删掉(反向守卫)。
//   ④ mac 回归:mac 侧的前台回执仍是原文(「全局事件已影响用户前台」),mac 一字未改。
//
// 口径说明(为什么这么写、语义有没有放宽):本文件只**新增**观测 Win32 回执文本与 `--method global`
// 的断言,不改任何既有用例的判据;产品侧放宽的是"核验不到时是否放行",这条用例把"放行时必须如实
// 说没核验"钉死,语义是**收紧**回执口径,不是放宽。
//
// 跑法:node tests/unit/check-cu-win-foreground-receipt.mjs
import assert from 'node:assert/strict';
import { makeReport } from './q8-helpers/report.mjs';
import { GRANTED, grantedWindow, makeWinHome, startWinMcp } from './r142-helpers/win-fixture.mjs';

const report = makeReport('check-cu-win-foreground-receipt');
const TARGET = { bundleId: GRANTED.bundleId, pid: GRANTED.pid, windowId: GRANTED.windowId };
const UNVERIFIED = '未能核验目标是否为当前前台';
const VERIFIED = '已核验:目标就是当前前台窗口';
// 未核验时**不许**出现的确定性措辞(Win32 回执里)
const DETERMINISTIC = ['目标窗口被切到前台', '当前前台目标', '已影响用户前台'];

/** 五个副作用工具的前台调用(坐标都落在截图内:imgW=100 × imgH=50)。 */
const CALLS = [
  ['left_click', { x: 10, y: 10 }, '单击'],
  ['drag', { x1: 10, y1: 10, x2: 20, y2: 20 }, '拖拽'],
  ['scroll', { x: 10, y: 10 }, '滚轮'],
  ['type', { text: 'AB' }, '输入'],
  ['key', { keys: 'a' }, '按键'],
];

async function withWinMcp(name, windowsReply, fn) {
  const fake = makeWinHome(name);
  fake.setGrants({ apps: [GRANTED.bundleId] });
  fake.setScenario({ windows: { reply: windowsReply } });
  const mcp = await startWinMcp(fake);
  try {
    const shot = await mcp.call('screenshot', {}, 30_000);
    assert.equal(shot.isError, false, `前置截图失败:${JSON.stringify(shot.sc)}`);
    return await fn(mcp, fake);
  } finally {
    mcp.kill();
  }
}

/** 依次跑 5 个前台调用,返回 [{name, receipt, methods}]。 */
async function runForeground(mcp, fake, tag) {
  const out = [];
  for (const [name, extra] of CALLS) {
    const actionId = `r142fg_${tag}_${name}`;
    const r = await mcp.call(name, { actionId, target: TARGET, foreground: true, ...extra }, 40_000)
      .catch((e) => ({ error: String(e) }));
    out.push({ name, r, methods: fake.methodsSeen() });
  }
  return out;
}

// ── F-01 拿不到 frontmost:放行 + 回执如实说"未能核验"(修前红)──────────
{
  const results = await withWinMcp('t9-unverified', { ok: true, frontmost: null, windows: [grantedWindow()] },
    (mcp, fake) => runForeground(mcp, fake, 'unv'));
  await report.check('F-01', 'Windows 拿不到 frontmost:全局投递照常执行,但回执必须写明"未能核验前台"且不得给确定性结论', 'red', () => {
    for (const { name, r, methods } of results) {
      assert.ok(!r.error, `${name} 调用本身报错:${r.error}`);
      assert.equal(r.isError, false,
        `${name} 在"拿不到 frontmost"时被判成失败(${r.sc?.code}) —— 这正是裁定 2 要放行的场景`);
      assert.ok(methods.includes('global'),
        `${name} 没走全局投递(helper 收到的 --method:${JSON.stringify(methods)})`);
      const text = String(r.text || '');
      assert.ok(text.includes(UNVERIFIED),
        `${name} 的回执没明说"${UNVERIFIED}"(实际:${text.slice(0, 200)})`);
      assert.ok(text.includes('全局投递已按你的显式同意执行'),
        `${name} 的回执没说清"是按你的显式同意执行的"(实际:${text.slice(0, 200)})`);
      for (const bad of DETERMINISTIC) {
        assert.ok(!text.includes(bad),
          `${name} 的回执在**没有核验过**前台的情况下写了确定性结论「${bad}」:${text.slice(0, 200)}`);
      }
    }
  });
}

// ── F-02 拿得到 frontmost 且匹配:回执写明"已核验"(修前红)────────────
{
  const frontmost = { pid: GRANTED.pid, name: GRANTED.name, bundleId: GRANTED.bundleId };
  const results = await withWinMcp('t9-verified', { ok: true, frontmost, windows: [grantedWindow()] },
    (mcp, fake) => runForeground(mcp, fake, 'ver'));
  await report.check('F-02', 'Windows 拿到了 frontmost 且匹配:回执写明"已核验:目标就是当前前台窗口",不写"未能核验"', 'red', () => {
    for (const { name, r } of results) {
      assert.equal(r.isError, false, `${name} 失败:${JSON.stringify(r.sc)}`);
      const text = String(r.text || '');
      assert.ok(text.includes(VERIFIED), `${name} 的回执没写明已核验(实际:${text.slice(0, 200)})`);
      assert.ok(!text.includes(UNVERIFIED), `${name} 明明核验过了却写"未能核验":${text.slice(0, 200)}`);
    }
  });
}

// ── F-03 反向守卫:拿到 frontmost 但不匹配 ⇒ 仍 CU_TARGET_CHANGED、零全局投递(修前绿)──
{
  const frontmost = { pid: 999_999, name: 'OtherApp', bundleId: 'C:\\Other\\other.exe' };
  const results = await withWinMcp('t9-mismatch', { ok: true, frontmost, windows: [grantedWindow()] },
    (mcp, fake) => runForeground(mcp, fake, 'mis'));
  await report.check('F-03', 'Windows 拿到 frontmost 但不匹配:仍然 CU_TARGET_CHANGED 且一次全局投递都没有(放宽≠删掉校验)', 'green', () => {
    for (const { name, r, methods } of results) {
      assert.equal(r.isError, true, `${name} 目标与前台不符却回了成功回执:${JSON.stringify(r.sc)}`);
      assert.equal(r.sc?.code, 'CU_TARGET_CHANGED', `${name} 的失败码是 ${r.sc?.code},应为 CU_TARGET_CHANGED`);
      assert.ok(!methods.includes('global'),
        `${name} 在目标与前台不符时仍走了全局投递(--method:${JSON.stringify(methods)})`);
    }
  });
}

// ── F-04 mac 回归:macOS 前台回执仍是原文(mac 一字未改)──────────────
{
  const macH = await import('./q8-helpers/cu-harness.mjs');
  const fake = macH.makeFakeHome('r142-mac-foreground');
  fake.setGrants({ apps: [macH.GRANTED.bundleId] });
  fake.setScenario({
    windows: { reply: { ok: true, frontmost: { pid: macH.GRANTED.pid, name: macH.GRANTED.name, bundleId: macH.GRANTED.bundleId },
      windows: [macH.grantedWindow()] } },
  });
  const mac = await macH.startMcp(fake);
  const r = await mac.call('key', { actionId: 'r142fg_mac', target: macH.TARGET, keys: 'a', foreground: true }, 30_000)
    .catch((e) => ({ error: String(e) }));
  mac.kill();
  await report.check('F-04', 'macOS 回归:前台按键回执仍是「向当前前台目标 …;全局事件已影响用户前台。」,mac 措辞一字未改', 'green', () => {
    assert.equal(r.isError, false, `mac 前台按键失败:${JSON.stringify(r.sc || r.error)}`);
    const text = String(r.text || '');
    assert.ok(text.includes('当前前台目标') && text.includes('全局事件已影响用户前台'),
      `mac 的前台回执措辞变了(mac 判据严格、必然已核验,不该跟着 Windows 改):${text.slice(0, 200)}`);
    assert.ok(!text.includes(UNVERIFIED), `mac 回执出现了 Windows 的"未能核验"措辞:${text.slice(0, 200)}`);
  });
}

process.exit(report.finish());
