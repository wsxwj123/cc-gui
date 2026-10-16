// r151d 行为清单 4、5:发送档案写盘失败导致的"按没有档案判",服务重启后仍然保持,直到该会话的发送档案成功写入一次。
// 一次性实例(要重启服务、要改目录权限,不碰共享实例)。"跨会话数据目录不可写" = 临时 HOME 下 .claude-gui/xsession/
// 连同其下所有子目录、文件都去掉写权限;用例结束无论成败都恢复原权限。
// T 先在目录可写时跑过一个回合(盘上已有一份旧档案),再在不可写时跑一个回合 —— 这样"重启后又读到盘上的旧档案"才会暴露出来。
// 发送档案里记着这一回合的模型,内容没变的回合不会重写档案(实测),所以不可写期间那一回合换一个模型,确保真的要写盘;
// 恢复可写后的那一回合再换一个盘上、内存里都没出现过的模型,确保真的写成一次。
// 发送方 = 真 CLI 会话(「放任」),模型请求只到本地假接口。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { seedSession, uniq, makeWorkspace, realCliPath, xsDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs } from '../r151b-xsession-p1/helpers/api.mjs';
import { HELD, inboundOk, entry, profileTurn, startInstanceP2, wsT, msgs } from '../r151c-xsession-p2/helpers/p2.mjs';
import { lockTree, turnWith, sendFrom, waitNewMsg, waitSettled, sleep } from './helpers/d.mjs';

test.describe.configure({ timeout: 300_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI(发送方要用真 CLI 调 send_message)'); });

/** 行为清单 4 的前半段:T「放任」、自动处理、已有旧档案;目录设为不可写后 T 跑一个回合。返回 { inst, c, T, S, unlock }。 */
async function failWrite(tag) {
  const inst = await startInstanceP2(tag);
  const c = inst.c;
  await xs(c, inst.home).on();
  const run = uniq('');
  const T = seedSession(`${tag}-t-${run}`, { home: inst.home });
  await profileTurn(c, T, 'bypassPermissions');
  await inboundOk(c, T.sid, 'auto');
  expect((await entry(c, T.sid)).hasProfile, '前置:目录可写时跑过回合 → hasProfile:true').toBe(true);
  const dir = xsDir(inst.home);
  expect(fs.existsSync(dir), `前置:跨会话数据目录存在(${dir})`).toBe(true);
  const unlock = lockTree(dir);
  await turnWith(c, T, { model: 'claude-opus-4-1', note: '目录不可写' });
  return { inst, c, T, S: { cwd: makeWorkspace(`real-${tag}-${run}`) }, run, unlock };
}

test('D04 写盘失败标记跨重启保留:目录不可写时 T 跑回合 → hasProfile:false;重启(目录仍不可写)→ 仍 false;「放任」发送方发来消息 → 卡片 no-profile,不自动处理', async () => {
  const { inst, c, T, S, run, unlock } = await failWrite('d04');
  const ws0 = [];
  try {
    expect((await entry(c, T.sid)).hasProfile, '目录不可写时跑完回合 → 会话列表 T 的 hasProfile:false').toBe(false);
    await inst.restart();
    expect((await entry(inst.c, T.sid)).hasProfile, '重启服务(目录仍不可写)→ T 的 hasProfile 仍为 false').toBe(false);

    const ws = await wsT(inst.base); ws0.push(ws);
    const known = new Set((await msgs(inst.c, T.sid)).map((x) => x.id));
    const r = await sendFrom(inst.c, S, T.sid, `R151D d04 ${run}`);
    expect(r && { delivery: r.delivery, note: r.note }, '工具结果:卡片 / 没有可用的发送设置').toEqual({ delivery: 'card', note: HELD['no-profile'] });
    const m = await waitNewMsg(inst.c, T.sid, known);
    expect(m && { status: m.status, heldReason: m.heldReason }, '收件列表:pending / no-profile').toEqual({ status: 'pending', heldReason: 'no-profile' });
    await sleep(3_000);
    expect((await waitSettled(inst.c, T.sid, m.id, 1)).status, '之后也不自动处理').toBe('pending');
    expect(ws.ofType('xs:turn').filter((e) => e.sessionId === T.sid), '事件流里没有 T 的自动处理回合').toEqual([]);
  } finally { for (const w of ws0) w.close(); unlock(); await inst.stop(); }
});

test('D05 恢复后正常:接 D04 的场景,目录恢复可写、T 再跑一个回合 → hasProfile:true;再重启 → 仍 true;「放任」发送方发来消息 → 自动处理(done、via:"auto")', async () => {
  const { inst, c, T, S, run, unlock } = await failWrite('d05');
  let locked = true;
  try {
    expect((await entry(c, T.sid)).hasProfile, '前置:目录不可写时跑完回合 → hasProfile:false').toBe(false);
    await inst.restart();
    unlock(); locked = false;
    await turnWith(inst.c, T, { model: 'claude-haiku-4-5', note: '目录已恢复可写' });
    expect((await entry(inst.c, T.sid)).hasProfile, '目录恢复可写、T 再跑一个回合 → hasProfile:true').toBe(true);
    await inst.restart();
    expect((await entry(inst.c, T.sid)).hasProfile, '再重启一次服务 → 仍为 true').toBe(true);

    const known = new Set((await msgs(inst.c, T.sid)).map((x) => x.id));
    const r = await sendFrom(inst.c, S, T.sid, `R151D d05 ${run}`);
    expect(r && r.delivery, '工具结果:自动处理').toBe('auto');
    const m = await waitNewMsg(inst.c, T.sid, known);
    const fin = await waitSettled(inst.c, T.sid, m && m.id);
    expect(fin && { status: fin.status, via: fin.via }, `「放任」发送方的消息被自动处理(实际:${JSON.stringify(fin)})`).toEqual({ status: 'done', via: 'auto' });
  } finally { if (locked) unlock(); await inst.stop(); }
});
