// r151e 行为清单 C(10)、D(11):"按没有档案判"的标记与偏好文件读不出。
// 10:偏好文件读不出期间 T 跑回合 → 按没有档案判(标记当时存不进偏好文件)。读不出期间总开关按"关"读、跨会话接口回 409,
//     所以那时不查会话列表;恢复可读后查一次(hasProfile:false),之后什么都不做,服务要在 30 秒内自己补存,
//     所以等 40 秒再重启,T 仍按没有档案判。
// 11:T 先处于"按没有档案判"且已跨重启保留(造法同 r151d 行为清单 4:只让发送档案写不进,T 跑回合,重启);去掉占位后,
//     服务在偏好文件读不出时启动,恢复可读后 T 立刻跑一个回合(档案写成),等 40 秒再重启 → T 按正常档案判。
// 一次性实例(要重启服务、要动偏好文件权限和跨会话数据目录)。发送档案里记着这一回合的模型,内容没变的回合不会重写档案,
// 所以"要真的写档案"的回合都换一个这次实例里没出现过的模型。发送方 = 真 CLI 会话(「放任」),模型请求只到本地假接口。
// 用例结束无论成败:偏好文件权限改回原值、撤掉占位、停掉实例。
import { test, expect } from '@playwright/test';
import { seedSession, uniq, makeWorkspace, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs } from '../r151b-xsession-p1/helpers/api.mjs';
import { inboundOk, entry, profileTurn, startInstanceP2 } from '../r151c-xsession-p2/helpers/p2.mjs';
import { turnWith } from '../r151d-xsession-hardening/helpers/d.mjs';
import { makePrefsUnreadable, blockProfileWrites, sendAndSettle, sleep } from './helpers/e.mjs';

test.describe.configure({ timeout: 360_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI(发送方要用真 CLI 调 send_message)'); });

/** 总开关开着;T「放任」、自动处理、有「放任」档案。返回 { T, S }。 */
async function profiledT(inst, tag) {
  await xs(inst.c, inst.home).on();
  const run = uniq('');
  const T = seedSession(`${tag}-t-${run}`, { home: inst.home });
  await profileTurn(inst.c, T, 'bypassPermissions');
  await inboundOk(inst.c, T.sid, 'auto');
  const e = await entry(inst.c, T.sid);
  expect(e && e.hasProfile, `前置:T 跑过「放任」回合,有发送档案(${JSON.stringify(e)})`).toBe(true);
  return { T, S: { cwd: makeWorkspace(`real-${tag}-${run}`) } };
}
/** 会话列表(GET /api/xsession/sessions?ids=…)里 sid 的 hasProfile;列表里没有它时返回一段带接口原始应答的说明文字(断言失败时看得到原因)。 */
const hasProfileOf = async (inst, sid) => {
  const r = await inst.c.get(`/api/xsession/sessions?ids=${sid}`);
  const e = r.body && Array.isArray(r.body.sessions) ? r.body.sessions.find((s) => s && s.sessionId === sid) : null;
  return e ? e.hasProfile : `会话列表里没有这个会话(GET ${r.status}:${r.text.slice(0, 160)})`;
};

test('E10 标记没能存进偏好文件会补存:偏好文件读不出时 T 跑回合(这时不查会话列表);恢复可读后 hasProfile:false;之后不做任何操作等 40 秒再重启 → hasProfile 仍 false,「放任」发送方发来消息 → pending / no-profile,不自动处理', async () => {
  const inst = await startInstanceP2('e10');
  let restore = null;
  try {
    const { T, S } = await profiledT(inst, 'e10');
    restore = makePrefsUnreadable(inst.home);
    // 读不出期间总开关按"关"读,跨会话接口回 409 XS_DISABLED(已有约定),所以这时不查会话列表
    await turnWith(inst.c, T, { model: 'claude-opus-4-1', note: '偏好文件读不出' });
    restore();
    expect(await hasProfileOf(inst, T.sid), '恢复可读后,会话列表 T 的 hasProfile 为 false').toBe(false);
    await sleep(40_000);
    await inst.restart();

    expect(await hasProfileOf(inst, T.sid), '恢复可读、等 40 秒、重启服务 → T 的 hasProfile 仍为 false').toBe(false);
    const { r, fin, turns } = await sendAndSettle(inst, S, T, `R151E e10 ${uniq('')}`);
    expect({ delivery: r && r.delivery, status: fin && fin.status, heldReason: fin && fin.heldReason, autoTurns: turns.length },
      `「放任」发送方发来的消息落卡片 no-profile,不自动处理(收件列表:${JSON.stringify(fin)})`)
      .toEqual({ delivery: 'card', status: 'pending', heldReason: 'no-profile', autoTurns: 0 });
  } finally {
    if (restore) restore();
    await inst.stop();
  }
});

test('E11 读不出期间恢复正常的会话,重启后也正常:T 的"按没有档案判"已跨重启保留;去掉占位后服务在偏好文件读不出时启动,恢复可读后 T 立刻跑回合、等 40 秒再重启 → hasProfile:true,「放任」发送方发来消息 → 自动处理(done、via:"auto")', async () => {
  const inst = await startInstanceP2('e11');
  let blk = null;
  let restore = null;
  try {
    const { T, S } = await profiledT(inst, 'e11');
    blk = blockProfileWrites(inst.home);
    await turnWith(inst.c, T, { model: 'claude-opus-4-1', note: '发送档案写不进' });
    expect(await hasProfileOf(inst, T.sid), '前置:发送档案写不进时 T 跑完回合 → hasProfile:false').toBe(false);
    await inst.restart();
    expect(await hasProfileOf(inst, T.sid), '前置:重启后仍为 false(这一状态已跨重启保留)').toBe(false);

    blk.restore();
    await inst.stop();
    restore = makePrefsUnreadable(inst.home);
    await inst.restart();
    restore();
    await turnWith(inst.c, T, { model: 'claude-haiku-4-5', note: '档案写成' });
    await sleep(40_000);
    await inst.restart();

    expect(await hasProfileOf(inst, T.sid), '档案写成、等 40 秒、重启服务 → T 的 hasProfile 为 true').toBe(true);
    const { r, fin } = await sendAndSettle(inst, S, T, `R151E e11 ${uniq('')}`, { settleMs: 0 });
    expect({ delivery: r && r.delivery, status: fin && fin.status, via: fin && fin.via }, `「放任」发送方发来的消息被自动处理(收件列表:${JSON.stringify(fin)})`)
      .toEqual({ delivery: 'auto', status: 'done', via: 'auto' });
  } finally {
    let firstErr = null;
    try { if (restore) restore(); } catch (e) { firstErr = e; }
    try { if (blk) blk.restore(); } catch (e) { firstErr = firstErr || e; }
    await inst.stop();
    if (firstErr) console.warn(`[r151e] E11 收尾出错:${firstErr && firstErr.message}`);
  }
});
