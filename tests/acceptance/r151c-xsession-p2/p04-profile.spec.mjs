// 二期行为清单 4、11、24:发送档案(关变开后失效、没有档案、换过 provider)与服务重启后的状态。全部在一次性实例里跑
// (要重启服务、要改 provider 设置,不碰共享实例)。发送方 = 真 CLI 会话(ws/real-*,模型请求只到本地假接口)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedSession, uniq, makeWorkspace, realCliPath, claudeDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, MOCK, waitFor, turnRecords, writeScript } from '../r151b-xsession-p1/helpers/api.mjs';
import { SM, NOTE, HELD, aiCalls, resultJson, inboundOk, entry, msgs, waitMsg, profileTurn, startInstanceP2 } from './helpers/p2.mjs';

test.describe.configure({ timeout: 300_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI'); });
const fromSession = (x) => x.from && x.from.kind === 'session';
const firstItem = (r) => resultJson(r, 0, 1)?.results?.[0];

test('P04 总开关由关变开 → 会话列表所有项 hasProfile:false,直到该会话再开始一个回合;这期间发给它的消息落卡片 no-profile', async () => {
  const inst = await startInstanceP2('p04');
  try {
    const c = inst.c;
    const api = xs(c, inst.home);
    await api.on();
    const run = uniq('');
    const B = seedSession(`p04-b-${run}`, { home: inst.home });
    const O = seedSession(`p04-o-${run}`, { home: inst.home });
    for (const s of [B, O]) await profileTurn(c, s);
    await inboundOk(c, B.sid, 'auto');
    expect([(await entry(c, B.sid)).hasProfile, (await entry(c, O.sid)).hasProfile], '前置:两个会话都有档案').toEqual([true, true]);
    expect((await c.put('/api/xsession/config', { enabled: false })).status).toBe(200);
    expect((await c.put('/api/xsession/config', { enabled: true })).status).toBe(200);
    const list = (await c.get('/api/xsession/sessions')).body.sessions;
    expect(list.map((s) => s.hasProfile), '关变开后所有项 hasProfile:false').toEqual(list.map(() => false));
    expect((await entry(c, B.sid)).inbound, '接收设置不受影响').toBe('auto');
    const cwd = makeWorkspace(`real-p04-${run}`);
    const r = await aiCalls(c, { cwd, steps: [{ name: SM, input: { to: [B.sid], message: `R151C p04 一 ${run}` } }] });
    expect(firstItem(r), '档案已失效 → 卡片').toMatchObject({ ok: true, delivery: 'card', note: HELD['no-profile'] });
    expect(await waitMsg(c, B.sid, fromSession), 'B:pending / no-profile').toMatchObject({ status: 'pending', heldReason: 'no-profile', heldText: HELD['no-profile'] });
    await profileTurn(c, B);
    expect((await entry(c, B.sid)).hasProfile, 'B 再开始一个回合 → true').toBe(true);
    expect((await entry(c, O.sid)).hasProfile, 'O 没有开始回合 → 仍 false').toBe(false);
    const r2 = await aiCalls(c, { cwd, sid: r.sid, steps: [{ name: SM, input: { to: [B.sid], message: `R151C p04 二 ${run}` } }] });
    expect(firstItem(r2), '有了新档案 → 自动处理').toMatchObject({ ok: true, delivery: 'auto', note: NOTE.auto });
  } finally { await inst.stop(); }
});

test('P11 目标没有档案 → no-profile;档案记录后换过 provider(含凭据)→ profile-stale', async () => {
  const inst = await startInstanceP2('p11');
  try {
    let c = inst.c;
    await xs(c, inst.home).on();
    const run = uniq('');
    const N = seedSession(`p11-n-${run}`, { home: inst.home });
    const P = seedSession(`p11-p-${run}`, { home: inst.home });
    await profileTurn(c, P);
    for (const s of [N, P]) await inboundOk(c, s.sid, 'auto');
    const r = await aiCalls(c, { cwd: makeWorkspace(`real-p11a-${run}`), steps: [{ name: SM, input: { to: [N.sid], message: `R151C p11 无档案 ${run}` } }] });
    expect(firstItem(r), '没有档案 → 卡片 no-profile').toMatchObject({ ok: true, delivery: 'card', note: HELD['no-profile'] });
    expect(await waitMsg(c, N.sid, fromSession)).toMatchObject({ status: 'pending', heldReason: 'no-profile' });

    const sf = path.join(claudeDir(inst.home), 'settings.json');
    fs.writeFileSync(sf, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${MOCK}/lane/real-p11`, ANTHROPIC_AUTH_TOKEN: `r151c-p11-${run}` } }, null, 2));
    await inst.restart();
    c = inst.c;
    expect((await entry(c, P.sid)).hasProfile, 'hasProfile 不看 provider 是否已换').toBe(true);
    const r2 = await aiCalls(c, { lane: 'real-p11', cwd: makeWorkspace(`real-p11b-${run}`), steps: [{ name: SM, input: { to: [P.sid], message: `R151C p11 换过 provider ${run}` } }] });
    expect(firstItem(r2), '换过 provider → 卡片 profile-stale').toMatchObject({ ok: true, delivery: 'card', note: HELD['profile-stale'] });
    expect(await waitMsg(c, P.sid, fromSession)).toMatchObject({ status: 'pending', heldReason: 'profile-stale', heldText: HELD['profile-stale'] });
  } finally { await inst.stop(); }
});

test('P24 服务重启后:processing / claimed / queued 的消息一律变卡片 interrupted,不会一开机就自动处理', async () => {
  const inst = await startInstanceP2('p24');
  try {
    const c = inst.c;
    const api = xs(c, inst.home);
    await api.on();
    const run = uniq('');
    const B = seedSession(`p24-b-${run}`, { home: inst.home }); const C = seedSession(`p24-c-${run}`, { home: inst.home }); const D = seedSession(`p24-d-${run}`, { home: inst.home });
    for (const s of [B, C]) { await profileTurn(c, s); await inboundOk(c, s.sid, 'auto'); }
    writeScript('p24hold', [{ waitFile: `p24-never-${run}` }], inst.ctl);
    const busy = await c.post('/api/chat', { sessionId: B.sid, cwd: B.cwd, prompt: 'R151C p24 R151S:p24hold', permissionMode: 'bypassPermissions' });
    expect(busy.status, '前置:B 忙').toBe(200);
    expect(await waitFor(() => turnRecords(inst.ctl).some((t) => t.sid === B.sid && t.text.includes('p24hold')), 15_000)).toBeTruthy();
    await aiCalls(c, { cwd: makeWorkspace(`real-p24-${run}`), steps: [
      { name: SM, input: { to: [B.sid], message: `R151C p24 排队 ${run}` } },
      { name: SM, input: { to: [C.sid], message: `R151C p24 处理中 R151S:p24hold ${run}` } },
    ] });
    const mB = await waitMsg(c, B.sid, (x) => fromSession(x) && x.status === 'queued');
    const mC = await waitMsg(c, C.sid, (x) => fromSession(x) && x.status === 'processing');
    expect([Boolean(mB), Boolean(mC)], '前置:B 的一条 queued、C 的一条 processing').toEqual([true, true]);
    const [mD] = await api.send(null, [D.sid], `R151C p24 认领 ${run}`);
    await api.claimOk(mD.id);
    await inst.restart();
    const t0 = turnRecords(inst.ctl).length;
    for (const [s, m, label] of [[B, mB, 'queued'], [C, mC, 'processing'], [D, mD, 'claimed']]) {
      const x = (await msgs(inst.c, s.sid)).find((y) => y.id === m.id);
      expect(x, `重启前 ${label} → pending / interrupted`).toMatchObject({ status: 'pending', heldReason: 'interrupted', heldText: HELD.interrupted });
    }
    await new Promise((res) => setTimeout(res, 4_000));
    expect(turnRecords(inst.ctl).slice(t0).filter((t) => [B.sid, C.sid].includes(t.sid)), '开机后没有自动处理').toEqual([]);
    expect((await msgs(inst.c, B.sid)).find((y) => y.id === mB.id).status, '仍是 pending').toBe('pending');
  } finally { await inst.stop(); }
});
