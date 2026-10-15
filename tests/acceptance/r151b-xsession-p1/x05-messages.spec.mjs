// 行为清单 5–8:手动转发接口、校验顺序、目标不存在 / 收件箱满、收件列表。共享实例。
import { test, expect } from '@playwright/test';
import { seedSession, uniq, newSid } from './helpers/fixtures.mjs';
import { xs, expectError, wsCollector, ID_RE } from './helpers/api.mjs';

const api = xs();
const idsOf = (r) => (r.body && Array.isArray(r.body.messages) ? r.body.messages.map((m) => m.id) : `应答:${r.status} ${r.text.slice(0, 200)}`);
const ALL = 'pending,queued,claimed,processing,done,dismissed';

test('X05 开关开:转发给 [B,C] → 200 每个目标一条 pending;B 的收件列表能看到(target-card / 等待你确认后处理 / from.kind=user);广播的 xs:message 不含正文', async () => {
  await api.on();
  const A = seedSession(`x05-a-${uniq('')}`);
  const B = seedSession(`x05-b-${uniq('')}`);
  const C = seedSession(`x05-c-${uniq('')}`);
  const ws = await wsCollector();
  try {
    const marker = uniq('R151BX05BODY');
    const body = `${marker} 第一行\n第二行:中文、emoji 😀、引号 "q"`;
    const r = await api.post({ to: [B.sid, C.sid], body, fromSessionId: A.sid });
    expect(r.status, `状态码(${r.text.slice(0, 300)})`).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.messages.map((m) => ({ ...m, id: ID_RE.test(m.id) ? 'ID' : m.id })), '每个目标一项').toEqual([
      { id: 'ID', to: { sessionId: B.sid, title: B.title }, status: 'pending' },
      { id: 'ID', to: { sessionId: C.sid, title: C.title }, status: 'pending' },
    ]);
    const idB = r.body.messages[0].id;
    const l = await api.list(B.sid);
    expect(l.status).toBe(200);
    expect(idsOf(l), 'B 收到一条').toEqual([idB]);
    const m = l.body.messages[0];
    expect(m, '消息对象').toMatchObject({
      id: idB, status: 'pending', hop: 1, via: null, heldReason: 'target-card', heldText: '等待你确认后处理',
      from: { kind: 'user', sessionId: A.sid, title: A.title }, to: { sessionId: B.sid, title: B.title },
      body, bodyBytes: Buffer.byteLength(body, 'utf8'),
    });
    expect(typeof m.chainId === 'string' && m.chainId.length > 0, 'chainId 非空').toBe(true);
    expect(Number.isNaN(Date.parse(m.createdAt)), 'createdAt 是时间字符串').toBe(false);
    expect(idsOf(await api.list(C.sid)), 'C 也收到一条').toEqual([r.body.messages[1].id]);

    const ev = await ws.waitFor((x) => x && x.type === 'xs:message' && x.message && x.message.id === idB);
    expect(ev, '应广播 xs:message').not.toBeNull();
    expect(ev.message, '广播的消息对象不带 body').not.toHaveProperty('body');
    for (const e of ws.ofType('xs:message')) expect(JSON.stringify(e), '广播里不应出现正文片段').not.toContain(marker);
  } finally { ws.close(); }
});

test('X06 转发按顺序校验,命中第一条即整次拒绝、一条不发(非法输入 / 目标超 8 个 / 正文超 32768 字节 / 目标含自己 / 来源不存在)', async () => {
  await api.on();
  const A = seedSession(`x06-a-${uniq('')}`);
  const B = seedSession(`x06-b-${uniq('')}`);
  const nine = Array.from({ length: 9 }, () => newSid());
  const ghost = newSid();
  const big = 'a'.repeat(32769);
  const cases = [
    ['请求体不是对象', '[1]', 400, 'XS_INVALID_INPUT'],
    ['to 不是数组', { to: B.sid, body: 'x' }, 400, 'XS_INVALID_INPUT'],
    ['to 是空数组', { to: [], body: 'x' }, 400, 'XS_INVALID_INPUT'],
    ['to 含形状不对的 id', { to: [B.sid, 'not-an-id'], body: 'x' }, 400, 'XS_INVALID_INPUT'],
    ['body 不是字符串', { to: [B.sid], body: 5 }, 400, 'XS_INVALID_INPUT'],
    ['body 去空白后为空', { to: [B.sid], body: ' \n\t　 ' }, 400, 'XS_INVALID_INPUT'],
    ['fromSessionId 形状不对', { to: [B.sid], body: 'x', fromSessionId: 'bad' }, 400, 'XS_INVALID_INPUT'],
    ['出现其它键', { to: [B.sid], body: 'x', fromSessionId: A.sid, immediate: true }, 400, 'XS_INVALID_INPUT'],
    ['非法输入 + 目标超 8 个 → 先判非法输入', { to: [...nine, 'bad'], body: 'x' }, 400, 'XS_INVALID_INPUT'],
    ['去重后 9 个目标', { to: nine, body: 'x' }, 400, 'XS_TOO_MANY_TARGETS'],
    ['目标超 8 个 + 正文超长 → 先判目标数', { to: nine, body: big }, 400, 'XS_TOO_MANY_TARGETS'],
    ['正文 32769 字节', { to: [B.sid], body: big }, 400, 'XS_BODY_TOO_LARGE'],
    ['正文 32769 字节(多字节字符)', { to: [B.sid], body: '汉'.repeat(10923) }, 400, 'XS_BODY_TOO_LARGE'],
    ['正文超长 + 目标含自己 → 先判正文', { to: [A.sid], body: big, fromSessionId: A.sid }, 400, 'XS_BODY_TOO_LARGE'],
    ['目标含自己', { to: [B.sid, A.sid], body: 'x', fromSessionId: A.sid }, 400, 'XS_SELF_TARGET'],
    ['目标含自己 + 来源不存在 → 先判自己', { to: [ghost], body: 'x', fromSessionId: ghost }, 400, 'XS_SELF_TARGET'],
    ['来源会话不存在', { to: [B.sid], body: 'x', fromSessionId: newSid() }, 404, 'XS_SOURCE_NOT_FOUND'],
    ['来源不存在 + 目标不存在 → 先判来源', { to: [newSid()], body: 'x', fromSessionId: newSid() }, 404, 'XS_SOURCE_NOT_FOUND'],
    ['10 个 id 去重后 8 个 → 不算超量(目标不存在)', { to: [...nine.slice(0, 8), nine[0], nine[1]], body: 'x' }, 404, 'XS_TARGET_NOT_FOUND'],
  ];
  for (const [label, body, status, code] of cases) expectError(await api.post(body), status, code, undefined, label);
  expect(idsOf(await api.list(B.sid, ALL)), '被拒的请求一条都没发').toEqual([]);

  const ok = await api.post({ to: [B.sid], body: 'b'.repeat(32768), fromSessionId: A.sid });
  expect(ok.status, `正文恰好 32768 字节可以发(${ok.text.slice(0, 200)})`).toBe(200);
  expect(ok.body.messages.length).toBe(1);
  const noFrom = await api.post({ to: [B.sid], body: '没有来源会话' });
  expect(noFrom.status, `不给 fromSessionId 也可以(${noFrom.text.slice(0, 200)})`).toBe(200);
  const mm = await api.find(B.sid, noFrom.body.messages[0].id);
  expect(mm && mm.from, '没有来源会话时 from.sessionId 为 null').toMatchObject({ kind: 'user', sessionId: null });
});

test('X07 目标不存在 → 404 XS_TARGET_NOT_FOUND 附 targets;目标已有 50 条待处理 → 409 XS_INBOX_FULL 附 targets;两种情况其它合法目标都没收到', async () => {
  await api.on();
  const A = seedSession(`x07-a-${uniq('')}`);
  const B = seedSession(`x07-b-${uniq('')}`);
  const C = seedSession(`x07-c-${uniq('')}`);
  const g1 = newSid();
  const g2 = newSid();
  const r = await api.post({ to: [B.sid, g1, g2], body: 'R151B x07 不存在', fromSessionId: A.sid });
  expectError(r, 404, 'XS_TARGET_NOT_FOUND', undefined, '目标不存在');
  expect([...(r.body.targets || [])].sort(), 'targets 列出不存在的 id').toEqual([g1, g2].sort());
  expect(idsOf(await api.list(B.sid, ALL)), '合法目标 B 一条都没收到').toEqual([]);

  for (let i = 0; i < 50; i += 1) await api.send(A.sid, [C.sid], `R151B x07 填满 ${i}`);
  const full = await api.post({ to: [B.sid, C.sid], body: 'R151B x07 第 51 条', fromSessionId: A.sid });
  expectError(full, 409, 'XS_INBOX_FULL', undefined, '收件箱满');
  expect(full.body.targets, 'targets 列出满的目标').toEqual([C.sid]);
  expect(idsOf(await api.list(B.sid, ALL)), '合法目标 B 一条都没收到').toEqual([]);
  const cl = await api.list(C.sid, 'pending');
  expect(cl.body.messages.length, 'C 仍是 50 条').toBe(50);
  for (const m of cl.body.messages) await api.dismiss(m.id);
});

test('X08 收件列表:按到达时间升序;默认只含 pending,queued,claimed,processing;缺 sessionId / 形状不对 / status 非法 → 400;会话不存在 → 200 {messages:[]}', async () => {
  await api.on();
  const A = seedSession(`x08-a-${uniq('')}`);
  const B = seedSession(`x08-b-${uniq('')}`);
  const ids = [];
  for (const t of ['一', '二', '三', '四']) ids.push((await api.send(A.sid, [B.sid], `R151B x08 ${t}`))[0].id);
  const [m1, m2, m3, m4] = ids;
  expect((await api.dismiss(m2)).status, '前置:忽略第二条').toBe(200);
  await api.claimOk(m4);
  const def = await api.list(B.sid);
  expect(def.status).toBe(200);
  expect(idsOf(def), '默认不含 dismissed,按到达升序').toEqual([m1, m3, m4]);
  expect(def.body.messages.map((m) => m.status)).toEqual(['pending', 'pending', 'claimed']);
  expect(idsOf(await api.list(B.sid, 'dismissed')), 'status=dismissed').toEqual([m2]);
  expect(idsOf(await api.list(B.sid, 'pending,dismissed')), 'status 多值').toEqual([m1, m2, m3]);
  expect(idsOf(await api.list(B.sid, 'queued')), 'queued 是合法值').toEqual([]);
  expectError(await api.list(B.sid, 'pending,foo'), 400, 'XS_INVALID_INPUT', undefined, 'status 含非法值');
  expectError(await api.list(B.sid, 'expired'), 400, 'XS_INVALID_INPUT', undefined, 'status 非法');
  expectError(await xs().list('not-a-session-id'), 400, 'XS_INVALID_INPUT', undefined, 'sessionId 形状不对');
  const { get } = await import('./helpers/api.mjs');
  expectError(await get('/api/xsession/messages'), 400, 'XS_INVALID_INPUT', undefined, '缺 sessionId');
  const none = await api.list(newSid());
  expect(none.status).toBe(200);
  expect(none.body, '会话不存在').toEqual({ messages: [] });
});
