#!/usr/bin/env node
// 单测:r209 会话记录备份保留规则 —— server/services/history-backup-retention.js 的白盒部分
// (文件名、保留规则、环境变量、根目录必填、归属、自动清理两轮、会话忙、删不掉 / 读不了、设置页列表与删除、
// 删除会话连带、历史操作后收尾、排程)。
// 隔离:全部在 os.tmpdir() 下自建目录,根目录一律显式传给模块;HOME / USERPROFILE 在 import 之前也指到临时目录(双保险)。
// Run: node tests/unit/check-r209-histbak-retention.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r209-hb-'));
process.env.HOME = path.join(TMP, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });
const M = await import('../../server/services/history-backup-retention.js');
const { SESSION_ID_SHAPE } = await import('../../server/services/session-reader.js');

const DAY = 86_400_000;
const H = 3_600_000;
const POSIX_PERMS = process.platform !== 'win32' && process.getuid?.() !== 0; // root 无视权限位
const CAN_LINK = process.platform !== 'win32';
const sidOf = (n) => `0000abcd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tok = (c) => c.repeat(24);
const hb = (sid, ts, t = tok('a')) => `${sid}.jsonl.histbak-${ts}-${t}`;
const hbOld = (sid, ts) => `${sid}.jsonl.histbak-${ts}`;
const bakTs = (sid, ts) => `${sid}.jsonl.bak-${ts}`;
const bakPlain = (sid) => `${sid}.jsonl.bak`;
let seq = 0;
const freshRoot = () => { const r = path.join(TMP, `R${++seq}`); fs.mkdirSync(r, { recursive: true }); return r; };
const outside = (...p) => path.join(TMP, 'outside', ...p);
function put(dir, name, { size = 10, mtimeMs, content } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content ?? 'x'.repeat(size));
  if (mtimeMs) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}
const session = (dir, sid) => put(dir, `${sid}.jsonl`, { content: '{"type":"user"}\n' });
const ls = (dir) => fs.readdirSync(dir).sort();
const has = (dir, name) => fs.existsSync(path.join(dir, name));
async function capture(fn) {
  const lines = [];
  const [ol, oe] = [console.log, console.error];
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { return { value: await fn(), lines }; } finally { console.log = ol; console.error = oe; }
}
const sweep = (root, mem, kind = 'startup') => capture(() => M.runHistoryBackupSweep(root, mem, kind));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cases = 0;
const ok = () => { cases += 1; };

// ── t1 文件名:3.0 四种形态与反例 ──
{
  const s = sidOf(1);
  const ts = '1763000000000';
  assert.deepEqual(M.parseBackupName(hb(s, ts)), { sid: s, form: 'histbak', ts: 1763000000000, auto: true });
  assert.deepEqual(M.parseBackupName(hbOld(s, ts)), { sid: s, form: 'histbak-legacy', ts: 1763000000000, auto: true });
  assert.deepEqual(M.parseBackupName(bakTs(s, ts)), { sid: s, form: 'bak-ts', ts: 1763000000000, auto: true });
  assert.deepEqual(M.parseBackupName(bakPlain(s)), { sid: s, form: 'bak-plain', ts: null, auto: false });
  assert.equal(M.parseBackupName(hb(s.toUpperCase(), ts))?.sid, s.toUpperCase(), '会话编号允许大写十六进制');
  const negatives = [
    `${s}.jsonl`, `${s}.jsonl.archived`, `${s}.jsonl.tmp-trim-123e4567-e89b-12d3-a456-426614174000`,
    hb(s, ts, 'a'.repeat(23)), hb(s, ts, 'a'.repeat(25)), hb(s, ts, 'A'.repeat(24)), hb(s, '176300000000a', tok('a')),
    hb(s, '176300000000', tok('a')), hb(s, '17630000000000', tok('a')), hb(s, '0763000000000', tok('a')),
    `${hb(s, ts)}.tmp`, `${bakTs(s, ts)}-x`, `${s}.jsonl.BAK`, `${s}.jsonl.bak.old`, `notes.jsonl.histbak-${ts}-${tok('a')}`,
    `x${hb(s, ts)}`, `${s}.json.histbak-${ts}-${tok('a')}`, `${hb(s, ts)}\n`, hbOld(s, '176300000000'), bakTs(s, '0763000000000'),
    `${s.slice(1)}.jsonl.bak`, null, 42,
  ];
  for (const n of negatives) assert.equal(M.parseBackupName(n), null, `不是备份:${JSON.stringify(n)}`);
  ok();
}

// ── t2 SID 判据与 session-reader 的 SESSION_ID_SHAPE 一致 ──
assert.equal(SESSION_ID_SHAPE.source, `^${M.SID_PATTERN}$`);
assert.equal(SESSION_ID_SHAPE.flags, '');
ok();

// ── t3 保留规则(纯函数)边界 ──
{
  const now = 1_800_000_000_000;
  const f = (name, createdAt, auto = true) => ({ name, createdAt, auto });
  const names = (arr) => arr.map((x) => x.name);
  let p = M.planPresentGroup([f('a', now - M.HISTBAK_MAX_AGE_MS + 1), f('b', now - M.HISTBAK_MAX_AGE_MS)], now);
  assert.deepEqual([names(p.keep), names(p.remove)], [['a'], ['b']], '差 1 毫秒满 14 天留,整 14 天删');
  p = M.planPresentGroup([4, 2, 3, 1].map((i) => f(`n${i}`, now - i * H)), now);
  assert.deepEqual([names(p.keep), names(p.remove)], [['n1', 'n2', 'n3'], ['n4']], '第 3 份留、第 4 份删');
  p = M.planPresentGroup(['a', 'c', 'b', 'd'].map((c) => f(c, now - H)), now);
  assert.deepEqual([names(p.keep), names(p.remove)], [['d', 'c', 'b'], ['a']], '同一时刻按文件名从大到小');
  p = M.planPresentGroup([f('own', now - 10 * H), f('x1', now - H), f('x2', now - 2 * H), f('x3', now - 3 * H)], now, 'own');
  assert.deepEqual([names(p.keep), names(p.remove)], [['own', 'x1', 'x2'], ['x3']], '本次那份排第 4 位仍留,合计 3 份');
  p = M.planPresentGroup([f('own', now - 20 * DAY), f('x1', now - H)], now, 'own');
  assert.deepEqual(names(p.keep), ['own', 'x1'], '本次那份不按天数删');
  p = M.planPresentGroup([f('x1', now - H), f('x2', now - 2 * H), f('x3', now - 3 * H)], now, 'gone-own');
  assert.deepEqual([names(p.keep), names(p.remove)], [['x1', 'x2'], ['x3']], '本次那份不在列表里也占一个名额');
  p = M.planPresentGroup([f('plain', now - 100 * DAY, false), ...[1, 2, 3, 4].map((i) => f(`n${i}`, now - i * H))], now);
  assert.ok(!names(p.keep).includes('plain') && !names(p.remove).includes('plain'), '.jsonl.bak 不进任何名单');
  assert.equal(p.keep.length, 3, '.jsonl.bak 不占名额');
  p = M.planPresentGroup([f('e1', now - 15 * DAY), f('e2', now - 16 * DAY), ...[1, 2, 3, 4].map((i) => f(`d${i}`, now - i * DAY))], now);
  assert.deepEqual([names(p.keep), names(p.remove).sort()], [['d1', 'd2', 'd3'], ['d4', 'e1', 'e2']], '先按天数再按份数');
  ok();
}

// ── t4 环境变量 ──
{
  const P = M.historyBackupSweepPlan;
  assert.deepEqual(P({}), { delayMs: 60000, intervalMs: 3600000 });
  assert.deepEqual(P(), { delayMs: 60000, intervalMs: 3600000 });
  for (const bad of ['abc', '', '   ', '-1', 'Infinity', '-Infinity', 'NaN', '2147483648', '1e400']) {
    assert.equal(P({ CGUI_HISTBAK_SWEEP_DELAY_MS: bad }).delayMs, 60000, `delay=${bad}`);
  }
  assert.equal(P({ CGUI_HISTBAK_SWEEP_DELAY_MS: '0' }).delayMs, 0);
  assert.equal(P({ CGUI_HISTBAK_SWEEP_DELAY_MS: '2147483647' }).delayMs, 2147483647);
  for (const bad of ['abc', '', '999', '0', '-5', 'Infinity', 'NaN', '2147483648']) {
    assert.equal(P({ CGUI_HISTBAK_SWEEP_INTERVAL_MS: bad }).intervalMs, 3600000, `interval=${bad}`);
  }
  assert.equal(P({ CGUI_HISTBAK_SWEEP_INTERVAL_MS: '1000' }).intervalMs, 1000);
  assert.equal(P({ CGUI_HISTBAK_SWEEP_INTERVAL_MS: '2147483647' }).intervalMs, 2147483647);
  ok();
}

// ── t5 不传根目录直接报错;两个「永不抛」的收尾只打一行出错日志、什么都不动 ──
{
  await assert.rejects(() => M.runHistoryBackupSweep(undefined, new Set(), 'startup'), TypeError);
  await assert.rejects(() => M.runHistoryBackupSweep('relative/dir', new Set(), 'startup'), TypeError);
  await assert.rejects(() => M.listHistoryBackups(), TypeError);
  await assert.rejects(() => M.deleteAllHistoryBackups(''), TypeError);
  await assert.rejects(() => M.deleteSessionHistoryBackups(undefined, 'p', sidOf(1)), TypeError);
  assert.throws(() => M.scheduleHistoryBackupSweeps(undefined, { delayMs: 0, intervalMs: 1000 }), TypeError);
  const { lines } = await capture(async () => {
    await M.cleanupAfterHistoryOp(undefined, { projectHash: 'p', sid: sidOf(1), ownName: 'x', dropOwn: false });
    await M.dropSessionBackups(undefined, 'p', sidOf(1));
  });
  assert.deepEqual(lines, [
    '[histbak] 历史操作后清理出错(已忽略) sid=0000abcd: TypeError',
    '[histbak] 删除会话时清理出错(已忽略) sid=0000abcd: TypeError',
  ]);
  ok();
}

// ── t6 自动清理:present 规则、gone 两轮、elsewhere / unknown 不动、反例不动、不是工作区目录的不进 ──
{
  const R = freshRoot();
  const now = Date.now();
  const A = path.join(R, 'wsA'); const G = path.join(R, 'wsGone'); const EA = path.join(R, 'wsElseA'); const EB = path.join(R, 'wsElseB');
  const [P1, GS, ES, US, DS] = [11, 12, 13, 14, 15].map(sidOf);
  session(A, P1);
  const keepP1 = [hb(P1, now - H, tok('1')), hbOld(P1, now - 2 * H), bakTs(P1, now - 3 * H), hb(P1, now + 5 * DAY, tok('f'))];
  const delP1 = [hb(P1, now - 4 * H, tok('2')), hb(P1, now - 5 * H, tok('3')), hb(P1, now - 15 * DAY, tok('4'))];
  for (const n of [...keepP1, ...delP1]) put(A, n);
  put(A, bakPlain(P1), { mtimeMs: now - 40 * DAY });
  const decoys = [`${P1}.jsonl.archived`, hb(P1, now - 20 * DAY, 'a'.repeat(23)), `${hb(P1, now - 20 * DAY)}.tmp`, `x${hb(P1, now - 20 * DAY)}`];
  for (const n of decoys) put(A, n);
  const upperBak = `${sidOf(16)}.jsonl.BAK`; // 另一个会话:大小写不敏感的文件系统上与同会话的 .bak 是同一个文件
  put(A, upperBak);
  fs.mkdirSync(path.join(A, hb(P1, now - 21 * DAY, tok('d'))));
  if (CAN_LINK) {
    put(outside(), 'target.txt');
    fs.symlinkSync(outside('target.txt'), path.join(A, hb(P1, now - 22 * DAY, tok('e'))));
    put(outside(), 'u.jsonl');
    fs.symlinkSync(outside('u.jsonl'), path.join(A, `${US}.jsonl`)); // 会话记录是软链接 → unknown
    for (let i = 1; i <= 5; i += 1) put(A, hb(US, now - i * H));
  }
  for (const n of [hb(GS, now - H), hbOld(GS, now - 20 * DAY)]) put(G, n);
  put(G, bakPlain(GS));
  session(EB, ES);
  for (let i = 1; i <= 5; i += 1) put(EA, hb(ES, now - i * H));
  session(path.join(R, '.dot'), DS); put(path.join(R, '.dot'), hb(DS, now - 20 * DAY));
  if (CAN_LINK) {
    session(outside('lws'), DS); put(outside('lws'), hb(DS, now - 20 * DAY));
    fs.symlinkSync(outside('lws'), path.join(R, 'linkws'));
  }
  put(R, 'plain-file.txt');
  const snapshot = () => JSON.stringify([ls(A), ls(G), ls(EA), ls(EB), ls(path.join(R, '.dot'))]);

  const mem = new Set();
  const r1 = await sweep(R, mem, 'startup');
  assert.deepEqual(ls(A).filter((n) => n.startsWith(P1) || n.startsWith(`x${P1}`)).sort(),
    [`${P1}.jsonl`, ...keepP1, bakPlain(P1), ...decoys, hb(P1, now - 21 * DAY, tok('d')), ...(CAN_LINK ? [hb(P1, now - 22 * DAY, tok('e'))] : [])].sort(),
    'present:留最新 3 份 + 未来文件 + .jsonl.bak + 反例,删第 4 份起与满 14 天的');
  assert.ok(has(A, upperBak), '.jsonl.BAK 不是备份');
  assert.equal(ls(G).length, 3, 'gone 第一轮一份不删');
  assert.equal(ls(EA).length, 5, 'elsewhere 不动');
  if (CAN_LINK) assert.equal(ls(A).filter((n) => n.startsWith(US)).length, 6, 'unknown 不动(5 份 + 软链接会话记录)');
  assert.ok(has(path.join(R, '.dot'), hb(DS, now - 20 * DAY)), '点开头的目录不进');
  if (CAN_LINK) assert.ok(has(outside('lws'), hb(DS, now - 20 * DAY)), '软链接工作区目录不进');
  assert.equal(r1.lines.length, 1);
  assert.match(r1.lines[0], new RegExp(`^\\[histbak\\] 清理完成\\(启动\\): 工作区目录 4 个, 删除 3 份共 30 字节, 失败 0 份, 占用跳过 0 份, 归属不明 ${CAN_LINK ? 1 : 0} 组, 待确认已删 1 组, 目录读取失败 0 个, 耗时 \\d+ ms$`));
  const r2 = await sweep(R, mem, 'interval');
  assert.deepEqual(ls(G), [bakPlain(GS)], 'gone 连续第二轮:三种删光,.jsonl.bak 留');
  assert.match(r2.lines[0], /^\[histbak\] 清理完成\(定时\): 工作区目录 4 个, 删除 2 份共 20 字节, .* 待确认已删 0 组, /);
  const before3 = snapshot();
  const r3 = await sweep(R, mem, 'interval');
  assert.equal(snapshot(), before3, '第三轮没什么可删');
  assert.match(r3.lines[0], /删除 0 份共 0 字节/);
  ok();
}

// ── t7 gone 必须「连续」两轮:中间一轮判成别的,重新计 ──
{
  const R = freshRoot();
  const now = Date.now();
  const X = sidOf(21); const d = path.join(R, 'ws'); const other = path.join(R, 'ws2');
  put(d, hb(X, now - H)); fs.mkdirSync(other);
  const mem = new Set();
  await sweep(R, mem);
  session(other, X); // 记录出现在别的目录 → elsewhere
  await sweep(R, mem, 'interval');
  fs.unlinkSync(path.join(other, `${X}.jsonl`));
  const r3 = await sweep(R, mem, 'interval');
  assert.ok(has(d, hb(X, now - H)), '中断后重新计:这一轮只是第一次判为 gone');
  assert.match(r3.lines[0], /待确认已删 1 组/);
  await sweep(R, mem, 'interval');
  assert.ok(!has(d, hb(X, now - H)), '再连续一轮才删');
  ok();
}

// ── t8 会话忙:所有删除入口跳过;解除后照常;键不分大小写;解除函数只生效一次 ──
{
  const R = freshRoot();
  const now = Date.now();
  const S = sidOf(31); const d = path.join(R, 'ws');
  session(d, S);
  for (let i = 1; i <= 5; i += 1) put(d, hb(S, now - i * H));
  const release = M.markSessionBusy(S.toUpperCase());
  assert.ok(M.isSessionBusy(S) && !M.isSessionBusy(S, 1));
  const r = await sweep(R, new Set());
  assert.equal(ls(d).length, 6, '会话忙:一份不删');
  assert.match(r.lines[0], /占用跳过 2 份/);
  const one = await capture(() => M.deleteSessionHistoryBackups(R, 'ws', S));
  assert.deepEqual(one.value.body, { ok: true, deleted: 0, freedBytes: 0, failed: 0, skippedBusy: 5, skippedUnknown: 0, skippedDirs: 0 });
  const all = await capture(() => M.deleteAllHistoryBackups(R));
  assert.equal(all.value.body.skippedBusy, 5);
  const drop = await capture(() => M.dropSessionBackups(R, 'ws', S));
  assert.deepEqual(drop.lines, [`[histbak] 删除会话时清理 sid=0000abcd: 删除 0 份, 失败 0 份, 占用跳过 5 份, 目录读取失败 0 个`]);
  release(); release();
  assert.ok(!M.isSessionBusy(S), '解除后不忙;重复解除不会减成负数');
  const again = M.markSessionBusy(S); assert.ok(M.isSessionBusy(S)); again();
  await sweep(R, new Set());
  assert.equal(ls(d).length, 4, '解除后按规则删(会话记录 + 3 份)');
  ok();
}

// ── t9 删不掉(目录只读)与读不了(目录 000):只计数,不扩散 ──
if (POSIX_PERMS) {
  const R = freshRoot();
  const now = Date.now();
  const S = sidOf(41); const ro = path.join(R, 'ro'); const bad = path.join(R, 'bad'); const q = path.join(R, 'q');
  session(ro, S);
  for (let i = 1; i <= 5; i += 1) put(ro, hb(S, now - i * H));
  const Q = sidOf(42); put(q, hb(Q, now - H)); // 会话记录哪儿都没有,但 bad 目录查不了 → unknown
  session(bad, sidOf(43)); put(bad, hb(sidOf(43), now - H));
  fs.chmodSync(ro, 0o555); fs.chmodSync(bad, 0o000);
  try {
    const r = await sweep(R, new Set());
    assert.match(r.lines[0], /^\[histbak\] 清理完成\(启动\): 工作区目录 3 个, 删除 0 份共 0 字节, 失败 2 份, 占用跳过 0 份, 归属不明 1 组, 待确认已删 0 组, 目录读取失败 1 个, 耗时 \d+ ms \(失败原因 EACCES×2\)$/);
    assert.equal(ls(ro).length, 6, '删不掉的原样在');
    const list = await M.listHistoryBackups(R);
    assert.equal(list.status, 200);
    assert.equal(list.body.skippedDirs, 1);
    assert.equal(list.body.skippedUnknown, 1, 'q 组判不了归属:只计数不列出');
    assert.deepEqual(list.body.sessions.map((s) => s.sessionId), [S]);
    const one = await capture(() => M.deleteSessionHistoryBackups(R, 'bad', sidOf(43)));
    assert.deepEqual([one.value.status, one.value.body], [500, { ok: false, code: 'HISTBAK_DELETE_FAILED', error: '清理失败(EACCES)' }]);
    assert.match(one.lines[0], /^\[histbak\] 设置页清理\(单个会话 sid=0000abcd\): .*目录读取失败 1 个$/);
    const all = await capture(() => M.deleteAllHistoryBackups(R));
    assert.deepEqual(all.value.body, { ok: true, deleted: 0, freedBytes: 0, failed: 5, skippedBusy: 0, skippedUnknown: 1, skippedDirs: 1 });
  } finally { fs.chmodSync(ro, 0o755); fs.chmodSync(bad, 0o755); }
  assert.ok(has(bad, hb(sidOf(43), now - H)), '读不了的目录里的没动');
  // R 本身读不了
  const R2 = freshRoot(); fs.chmodSync(R2, 0o000);
  try {
    const mem = new Set(['x/y']);
    const r = await sweep(R2, mem);
    assert.equal(r.value, null);
    assert.deepEqual(r.lines, ['[histbak] 清理失败(已忽略,不影响服务): EACCES']);
    assert.equal(mem.size, 0, '整轮失败:连续两轮的记忆清空');
    assert.deepEqual((await M.listHistoryBackups(R2)).body, { ok: false, code: 'HISTBAK_LIST_FAILED', error: '读取会话记录目录失败(EACCES)' });
    const all = await capture(() => M.deleteAllHistoryBackups(R2));
    assert.deepEqual([all.value.status, all.value.body], [500, { ok: false, code: 'HISTBAK_DELETE_FAILED', error: '清理失败(EACCES)' }]);
  } finally { fs.chmodSync(R2, 0o755); }
  ok();
}

// ── t10 R 不存在:0 个工作区目录,不报错 ──
{
  const R = path.join(TMP, 'no-such-root');
  const r = await sweep(R, new Set());
  assert.match(r.lines[0], /^\[histbak\] 清理完成\(启动\): 工作区目录 0 个, 删除 0 份/);
  const list = await M.listHistoryBackups(R);
  assert.deepEqual(list, { status: 200, body: { ok: true, totalCount: 0, totalBytes: 0, skippedUnknown: 0, skippedDirs: 0, rules: { maxAgeDays: 14, maxPerSession: 3 }, sessions: [] } });
  const all = await capture(() => M.deleteAllHistoryBackups(R));
  assert.deepEqual(all.value.body, { ok: true, deleted: 0, freedBytes: 0, failed: 0, skippedBusy: 0, skippedUnknown: 0, skippedDirs: 0 });
  assert.equal((await M.deleteSessionHistoryBackups(R, 'ws', sidOf(1))).status, 404);
  ok();
}

// ── t11 设置页列表:字段、状态、标题取法、排序、未来文件不算、软链接根目录照样认 ──
{
  const R = freshRoot();
  const b = Math.floor(Date.now() / 1000) * 1000;
  const d = path.join(R, 'l1'); const d2 = path.join(R, 'l2');
  const [A, B, C, E] = [51, 52, 53, 54].map(sidOf);
  session(d, A); session(d2, C);
  put(d, hb(A, b - 3 * H), { size: 100 });
  put(d, bakTs(A, b - H), { content: `${JSON.stringify({ type: 'assistant', message: { content: 'x' } })}\n${JSON.stringify({ type: 'user', message: { content: '😀'.repeat(100) } })}\n` });
  put(d, bakPlain(A), { size: 7, mtimeMs: b - 10 * H });
  put(d, hb(A, b + 2 * DAY), { size: 999 });
  put(d, hb(B, b - 5 * H), { content: JSON.stringify({ type: 'user', message: { content: [{ type: 'image' }, { type: 'text', text: '数组标题' }] } }) });
  put(d, hb(C, b - 6 * H), { content: 'not json' });
  put(d, hb(E, b - H), { content: `${JSON.stringify({ type: 'assistant', message: { content: 'z'.repeat(9000) } })}\n${JSON.stringify({ type: 'user', message: { content: '太靠后' } })}` });
  session(d, E);
  const res = await M.listHistoryBackups(R);
  const aBytes = 100 + fs.statSync(path.join(d, bakTs(A, b - H))).size + 7;
  const bBytes = fs.statSync(path.join(d, hb(B, b - 5 * H))).size;
  const eBytes = fs.statSync(path.join(d, hb(E, b - H))).size;
  assert.equal(res.status, 200);
  assert.equal(res.body.totalCount, 6);
  assert.deepEqual(res.body.sessions, [
    { projectHash: 'l1', sessionId: E, state: 'present', title: '', count: 1, bytes: eBytes, oldestAt: b - H, newestAt: b - H },
    { projectHash: 'l1', sessionId: A, state: 'present', title: '😀'.repeat(80), count: 3, bytes: aBytes, oldestAt: b - 10 * H, newestAt: b - H },
    { projectHash: 'l1', sessionId: B, state: 'gone', title: '数组标题', count: 1, bytes: bBytes, oldestAt: b - 5 * H, newestAt: b - 5 * H },
    { projectHash: 'l1', sessionId: C, state: 'elsewhere', title: '', count: 1, bytes: 8, oldestAt: b - 6 * H, newestAt: b - 6 * H },
  ].sort((x, y) => y.bytes - x.bytes));
  assert.doesNotMatch(JSON.stringify(res.body), /histbak|\.jsonl|not json/);
  if (CAN_LINK) {
    const link = path.join(TMP, `link-to-R${seq}`); fs.symlinkSync(R, link);
    assert.deepEqual((await M.listHistoryBackups(link)).body, res.body, '根目录经软链接(家目录是软链接)照样认');
  }
  ok();
}

// ── t12 设置页单个删除:校验顺序与文案、404、删全组(四种)、留未来与反例、unknown、重复删得 0 ──
{
  const R = freshRoot();
  const now = Date.now();
  const S = sidOf(61); const O = sidOf(62); const d = path.join(R, 'x1');
  session(d, S);
  const mine = [hb(S, now - H), hbOld(S, now - 2 * H), bakTs(S, now - 3 * H), hb(S, now - 20 * DAY, tok('b')), bakPlain(S)];
  for (const n of mine) put(d, n, { size: 11 });
  const keep = [hb(S, now + DAY, tok('c')), `${S}.jsonl.archived`, hb(O, now - H)];
  for (const n of keep) put(d, n);
  const BAD_HASH = { status: 400, body: { ok: false, code: 'HISTBAK_INVALID_INPUT', error: 'projectHash 必须是合法的工作区目录名' } };
  const BAD_SID = { status: 400, body: { ok: false, code: 'HISTBAK_INVALID_INPUT', error: 'sessionId 必须是 36 位会话编号' } };
  for (const h of ['', '..', '.', '.x1', 'a/b', 'a\\b', `a${String.fromCharCode(0)}b`, 'a'.repeat(256), undefined, 5]) {
    assert.deepEqual(await M.deleteSessionHistoryBackups(R, h, S), BAD_HASH, `projectHash=${JSON.stringify(h)}`);
  }
  assert.deepEqual(await M.deleteSessionHistoryBackups(R, '..', 'abc'), BAD_HASH, '两个都错先报 projectHash');
  for (const s of ['abc', S.slice(1), `${S}0`, `g${S.slice(1)}`, undefined]) assert.deepEqual(await M.deleteSessionHistoryBackups(R, 'x1', s), BAD_SID);
  put(R, 'afile');
  const NF = { status: 404, body: { ok: false, code: 'HISTBAK_NOT_FOUND', error: '没有这个工作区目录' } };
  for (const h of ['nope', 'afile', 'X1', 'a'.repeat(255)]) assert.deepEqual(await M.deleteSessionHistoryBackups(R, h, S), NF, `projectHash=${h}`);
  if (CAN_LINK) { fs.symlinkSync(d, path.join(R, 'x1link')); assert.deepEqual(await M.deleteSessionHistoryBackups(R, 'x1link', S), NF); }
  const r = await capture(() => M.deleteSessionHistoryBackups(R, 'x1', S));
  assert.deepEqual(r.value, { status: 200, body: { ok: true, deleted: 5, freedBytes: 55, failed: 0, skippedBusy: 0, skippedUnknown: 0, skippedDirs: 0 } });
  assert.deepEqual(r.lines, ['[histbak] 设置页清理(单个会话 sid=0000abcd): 删除 5 份共 55 字节, 失败 0 份, 占用跳过 0 份, 归属不明 0 份, 目录读取失败 0 个']);
  assert.deepEqual(ls(d), [`${S}.jsonl`, ...keep].sort());
  const again = await capture(() => M.deleteSessionHistoryBackups(R, 'x1', S));
  assert.deepEqual(again.value.body, { ok: true, deleted: 0, freedBytes: 0, failed: 0, skippedBusy: 0, skippedUnknown: 0, skippedDirs: 0 });
  if (CAN_LINK) {
    const U = sidOf(63); const du = path.join(R, 'x1u');
    put(outside(), 'u63.jsonl'); fs.mkdirSync(du); fs.symlinkSync(outside('u63.jsonl'), path.join(du, `${U}.jsonl`));
    put(du, hb(U, now - H)); put(du, bakPlain(U));
    const u = await capture(() => M.deleteSessionHistoryBackups(R, 'x1u', U));
    assert.equal(u.value.body.skippedUnknown, 2);
    assert.equal(ls(du).length, 3, 'unknown 一份不删');
  }
  ok();
}

// ── t13 设置页全部清理:present / gone / elsewhere 全删(含 .jsonl.bak),unknown 与非工作区目录不动 ──
{
  const R = freshRoot();
  const now = Date.now();
  const [S1, S2, S3, U] = [71, 72, 73, 74].map(sidOf);
  const a1 = path.join(R, 'a1'); const a2 = path.join(R, 'a2'); const a3 = path.join(R, 'a3'); const a4 = path.join(R, 'a4');
  session(a1, S1); session(a4, S3); fs.mkdirSync(a2); fs.mkdirSync(a3);
  for (let i = 1; i <= 5; i += 1) put(a1, hb(S1, now - i * H));
  put(a1, bakPlain(S1)); put(a2, hb(S2, now - H)); put(a2, bakPlain(S2)); put(a3, hbOld(S3, now - H));
  put(a1, hb(S1, now + DAY, tok('f')));
  if (CAN_LINK) { put(outside(), 'u74.jsonl'); fs.symlinkSync(outside('u74.jsonl'), path.join(a1, `${U}.jsonl`)); put(a1, hb(U, now - H)); }
  session(path.join(R, '.h'), sidOf(75)); put(path.join(R, '.h'), hb(sidOf(75), now - H));
  const r = await capture(() => M.deleteAllHistoryBackups(R));
  assert.deepEqual(r.value.body, { ok: true, deleted: 9, freedBytes: 90, failed: 0, skippedBusy: 0, skippedUnknown: CAN_LINK ? 1 : 0, skippedDirs: 0 });
  assert.deepEqual(r.lines, [`[histbak] 设置页清理(全部): 删除 9 份共 90 字节, 失败 0 份, 占用跳过 0 份, 归属不明 ${CAN_LINK ? 1 : 0} 份, 目录读取失败 0 个`]);
  assert.deepEqual(ls(a1), [`${S1}.jsonl`, hb(S1, now + DAY, tok('f')), ...(CAN_LINK ? [`${U}.jsonl`, hb(U, now - H)] : [])].sort());
  assert.deepEqual([ls(a2), ls(a3), ls(a4)], [[], [], [`${S3}.jsonl`]]);
  assert.equal(ls(path.join(R, '.h')).length, 2, '点开头的目录不动');
  ok();
}

// ── t14 删除会话连带:只看本目录、三种形态全删(不论新旧)、.jsonl.bak 留、未来文件留、别的不动、没删东西不打日志 ──
{
  const R = freshRoot();
  const now = Date.now();
  const S = sidOf(81); const O = sidOf(82); const d = path.join(R, 'd1'); const e = path.join(R, 'd1-else');
  const mine = [hb(S, now - H), hb(S, now - 20 * DAY, tok('b')), hbOld(S, now - 2 * H), bakTs(S, now - 3 * H)];
  for (const n of mine) put(d, n);
  const stay = [bakPlain(S), hb(S, now + DAY, tok('f')), hb(O, now - H), `${S}.jsonl.archived`];
  for (const n of stay) put(d, n);
  put(e, hb(S, now - H));
  const r = await capture(() => M.dropSessionBackups(R, 'd1', S));
  assert.deepEqual(r.lines, ['[histbak] 删除会话时清理 sid=0000abcd: 删除 4 份, 失败 0 份, 占用跳过 0 份, 目录读取失败 0 个']);
  assert.deepEqual(ls(d), [...stay].sort());
  assert.equal(ls(e).length, 1, '别的目录不动');
  const quiet = await capture(() => M.dropSessionBackups(R, 'd1', S));
  assert.deepEqual(quiet.lines, [], '没删东西不打日志');
  session(path.join(R, '.dd'), S); put(path.join(R, '.dd'), hb(S, now - H));
  await capture(() => M.dropSessionBackups(R, '.dd', S));
  assert.equal(ls(path.join(R, '.dd')).length, 2, '不是工作区目录:不动');
  ok();
}

// ── t15 历史操作后收尾:按规则(本次那份保护)、删本次、unknown、别的提交占着同一会话时不删 ──
{
  const R = freshRoot();
  const now = Date.now();
  const S = sidOf(91); const d = path.join(R, 'h');
  session(d, S);
  const own = hb(S, now - 10 * H, tok('0'));
  const others = [1, 2, 3, 4].map((i) => hb(S, now - i * H, tok(String(i))));
  for (const n of [own, ...others]) put(d, n);
  put(d, bakPlain(S));
  const two = M.markSessionBusy(S); const one = M.markSessionBusy(S);
  await capture(() => M.cleanupAfterHistoryOp(R, { projectHash: 'h', sid: S, ownName: own, dropOwn: false }));
  assert.equal(ls(d).length, 7, '另一个提交也占着这个会话:不删');
  two();
  const r = await capture(() => M.cleanupAfterHistoryOp(R, { projectHash: 'h', sid: S, ownName: own, dropOwn: false }));
  one();
  assert.deepEqual(ls(d), [`${S}.jsonl`, bakPlain(S), own, others[0], others[1]].sort(), '本次那份 + 最新 2 份;.jsonl.bak 不动');
  assert.deepEqual(r.lines, ['[histbak] 历史操作后清理(按规则) sid=0000abcd: 删除 2 份, 失败 0 份, 归属不明 0 组, 目录读取失败 0 个']);
  const own2 = hb(S, now, tok('9')); put(d, own2);
  const drop = await capture(() => M.cleanupAfterHistoryOp(R, { projectHash: 'h', sid: S, ownName: own2, dropOwn: true }));
  assert.deepEqual(ls(d), [`${S}.jsonl`, bakPlain(S), own, others[0], others[1]].sort(), '删本次:只删这一份');
  assert.deepEqual(drop.lines, ['[histbak] 历史操作后清理(删本次) sid=0000abcd: 删除 1 份, 失败 0 份, 归属不明 0 组, 目录读取失败 0 个']);
  if (CAN_LINK) {
    const U = sidOf(92); put(outside(), 'u92.jsonl'); fs.symlinkSync(outside('u92.jsonl'), path.join(d, `${U}.jsonl`));
    for (let i = 1; i <= 4; i += 1) put(d, hb(U, now - i * H));
    const u = await capture(() => M.cleanupAfterHistoryOp(R, { projectHash: 'h', sid: U, ownName: hb(U, now - H), dropOwn: false }));
    assert.equal(ls(d).filter((n) => n.startsWith(U)).length, 5, 'unknown:不删');
    assert.deepEqual(u.lines, ['[histbak] 历史操作后清理(按规则) sid=0000abcd: 删除 0 份, 失败 0 份, 归属不明 1 组, 目录读取失败 0 个']);
  }
  const partial = put(d, hb(S, now, tok('7')));
  const p = await capture(() => M.discardPartialBackup(partial, S));
  assert.ok(!fs.existsSync(partial));
  assert.deepEqual(p.lines, ['[histbak] 历史操作后清理(删本次) sid=0000abcd: 删除 1 份, 失败 0 份, 归属不明 0 组, 目录读取失败 0 个']);
  assert.deepEqual((await capture(() => M.discardPartialBackup(partial, S))).lines, [], '根本没建出来:不算删除也不打日志');
  ok();
}

// ── t16 排程:首轮(启动)→ 再过一个首轮延迟第二轮(定时)→ 之后按间隔;stop 后不再跑 ──
{
  const R = freshRoot();
  const now = Date.now();
  const S = sidOf(95); const G = sidOf(96); const d = path.join(R, 's');
  session(d, S);
  for (let i = 1; i <= 4; i += 1) put(d, hb(S, now - i * H));
  put(d, hb(G, now - H));
  const lines = [];
  const ol = console.log;
  console.log = (...a) => { const l = a.join(' '); if (l.startsWith('[histbak]')) lines.push(l); else ol(...a); };
  let handle;
  try {
    const t0 = Date.now();
    handle = M.scheduleHistoryBackupSweeps(R, { delayMs: 150, intervalMs: 200 });
    for (let i = 0; i < 100 && lines.length < 3; i += 1) await sleep(50);
    handle.stop();
    const n = lines.length;
    await sleep(500);
    assert.ok(n >= 3, `三轮都应跑到(实际 ${n})`);
    assert.equal(lines.length, n, 'stop 之后不再跑');
    assert.match(lines[0], /^\[histbak\] 清理完成\(启动\)/);
    assert.match(lines[1], /^\[histbak\] 清理完成\(定时\).*待确认已删 0 组/);
    assert.match(lines[2], /^\[histbak\] 清理完成\(定时\)/);
    assert.ok(Date.now() - t0 >= 300, '第二轮在首轮之后再过一个首轮延迟');
  } finally { handle?.stop(); console.log = ol; }
  assert.equal(ls(d).length, 4, 'present 删到 3 份;gone 第二轮删掉');
  ok();
}

// ── t17 工作区目录核验自己把关:名字含 /、\、NUL,或是空串、'.'、'..',一律不是工作区目录(不靠调用方先校验)──
{
  const R = freshRoot();
  const now = Date.now();
  const S = sidOf(97);
  const own = hb(S, now - H);
  const nested = path.join(R, 'a', 'b'); // 'a/b' 的 realpath 恰好等于 realpath(R) 拼上它:修前会落到这层
  session(nested, S); put(nested, own); put(nested, hb(S, now - 2 * H, tok('c')));
  const backslashDir = process.platform === 'win32' ? null : path.join(R, 'a\\b'); // POSIX 上是一段名为 a\b 的目录
  if (backslashDir) { session(backslashDir, S); put(backslashDir, own); }
  const names = ['a/b', 'a/../a/b', 'a\\b', `a${String.fromCharCode(0)}b`, '', '.', '..'];
  for (const name of names) {
    await capture(() => M.dropSessionBackups(R, name, S));
    await capture(() => M.cleanupAfterHistoryOp(R, { projectHash: name, sid: S, ownName: own, dropOwn: true }));
  }
  assert.equal(ls(nested).length, 3, '第二层目录一份不动');
  if (backslashDir) assert.equal(ls(backslashDir).length, 2, '名字带反斜杠的不当工作区目录');
  ok();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`PASS check-r209-histbak-retention (${cases} 组)`);
