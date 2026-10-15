// 行为清单 9–11:认领、撤回、忽略。共享实例;凭据是否作废用 POST /api/chat 兑换来验(目标是假 CLI 会话)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedSession, uniq, newSid, xsDir } from './helpers/fixtures.mjs';
import { xs, expectError, chat, spawnRecords, inputRecords, ID_RE } from './helpers/api.mjs';

const api = xs();
const spawnsFor = (cwd) => spawnRecords().filter((s) => s.interactive && s.cwd === cwd).length;
const inputsFor = (cwd) => inputRecords().filter((s) => s.cwd === cwd).length;
const settle = () => new Promise((r) => setTimeout(r, 1_500));

test('X09 认领 pending → 200 {ok,id,sessionId,token}(不含信封文本),状态变 claimed;id 形状不对 → 400;不存在 → 404;非 pending → 409 XS_NOT_PENDING 附 status', async () => {
  await api.on();
  const A = seedSession(`x09-a-${uniq('')}`);
  const B = seedSession(`x09-b-${uniq('')}`);
  const marker = uniq('R151BX09BODY');
  const [m] = await api.send(A.sid, [B.sid], `${marker} 正文`);
  const r = await api.claim(m.id);
  expect(r.status, `状态码(${r.text.slice(0, 200)})`).toBe(200);
  expect(r.body, '应答只有 ok / id / sessionId / token').toEqual({ ok: true, id: m.id, sessionId: B.sid, token: expect.stringMatching(ID_RE) });
  expect(r.text, '不返回正文').not.toContain(marker);
  expect(r.text, '不返回信封文本').not.toContain('cross-session-message');
  expect(await api.find(B.sid, m.id), '状态变 claimed,heldReason 为空').toMatchObject({ status: 'claimed', heldReason: null });

  expectError(await api.claim('not-an-id'), 400, 'XS_INVALID_INPUT', undefined, 'id 形状不对');
  expectError(await api.claim(newSid()), 404, 'XS_MESSAGE_NOT_FOUND', undefined, '消息不存在');
  const again = await api.claim(m.id);
  expectError(again, 409, 'XS_NOT_PENDING', undefined, '已认领再认领');
  expect(again.body.status, '附当前 status').toBe('claimed');
  const [m2] = await api.send(A.sid, [B.sid], 'R151B x09 将被忽略');
  await api.dismiss(m2.id);
  const d = await api.claim(m2.id);
  expectError(d, 409, 'XS_NOT_PENDING', undefined, '已忽略的认领');
  expect(d.body.status).toBe('dismissed');
});

test('X10 撤回 claimed → 回到 pending、heldReason 恢复;旧凭据之后兑换失败且不起进程;对非 claimed → 409 XS_NOT_CLAIMED', async () => {
  await api.on();
  const A = seedSession(`x10-a-${uniq('')}`);
  const B = seedSession(`x10-b-${uniq('')}`);
  const [m] = await api.send(A.sid, [B.sid], 'R151B x10 正文');
  const oldToken = await api.claimOk(m.id);
  const r = await api.release(m.id);
  expect(r.status, `状态码(${r.text.slice(0, 200)})`).toBe(200);
  expect(r.body).toEqual({ ok: true, id: m.id, status: 'pending' });
  expect(await api.find(B.sid, m.id), 'heldReason 恢复为认领前的值').toMatchObject({ status: 'pending', heldReason: 'target-card', heldText: '等待你确认后处理' });

  const newToken = await api.claimOk(m.id);
  expect(newToken, '重新认领拿到新凭据').not.toBe(oldToken);
  const s0 = spawnsFor(B.cwd);
  const i0 = inputsFor(B.cwd);
  const c = await chat({ sessionId: B.sid, cwd: B.cwd, prompt: 'x', xsMessageId: m.id, xsToken: oldToken });
  expectError(c, 409, 'XS_CLAIM_INVALID', undefined, '撤回前的旧凭据');
  await settle();
  expect(spawnsFor(B.cwd), '不起进程').toBe(s0);
  expect(inputsFor(B.cwd), '不发任何内容').toBe(i0);
  expect((await api.find(B.sid, m.id)).status, '消息仍是 claimed').toBe('claimed');

  expect((await api.release(m.id)).status, '前置:再撤回').toBe(200);
  const r2 = await api.release(m.id);
  expectError(r2, 409, 'XS_NOT_CLAIMED', undefined, '对 pending 撤回');
  expect(r2.body.status, '附当前 status').toBe('pending');
  expectError(await api.release('not-an-id'), 400, 'XS_INVALID_INPUT', undefined, 'id 形状不对');
  expectError(await api.release(newSid()), 404, 'XS_MESSAGE_NOT_FOUND', undefined, '消息不存在');
});

test('X11 忽略 pending / claimed → dismissed,之后 body 为 null 且正文文件删除;认领过的凭据随之作废;再忽略 → 409 XS_NOT_PENDING', async () => {
  await api.on();
  const A = seedSession(`x11-a-${uniq('')}`);
  const B = seedSession(`x11-b-${uniq('')}`);
  const [m1] = await api.send(A.sid, [B.sid], 'R151B x11 待忽略');
  const bodyFile = path.join(xsDir(), 'bodies', `${m1.id}.txt`);
  expect(fs.existsSync(bodyFile), `前置:正文存于 ${bodyFile}`).toBe(true);
  const r = await api.dismiss(m1.id);
  expect(r.status, `状态码(${r.text.slice(0, 200)})`).toBe(200);
  expect(r.body).toEqual({ ok: true, id: m1.id, status: 'dismissed' });
  expect(await api.find(B.sid, m1.id), '忽略后正文为 null').toMatchObject({ status: 'dismissed', body: null, heldReason: null });
  expect(fs.existsSync(bodyFile), '正文文件已删除').toBe(false);

  const [m2] = await api.send(A.sid, [B.sid], 'R151B x11 认领后忽略');
  const token = await api.claimOk(m2.id);
  expect((await api.dismiss(m2.id)).status, 'claimed 也可以忽略').toBe(200);
  const s0 = spawnsFor(B.cwd);
  expectError(await chat({ sessionId: B.sid, cwd: B.cwd, prompt: 'x', xsMessageId: m2.id, xsToken: token }), 409, 'XS_CLAIM_INVALID', undefined, '忽略后旧凭据');
  await settle();
  expect(spawnsFor(B.cwd), '不起进程').toBe(s0);

  const again = await api.dismiss(m1.id);
  expectError(again, 409, 'XS_NOT_PENDING', undefined, '对已忽略再忽略');
  expect(again.body.status).toBe('dismissed');
  expectError(await api.dismiss('not-an-id'), 400, 'XS_INVALID_INPUT', undefined, 'id 形状不对');
  expectError(await api.dismiss(newSid()), 404, 'XS_MESSAGE_NOT_FOUND', undefined, '消息不存在');
});
