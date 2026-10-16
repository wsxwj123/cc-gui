// r151d 行为清单 4、5:发送档案写盘失败导致的"按没有档案判",服务重启后仍然保持,直到该会话的发送档案成功写入一次。
// 一次性实例(要重启服务、要动跨会话数据目录,不碰共享实例)。
// "只让发送档案写不进、收件箱仍可写" = 在测试自己的临时 HOME 里,用一个同名的空目录占住发送档案文件
// .claude-gui/xsession/profiles.json 的位置(原来有这个文件就先改名留在同目录,不删);同目录下的收件箱照常可写。
// "撤掉占位" = 用非递归的 rmdirSync 删掉这个空目录;用例结束无论成败都撤掉占位、停掉实例。
// T 先在发送档案可写时跑过一个回合(盘上已有一份档案),再在占位期间跑一个回合。
// 发送档案里记着这一回合的模型,内容没变的回合不会重写档案(实测),所以占位期间那一回合换一个模型,确保真的要写盘;
// 撤掉占位后的那一回合再换一个盘上、内存里都没出现过的模型,确保真的写成一次。改名移开的旧档案不放回原位,
// 所以 D05 里"再重启仍为 true"只能来自撤掉占位后那一次真正写成的档案。
// 发送方 = 真 CLI 会话(「放任」),模型请求只到本地假接口。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedSession, uniq, makeWorkspace, realCliPath, xsDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs } from '../r151b-xsession-p1/helpers/api.mjs';
import { HELD, inboundOk, entry, profileTurn, startInstanceP2, wsT, msgs } from '../r151c-xsession-p2/helpers/p2.mjs';
import { turnWith, sendFrom, waitNewMsg, waitSettled, sleep } from './helpers/d.mjs';

test.describe.configure({ timeout: 300_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI(发送方要用真 CLI 调 send_message)'); });

/**
 * 只让发送档案写不进、收件箱仍可写:在临时 HOME 的跨会话数据目录里,用同名空目录占住 profiles.json 的位置。
 * 原来有这个文件就先用 renameSync 改名留在同目录(不删)。返回 { file, hadFile, restore };
 * restore 只用非递归的 rmdirSync 删掉这个空目录(重复调用不再动手),不把改名移开的旧文件放回原位。
 */
function blockProfileWrites(home) {
  const dir = xsDir(home);
  const file = path.join(dir, 'profiles.json');
  const hadFile = fs.existsSync(file);
  if (hadFile) {
    expect(fs.lstatSync(file).isFile(), `前置:${file} 是普通文件`).toBe(true);
    fs.renameSync(file, path.join(dir, `profiles.json.r151d-aside-${Date.now().toString(36)}`));
  }
  fs.mkdirSync(file);
  let restored = false;
  const restore = () => { if (restored) return; restored = true; fs.rmdirSync(file); };
  return { file, hadFile, restore };
}

/**
 * 行为清单 4 的前半段:T「放任」、自动处理、已有档案;占住 profiles.json 后 T 跑一个回合,再把场景交给 body。
 * 无论成败,最后都撤掉占位(body 里还没撤的话)并停掉一次性实例;撤占位出错不盖住 body 自己的失败。
 */
async function withProfileWritesBlocked(tag, body) {
  const inst = await startInstanceP2(tag);
  let blk = null;
  let failed = false;
  try {
    await xs(inst.c, inst.home).on();
    const run = uniq('');
    const T = seedSession(`${tag}-t-${run}`, { home: inst.home });
    await profileTurn(inst.c, T, 'bypassPermissions');
    await inboundOk(inst.c, T.sid, 'auto');
    expect((await entry(inst.c, T.sid)).hasProfile, '前置:发送档案可写时跑过回合 → hasProfile:true').toBe(true);
    const dir = xsDir(inst.home);
    expect(fs.existsSync(dir), `前置:跨会话数据目录存在(${dir})`).toBe(true);
    blk = blockProfileWrites(inst.home);
    await turnWith(inst.c, T, { model: 'claude-opus-4-1', note: '发送档案写不进' });
    await body({ inst, T, S: { cwd: makeWorkspace(`real-${tag}-${run}`) }, run, blk });
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    let restoreErr = null;
    try { if (blk) blk.restore(); } catch (e) { restoreErr = e; }
    await inst.stop();
    if (restoreErr && !failed) throw restoreErr;
  }
}

test('D04 写盘失败标记跨重启保留:只让发送档案写不进(收件箱仍可写)时 T 跑回合 → hasProfile:false;重启(仍写不进)→ 仍 false;「放任」发送方发来消息 → 卡片 no-profile,不自动处理', async () => {
  await withProfileWritesBlocked('d04', async ({ inst, T, S, run, blk }) => {
    expect((await entry(inst.c, T.sid)).hasProfile,
      `发送档案写不进时跑完回合 → 会话列表 T 的 hasProfile:false(占位前 profiles.json ${blk.hadFile ? '存在,已改名移开' : '不存在'})`).toBe(false);
    await inst.restart();
    expect((await entry(inst.c, T.sid)).hasProfile, '重启服务(发送档案仍写不进)→ T 的 hasProfile 仍为 false').toBe(false);

    const ws = await wsT(inst.base);
    try {
      const known = new Set((await msgs(inst.c, T.sid)).map((x) => x.id));
      const r = await sendFrom(inst.c, S, T.sid, `R151D d04 ${run}`);
      expect(r && { delivery: r.delivery, note: r.note }, '工具结果:卡片 / 没有可用的发送设置').toEqual({ delivery: 'card', note: HELD['no-profile'] });
      const m = await waitNewMsg(inst.c, T.sid, known);
      expect(m && { status: m.status, heldReason: m.heldReason }, '收件列表(收件箱仍可写,消息存得进):pending / no-profile').toEqual({ status: 'pending', heldReason: 'no-profile' });
      await sleep(3_000);
      expect((await waitSettled(inst.c, T.sid, m.id, 1)).status, '之后也不自动处理').toBe('pending');
      expect(ws.ofType('xs:turn').filter((e) => e.sessionId === T.sid), '事件流里没有 T 的自动处理回合').toEqual([]);
    } finally { ws.close(); }
  });
});

test('D05 恢复后正常:接 D04 的场景,撤掉占位、发送档案恢复可写,T 再跑一个回合 → hasProfile:true;再重启 → 仍 true;「放任」发送方发来消息 → 自动处理(done、via:"auto")', async () => {
  await withProfileWritesBlocked('d05', async ({ inst, T, S, run, blk }) => {
    expect((await entry(inst.c, T.sid)).hasProfile, '前置:发送档案写不进时跑完回合 → hasProfile:false').toBe(false);
    await inst.restart();
    blk.restore();
    await turnWith(inst.c, T, { model: 'claude-haiku-4-5', note: '发送档案已恢复可写' });
    expect((await entry(inst.c, T.sid)).hasProfile, '撤掉占位、T 再跑一个回合 → hasProfile:true').toBe(true);
    await inst.restart();
    expect((await entry(inst.c, T.sid)).hasProfile, '再重启一次服务 → 仍为 true').toBe(true);

    const known = new Set((await msgs(inst.c, T.sid)).map((x) => x.id));
    const r = await sendFrom(inst.c, S, T.sid, `R151D d05 ${run}`);
    expect(r && r.delivery, '工具结果:自动处理').toBe('auto');
    const m = await waitNewMsg(inst.c, T.sid, known);
    const fin = await waitSettled(inst.c, T.sid, m && m.id);
    expect(fin && { status: fin.status, via: fin.via }, `「放任」发送方的消息被自动处理(实际:${JSON.stringify(fin)})`).toEqual({ status: 'done', via: 'auto' });
  });
});
