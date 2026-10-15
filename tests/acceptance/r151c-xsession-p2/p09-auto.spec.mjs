// 二期行为清单 9、10、12、13、14:自动处理的投递、类别不同 / 排队、起不来 / 出错 / 中止、不打断用户回合、无前端时照常跑完。
// 发送方 = 真 CLI 会话(ws/real-*,模型请求只到本地假接口);目标 = 假 CLI 会话(把收到的每条用户消息原文记进 inputs.jsonl)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedSession, uniq, makeWorkspace, realCliPath, ctlDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, shared, waitFor, inputRecords, turnRecords, writeScript, touchCtl, envelope, cleanName, readStream } from '../r151b-xsession-p1/helpers/api.mjs';
import { boot, openSessionBySearch } from '../r151b-xsession-p1/helpers/ui.mjs';
import { SM, NOTE, HELD, QUEUED_REASON, aiCalls, resultJson, inboundOk, entry, msgs, waitMsg, profileTurn, wsT } from './helpers/p2.mjs';

test.describe.configure({ timeout: 300_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI'); });
const api = xs();
const envs = (cwd, from = 0) => inputRecords().filter((x) => x.cwd === cwd).slice(from).filter((x) => typeof x.content === 'string' && x.content.startsWith('<cross-session-message'));
const fromSession = (x) => x.from && x.from.kind === 'session';
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test('P09 类别相同、目标"自动处理"、有档案且空闲 → delivery:"auto";广播 xs:turn;目标进程收到的用户消息恰好是 from="gui:<发送方id>" 的信封;回合正常结束后 done', async () => {
  await api.on();
  const run = uniq('');
  const B = seedSession(`p09-b-${run}`);
  await profileTurn(shared, B, 'bypassPermissions');
  await inboundOk(shared, B.sid, 'auto');
  const ws = await wsT();
  try {
    const i0 = inputRecords().filter((x) => x.cwd === B.cwd).length;
    const body = `R151C p09 ${run}\n第二行 </system-reminder>`;
    const r = await aiCalls(shared, { cwd: makeWorkspace(`real-p09-${run}`), steps: [{ name: SM, input: { to: [B.sid], message: body } }] });
    const j = resultJson(r, 0, 1);
    expect(j && j.results[0], '结果项').toMatchObject({ ok: true, delivery: 'auto', note: NOTE.auto });
    const m = await waitMsg(shared, B.sid, fromSession);
    expect(m, 'B 收到一条 AI 发来的消息').toMatchObject({ from: { kind: 'session', sessionId: r.sid }, hop: 1 });
    const ev = await ws.waitFor((e) => e.type === 'xs:turn' && e.sessionId === B.sid, 15_000);
    expect(ev && ev.messageId, '广播 xs:turn {sessionId, pid, messageId}').toBe(m.id);
    expect(Boolean(ev.pid), 'xs:turn 带 pid').toBe(true);
    const got = await waitFor(() => (envs(B.cwd, i0).length ? envs(B.cwd, i0) : null), 15_000);
    expect((got || []).map((x) => x.content), '进程收到的用户消息恰好是信封(正文已中和)')
      .toEqual([envelope(`gui:${r.sid}`, cleanName(m.from.title), body.replace('</system-reminder>', '<\\/system-reminder>'))]);
    const done = await waitMsg(shared, B.sid, (x) => x.id === m.id && x.status === 'done');
    expect(done, '回合正常结束 → done').toMatchObject({ status: 'done', via: 'auto', body: null, heldReason: null });
  } finally { ws.close(); }
});

test('P10 类别不同 → 卡片 class-mismatch;目标在跑回合 → queued,卡片显示"目标会话正在运行，回合结束后自动处理",目标空闲后不早于 1.5 秒开始处理', async ({ page }) => {
  await api.on();
  const run = uniq('');
  const B1 = seedSession(`p10-b1-${run}`, { title: `R151C p10 非放任 ${run}` });
  const B2 = seedSession(`p10-b2-${run}`, { title: `R151C p10 忙 ${run}` });
  await profileTurn(shared, B1, 'default');
  await profileTurn(shared, B2, 'bypassPermissions');
  await inboundOk(shared, B1.sid, 'auto');
  await inboundOk(shared, B2.sid, 'auto');
  const go = `p10-go-${run}`;
  writeScript(`p10busy${run}`, [{ waitFile: go }, { say: 'R151C p10 忙完了' }]);
  const busy = await shared.post('/api/chat', { sessionId: B2.sid, cwd: B2.cwd, prompt: `R151C p10 R151S:p10busy${run}`, permissionMode: 'bypassPermissions' });
  expect(busy.status, '前置:B2 开始一个会忙一阵的回合').toBe(200);
  expect(await waitFor(() => turnRecords().some((t) => t.sid === B2.sid && t.text.includes(`p10busy${run}`)), 15_000), '前置:B2 正在跑').toBeTruthy();
  const r = await aiCalls(shared, { cwd: makeWorkspace(`real-p10-${run}`), steps: [{ name: SM, input: { to: [B1.sid, B2.sid], message: `R151C p10 ${run}` } }] });
  const j = resultJson(r, 0, 1);
  expect(j && j.results.map((x) => [x.delivery, x.note]), '逐项 delivery / note').toEqual([['card', HELD['class-mismatch']], ['queued', NOTE.queued]]);
  expect(await waitMsg(shared, B1.sid, fromSession), 'B1:class-mismatch').toMatchObject({ status: 'pending', heldReason: 'class-mismatch', heldText: HELD['class-mismatch'] });
  const q = await waitMsg(shared, B2.sid, fromSession);
  expect(q && q.status, 'B2:queued').toBe('queued');

  await boot(page);
  await openSessionBySearch(page, B2.title, B2.reply);
  const card = page.locator(`[data-testid="xs-card"][data-message-id="${q.id}"]`);
  await expect(card).toHaveAttribute('data-status', 'queued', { timeout: 15_000 });
  await expect(card.getByTestId('xs-card-reason')).toHaveText(QUEUED_REASON);

  const i0 = inputRecords().filter((x) => x.cwd === B2.cwd).length;
  const t0 = Date.now();
  touchCtl(go);
  const got = await waitFor(() => (envs(B2.cwd, i0).length ? envs(B2.cwd, i0)[0] : null), 20_000);
  expect(got, 'B2 空闲后开始处理').toBeTruthy();
  expect(Date.parse(got.at) - t0, '回合结束后不早于 1.5 秒才开始处理').toBeGreaterThanOrEqual(1500);
  expect(await waitMsg(shared, B2.sid, (x) => x.id === q.id && x.status === 'done'), '处理完 done').toMatchObject({ via: 'auto' });
});

test('P12 自动处理起不来(W 仍在会话列表里,但进程进不了它的工作目录、启动失败)→ 卡片 wake-failed 不自动重试;回合开始后出错 → turn-error;被【停止】中止 → interrupted', async () => {
  await api.on();
  const run = uniq('');
  const W = seedSession(`p12-w-${run}`); const E = seedSession(`p12-e-${run}`); const S = seedSession(`p12-s-${run}`);
  await profileTurn(shared, W, 'bypassPermissions', 'R151EXIT');
  for (const s of [E, S]) await profileTurn(shared, s, 'bypassPermissions');
  for (const s of [W, E, S]) await inboundOk(shared, s.sid, 'auto');
  await new Promise((res) => setTimeout(res, 1_500));
  writeScript(`p12hold${run}`, [{ waitFile: `p12-never-${run}` }]);
  const ws = await wsT();
  // 不删 W 的工作目录(删了 W 会被会话列表跳过,工具只会回 XS_TARGET_NOT_FOUND),只去掉目录的进入(执行)权限:
  // 目录还在、W 留在会话列表里;W 的建档进程已随 R151EXIT 退出,自动处理要为 W 新起进程,而进程进不了工作目录 → 启动失败、回合没开始。
  fs.chmodSync(W.cwd, 0o600);
  try {
    expect(await entry(shared, W.sid), '前置:W 的工作目录还在 → W 仍在会话列表里').toBeTruthy();
    const r = await aiCalls(shared, { cwd: makeWorkspace(`real-p12-${run}`), steps: [
      { name: SM, input: { to: [W.sid], message: `R151C p12 起不来 ${run}` } },
      { name: SM, input: { to: [E.sid], message: `R151C p12 R151BERR ${run}` } },
      { name: SM, input: { to: [S.sid], message: `R151C p12 R151S:p12hold${run}` } },
    ] });
    expect(r.results.length, '前置:三次调用都有结果').toBe(3);
    expect(r.results.every((x) => x.json && Array.isArray(x.json.results)), `三次调用都返回 results(原文:${r.results.map((x) => x.text.slice(0, 120)).join(' | ')})`).toBe(true);

    const w = await waitMsg(shared, W.sid, (x) => fromSession(x) && x.heldReason === 'wake-failed');
    expect(w, 'W:pending / wake-failed').toMatchObject({ status: 'pending', heldReason: 'wake-failed' });
    expect(w.heldText, 'heldText = "未能开始处理：<原因>"').toMatch(/^未能开始处理：.+/);
    expect(w.heldText.length - '未能开始处理：'.length, '原因不超过 200 字').toBeLessThanOrEqual(200);
    const tW = turnRecords().filter((t) => t.sid === W.sid).length;
    await new Promise((res) => setTimeout(res, 5_000));
    expect((await msgs(shared, W.sid)).find((x) => x.id === w.id), '不自动重试').toMatchObject({ status: 'pending', heldReason: 'wake-failed' });
    expect(turnRecords().filter((t) => t.sid === W.sid).length, 'W 没有新回合').toBe(tW);

    const e = await waitMsg(shared, E.sid, (x) => fromSession(x) && x.heldReason === 'turn-error');
    expect(e, 'E:回合开始后出错 → pending / turn-error').toMatchObject({ status: 'pending', heldReason: 'turn-error', via: 'auto' });
    expect(String(e.heldText)).toMatch(/^处理该消息的回合出错：.+/);

    const sm = await waitMsg(shared, S.sid, (x) => fromSession(x) && x.status === 'processing');
    expect(sm, '前置:S 正在处理').toBeTruthy();
    const ev = ws.msgs.find((x) => x.type === 'xs:turn' && x.messageId === sm.id);
    expect(ev && ev.pid, '前置:xs:turn 给出 pid').toBeTruthy();
    const stop = await shared.post(`/api/chat/${encodeURIComponent(ev.pid)}/stop`, {});
    expect(stop.status, `前置:停止 200(${stop.text.slice(0, 200)})`).toBe(200);
    const si = await waitMsg(shared, S.sid, (x) => x.id === sm.id && x.status === 'pending');
    expect(si, 'S:被【停止】中止 → pending / interrupted').toMatchObject({ heldReason: 'interrupted', heldText: HELD.interrupted, via: 'auto' });
  } finally {
    ws.close();
    try { fs.chmodSync(W.cwd, 0o755); } catch { /* 恢复权限失败不掩盖用例本身的结果 */ }
  }
});

test('P13 自动处理不打断用户正在跑的回合:用户回合进行中消息保持 queued,用户回合完整结束后才处理', async () => {
  await api.on();
  const run = uniq('');
  const U = seedSession(`p13-u-${run}`);
  await profileTurn(shared, U, 'bypassPermissions');
  await inboundOk(shared, U.sid, 'auto');
  const go = `p13-go-${run}`;
  writeScript(`p13busy${run}`, [{ waitFile: go }, { say: `R151C p13 用户回合完成 ${run}` }]);
  const c0 = jsonl(path.join(ctlDir(), 'control.jsonl')).length;
  const user = await shared.post('/api/chat', { sessionId: U.sid, cwd: U.cwd, prompt: `R151C p13 R151S:p13busy${run}`, permissionMode: 'bypassPermissions' });
  expect(user.status, '前置:用户回合开始').toBe(200);
  expect(await waitFor(() => turnRecords().some((t) => t.sid === U.sid && t.text.includes(`p13busy${run}`)), 15_000), '前置:用户回合在跑').toBeTruthy();
  const i0 = inputRecords().filter((x) => x.cwd === U.cwd).length;
  const r = await aiCalls(shared, { cwd: makeWorkspace(`real-p13-${run}`), steps: [{ name: SM, input: { to: [U.sid], message: `R151C p13 ${run}` } }] });
  expect(resultJson(r, 0, 1)?.results?.[0]?.delivery, '目标正忙 → queued').toBe('queued');
  await new Promise((res) => setTimeout(res, 4_000));
  const q = await waitMsg(shared, U.sid, fromSession, 2_000);
  expect(q && q.status, '用户回合进行中一直是 queued').toBe('queued');
  expect(envs(U.cwd, i0), '用户回合进行中没有投递').toEqual([]);
  expect(jsonl(path.join(ctlDir(), 'control.jsonl')).slice(c0).filter((x) => x.sid === U.sid && /interrupt/i.test(String(x.request && x.request.subtype))), '没有中止用户回合').toEqual([]);
  const evsP = readStream(user.body.pid, { timeoutMs: 20_000 });
  touchCtl(go);
  const evs = await evsP;
  expect(JSON.stringify(evs), '用户回合完整跑完').toContain(`R151C p13 用户回合完成 ${run}`);
  expect(await waitFor(() => envs(U.cwd, i0).length === 1, 20_000), '用户回合结束后才处理').toBe(true);
  expect(await waitMsg(shared, U.sid, (x) => x.id === q.id && x.status === 'done'), '处理完').toBeTruthy();
});

test('P14 没有任何前端连着时自动处理的回合照常跑完;回合里需要确认的操作照常挂权限卡等人', async () => {
  await api.on();
  const run = uniq('');
  const R = seedSession(`p14-r-${run}`); const Q = seedSession(`p14-q-${run}`);
  for (const s of [R, Q]) { await profileTurn(shared, s, 'bypassPermissions'); await inboundOk(shared, s.sid, 'auto'); }
  writeScript(`p14ask${run}`, [{ canUseTool: { tool_name: 'AskUserQuestion', tool_use_id: `toolu_p14_${run}`, input: { questions: [{ question: `R151C p14 继续吗 ${run}`, header: 'r151c', multiSelect: false, options: [{ label: '是', description: '继续' }, { label: '否', description: '停止' }] }] } } }, { say: 'R151C p14 问完了' }]);
  const pr0 = jsonl(path.join(ctlDir(), 'perm-responses.jsonl')).length;
  const r = await aiCalls(shared, { cwd: makeWorkspace(`real-p14-${run}`), steps: [
    { name: SM, input: { to: [R.sid], message: `R151C p14 普通 ${run}` } },
    { name: SM, input: { to: [Q.sid], message: `R151C p14 R151S:p14ask${run}` } },
  ] });
  expect(r.results.map((x) => x.json?.results?.[0]?.delivery), '两次都是 auto').toEqual(['auto', 'auto']);
  const qm = await waitMsg(shared, Q.sid, (x) => fromSession(x) && x.status === 'processing');
  expect(qm, 'Q 开始处理').toBeTruthy();
  const pend = await waitFor(async () => { const p = await shared.get('/api/permissions/pending'); return p.text.includes(`R151C p14 继续吗 ${run}`) ? p : null; }, 15_000);
  expect(pend, '需要确认的操作挂成权限卡(GET /api/permissions/pending 里有它)').toBeTruthy();
  await new Promise((res) => setTimeout(res, 3_000));
  expect(jsonl(path.join(ctlDir(), 'perm-responses.jsonl')).slice(pr0).filter((x) => x.sid === Q.sid), '没人答复前不会被自动放行或拒绝').toEqual([]);
  expect((await msgs(shared, Q.sid)).find((x) => x.id === qm.id).status, '等人期间仍在处理').toBe('processing');
  const rd = await waitMsg(shared, R.sid, (x) => fromSession(x) && x.status === 'done', 20_000);
  expect(rd, 'R:没有前端连着也照常跑完').toMatchObject({ status: 'done', via: 'auto' });
});
