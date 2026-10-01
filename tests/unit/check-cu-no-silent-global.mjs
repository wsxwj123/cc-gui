#!/usr/bin/env node
// r142 / T-7 —— "绝不静默抢前台"(§2.2 修订判据 + §2.3 降级链 + §4.1 effect 字段)。
// 伪 win32 真跑:桩 helper 按剧本回"UIA 失败 / 消息投递成功 / 消息投递失败",看 Node 侧的降级链怎么落。
//
// 核心断言只有一条,但它是整个方案的地基:**没给 foreground:true 时,helper 调用里永远不许出现全局投递**。
// 这条不看文案、不看代码,直接看产品真实传给 helper 的 argv(桩全记下来了),想蒙混过关只能真的不调。
//
// 阶梯落点的口径(方案 §3.2 B-3 #7):阶梯在 **Node 侧**(tool* body 内),所以本用例要求看到
// "先 uia 后 post"两次调用。若实现把阶梯放进 Python(只调一次),本用例会红 —— 那是口径分歧,
// 该回去改方案/实现,不是改测试。
//
// 跑法:node tests/unit/check-cu-no-silent-global.mjs
import assert from 'node:assert/strict';
import { makeReport } from './q8-helpers/report.mjs';
import { GRANTED, grantedWindow, makeWinHome, startWinMcp } from './r142-helpers/win-fixture.mjs';

const report = makeReport('check-cu-no-silent-global');
const WIN_TARGET = { bundleId: GRANTED.bundleId, pid: GRANTED.pid, windowId: GRANTED.windowId };

function winFake(name, typeReplies) {
  const fake = makeWinHome(name);
  fake.setGrants({ apps: [GRANTED.bundleId] });
  fake.setScenario({
    windows: { reply: { ok: true, frontmost: null, windows: [grantedWindow()] } },
    'uia-probe': { reply: { ok: true, uia: true, comtypes: '1.4.11' } },
    type: { replies: typeReplies },
  });
  return fake;
}

// ── T7-01 UIA 失败 → 消息投递成功:成功回执、method 是消息类、全程无全局(修前红)──
{
  const fake = winFake('t7-fallback', [
    { ok: false, code: 'CU_UIA_BLOCKED', error: 'ElementFromPoint 返回空' },
    { ok: true, method: 'post-message', chars: 2, effect: { observed: 'changed', diffRatio: 0.03 } },
  ]);
  const mcpWin = await startWinMcp(fake);
  const r = await mcpWin.call('type', { actionId: 'r142_t7a', target: WIN_TARGET, text: 'AB' }, 40_000).catch((e) => ({ error: e }));
  const methods = fake.methodsSeen();
  const calls = fake.helperCalls();
  mcpWin.kill();
  await report.check('T7-01', 'UIA 不可达时降级到消息投递:回执成功、method=消息类,且 helper 一次都没收到全局投递', 'red', () => {
    assert.ok(calls.length >= 2, `没看到"UIA 试一次 → 消息投递再试一次"的阶梯(Node 侧阶梯,§B-3 #7);helper 调用:${JSON.stringify(calls.map((c) => [c.subcmd, c.args]))}`);
    assert.ok(!methods.includes('global'),
      `未给 foreground:true,产品却让 helper 走了全局投递(--method global)。这是方案的红线:绝不许静默抢前台。`);
    assert.equal(r?.isError, false, `降级到消息投递成功却回了失败回执:${JSON.stringify(r?.sc || r?.error?.message)}`);
    assert.equal(r?.sc?.method, 'post-message', `回执 method=${r?.sc?.method},消息投递必须是 post-message(§2.3)`);
    assert.equal(r?.sc?.verification, 'unknown', `消息投递的 verification 必须是 unknown(§2.3:只证明入了队列,不证明生效)`);
  });
}

// ── T7-02 两条后台通道都不可用:硬失败 = CU_BACKGROUND_UNSUPPORTED + "新的 actionId"(修前红)──
{
  const fake = winFake('t7-unsupported', [
    { ok: false, code: 'CU_UIA_BLOCKED', error: '没有 UIA 元素' },
    { ok: false, code: 'CU_BACKGROUND_UNSUPPORTED', error: '拿不到可投递的 hwnd' },
  ]);
  const mcpWin = await startWinMcp(fake);
  const r = await mcpWin.call('type', { actionId: 'r142_t7b', target: WIN_TARGET, text: 'AB' }, 40_000).catch((e) => ({ error: e }));
  const methods = fake.methodsSeen();
  mcpWin.kill();
  await report.check('T7-02', '后台通道全不可用时:CU_BACKGROUND_UNSUPPORTED + 文案含"新的 actionId",仍无全局投递', 'red', () => {
    assert.ok(!methods.includes('global'), '后台失败后自己偷偷升级成全局投递了(§2.3 红线)');
    assert.equal(r?.isError, true, `两条后台通道都失败,却回了成功回执:${JSON.stringify(r?.sc)}`);
    assert.equal(r?.sc?.code, 'CU_BACKGROUND_UNSUPPORTED', `失败码是 ${r?.sc?.code},方案 §2.3 钉的是 CU_BACKGROUND_UNSUPPORTED`);
    assert.match(String(r?.text || ''), /新的 actionId/,
      `文案没提"用新的 actionId 重试":${String(r?.text).slice(0, 160)}。`
      + '(canonicalParams:372-382 把 foreground 算进指纹,同 id 换 foreground:true 会撞 CU_ACTION_CONFLICT,所以必须换 id)');
  });
}

// ── T7-03 消息投递成功但截图未观察到变化:仍是非错误回执(§2.2 修订判据,修前红)──
{
  const fake = winFake('t7-unchanged', [
    { ok: false, code: 'CU_UIA_BLOCKED', error: '没有 UIA 元素' },
    { ok: true, method: 'post-message', chars: 2, effect: { observed: 'unchanged', diffRatio: 0 } },
  ]);
  const mcpWin = await startWinMcp(fake);
  const r = await mcpWin.call('type', { actionId: 'r142_t7c', target: WIN_TARGET, text: 'AB' }, 40_000).catch((e) => ({ error: e }));
  mcpWin.kill();
  await report.check('T7-03', 'effect=unchanged 不得判硬失败:回执仍成功,且文案明说"无法据此判定投递失败"', 'red', () => {
    assert.equal(r?.isError, false,
      `unchanged 被判成了硬失败(${JSON.stringify(r?.sc)});方案 §2.2:后台窗口被遮挡/最小化时 diff 双向误判,unchanged 不构成失败证据`);
    assert.match(String(r?.text || ''), /未观察到变化|无法.*判定|不能.*判定/,
      `文案没说清"未观察到变化不等于失败":${String(r?.text).slice(0, 200)}`);
  });
}

// ── T7-04 回执带 effect 字段(§4.1 新增附加字段)(修前红)────────────────
{
  const fake = winFake('t7-effect', [
    { ok: false, code: 'CU_UIA_BLOCKED', error: '没有 UIA 元素' },
    { ok: true, method: 'post-message', chars: 2, effect: { observed: 'changed', diffRatio: 0.03 } },
  ]);
  const mcpWin = await startWinMcp(fake);
  const r = await mcpWin.call('type', { actionId: 'r142_t7d', target: WIN_TARGET, text: 'AB' }, 40_000).catch((e) => ({ error: e }));
  mcpWin.kill();
  await report.check('T7-04', '消息投递回执带 structuredContent.effect = {observed, diffRatio}', 'red', () => {
    const eff = r?.sc?.effect;
    assert.ok(eff && typeof eff === 'object', `回执没有 effect 字段:${JSON.stringify(r?.sc)}`);
    assert.ok(['changed', 'unchanged'].includes(eff.observed), `effect.observed=${eff.observed} 只能是 changed/unchanged`);
    assert.equal(typeof eff.diffRatio, 'number', `effect.diffRatio 必须是数字,实际 ${typeof eff.diffRatio}`);
  });
}

// ── T7-05 正对照:foreground:true 才允许全局投递(§2.1 阶梯 2 唯一入口)(修前红)──
{
  const fake = winFake('t7-foreground', [
    { ok: true, method: 'global', chars: 2, foreground_affected: true },
  ]);
  const mcpWin = await startWinMcp(fake);
  const r = await mcpWin.call('type', { actionId: 'r142_t7e', target: WIN_TARGET, text: 'AB', foreground: true }, 40_000).catch((e) => ({ error: e }));
  const methods = fake.methodsSeen();
  mcpWin.kill();
  await report.check('T7-05', '显式 foreground:true 时全局投递必须真的可达(门是门,不是墙)', 'red', () => {
    assert.ok(methods.includes('global'),
      `foreground:true 却没走全局投递;helper 收到的 --method:${JSON.stringify(methods)};回执:${JSON.stringify(r?.sc)}`);
    assert.equal(r?.isError, false, `前台投递成功却回了失败回执:${JSON.stringify(r?.sc)}`);
  });
}

// ── T7-06 mac 回归:未给 foreground 时回执 method 不是 foreground(修前绿)──
{
  const macH = await import('./q8-helpers/cu-harness.mjs');
  const fake = macH.makeFakeHome('r142-mac-nosilent');
  fake.setGrants({ apps: [macH.GRANTED.bundleId] });
  fake.setScenario({ windows: { reply: { ok: true, frontmost: null, windows: [macH.grantedWindow()] } } });
  const mac = await macH.startMcp(fake);
  const r = await mac.call('key', { actionId: 'r142_t7f', target: macH.TARGET, keys: 'a' }, 30_000).catch((e) => ({ error: e }));
  mac.kill();
  await report.check('T7-06', 'macOS 回归:未给 foreground 时回执 method 不是 foreground/global', 'green', () => {
    assert.ok(r && !r.error, `mac 的 key 调用失败:${JSON.stringify(r?.error || r?.sc)}`);
    assert.notEqual(r.sc?.method, 'foreground', `mac 上未给 foreground 却走了前台投递:${JSON.stringify(r.sc)}`);
  });
}

process.exit(report.finish());
