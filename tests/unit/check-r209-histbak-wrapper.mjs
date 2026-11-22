#!/usr/bin/env node
// 单测:r209 历史操作写备份的包装 runWithHistoryBackup(server/routes/session-history.js)。
// 覆盖:INTERFACE 3.2 收尾表的五行;会话忙在改写期间登记、收尾后(含抛错)解除;写备份失败时删掉写了一半的那份;
// 真实路由连续提交后同组只剩 3 份、最后一份在、重启后凭引用仍能找回;体检与清理不再另写 .bak-<时刻>;
// 两条守卫:产品代码里 writeHistoryBackup( 只在包装里调用,repairSessionFileGuarded( 只在包装的改写回调里调用。
// 隔离:HOME / USERPROFILE 在 import 之前指到系统临时目录(会话路径由 homedir() 拼),绝不碰真实 ~/.claude。
// Run: node tests/unit/check-r209-histbak-wrapper.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r209-wrap-'));
const HOME = path.join(TMP, 'home');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
assert.equal(os.homedir(), HOME, '家目录隔离没生效,不往下跑');
const HASH = 'r209-wrap';
const DIR = path.join(HOME, '.claude', 'projects', HASH);
fs.mkdirSync(DIR, { recursive: true });

const SH = await import('../../server/routes/session-history.js');
const { isSessionBusy } = await import('../../server/services/history-backup-retention.js');
const express = (await import('express')).default;

const H = 3_600_000;
const DAY = 86_400_000;
const sidOf = (n) => `00000209-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hb = (sid, ts, c = 'a') => `${sid}.jsonl.histbak-${ts}-${c.repeat(24)}`;
const put = (name, content = 'old') => fs.writeFileSync(path.join(DIR, name), content);
const backupsOf = (sid) => fs.readdirSync(DIR).filter((n) => n.startsWith(`${sid}.jsonl.`)).sort();
const ownOf = (ref, sid) => { const [, ts36, token] = ref.split('-'); return `${sid}.jsonl.histbak-${parseInt(ts36, 36)}-${token}`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function quiet(fn) {
  const lines = [];
  const [ol, oe, ow] = [console.log, console.error, console.warn];
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.error = console.log; console.warn = console.log;
  try { return { v: await fn(), lines }; } finally { console.log = ol; console.error = oe; console.warn = ow; }
}
function setup(sid) {
  const file = path.join(DIR, `${sid}.jsonl`);
  fs.writeFileSync(file, '{"type":"user","uuid":"u1","message":{"content":"hi"}}\n');
  const now = Date.now();
  const olds = [1, 2, 3, 4].map((i) => hb(sid, now - i * H, String(i)));
  for (const n of olds) put(n);
  put(`${sid}.jsonl.bak`);
  return { file, olds };
}
const ctx = (sid, file, raw = 'RAW') => ({ file, raw, sid, projectHash: HASH, principal: 'local' });

// ── 第 1 行:200 成功 → 保留本次,按规则清理同组(本次占一个名额);改写期间会话忙,收尾后解除 ──
{
  const sid = sidOf(1);
  const { file, olds } = setup(sid);
  let busyInside = null;
  let ref = null;
  const { v: out } = await quiet(() => SH.__runWithHistoryBackup(ctx(sid, file), async (r) => {
    busyInside = isSessionBusy(sid);
    ref = r;
    return { outcome: { ok: true, result: { ok: true, backupRef: r } } };
  }));
  assert.deepEqual(out, { ok: true, result: { ok: true, backupRef: ref } }, '返回值原样是 outcome');
  assert.equal(busyInside, true, '改写期间会话忙');
  assert.equal(isSessionBusy(sid), false, '收尾后解除');
  assert.equal(fs.readFileSync(path.join(DIR, ownOf(ref, sid)), 'utf8'), 'RAW');
  assert.deepEqual(backupsOf(sid), [`${sid}.jsonl.bak`, ownOf(ref, sid), olds[0], olds[1]].sort(), '本次 + 最新 2 份;.jsonl.bak 不动');
}

// ── 第 2、3 行:改写前拦下(显式 sessionUntouched)→ 删本次,同组别的不动 ──
for (const [n, code] of [[2, 'SESSION_CHANGED'], [3, 'SESSION_RUNNING']]) {
  const sid = sidOf(n);
  const { file } = setup(sid);
  const before = backupsOf(sid);
  const failure = { ok: false, status: 409, code, error: '拦下' };
  const { v: out, lines } = await quiet(() => SH.__runWithHistoryBackup(ctx(sid, file), async () => ({ sessionUntouched: true, outcome: failure })));
  assert.deepEqual(out, failure, `${code}:返回值不变`);
  assert.deepEqual(backupsOf(sid), before, `${code}:磁盘上该组一份不多一份不少`);
  assert.ok(lines.includes('[histbak] 历史操作后清理(删本次) sid=00000209: 删除 1 份, 失败 0 份, 归属不明 0 组, 目录读取失败 0 个'), lines.join('\n'));
  assert.equal(isSessionBusy(sid), false);
}

// ── 第 4 行:改写中抛错(可能已改写)→ 500 SESSION_WRITE_FAILED,保留本次并按规则清理;没标明的失败同样当可能已改写 ──
{
  const sid = sidOf(4);
  const { file, olds } = setup(sid);
  let ref = null;
  const { v: out } = await quiet(() => SH.__runWithHistoryBackup(ctx(sid, file), async (r) => { ref = r; throw new Error('rename boom'); }));
  assert.deepEqual(out, { ok: false, status: 500, code: 'SESSION_WRITE_FAILED', error: '改写失败,原会话可能未改动:rename boom' });
  assert.deepEqual(backupsOf(sid), [`${sid}.jsonl.bak`, ownOf(ref, sid), olds[0], olds[1]].sort());
  assert.equal(isSessionBusy(sid), false, '抛错之后也解除会话忙');
  const sid2 = sidOf(14);
  const s2 = setup(sid2);
  let ref2 = null;
  await quiet(() => SH.__runWithHistoryBackup(ctx(sid2, s2.file), async (r) => { ref2 = r; return { outcome: { ok: false, status: 409, code: 'SESSION_CHANGED', error: 'x' } }; }));
  assert.ok(backupsOf(sid2).includes(ownOf(ref2, sid2)), '没标明 sessionUntouched 的失败:保留本次');
}

// ── 第 5 行:写备份本身失败 → 500 SESSION_BACKUP_FAILED,写了一半的那份删掉,别的不动,不调改写 ──
{
  const sid = sidOf(5);
  const { file } = setup(sid);
  const before = backupsOf(sid);
  function* halfThenFail() { yield 'half-'; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
  let called = false;
  const { v: out, lines } = await quiet(() => SH.__runWithHistoryBackup(ctx(sid, file, halfThenFail()), async () => { called = true; return { outcome: { ok: true } }; }));
  assert.equal(called, false, '备份失败不改写');
  assert.deepEqual(out, { ok: false, status: 500, code: 'SESSION_BACKUP_FAILED', error: '备份失败,会话未改动:disk full' });
  assert.deepEqual(backupsOf(sid), before, '写了一半的那份已删,别的不动');
  assert.ok(lines.includes('[histbak] 历史操作后清理(删本次) sid=00000209: 删除 1 份, 失败 0 份, 归属不明 0 组, 目录读取失败 0 个'), `半份确实写出来过又被删掉:${lines.join('\n')}`);
  assert.equal(isSessionBusy(sid), false);
}

// ── 真实路由:连续 5 次去思考块后同组只剩 3 份(最后 3 次的),重启后凭引用仍能找回;体检与清理不再另写 .bak-<时刻> ──
{
  const sid = sidOf(6);
  const file = path.join(DIR, `${sid}.jsonl`);
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(file, `${[
    L({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'q' }] } }),
    L({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'ans' }] } }),
  ].join('\n')}\n`);
  const now = Date.now();
  const pre = [`${sid}.jsonl.bak-${now - H}`, `${sid}.jsonl.histbak-${now - 2 * H}`, hb(sid, now - 20 * DAY, 'b')];
  for (const n of pre) put(n);
  put(`${sid}.jsonl.bak`);
  const app = express();
  app.use(express.json());
  app.use('/api', SH.default);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sessions/${sid}`;
  const post = async (op, body) => {
    const r = await fetch(`${base}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectHash: HASH, ...body }) });
    return { status: r.status, json: await r.json() };
  };
  const submit = async (op) => {
    const pv = await post(op, { dryRun: true });
    assert.equal(pv.status, 200, JSON.stringify(pv.json));
    const sb = await post(op, { dryRun: false, previewToken: pv.json.previewToken, baseVersion: pv.json.baseVersion });
    assert.equal(sb.status, 200, JSON.stringify(sb.json));
    assert.equal(typeof sb.json.backupRef, 'string');
    return sb.json.backupRef;
  };
  try {
    const refs = [(await quiet(() => submit('strip-thinking'))).v];
    assert.deepEqual(backupsOf(sid), [`${sid}.jsonl.bak`, ownOf(refs[0], sid), pre[0], pre[1]].sort(), '第 1 次:本次 + 旧的最新 2 份,满 14 天的删掉');
    for (let i = 0; i < 4; i += 1) { await sleep(5); refs.push((await quiet(() => submit('strip-thinking'))).v); }
    assert.deepEqual(backupsOf(sid), [`${sid}.jsonl.bak`, ...refs.slice(2).map((r) => ownOf(r, sid))].sort(), '连续 5 次后只剩最后 3 次的 + .jsonl.bak');
    SH.__resetHistoryStores();
    const back = await SH.__recoverBackup(refs[4], sid, 'local');
    assert.equal(back.entry?.path, path.join(DIR, ownOf(refs[4], sid)), '重启后凭引用找回最后一份');
    fs.appendFileSync(file, `${L({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } })}\n`);
    await sleep(5);
    const t0 = Date.now();
    const repairRef = (await quiet(() => submit('repair-official-compat'))).v;
    const names = backupsOf(sid);
    assert.ok(names.includes(ownOf(repairRef, sid)), '体检与清理:本次的 .histbak 在');
    assert.deepEqual(names.filter((n) => /\.jsonl\.bak-\d+$/.test(n) && Number(n.split('.bak-')[1]) >= t0), [], '体检与清理不再另写 .bak-<时刻>');
    assert.equal(names.filter((n) => n !== `${sid}.jsonl.bak`).length, 3, '合计仍是 3 份');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => { server.close(() => r()); });
  }
}

// ── 守卫:绕过包装写备份 / 调体检(它不再自带备份)会被拦下 ──
{
  const SERVER = fileURLToPath(new URL('../../server/', import.meta.url));
  const jsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : (/\.(c|m)?js$/.test(e.name) ? [p] : []);
  });
  const codeLines = (src) => src.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l));
  const bodyRange = (lines, header) => {
    const start = lines.findIndex((l) => l.startsWith(header));
    assert.ok(start >= 0, `找不到 ${header}`);
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return [start, end];
  };
  const hits = (needle) => jsFiles(SERVER).flatMap((f) => codeLines(fs.readFileSync(f, 'utf8'))
    .map((l, i) => (l.includes(needle) ? { file: path.relative(SERVER, f), line: i } : null)).filter(Boolean));
  const shLines = codeLines(fs.readFileSync(path.join(SERVER, 'routes', 'session-history.js'), 'utf8'));
  const [ws, we] = bodyRange(shLines, 'async function runWithHistoryBackup(');
  const writes = hits('writeHistoryBackup(');
  const writeCalls = writes.filter((h) => !(h.file === path.join('routes', 'session-history.js') && shLines[h.line].startsWith('async function writeHistoryBackup(')));
  assert.equal(writeCalls.length, 1, `writeHistoryBackup( 只应有 1 处调用:${JSON.stringify(writeCalls)}`);
  assert.ok(writeCalls[0].file === path.join('routes', 'session-history.js') && writeCalls[0].line > ws && writeCalls[0].line < we, '唯一的调用在 runWithHistoryBackup 里');
  const [rs, re] = bodyRange(shLines, 'async function runSubmitLocked(');
  const wrapAt = shLines.findIndex((l, i) => i > rs && i < re && l.includes('return runWithHistoryBackup('));
  const repairs = hits('repairSessionFileGuarded(').filter((h) => !(h.file === path.join('routes', 'sessions.js')));
  const defs = hits('repairSessionFileGuarded(').filter((h) => h.file === path.join('routes', 'sessions.js'));
  assert.equal(defs.length, 1, 'sessions.js 里只有定义,没有调用');
  assert.equal(repairs.length, 1, `repairSessionFileGuarded( 只应有 1 处调用:${JSON.stringify(repairs)}`);
  assert.ok(wrapAt > 0 && repairs[0].file === path.join('routes', 'session-history.js') && repairs[0].line > wrapAt && repairs[0].line < re,
    '唯一的调用在 runSubmitLocked 交给 runWithHistoryBackup 的改写回调里');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('PASS check-r209-histbak-wrapper');
