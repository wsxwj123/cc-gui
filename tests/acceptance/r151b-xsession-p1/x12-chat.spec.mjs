// 行为清单 12–15:POST /api/chat 兑换凭据、新字段的错误契约、clientTurnId 幂等、出错与重启后的状态。
// 目标会话是假 CLI 会话:假 CLI 把从 stdin 收到的每条用户消息原文记进 inputs.jsonl(= "目标会话进程收到的那条用户消息")。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedSession, uniq, newSid, xsDir } from './helpers/fixtures.mjs';
import { startInstance } from './helpers/instance.mjs';
import {
  xs, expectError, chat, readStream, waitFor, spawnRecords, inputRecords, writeScript, envelope, cleanName, CLAIM_INVALID_TEXT,
} from './helpers/api.mjs';

const api = xs();
const spawnsFor = (cwd) => spawnRecords().filter((s) => s.interactive && s.cwd === cwd).length;
const inputsFor = (cwd) => inputRecords().filter((s) => s.cwd === cwd);
const settle = () => new Promise((r) => setTimeout(r, 1_500));

test('X12 用认领凭据 POST /api/chat → 目标进程收到的用户消息恰好是信封;事件流有一条 xs_message;回合结束后 done、正文删除', async () => {
  await api.on();
  const A = seedSession(`x12-a-${uniq('')}`);
  const B = seedSession(`x12-b-${uniq('')}`);
  const body = `R151B x12 第一行\n第二行 ${uniq('M')}`;
  const [m] = await api.send(A.sid, [B.sid], body);
  const srcTitle = (await api.find(B.sid, m.id)).from.title;
  const token = await api.claimOk(m.id);
  const before = inputsFor(B.cwd).length;
  const r = await chat({ sessionId: B.sid, cwd: B.cwd, prompt: 'x', xsMessageId: m.id, xsToken: token });
  expect(r.status, `兑换应 200(${r.text.slice(0, 300)})`).toBe(200);
  const evs = await readStream(r.body.pid, { timeoutMs: 25_000 });
  const got = await waitFor(() => { const l = inputsFor(B.cwd).slice(before); return l.length ? l : null; }, 10_000);
  expect((got || []).map((x) => x.content), '进程收到的用户消息恰好是信封(prompt 的内容被忽略)')
    .toEqual([envelope('gui:user', cleanName(`用户转发自 ${srcTitle}`), body)]);
  const xm = evs.filter((e) => e && e.type === 'xs_message');
  expect(xm.length, `事件流里应恰有一条 xs_message(事件类型:${evs.map((e) => e.type).join(',')})`).toBe(1);
  expect(xm[0]).toMatchObject({ id: m.id, via: 'card', hop: 1, from: { kind: 'user', sessionId: A.sid } });
  expect(xm[0], 'xs_message 和其它事件一样带 runId 与 seq').toEqual(expect.objectContaining({ runId: expect.anything(), seq: expect.anything() }));
  const firstAssistant = evs.findIndex((e) => e && e.type === 'assistant');
  expect(firstAssistant < 0 || evs.indexOf(xm[0]) < firstAssistant, 'xs_message 排在模型输出之前').toBe(true);
  const done = await api.waitStatus(B.sid, m.id, 'done');
  expect(done, '回合正常结束 → done,正文删除').toMatchObject({ status: 'done', via: 'card', body: null, heldReason: null });
  expect(fs.existsSync(path.join(xsDir(), 'bodies', `${m.id}.txt`)), '正文文件已删除').toBe(false);
});

test('X13 /api/chat 新字段:只带一个或形状不对 → 400;凭据不对 / 非 claimed / 目标不符 → 409 XS_CLAIM_INVALID;开关关 → 409 XS_DISABLED;都不起进程;两个都不带与改动前相同', async () => {
  await test.step('两个新字段都不带:普通回合照常,进程收到的就是 prompt 原文', async () => {
    const N = seedSession(`x13-n-${uniq('')}`);
    const prompt = `R151B x13 普通回合 ${uniq('P')} R151EXIT`;
    const ok = await chat({ sessionId: N.sid, cwd: N.cwd, prompt });
    expect(ok.status, `普通回合 200(${ok.text.slice(0, 200)})`).toBe(200);
    const got = await waitFor(() => inputsFor(N.cwd).length ? inputsFor(N.cwd) : null, 15_000);
    const asText = (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : c));
    expect((got || []).map((x) => asText(x.content)), '进程收到的就是 prompt 原文').toEqual([prompt]);
  });

  await api.on();
  const A = seedSession(`x13-a-${uniq('')}`);
  const B = seedSession(`x13-b-${uniq('')}`);
  const C = seedSession(`x13-c-${uniq('')}`);
  const [m] = await api.send(A.sid, [B.sid], 'R151B x13 已认领');
  const [p] = await api.send(A.sid, [B.sid], 'R151B x13 未认领');
  const token = await api.claimOk(m.id);
  const s0 = { B: spawnsFor(B.cwd), C: spawnsFor(C.cwd) };
  const i0 = { B: inputsFor(B.cwd).length, C: inputsFor(C.cwd).length };
  const req = (t, extra) => chat({ sessionId: t.sid, cwd: t.cwd, prompt: 'x', ...extra });
  for (const [label, extra] of [
    ['只带 xsMessageId', { xsMessageId: m.id }], ['只带 xsToken', { xsToken: token }],
    ['xsMessageId 形状不对', { xsMessageId: 'not-an-id', xsToken: token }], ['xsToken 不是字符串', { xsMessageId: m.id, xsToken: 123 }],
  ]) expectError(await req(B, extra), 400, 'XS_CLAIM_INVALID', CLAIM_INVALID_TEXT, label);
  for (const [label, t, extra] of [
    ['凭据对不上', B, { xsMessageId: m.id, xsToken: newSid() }], ['消息不存在', B, { xsMessageId: newSid(), xsToken: token }],
    ['消息不是 claimed', B, { xsMessageId: p.id, xsToken: token }], ['消息目标不是请求的 sessionId', C, { xsMessageId: m.id, xsToken: token }],
  ]) expectError(await req(t, extra), 409, 'XS_CLAIM_INVALID', undefined, label);
  await api.off();
  expectError(await req(B, { xsMessageId: m.id, xsToken: token }), 409, 'XS_DISABLED', '跨会话消息未开启', '总开关关');
  await settle();
  expect({ B: spawnsFor(B.cwd), C: spawnsFor(C.cwd) }, '以上都不起进程').toEqual(s0);
  expect({ B: inputsFor(B.cwd).length, C: inputsFor(C.cwd).length }, '以上都不发任何内容').toEqual(i0);
});

test('X14 同一 clientTurnId 重发已兑换过的请求 → 应答与第一次相同,消息不会被再处理一次', async () => {
  await api.on();
  const A = seedSession(`x14-a-${uniq('')}`);
  const B = seedSession(`x14-b-${uniq('')}`);
  const [m] = await api.send(A.sid, [B.sid], 'R151B x14 只处理一次');
  const token = await api.claimOk(m.id);
  const body = { sessionId: B.sid, cwd: B.cwd, prompt: 'x', xsMessageId: m.id, xsToken: token, clientTurnId: `r151b-x14-${uniq('')}` };
  const r1 = await chat(body);
  expect(r1.status, `第一次兑换 200(${r1.text.slice(0, 200)})`).toBe(200);
  await readStream(r1.body.pid, { timeoutMs: 25_000 });
  expect((await api.waitStatus(B.sid, m.id, 'done')).status, '前置:第一次处理完').toBe('done');
  const r2 = await chat(body);
  expect(r2.status, '重发的状态码相同').toBe(r1.status);
  expect(r2.body, '重发的应答相同').toEqual(r1.body);
  await settle();
  const envs = inputsFor(B.cwd).filter((x) => typeof x.content === 'string' && x.content.startsWith('<cross-session-message'));
  expect(envs.length, '信封只投递过一次').toBe(1);
  expect((await api.find(B.sid, m.id)).status).toBe('done');
});

test('X15 处理消息的回合以错误结束 → pending / turn-error;服务重启后,重启前 processing 或 claimed 的消息 → pending / interrupted', async () => {
  await test.step('回合以错误结束', async () => {
    await api.on();
    const A = seedSession(`x15-a-${uniq('')}`);
    const B = seedSession(`x15-b-${uniq('')}`);
    const body = 'R151B x15 R151BERR 这一回合会出错';
    const [m] = await api.send(A.sid, [B.sid], body);
    const token = await api.claimOk(m.id);
    const r = await chat({ sessionId: B.sid, cwd: B.cwd, prompt: 'x', xsMessageId: m.id, xsToken: token });
    expect(r.status, `兑换 200(${r.text.slice(0, 200)})`).toBe(200);
    await readStream(r.body.pid, { timeoutMs: 25_000 });
    const back = await waitFor(async () => { const x = await api.find(B.sid, m.id); return x && x.heldReason === 'turn-error' ? x : null; }, 15_000);
    expect(back, '应回到 pending / turn-error').not.toBeNull();
    expect(back).toMatchObject({ status: 'pending', heldReason: 'turn-error', via: 'card', body });
    expect(String(back.heldText), 'heldText = "处理该消息的回合出错:<摘要>"').toMatch(/^处理该消息的回合出错：.+/);
  });
  await test.step('服务重启', async () => {
    const inst = await startInstance('x15');
    try {
      const ia = xs(inst.c, inst.home);
      await ia.on();
      const A = seedSession(`x15r-a-${uniq('')}`, { home: inst.home });
      const B = seedSession(`x15r-b-${uniq('')}`, { home: inst.home });
      const C = seedSession(`x15r-c-${uniq('')}`, { home: inst.home });
      writeScript('x15hold', [{ waitFile: 'x15-never' }], inst.ctl);
      const [mp] = await ia.send(A.sid, [B.sid], 'R151B x15 R151S:x15hold 处理中被重启');
      const tok = await ia.claimOk(mp.id);
      const rc = await chat({ sessionId: B.sid, cwd: B.cwd, prompt: 'x', xsMessageId: mp.id, xsToken: tok }, inst.c);
      expect(rc.status, `兑换 200(${rc.text.slice(0, 200)})`).toBe(200);
      expect((await ia.waitStatus(B.sid, mp.id, 'processing')).status, '前置:处理中').toBe('processing');
      const [mc] = await ia.send(A.sid, [C.sid], 'R151B x15 认领后被重启');
      await ia.claimOk(mc.id);
      const [mq] = await ia.send(A.sid, [C.sid], 'R151B x15 pending 原样');
      await inst.restart();
      const ib = xs(inst.c, inst.home);
      expect(await ib.find(B.sid, mp.id), '重启前 processing').toMatchObject({ status: 'pending', heldReason: 'interrupted', heldText: '上次处理被中断' });
      expect(await ib.find(C.sid, mc.id), '重启前 claimed').toMatchObject({ status: 'pending', heldReason: 'interrupted', heldText: '上次处理被中断' });
      expect(await ib.find(C.sid, mq.id), '重启前 pending 原样').toMatchObject({ status: 'pending', heldReason: 'target-card' });
    } finally { await inst.stop(); }
  });
});
