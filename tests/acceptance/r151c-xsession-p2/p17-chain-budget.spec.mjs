// 二期行为清单 17、18、23:连锁 hop 与上限、全局自动处理次数触顶暂停、目标卡住(处理超过 30 分钟)。
// P17 两个真 CLI 会话互发(各自"自动处理"),由假接口按信封正文里的标记让收方继续转发;界面上看 hop 标签。
// P18 / P23 在一次性实例里跑,服务进程的墙上时间可平移(helpers/clock-shim.cjs),用来越过"10 分钟""30 分钟"。
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { seedSession, uniq, makeWorkspace, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, shared, writeScript, touchCtl } from '../r151b-xsession-p1/helpers/api.mjs';
import { boot, openSessionBySearch } from '../r151b-xsession-p1/helpers/ui.mjs';
import { SM, NOTE, HELD, addScript, aiCalls, resultJson, blast, inboundOk, entry, msgs, waitMsg, profileTurn, wsT, startInstanceP2 } from './helpers/p2.mjs';

test.describe.configure({ timeout: 420_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI'); });
const fromSession = (x) => x.from && x.from.kind === 'session';
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test('P17 连锁:自动处理开始的回合里发出的消息 hop 加 1、chainId 不变;hop 超过 4 → 卡片 chain-limit,界面显示"连锁第 5 次";用户在该会话发消息后下一次发送回到 hop:1', async ({ page }) => {
  const api = xs();
  await api.on();
  const run = uniq('');
  const A = await aiCalls(shared, { cwd: makeWorkspace(`real-p17a-${run}`), steps: [] });
  const B = await aiCalls(shared, { cwd: makeWorkspace(`real-p17b-${run}`), steps: [] });
  for (const s of [A, B]) await inboundOk(shared, s.sid, 'auto');
  const K = [2, 3, 4, 5, 6].map((n) => `R151CHOP${n}x${run}`);
  addScript('real', K[0], [{ name: SM, input: { to: [A.sid], message: `${K[1]} 第 2 跳` } }]);
  addScript('real', K[1], [{ name: SM, input: { to: [B.sid], message: `${K[2]} 第 3 跳` } }]);
  addScript('real', K[2], [{ name: SM, input: { to: [A.sid], message: `${K[3]} 第 4 跳` } }]);
  addScript('real', K[3], [{ name: SM, input: { to: [B.sid], message: `${K[4]} 第 5 跳` } }]);
  const u = await aiCalls(shared, { cwd: makeWorkspace(`real-p17a-${run}`), sid: A.sid, steps: [{ name: SM, input: { to: [B.sid], message: `${K[0]} 第 1 跳` } }] });
  expect(resultJson(u, 0, 1)?.results?.[0]?.delivery, '第 1 跳自动处理').toBe('auto');
  const last = await waitMsg(shared, B.sid, (x) => fromSession(x) && x.hop === 5, 180_000);
  const chain = [...await msgs(shared, A.sid), ...await msgs(shared, B.sid)].filter((x) => fromSession(x) && x.chainId === (last || {}).chainId)
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
  expect(chain.map((x) => x.hop), '同一条连锁的 hop 依次加 1').toEqual([1, 2, 3, 4, 5]);
  expect(last, '第 5 跳 → pending / chain-limit,不处理').toMatchObject({ status: 'pending', heldReason: 'chain-limit', heldText: HELD['chain-limit'] });

  const bt = (await entry(shared, B.sid)).title;
  await boot(page);
  await openSessionBySearch(page, bt);
  const card = page.locator(`[data-testid="xs-card"][data-message-id="${last.id}"]`);
  await expect(card.getByTestId('xs-card-hop'), 'hop>1 时卡片显示连锁次数').toHaveText('连锁第 5 次', { timeout: 15_000 });
  await expect(card.getByTestId('xs-card-reason')).toHaveText(HELD['chain-limit']);

  const reset = await aiCalls(shared, { cwd: makeWorkspace(`real-p17a-${run}`), sid: A.sid, steps: [{ name: SM, input: { to: [B.sid], message: `R151C p17 用户发消息之后 ${run}` } }] });
  expect(reset.results.length, '前置:调用有结果').toBe(1);
  const fresh = await waitMsg(shared, B.sid, (x) => fromSession(x) && x.chainId !== last.chainId && String(x.createdAt) > String(last.createdAt));
  expect(fresh && fresh.hop, '用户在发送方会话发消息后,下一次发送回到 hop:1').toBe(1);
});

test('P18 10 分钟内自动处理到第 20 次 → 广播 xs:config autoPaused:true,之后的消息落卡片 paused;时间过去也不自动恢复;重启后仍暂停;PUT {autoPaused:false} 后恢复且计数清零', async () => {
  const inst = await startInstanceP2('p18', { clock: true });
  const ws = await wsT(inst.base);
  try {
    let c = inst.c;
    await xs(c, inst.home).on();
    const run = uniq('');
    const T = Array.from({ length: 21 }, (_, i) => seedSession(`p18-t${i}-${run}`, { home: inst.home }));
    for (const t of T) { await profileTurn(c, t); await inboundOk(c, t.sid, 'auto'); }
    const A = { cwd: makeWorkspace(`real-p18-${run}`) };
    const r1 = await blast(c, A, T.slice(0, 16).map((t) => t.sid), `R151C p18 ${run}`);
    expect(r1.flatMap((j) => (j && j.results ? j.results.map((x) => x.delivery) : ['无结果'])), '前 16 条都自动处理').toEqual(Array(16).fill('auto'));
    expect((await c.get('/api/xsession/config')).body.autoBudget, '计数 16').toEqual({ limit: 20, windowMs: 600000, used: 16 });
    const r2 = await blast(c, A, T.slice(16, 20).map((t) => t.sid), `R151C p18 ${run}`);
    expect(r2.flatMap((j) => (j && j.results ? j.results.map((x) => x.delivery) : ['无结果'])), '第 17–20 条也自动处理').toEqual(Array(4).fill('auto'));
    const ev = await ws.waitFor((m) => m.type === 'xs:config' && m.autoPaused === true, 10_000);
    expect(ev && { enabled: ev.enabled, autoPaused: ev.autoPaused }, '触顶广播').toEqual({ enabled: true, autoPaused: true });
    const r3 = await blast(c, A, [T[20].sid], `R151C p18 第 21 条 ${run}`);
    expect(r3[0] && r3[0].results[0], '暂停后 → 卡片 paused').toMatchObject({ delivery: 'card', note: HELD.paused });
    expect(await waitMsg(c, T[20].sid, fromSession)).toMatchObject({ status: 'pending', heldReason: 'paused', heldText: HELD.paused });
    expect((await c.get('/api/xsession/config')).body.autoPaused).toBe(true);
    inst.setClock(11 * 60_000);
    await new Promise((res) => setTimeout(res, 1_500));
    expect((await c.get('/api/xsession/config')).body.autoPaused, '10 分钟窗口过去也不自动恢复').toBe(true);
    await inst.restart();
    c = inst.c;
    const after = (await c.get('/api/xsession/config')).body;
    expect([after.autoPaused, after.autoBudget.used], '重启后仍暂停,内存计数清零').toEqual([true, 0]);
    const ws2 = await wsT(inst.base);
    try {
      const rs = await c.put('/api/xsession/config', { autoPaused: false });
      expect([rs.status, rs.body]).toEqual([200, { ok: true, enabled: true, autoPaused: false }]);
      expect(await ws2.waitFor((m) => m.type === 'xs:config' && m.autoPaused === false), '恢复广播').toBeTruthy();
    } finally { ws2.close(); }
    const now = (await c.get('/api/xsession/config')).body;
    expect([now.autoPaused, now.autoBudget.used], '恢复后计数清零').toEqual([false, 0]);
    const r4 = await blast(c, A, [T[0].sid], `R151C p18 恢复后 ${run}`);
    expect(r4[0] && r4[0].results[0] && r4[0].results[0].delivery, '恢复后自动处理').toBe('auto');
  } finally { ws.close(); await inst.stop(); }
});

test('P23 一条自动处理的消息处理超过 30 分钟仍未结束 → 之后新到的消息落卡片 target-stuck,直到那条结束;那个回合不被自动中止', async () => {
  const inst = await startInstanceP2('p23', { clock: true });
  try {
    const c = inst.c;
    await xs(c, inst.home).on();
    const run = uniq('');
    const B = seedSession(`p23-b-${run}`, { home: inst.home });
    await profileTurn(c, B);
    await inboundOk(c, B.sid, 'auto');
    const go = `p23-go-${run}`;
    writeScript('p23hold', [{ waitFile: go }, { say: 'R151C p23 终于完了' }], inst.ctl);
    const A = { cwd: makeWorkspace(`real-p23-${run}`) };
    await blast(c, A, [B.sid], `R151C p23 一 R151S:p23hold ${run}`);
    const m1 = await waitMsg(c, B.sid, (x) => fromSession(x) && x.status === 'processing');
    expect(m1, '前置:第一条在处理').toBeTruthy();
    const c0 = jsonl(path.join(inst.ctl, 'control.jsonl')).length;
    inst.setClock(31 * 60_000);
    await new Promise((res) => setTimeout(res, 1_000));
    const r2 = await blast(c, A, [B.sid], `R151C p23 二 ${run}`);
    expect(r2[0] && r2[0].results[0], '超过 30 分钟 → 新到的落卡片 target-stuck').toMatchObject({ delivery: 'card', note: HELD['target-stuck'] });
    expect(await waitMsg(c, B.sid, (x) => fromSession(x) && x.id !== m1.id)).toMatchObject({ status: 'pending', heldReason: 'target-stuck', heldText: HELD['target-stuck'] });
    await new Promise((res) => setTimeout(res, 3_000));
    expect((await msgs(c, B.sid)).find((x) => x.id === m1.id).status, '那个回合不被自动中止').toBe('processing');
    expect(jsonl(path.join(inst.ctl, 'control.jsonl')).slice(c0).filter((x) => x.sid === B.sid && /interrupt/i.test(String(x.request && x.request.subtype))), '没有对它发中止').toEqual([]);
    touchCtl(go, inst.ctl);
    expect(await waitMsg(c, B.sid, (x) => x.id === m1.id && x.status === 'done'), '放行后那条结束').toBeTruthy();
    const r3 = await blast(c, A, [B.sid], `R151C p23 三 ${run}`);
    expect(r3[0] && r3[0].results[0] && r3[0].results[0].delivery, '那条结束后恢复自动处理').toBe('auto');
  } finally { await inst.stop(); }
});
