// r151e 行为清单 B(7–9):服务启动时偏好文件读不出、之后恢复可读。
// 7、8:读不出期间用户把「放任」目标 T 切到「逐步确认」,这次切档要被记下 —— 恢复后(7:碰一下跨会话设置;8:立刻重启服务),
//       「放任」发送方发来的消息都不得按切档前更宽的「放任」档自动处理:落卡片 pending,heldReason 为 class-mismatch 或 no-profile。
// 9(相邻回归):总开关关着时同样走一遍,之后跨会话照"总开关关"表现。
// 每条用例一个一次性实例。目标 T = 假 CLI 会话(建档回合带 R151EXIT:建完档进程就退,T 没有存活进程);
// 发送方 = 真 CLI 会话(「放任」,ws/real-*,模型请求只到本地假接口)。
// 用例结束无论成败都把偏好文件权限改回原值:改权限的那一刻就把恢复函数登记到 hold 上,finally 里统一调用(可重复调用)。
import { test, expect } from '@playwright/test';
import { seedSession, uniq, makeWorkspace, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, waitFor, expectError, DISABLED } from '../r151b-xsession-p1/helpers/api.mjs';
import { inboundOk, entry, profileTurn, startInstanceP2 } from '../r151c-xsession-p2/helpers/p2.mjs';
import { makePrefsUnreadable, procPids, switchMode, sendAndSettle, HELD_EITHER } from './helpers/e.mjs';

test.describe.configure({ timeout: 300_000 });

/**
 * 第 7、8 条的前提与共同前半段:总开关开着;T 自动处理、「放任」、有「放任」档案、没有存活进程;
 * 停服务 → 偏好文件设为读不出 → 起服务 → 把 T 切到「逐步确认」(200)→ 恢复偏好文件可读。返回 { T, S }。
 */
async function stage(inst, tag, hold) {
  await xs(inst.c, inst.home).on();
  const run = uniq('');
  const T = seedSession(`${tag}-t-${run}`, { home: inst.home });
  await profileTurn(inst.c, T, 'bypassPermissions', 'R151EXIT');
  await inboundOk(inst.c, T.sid, 'auto');
  const e = await entry(inst.c, T.sid);
  expect(e && e.hasProfile, `前置:T 跑过「放任」回合,有发送档案(${JSON.stringify(e)})`).toBe(true);
  let pids = [];
  await waitFor(async () => { pids = await procPids(inst.c, T.sid); return pids.length === 0; }, 10_000, 250);
  expect(pids, '前置:T 没有存活进程').toEqual([]);

  await inst.stop();
  hold.restore = makePrefsUnreadable(inst.home);
  await inst.restart();
  const sw = await switchMode(inst.c, T.sid, 'default', 20_000);
  expect(sw.status, `前置:偏好文件读不出时起的服务上,把 T 切到「逐步确认」→ 200(${String(sw.text).slice(0, 200)})`).toBe(200);
  hold.restore();
  return { T, S: { cwd: makeWorkspace(`real-${tag}-${run}`) } };
}

/** 结果断言:这条消息不自动处理 —— 落卡片 pending,heldReason 是 class-mismatch / no-profile 之一,事件流里没有处理它的回合。 */
function expectHeld({ fin, turns }) {
  expect(fin && fin.status, `不自动处理,落卡片 pending(实际:${JSON.stringify(fin)})`).toBe('pending');
  expect(HELD_EITHER, `heldReason 应为 class-mismatch 或 no-profile(实际:${fin && fin.heldReason})`).toContain(fin && fin.heldReason);
  expect(turns, '事件流里没有处理这条消息的回合').toEqual([]);
}

test('E07 启动时偏好文件读不出期间把「放任」目标切到「逐步确认」,恢复可读后碰一下跨会话设置 → 「放任」发送方发来的消息不自动处理(pending,class-mismatch 或 no-profile)', async () => {
  test.skip(!realCliPath(), '本机没有真 claude CLI(发送方要用真 CLI 调 send_message)');
  const inst = await startInstanceP2('e07');
  const hold = { restore: null };
  try {
    const { T, S } = await stage(inst, 'e07', hold);
    const on = await inst.c.put('/api/xsession/config', { enabled: true });
    expect(on.status, `前置:恢复可读后再设一次总开关为开 → 200(${on.text.slice(0, 200)})`).toBe(200);
    expectHeld(await sendAndSettle(inst, S, T, `R151E e07 ${uniq('')}`));
  } finally {
    if (hold.restore) hold.restore();
    await inst.stop();
  }
});

test('E08 启动时偏好文件读不出期间把「放任」目标切到「逐步确认」,恢复可读后立刻重启服务 → 「放任」发送方发来的消息不自动处理(pending,class-mismatch 或 no-profile)', async () => {
  test.skip(!realCliPath(), '本机没有真 claude CLI(发送方要用真 CLI 调 send_message)');
  const inst = await startInstanceP2('e08');
  const hold = { restore: null };
  try {
    const { T, S } = await stage(inst, 'e08', hold);
    await inst.restart();
    expectHeld(await sendAndSettle(inst, S, T, `R151E e08 ${uniq('')}`));
  } finally {
    if (hold.restore) hold.restore();
    await inst.stop();
  }
});

test('E09 总开关关着时偏好文件在启动时读不出、随后恢复(相邻回归):GET /api/xsession/config 的 enabled 为 false;GET /api/xsession/sessions 回 409 XS_DISABLED', async () => {
  const inst = await startInstanceP2('e09');
  let restore = null;
  try {
    const c0 = await inst.c.get('/api/xsession/config');
    expect([c0.status, c0.body && c0.body.enabled], `前置:总开关关着(${c0.text.slice(0, 200)})`).toEqual([200, false]);
    await inst.stop();
    restore = makePrefsUnreadable(inst.home);
    await inst.restart();
    restore();
    const cfg = await inst.c.get('/api/xsession/config');
    const ses = await inst.c.get('/api/xsession/sessions');
    expect([cfg.status, cfg.body && cfg.body.enabled], `GET /api/xsession/config(${cfg.text.slice(0, 200)})`).toEqual([200, false]);
    expectError(ses, 409, 'XS_DISABLED', DISABLED.error, 'GET /api/xsession/sessions');
  } finally {
    if (restore) restore();
    await inst.stop();
  }
});
