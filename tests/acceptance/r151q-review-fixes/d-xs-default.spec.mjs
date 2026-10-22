// D. 跨会话入站默认值(行为 10–13)。每条用例一个一次性实例(临时 HOME)。老用户的偏好由"真实打开总开关"得到,
// 再去掉 xsInboundDefault(保证带 xsEnabledAt);发送方 = 真 CLI 会话(只连本地假模型)。
import { test, expect } from '@playwright/test';
import { seedSession, uniq, makeWorkspace, realCliPath, prefsPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { readJson } from '../r151b-xsession-p1/helpers/api.mjs';
import { SM, NOTE, aiCalls, resultJson, inboundOk, entry, waitMsg, profileTurn } from '../r151c-xsession-p2/helpers/p2.mjs';
import { startInstanceQ } from './helpers/inst.mjs';

test.describe.configure({ timeout: 200_000 });
const fromSession = (x) => x.from && x.from.kind === 'session';
const inboundOf = async (c, sid) => ((await entry(c, sid)) || {}).inbound;

async function startOldUser(tag) {
  const seed = await startInstanceQ(`${tag}-seed`);
  try { expect((await seed.c.put('/api/xsession/config', { enabled: true })).status, '前置:打开总开关').toBe(200); } finally { await seed.stop(); }
  const prefs = readJson(prefsPath(seed.home)) || {};
  expect(prefs.xsEnabled, '前置:老用户偏好里总开关是开着的').toBe(true);
  delete prefs.xsInboundDefault;
  if (!prefs.xsEnabledAt) prefs.xsEnabledAt = new Date().toISOString();
  return startInstanceQ(tag, { prefs });
}

test('Q10 老用户(有 xsEnabledAt、总开关开着、没有 xsInboundDefault)启动 → 没单独设置过的会话 inbound 为 card;同类发送方的消息落卡片(pending)', async () => {
  test.skip(!realCliPath(), '本机没有真 claude CLI(发送方要用真 CLI 调 send_message)');
  const inst = await startOldUser('q10');
  try {
    const run = uniq('');
    const T = seedSession(`q10-t-${run}`, { home: inst.home });
    expect.soft(await inboundOf(inst.c, T.sid), '没单独设置过的会话 inbound').toBe('card');
    await profileTurn(inst.c, T, 'bypassPermissions');
    const r = await aiCalls(inst.c, { cwd: makeWorkspace(`real-q10-${run}`), steps: [{ name: SM, input: { to: [T.sid], message: `R151Q q10 ${run}` } }] });
    expect.soft(resultJson(r, 0, 1)?.results?.[0], '发送方拿到的工具结果项').toMatchObject({ ok: true, delivery: 'card', note: NOTE.card });
    expect.soft(await waitMsg(inst.c, T.sid, fromSession), '目标会话收件列表里的这条消息').toMatchObject({ status: 'pending', heldReason: 'target-card' });
  } finally { await inst.stop(); }
});

test('Q11 老用户经接口把总开关关掉再打开 → 没单独设置过的会话仍为 card', async () => {
  const inst = await startOldUser('q11');
  try {
    const T = seedSession(`q11-t-${uniq('')}`, { home: inst.home });
    expect((await inst.c.put('/api/xsession/config', { enabled: false })).status, '前置:关总开关').toBe(200);
    expect((await inst.c.put('/api/xsession/config', { enabled: true })).status, '前置:再打开').toBe(200);
    expect(await inboundOf(inst.c, T.sid), '关了再开之后,没单独设置过的会话 inbound').toBe('card');
  } finally { await inst.stop(); }
});

test('Q12 新环境(没有 xsEnabledAt)经接口第一次打开总开关 → 没单独设置过的会话为 auto', async () => {
  const inst = await startInstanceQ('q12');
  try {
    expect((readJson(prefsPath(inst.home)) || {}).xsEnabledAt, '前置:新环境的偏好里没有 xsEnabledAt').toBeUndefined();
    const T = seedSession(`q12-t-${uniq('')}`, { home: inst.home });
    expect((await inst.c.put('/api/xsession/config', { enabled: true })).status, '前置:第一次打开总开关').toBe(200);
    expect(await inboundOf(inst.c, T.sid), '没单独设置过的会话 inbound').toBe('auto');
  } finally { await inst.stop(); }
});

/** 一个实例里建 A(显式 auto)与 C(显式 card),都有发送档案;返回 { A, C, listed }(listed = 会话列表里读到的 inbound)。 */
async function explicitPair(inst, label) {
  const run = uniq('');
  const A = seedSession(`q13-${label}-a-${run}`, { home: inst.home });
  const C = seedSession(`q13-${label}-c-${run}`, { home: inst.home });
  for (const s of [A, C]) await profileTurn(inst.c, s, 'bypassPermissions');
  await inboundOk(inst.c, A.sid, 'auto');
  await inboundOk(inst.c, C.sid, 'card');
  const list = (await inst.c.get('/api/xsession/sessions')).body.sessions;
  const by = Object.fromEntries(list.map((s) => [s.sessionId, s.inbound]));
  return { A, C, run, listed: { auto: by[A.sid], card: by[C.sid] } };
}

test('Q13 显式设成 card / auto → 会话列表与消息判定都按显式值,老用户和新用户一样', async () => {
  test.skip(!realCliPath(), '本机没有真 claude CLI(判定部分要真 CLI 发送方)');
  const oldU = await startOldUser('q13-old');
  try {
    const p = await explicitPair(oldU, 'old');
    expect.soft(p.listed, '老用户:会话列表里的 inbound').toEqual({ auto: 'auto', card: 'card' });
    const r = await aiCalls(oldU.c, { cwd: makeWorkspace(`real-q13o-${p.run}`), steps: [{ name: SM, input: { to: [p.A.sid], message: `R151Q q13 老用户显式 auto ${p.run}` } }] });
    expect.soft(resultJson(r, 0, 1)?.results?.[0], '老用户显式 auto(默认是 card):按 auto 处理').toMatchObject({ ok: true, delivery: 'auto', note: NOTE.auto });
  } finally { await oldU.stop(); }
  const newU = await startInstanceQ('q13-new');
  try {
    expect((await newU.c.put('/api/xsession/config', { enabled: true })).status, '前置:新用户打开总开关').toBe(200);
    const p = await explicitPair(newU, 'new');
    expect.soft(p.listed, '新用户:会话列表里的 inbound').toEqual({ auto: 'auto', card: 'card' });
    const r = await aiCalls(newU.c, { cwd: makeWorkspace(`real-q13n-${p.run}`), steps: [{ name: SM, input: { to: [p.C.sid], message: `R151Q q13 新用户显式 card ${p.run}` } }] });
    expect.soft(resultJson(r, 0, 1)?.results?.[0], '新用户显式 card(默认是 auto):按 card 处理').toMatchObject({ ok: true, delivery: 'card', note: NOTE.card });
    expect.soft(await waitMsg(newU.c, p.C.sid, fromSession), '新用户显式 card:落卡片').toMatchObject({ status: 'pending', heldReason: 'target-card' });
  } finally { await newU.stop(); }
});
