#!/usr/bin/env node
// R13「会话流与子代理」服务端合同的白盒护栏(INTERFACE.md 该节 + 边界矩阵 chat/agent 行)。
// 直接 import chat.js 的真函数(非复刻):把下面任一判据改回去,断言必须失败。
//
// 锁定的行为:
//   ① POST /api/chat 输入闸门:空/空白/非字符串 prompt、非法 clientTurnId、缺 cwd、
//      未来 createdAt、超 24h、旧 serverEpoch —— 每种都有自己的状态码与稳定短码。
//   ② canonical turn 指纹:同参同指纹、异参异指纹,且 draft→真实 sid 不算异参。
//   ③ turn 账本:命中/结算只发生一次、终态枚举、24h 保留、512 上限不驱逐活跃记录。
//   ④ SSE:afterSeq 只认非负安全整数;事件盖章 runId+seq 且 SSE id = runId:seq;
//      带游标重放只回 seq>游标;环形窗随回合清空(seq 不重置)。
import assert from 'node:assert/strict';
import {
  validateChatTurnInput,
  chatTurnFingerprint,
  turnPrincipal,
  findTurnRecord,
  openTurnRecord,
  pruneTurnRecords,
  settleTurnRecord,
  turnLiveStatus,
  withTurnLock,
  parseAfterSeq,
  replayEventLog,
  sseFrame,
  stopIdentity,
  stopIdentityMismatch,
  streamCursorGate,
  stampStreamNotice,
  stampRunEvent,
  armTurnStartup,
  noteTurnFirstLine,
  waitTurnStartup,
} from '../../server/routes/chat.js';
import { readFileSync } from 'node:fs';
import { SERVER_EPOCH } from '../../server/utils/server-epoch.js';

const CWD = '/tmp/r13-unit';
const body = (over = {}) => ({ prompt: 'hello', cwd: CWD, ...over });

// ── ① 输入闸门 ────────────────────────────────────────────────────
{
  const bad = (over, status, code) => {
    const r = validateChatTurnInput(body(over));
    assert.equal(r.ok, false, `应当拒绝:${JSON.stringify(over)}`);
    assert.equal(r.status, status, `状态码:${JSON.stringify(over)}`);
    assert.equal(r.code, code, `稳定短码:${JSON.stringify(over)}`);
    assert.ok(r.error.length > 0 && r.error.length <= 300, 'error 是可读短句且 ≤300 字符');
    assert.ok(!/\n\s+at\s/.test(r.error), 'error 不含调用堆栈');
  };
  bad({ prompt: '' }, 400, 'CHAT_INVALID_INPUT');
  bad({ prompt: '  \n\t ' }, 400, 'CHAT_INVALID_INPUT');
  bad({ prompt: 20260911 }, 400, 'CHAT_INVALID_INPUT');
  bad({ prompt: null }, 400, 'CHAT_INVALID_INPUT');
  bad({ clientTurnId: 'a'.repeat(65) }, 400, 'CHAT_INVALID_INPUT');
  bad({ clientTurnId: '' }, 400, 'CHAT_INVALID_INPUT');
  bad({ clientTurnId: 'sb t04!中文' }, 400, 'CHAT_INVALID_INPUT');
  bad({ clientTurnId: 'a'.repeat(64) + '.', }, 400, 'CHAT_INVALID_INPUT');
  bad({ cwd: undefined }, 400, 'CHAT_INVALID_CWD');
  bad({ cwd: '' }, 400, 'CHAT_INVALID_CWD');
  bad({ cwd: 42 }, 400, 'CHAT_INVALID_CWD');
  bad({ createdAt: new Date(Date.now() + 6 * 3600e3).toISOString() }, 400, 'CHAT_INVALID_INPUT');
  bad({ createdAt: 'not-a-time' }, 400, 'CHAT_INVALID_INPUT');
  bad({ createdAt: new Date(Date.now() - 25 * 3600e3).toISOString() }, 409, 'TURN_EXPIRED');
  bad({ serverEpoch: 'stale-epoch-xyz' }, 409, 'TURN_SERVER_CHANGED');

  assert.equal(validateChatTurnInput(body()).ok, true, '正常载荷必须放行');
  assert.equal(
    validateChatTurnInput(body({ createdAt: new Date(Date.now() - 1000).toISOString() })).ok,
    true, '24h 窗口内的 createdAt 合法');
  assert.equal(
    validateChatTurnInput(Object.assign(body(), { clientTurnId: 'a'.repeat(64), serverEpoch: SERVER_EPOCH })).ok,
    true, '64 位 clientTurnId 与本实例 epoch 合法');
  assert.equal(
    validateChatTurnInput(Object.assign(body(), { createdAt: Date.now() - 1000 })).ok,
    true, '数字型 createdAt 同样按时刻解析');
  // 请求体不是对象(数组/null/字符串)一律按非法处理,不能崩
  assert.equal(validateChatTurnInput(null).ok, false, 'null body 必须拒绝');
  assert.equal(validateChatTurnInput([]).ok, false, '数组 body 必须拒绝');
}

// ── ② 参数指纹 ────────────────────────────────────────────────────
{
  const fp = (b, extra) => chatTurnFingerprint(b, { prompt: String(b.prompt), cwd: b.cwd, model: 'm1', ...extra });
  assert.equal(fp(body()), fp(body()), '同一组参数恒等');
  assert.notEqual(fp(body()), fp(body({ prompt: 'other' })), 'prompt 变了就是异参');
  assert.notEqual(fp(body()), fp(body({ cwd: '/tmp/other' })), 'cwd 变了就是异参');
  assert.notEqual(fp(body()), fp(body({ effort: 'high' })), 'effort 是发送设置,计入指纹');
  assert.notEqual(fp(body()), fp(body({ keepAlive: false })), 'keepAlive 计入指纹');
  assert.notEqual(fp(body()), fp(body({ addDirs: ['/a'] })), 'addDirs 计入指纹');
  assert.equal(fp(body({ addDirs: ['/a', '/b'] })), fp(body({ addDirs: ['/b', '/a'] })), 'addDirs 顺序无关');
  // draft→真实 sid 是同一个 canonical turn:sessionId/draftId 绝不进指纹
  assert.equal(fp(body({ sessionId: 'sid-1' })), fp(body({ sessionId: 'sid-2' })), 'sessionId 不计入指纹');
  assert.equal(fp(body({ draftId: 'd1' })), fp(body({ draftId: 'd2', sessionId: 'sid-9' })), 'draft 迁移前后同指纹');
  assert.notEqual(
    chatTurnFingerprint(body(), { prompt: 'hello', cwd: CWD, model: 'm2' }),
    chatTurnFingerprint(body(), { prompt: 'hello', cwd: CWD, model: 'm1' }),
    '解析后的 model 不同就是异参');
}

// ── ③ turn 账本:结算只一次 / 终态枚举 / 容量 / TTL ─────────────────
{
  const key = 'local|unit-turn-1';
  const rec = openTurnRecord({ key, principal: 'local', clientTurnId: 'unit-turn-1', fingerprint: 'fp' });
  assert.ok(rec, '登记应当成功');
  assert.equal(rec.status, 'pending');
  assert.equal(rec.serverEpoch, SERVER_EPOCH, '记录绑定本服务实例的 epoch');
  assert.equal(findTurnRecord('local', 'unit-turn-1'), rec, '按 (主体, clientTurnId) 命中');
  assert.equal(findTurnRecord('token', 'unit-turn-1'), null, '别的主体撞不进我的回合');

  // 未结算:该 slot 仍是当前回合 → running / stopping
  const slot = { turnEpoch: 0 };
  rec.turnEpoch = 0;
  assert.equal(turnLiveStatus(rec, slot), 'running');
  rec.stopRequested = true;
  assert.equal(turnLiveStatus(rec, slot), 'stopping');
  rec.stopRequested = false;

  // 结算:幂等,且只认合同枚举(非法值一律归 completed)
  settleTurnRecord(rec, 'stopped');
  assert.equal(rec.status, 'stopped');
  const firstSettledAt = rec.settledAt;
  settleTurnRecord(rec, 'completed');
  assert.equal(rec.status, 'stopped', '第二次结算不得覆盖已有终态');
  assert.equal(rec.settledAt, firstSettledAt, 'settledAt 不变');
  assert.ok(['running', 'stopping', 'completed', 'failed', 'stopped'].includes(rec.status), 'status 取自合同枚举');

  const weird = openTurnRecord({ key: 'local|unit-turn-weird', principal: 'local', clientTurnId: 'x', fingerprint: 'fp' });
  settleTurnRecord(weird, 'not-a-status');
  assert.equal(weird.status, 'completed', '非法终态一律归 completed');

  // 已结算 → 对外只报真实终态(与 slot 在不在无关)
  assert.equal(turnLiveStatus(rec, null), 'stopped');
  assert.equal(turnLiveStatus(rec, { turnEpoch: 7 }), 'stopped');

  // 24h 保留:刚结算的记录不许被清
  pruneTurnRecords(Date.now());
  assert.ok(findTurnRecord('local', 'unit-turn-1'), '未到期的结束记录必须留着(重复 stop 要能回终态)');
  pruneTurnRecords(Date.now() + 25 * 3600e3);
  assert.equal(findTurnRecord('local', 'unit-turn-1'), null, '超过 24h 的结束记录可以回收');
}

// ── ③ 容量:满 512 拒新 turn,且不驱逐活跃记录 ──────────────────────
{
  // 先造 511 条已结束(会被 TTL 清掉的)记录 + 1 条活跃记录,合计 512
  for (let i = 0; i < 511; i += 1) {
    const r = openTurnRecord({ key: `local|cap-fill-${i}`, principal: 'local', clientTurnId: `cap-fill-${i}`, fingerprint: 'fp' });
    assert.ok(r, `填充第 ${i} 条应当成功`);
    settleTurnRecord(r, 'completed');
  }
  const active = openTurnRecord({ key: 'local|cap-live', principal: 'local', clientTurnId: 'cap-live', fingerprint: 'fp' });
  assert.ok(active, '第 512 条应当成功');

  // 批次8-项12:满额时先驱逐结束最早的已结束记录(否则 24h 内发满 512 条后每次发送都 503);
  // 全部活跃才拒绝(503 TURN_CAPACITY)—— 那条由 check-q8-turn-capacity 的 Q8-12a 守。
  assert.ok(
    openTurnRecord({ key: 'local|cap-over', principal: 'local', clientTurnId: 'cap-over', fingerprint: 'fp' }),
    '满 512 但有已结束记录时,新 turn 应驱逐结束最早的那条后登记');
  assert.equal(findTurnRecord('local', 'cap-fill-0'), null, '被驱逐的应是结束最早的记录');
  assert.ok(findTurnRecord('local', 'cap-live'), '满额时活跃 turn 一条都不许驱逐');

  // 结束记录过了 24h → 腾出位置,新 turn 又能登记(活跃记录仍不被驱逐)
  pruneTurnRecords(Date.now() + 25 * 3600e3);
  assert.ok(findTurnRecord('local', 'cap-live'), '过期回收不得碰活跃 turn');
  assert.ok(
    openTurnRecord({ key: 'local|cap-after', principal: 'local', clientTurnId: 'cap-after', fingerprint: 'fp' }),
    '回收过期记录后应当腾出位置');
}

// ── ③ 并发同 id:串行化后第二根请求看得到第一根的登记 ────────────────
{
  const order = [];
  const key = 'local|unit-lock-1';
  let firstRec = null;
  const slow = withTurnLock(key, async () => {
    order.push('a:start');
    await new Promise((r) => setTimeout(r, 30));
    firstRec = openTurnRecord({ key, principal: 'local', clientTurnId: 'unit-lock-1', fingerprint: 'fp' });
    order.push('a:end');
    return firstRec;
  });
  const fast = withTurnLock(key, async () => {
    order.push('b:start');
    const hit = findTurnRecord('local', 'unit-lock-1');
    order.push('b:end');
    return hit;
  });
  const [a, b] = await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'], '同一 clientTurnId 的并发请求必须串行');
  assert.equal(a, firstRec);
  assert.equal(b, firstRec, '后到的请求命中的是同一条记录(合并成一个 run,不新起第二个)');

  // 不同 id 互不阻塞
  const t0 = Date.now();
  await Promise.all([
    withTurnLock('local|k-a', () => new Promise((r) => setTimeout(r, 40))),
    withTurnLock('local|k-b', () => new Promise((r) => setTimeout(r, 40))),
  ]);
  assert.ok(Date.now() - t0 < 80, '不同 clientTurnId 之间不串行');
}

// ── ④ 游标与事件盖章 ──────────────────────────────────────────────
{
  const ok = (v, expected) => assert.deepEqual(parseAfterSeq(v), { ok: true, afterSeq: expected });
  const no = (v) => assert.equal(parseAfterSeq(v).ok, false, `应当拒绝 afterSeq=${String(v)}`);
  ok(undefined, null);
  ok(null, null);
  ok(0, 0);
  ok('0', 0);
  ok(12, 12);
  ok('9007199254740991', Number.MAX_SAFE_INTEGER);
  no(-1); no('-1'); no(1.5); no('1.5'); no('abc'); no(''); no(' 0'); no('0x10');
  no(Number.MAX_SAFE_INTEGER + 1); no('9007199254740992'); no(Infinity); no(NaN); no('-0');

  // sseFrame:已盖章行发 id 行(runId:seq),未盖章的流级行不发
  const stamped = '{"type":"assistant"}';
  const withStamp = `${stamped.slice(0, -1)},"runId":"sdk-7","seq":12}`;
  assert.equal(sseFrame(withStamp), `id: sdk-7:12\ndata: ${withStamp}\n\n`);
  assert.equal(sseFrame('{"type":"early_overflow"}'), 'data: {"type":"early_overflow"}\n\n', '未盖章行不发 id 行');

  // 带游标重放:只回 seq > 游标,并清空 earlyLines(两者同源,不清会重复投递)
  const slot = { eventLog: [{ seq: 1, line: 'a' }, { seq: 2, line: 'b' }, { seq: 5, line: 'c' }], earlyLines: ['x', 'y'] };
  const got = [];
  replayEventLog(slot, 2, (l) => got.push(l));
  assert.deepEqual(got, ['c'], '只重放 seq 大于游标的事件');
  assert.deepEqual(slot.earlyLines, [], '重放后 earlyLines 必须清空');
  got.length = 0;
  replayEventLog({ eventLog: [], earlyLines: [] }, 0, (l) => got.push(l));
  assert.deepEqual(got, [], '空窗重放零事件(不报 gap,也不报错)');

  // streamCursorGate:三类拒绝各写自己的响应,通过时把游标交给路由
  const mkRes = () => ({
    statusCode: 0, body: null, sse: '', ended: 0,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    writeHead() { this.sse += '[head]'; },
    write(d) { this.sse += d; },
    end() { this.ended += 1; },
  });
  const run = (query, slot) => {
    const res = mkRes();
    const out = streamCursorGate({ query }, res, { runId: 'sdk-9', seq: 40, eventLog: [], ...slot });
    return { out, res };
  };
  let r = run({ afterSeq: '-1' });
  assert.equal(r.out, null); assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.body.code, 'STREAM_INVALID_CURSOR'); assert.equal(r.res.sse, '', '非法游标不得建立事件流');
  r = run({ afterSeq: '0', runId: 'sdk-other' });
  assert.equal(r.res.statusCode, 409); assert.equal(r.res.body.code, 'RUN_STALE');
  r = run({ afterSeq: '100000' });
  assert.equal(r.res.statusCode, 409); assert.equal(r.res.body.code, 'STREAM_CURSOR_AHEAD');
  r = run({ afterSeq: '40' });
  assert.deepEqual(r.out, { afterSeq: 40 }, '等于 lastSeq 合法');
  assert.equal(r.res.sse, '');
  r = run({});
  assert.deepEqual(r.out, { afterSeq: null }, '不带游标合法(走 earlyLines 一次消费语义)');
  // 游标过旧:窗内最老只剩 seq 100 → 游标 50 缺了一段 → stream_gap + 关流
  r = run({ afterSeq: '50' }, { eventLog: [{ seq: 100, line: 'x' }, { seq: 140, line: 'y' }], seq: 140 });
  assert.equal(r.out, null);
  assert.match(r.res.sse, /"type":"stream_gap"/);
  const gap = JSON.parse(r.res.sse.slice(r.res.sse.indexOf('data: ') + 6));
  assert.equal(gap.firstSeq, 100); assert.equal(gap.lastSeq, 140); assert.equal(gap.runId, 'sdk-9');
  assert.equal(r.res.ended, 1, 'stream_gap 之后必须关流');
  // 空窗(新回合刚清过环形窗):afterSeq=0 不算过旧,不许误报 gap
  r = run({ afterSeq: '0' }, { eventLog: [], seq: 0 });
  assert.deepEqual(r.out, { afterSeq: 0 });
  assert.equal(r.res.sse, '', '空窗不报 gap');
}

// ── ④ 停止身份 ────────────────────────────────────────────────────
{
  assert.equal(stopIdentity({}), null, '不带 owner/clientTurnId = 老调用方');
  assert.equal(stopIdentity({ hard: true, allTasks: true }), null, '只带 hard/allTasks 仍是老调用方');
  assert.deepEqual(stopIdentity({ owner: 'sid-1' }), { owner: 'sid-1', clientTurnId: null });
  assert.deepEqual(stopIdentity({ owner: 'sid-1', clientTurnId: 't1' }), { owner: 'sid-1', clientTurnId: 't1' });
  assert.equal(stopIdentity({ owner: 42 }), null, 'owner 不是字符串 = 没给身份');

  const rec = { clientTurnId: 't1', owner: 'sid-1', sessionId: 'sid-1', draftId: 'draft-1' };
  const slot = { sessionId: 'sid-1', draftId: null };
  assert.equal(stopIdentityMismatch(rec, slot, { owner: 'sid-1', clientTurnId: 't1' }), false, '身份相符');
  assert.equal(stopIdentityMismatch(rec, slot, { owner: 'draft-1', clientTurnId: 't1' }), false, 'draft 身份也能对上');
  assert.equal(stopIdentityMismatch(rec, slot, { owner: 'sid-1', clientTurnId: 't2' }), true, 'clientTurnId 不符');
  assert.equal(stopIdentityMismatch(rec, slot, { owner: 'sid-2', clientTurnId: 't1' }), true, 'owner 不符');
  // 没有记录的老运行:只认 slot 的 sessionId/draftId,且不接受 clientTurnId
  assert.equal(stopIdentityMismatch(null, slot, { owner: 'sid-1', clientTurnId: null }), false);
  assert.equal(stopIdentityMismatch(null, slot, { owner: 'sid-2', clientTurnId: null }), true);
  assert.equal(stopIdentityMismatch(null, slot, { owner: 'sid-1', clientTurnId: 't1' }), true, '无记录时 clientTurnId 无从核对');
  assert.equal(stopIdentityMismatch(null, null, { owner: null, clientTurnId: 't1' }), true, '连 slot 都没有时不许停');
}

// ── ④ 主体键:本机 vs 外部令牌是两档幂等域 ──────────────────────────
{
  assert.equal(turnPrincipal({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), 'local');
  assert.equal(turnPrincipal({ socket: { remoteAddress: '10.0.0.9' }, headers: {} }), 'token');
  assert.equal(turnPrincipal({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'cf-ray': 'x' } }), 'token',
    '带 CF 标记的回环流量按外部主体算(与鉴权口径一致)');
}

// ── ① serverEpoch 形状 ───────────────────────────────────────────
{
  assert.equal(typeof SERVER_EPOCH, 'string');
  assert.ok(SERVER_EPOCH.length > 0 && SERVER_EPOCH.length <= 128, '长度 ≤128');
  assert.ok(!/\s/.test(SERVER_EPOCH), '机器身份不含空白字符');
  const again = (await import('../../server/utils/server-epoch.js')).SERVER_EPOCH;
  assert.equal(again, SERVER_EPOCH, '同一进程内两次读取必须相同');
}

// ── ④ 流级通知帧的盖章(early_overflow / 缓冲 error / 收尾补发的 done / stream_gap)────
{
  const slot = { runId: 'sdk-11', seq: 7, eventLog: [] };
  const notice = stampStreamNotice(slot, JSON.stringify({ type: 'early_overflow' }));
  const parsed = JSON.parse(notice);
  assert.equal(parsed.type, 'early_overflow');
  assert.equal(parsed.runId, 'sdk-11', '流级通知也必须带 runId');
  assert.equal(parsed.seq, 8, '流级通知也必须吃一个单调 seq');
  assert.equal(sseFrame(notice), `id: sdk-11:8\ndata: ${notice}\n\n`, 'SSE id 仍是 runId:seq');
  assert.deepEqual(slot.eventLog, [], '流级通知不进环形窗(它只对当前连接有意义)');
  // 顺序:通知 → done,seq 必须继续单调
  const done = stampRunEvent(slot, JSON.stringify({ type: 'done' }), false);
  assert.equal(JSON.parse(done).seq, 9, '后面的终态帧 seq 必须更大');
  // 已盖章的行原样返回,不重复吃号
  assert.equal(stampStreamNotice(slot, notice), notice, '已盖章行不得二次盖章');
  assert.equal(slot.seq, 9, '二次盖章不消耗 seq');

  for (const [label, payload] of [
    ['error(缓冲)', { type: 'error', error: 'x' }],
    ['stream_gap', { type: 'stream_gap', firstSeq: 100, lastSeq: 140 }],
  ]) {
    const s2 = { runId: 'sdk-12', seq: 0, eventLog: [] };
    const line = stampStreamNotice(s2, JSON.stringify(payload));
    const ev = JSON.parse(line);
    assert.equal(ev.runId, 'sdk-12', `${label} 帧带 runId`);
    assert.equal(ev.seq, 1, `${label} 帧带单调 seq`);
    assert.match(sseFrame(line), new RegExp(`^id: sdk-12:1\\ndata: `), `${label} 帧的 id 行`);
    if (payload.type === 'stream_gap') {
      assert.equal(ev.firstSeq, 100); assert.equal(ev.lastSeq, 140); // 合同要求的退化边界仍在
    }
  }

  // 源码哨兵:三处退化帧必须走唯一写出口,不许各自裸写(裸写就回到"没 seq"的老 bug)
  const chat = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  assert.match(chat, /const onLine = \(line\) => \{[\s\S]{0,200}?stampStreamNotice\(slot, line\)/,
    'onLine 必须是补章的唯一写出口');
  assert.match(chat, /if \(slot\.earlyOverflowed\) \{ slot\.earlyOverflowed = false; onLine\(JSON\.stringify\(\{ type: 'early_overflow' \}\)\); \}/,
    'early_overflow 必须经 onLine 写出');
  assert.match(chat, /for \(const e of slot\.earlyErrors\) onLine\(JSON\.stringify\(/,
    '缓冲 error 必须经 onLine 写出');
  assert.match(chat, /res\.write\(sseFrame\(stampStreamNotice\(slot, JSON\.stringify\(\{ type: 'stream_gap', firstSeq, lastSeq \}\)\)\)\)/,
    'stream_gap 也要盖章+id 行');
  assert.ok(!/data: \$\{JSON\.stringify\(/.test(chat.slice(chat.indexOf("router.get('/chat/:pid/stream'"), chat.indexOf("router.post('/chat/:pid/stop'"))),
    'SSE 路由段里不得再有绕开 onLine 的裸 data 帧');
}

// ── ① POST /api/chat 的初始化超时(合同 504 CHAT_START_TIMEOUT)────────────
{
  // 假 slot:只放本次判据用到的字段;listeners 收 deliverLine 投出去的帧。
  const mkSlot = () => {
    const got = [];
    return { slot: { runId: 'sdk-13', seq: 0, eventLog: [], earlyLines: [], listeners: new Set([(l) => got.push(l)]), turnSawLine: false, startTimedOut: false, startupTimer: null, startWaiters: [], turnRecord: { clientTurnId: 't', startTimedOut: false } }, got };
  };

  // 到点没开口 → 等着的 POST 拿 false,且给观察者一条带码的 error 帧
  {
    const { slot, got } = mkSlot();
    armTurnStartup(slot, 20);
    const okPromise = waitTurnStartup(slot, 20);
    assert.equal(await okPromise, false, '15 秒(此处注入 20ms)没开口必须判失败');
    assert.equal(slot.startTimedOut, true);
    assert.equal(slot.turnRecord.startTimedOut, true, '账本要记下"送达未确认",重发命中回执时不许谎称已送达');
    assert.equal(got.length, 1, '到点必须给观察者发一条明确通知');
    const ev = JSON.parse(got[0]);
    assert.equal(ev.type, 'error');
    assert.equal(ev.code, 'CHAT_START_TIMEOUT', '合同码必须可见');
    assert.equal(ev.delivered, 'unknown', '不许假称已送达');
    assert.equal(ev.runId, 'sdk-13'); assert.ok(Number.isInteger(ev.seq), '通知帧同样带 seq');
    assert.equal(slot.startupTimer, null, '定时器只跑一次');
    // 已经判超时之后再问:立刻 false,不挂起
    assert.equal(await waitTurnStartup(slot, 20), false);
    assert.equal(got.length, 1, '重复询问不得再发通知');
  }

  // 开口了 → true,且不再发超时通知
  {
    const { slot, got } = mkSlot();
    armTurnStartup(slot, 30);
    const okPromise = waitTurnStartup(slot, 30);
    noteTurnFirstLine(slot);
    assert.equal(await okPromise, true, '开口即算初始化完成');
    assert.equal(slot.startTimedOut, false);
    assert.equal(slot.startupTimer, null, '开口后超时表必须撤掉');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(got, [], '开口之后到点也不该有超时通知');
    assert.equal(await waitTurnStartup(slot, 20), true, '已开口的回合立即放行');
    noteTurnFirstLine(slot); // 幂等:第二条事件不重复结算
    assert.equal(slot.turnSawLine, true);
  }

  // 没有超时表兜底时(调用点改动)也不许把响应永远悬着
  {
    const { slot } = mkSlot();
    assert.equal(await waitTurnStartup(slot, 20), false, '兜底定时器必须放行');
  }

  // 源码哨兵:POST 侧的 504 与两个口径字段必须同时在(合同:504 + runId + 送达状态)
  const chat = readFileSync(new URL('../../server/routes/chat.js', import.meta.url), 'utf8');
  const postSeg = chat.slice(chat.indexOf('async function handleChatPost(req, res) {'), chat.indexOf("router.get('/chat/:pid/stream'"));
  assert.match(postSeg, /if \(!\(await waitTurnStartup\(slot\)\)\)/, 'POST 必须在回响应前等初始化');
  assert.match(postSeg, /res\.status\(504\)\.json\(\{[\s\S]{0,300}?code: 'CHAT_START_TIMEOUT'/, '未初始化必须回 504 + 合同码');
  assert.match(postSeg, /delivered: 'unknown'/, '504 必须如实标"送达未确认"');
}

console.log('✓ check-r13-turn-identity: 输入闸门 / canonical turn 账本 / SSE 游标 / 流级帧盖章 / 初始化超时 / 停止身份 全过');
