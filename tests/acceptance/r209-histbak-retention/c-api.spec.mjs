// r209 设置页用的接口:GET /api/history-backups、DELETE /api/history-backups/all、DELETE /api/history-backups/:projectHash/:sessionId。
// 后端 A(自动清理推迟到约 24.8 天后)。每个用例开头 wipeMainBackups() 再造自己的夹具(目录名 r209-dyn-*),用例互不依赖。
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  api, rawRequest, listBackups, delSingle, delAll, wipeMainBackups, dynDir, mainR, mainHome, putFile, putSession, userLine, hb, hbOld, bakTs, bakPlain, sidOf, tok,
  names, exists, backupNamesOf, DAY,
} from './helpers/common.mjs';

const H = 3_600_000;
const sec = (ms) => Math.floor(ms / 1000) * 1000;
const base = () => sec(Date.now());
const put = (dir, name, size, mtimeMs, content) => putFile(dir, name, { size, mtimeMs: mtimeMs ?? Date.now(), content });
const ownOf = (res, hash) => res.json.sessions.filter((s) => s.projectHash === hash);
const OK0 = { ok: true, deleted: 0, freedBytes: 0, failed: 0, skippedBusy: 0, skippedUnknown: 0, skippedDirs: 0 };
const outside = (...p) => path.join(mainHome(), 'r209-outside', ...p);

test('L1 列表:总数/总占用/规则、每组的份数、字节、最早最晚时间(含古早.bak)、状态、标题取法、按占用降序、不含文件名路径', async () => {
  wipeMainBackups();
  const b = base(); const d = dynDir('l1'); const dB = dynDir('l1-b');
  const [A, B, C, D, E] = [31, 32, 33, 34, 35].map(sidOf);
  putSession(d, A); putSession(d, D); putSession(d, E); putSession(dB, C);
  put(d, hb(A, b - 3 * H, tok('a')), 100, b); put(d, hbOld(A, b - 2 * H), 200, b); put(d, bakTs(A, b - H), 300, b, userLine('R209标题A'));
  put(d, bakPlain(A), 400, b - 10 * H);
  put(d, hb(B, b - 5 * H, tok('a')), 1500, b, userLine('不该用这条旧的'));
  put(d, hb(B, b - 4 * H, tok('b')), 1500, b, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: '数组标题B' }] } }));
  put(d, hb(C, b - 6 * H, tok('a')), 50, b, 'not json');
  put(d, hb(D, b - H, tok('a')), 700, b, `${JSON.stringify({ type: 'assistant', message: { content: 'hi' } })}\n${userLine('X'.repeat(100))}`);
  put(d, hb(E, b - H, tok('a')), 9600, b, `${JSON.stringify({ type: 'assistant', message: { content: 'z'.repeat(9000) } })}\n${userLine('太靠后的标题')}`);
  const res = await listBackups();
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  expect(res.json.ok).toBe(true);
  expect(res.json.rules).toEqual({ maxAgeDays: 14, maxPerSession: 3 });
  expect(res.json.totalCount).toBe(9);
  expect(res.json.totalBytes).toBe(100 + 200 + 300 + 400 + 3000 + 50 + 700 + 9600);
  expect(res.json.skippedUnknown).toBe(0);
  expect(res.json.skippedDirs).toBe(0);
  const row = (hash, sessionId, state, title, count, bytes, oldestAt, newestAt) => ({ projectHash: hash, sessionId, state, title, count, bytes, oldestAt, newestAt });
  expect(res.json.sessions).toEqual([
    row('r209-dyn-l1', E, 'present', '', 1, 9600, b - H, b - H),
    row('r209-dyn-l1', B, 'gone', '数组标题B', 2, 3000, b - 5 * H, b - 4 * H),
    row('r209-dyn-l1', A, 'present', 'R209标题A', 4, 1000, b - 10 * H, b - H),
    row('r209-dyn-l1', D, 'present', 'X'.repeat(80), 1, 700, b - H, b - H),
    row('r209-dyn-l1', C, 'elsewhere', '', 1, 50, b - 6 * H, b - 6 * H),
  ]);
  expect(res.text, '响应里不应有文件名、路径、备份正文').not.toMatch(/histbak|\.jsonl|\.bak|not json/);
});

test('L3 列表排序平局:占用相同看最晚时间(新的在前),再相同看目录名升序,再相同看会话编号升序', async () => {
  wipeMainBackups();
  const b = base();
  const grp = (tag, sid, size, ts) => { const d = dynDir(tag); putSession(d, sid); put(d, hb(sid, ts, tok('a')), size, b); };
  grp('t1', sidOf(21), 777, b - 5 * H); grp('t1', sidOf(22), 777, b - H);
  grp('t3', sidOf(23), 555, b - 2 * H); grp('t2', sidOf(24), 555, b - 2 * H);
  grp('t4', sidOf(26), 555, b - 2 * H); grp('t4', sidOf(25), 555, b - 2 * H);
  const res = await listBackups();
  expect(res.status).toBe(200);
  expect(res.json.sessions.map((s) => `${s.projectHash}/${s.sessionId.slice(-2)}`)).toEqual(['r209-dyn-t1/22', 'r209-dyn-t1/21', 'r209-dyn-t2/24', 'r209-dyn-t3/23', 'r209-dyn-t4/25', 'r209-dyn-t4/26']);
});

test('L2 列表不算的东西:未来文件、名字对不上的、子目录、软链接、点开头与软链接的工作区目录;归属不明只计入 skippedUnknown 不列出', async () => {
  wipeMainBackups();
  const b = base(); const d = dynDir('s1'); const P = sidOf(41); const U = sidOf(42);
  putSession(d, P);
  for (let i = 1; i <= 3; i += 1) put(d, hb(P, b - i * H, tok('a')), 100, b);
  put(d, hb(P, b + 10 * DAY, tok('b')), 100, b);
  put(d, hb(P, b - 20 * DAY, 'a'.repeat(23)), 100, b); put(d, `${P}.jsonl.archived`, 100, b); put(d, `${P}.jsonl.BAK`, 100, b);
  fs.mkdirSync(path.join(d, hb(P, b - 5 * H, tok('c'))), { recursive: true });
  fs.mkdirSync(outside('t'), { recursive: true }); fs.writeFileSync(outside('t', 'x.txt'), 'x\n');
  fs.symlinkSync(outside('t', 'x.txt'), path.join(d, hb(P, b - 6 * H, tok('d'))));
  fs.writeFileSync(outside('real.jsonl'), `${userLine('u')}\n`); fs.symlinkSync(outside('real.jsonl'), path.join(d, `${U}.jsonl`));
  put(d, hb(U, b - H, tok('a')), 50, b); put(d, hb(U, b - 2 * H, tok('a')), 50, b);
  const hid = path.join(mainR(), '.r209-hidden'); putSession(hid, sidOf(43)); put(hid, hb(sidOf(43), b - H, tok('a')), 100, b);
  const linkTarget = outside('linkdir'); putSession(linkTarget, sidOf(44)); put(linkTarget, hb(sidOf(44), b - H, tok('a')), 100, b);
  fs.symlinkSync(linkTarget, path.join(mainR(), 'r209-dyn-link'));
  const res = await listBackups();
  expect(res.status).toBe(200);
  expect(res.json.sessions).toEqual([{ projectHash: 'r209-dyn-s1', sessionId: P, state: 'present', title: '', count: 3, bytes: 300, oldestAt: b - 3 * H, newestAt: b - H }]);
  expect(res.json.totalCount).toBe(3);
  expect(res.json.totalBytes).toBe(300);
  expect(res.json.skippedUnknown, '会话记录是软链接的那组(2 份)只计数不列出').toBe(2);
  expect(res.json.skippedDirs).toBe(0);
});

const BAD_HASH = { code: 'HISTBAK_INVALID_INPUT', error: 'projectHash 必须是合法的工作区目录名' };
const BAD_SID = { code: 'HISTBAK_INVALID_INPUT', error: 'sessionId 必须是 36 位会话编号' };

test('E1 设置页单个删除_参数非法(400):projectHash 为 .. / . / 点开头 / 含斜杠 / 含反斜杠 / 含 NUL / 256 位;sessionId 不是 36 位十六进制;两个都错先报 projectHash', async () => {
  wipeMainBackups();
  const sid = sidOf(51);
  const hashes = { '..': '%2e%2e', '.': '%2e', 点开头: '.hidden', 含斜杠: 'a%2Fb', 含反斜杠: 'a%5Cb', 含NUL: 'a%00b', 长256: 'a'.repeat(256) };
  for (const [label, enc] of Object.entries(hashes)) {
    const r = await rawRequest('DELETE', `/api/history-backups/${enc}/${sid}`);
    expect(r.status, `projectHash=${label}`).toBe(400);
    expect(r.json, `projectHash=${label}`).toEqual({ ok: false, ...BAD_HASH });
  }
  for (const [label, s] of Object.entries({ 太短: 'abc', 少一位: sidOf(1).slice(1), 多一位: `${sidOf(1)}0`, 含非十六进制: `g${sidOf(1).slice(1)}` })) {
    const r = await rawRequest('DELETE', `/api/history-backups/r209-dyn-e1/${s}`);
    expect(r.status, `sessionId ${label}`).toBe(400);
    expect(r.json, `sessionId ${label}`).toEqual({ ok: false, ...BAD_SID });
  }
  const both = await rawRequest('DELETE', '/api/history-backups/%2e%2e/abc');
  expect(both.status).toBe(400);
  expect(both.json, '两个参数都错:先校验 projectHash').toEqual({ ok: false, ...BAD_HASH });
});

test('E2 设置页单个删除_找不到工作区目录(404):不存在 / 是普通文件 / 是软链接(链接目标里的备份不动)/ 255 位合法长度但不存在', async () => {
  wipeMainBackups();
  const sid = sidOf(52); const b = base();
  fs.writeFileSync(path.join(mainR(), 'r209-dyn-e2file'), 'x\n');
  putSession(outside('e2target'), sid); put(outside('e2target'), hb(sid, b - H, tok('a')), 100, b);
  fs.symlinkSync(outside('e2target'), path.join(mainR(), 'r209-dyn-e2link'));
  for (const [label, hash] of Object.entries({ 不存在: 'r209-dyn-nonexistent', 普通文件: 'r209-dyn-e2file', 软链接: 'r209-dyn-e2link', 长255: 'a'.repeat(255) })) {
    const r = await delSingle(hash, sid);
    expect(r.status, `projectHash=${label}`).toBe(404);
    expect(r.json, `projectHash=${label}`).toEqual({ ok: false, code: 'HISTBAK_NOT_FOUND', error: '没有这个工作区目录' });
  }
  expect(names(outside('e2target')).length, '软链接指向的目录里的备份一份不动(会话记录 + 1 份备份)').toBe(2);
});

test('X1 设置页单个删除:删该组全部(含古早.bak,不受14天/3份限制),留未来文件与名字对不上的,别的会话不动,响应数字准确,重复删除再得全 0', async () => {
  wipeMainBackups();
  const b = base(); const d = dynDir('x1'); const S = sidOf(61); const O = sidOf(62);
  putSession(d, S);
  const mine = [[hb(S, b - H, tok('a')), 101], [hb(S, b - 2 * H, tok('b')), 102], [hbOld(S, b - 3 * H), 103], [bakTs(S, b - 4 * H), 104], [hb(S, b - 20 * DAY, tok('c')), 105], [bakPlain(S), 106]];
  for (const [n, size] of mine) put(d, n, size, n === bakPlain(S) ? b - 30 * DAY : b);
  const keep = [hb(S, b + 10 * DAY, tok('d')), `${S}.jsonl.archived`, hb(S, b - H, 'a'.repeat(25)), `${S}.jsonl.BAK`, hb(O, b - H, tok('a'))];
  for (const n of keep) put(d, n, 50, b);
  const r = await delSingle('r209-dyn-x1', S);
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(r.json).toEqual({ ...OK0, deleted: 6, freedBytes: 101 + 102 + 103 + 104 + 105 + 106 });
  expect(names(d).sort(), '只剩会话记录 + 不该删的').toEqual([`${S}.jsonl`, ...keep].sort());
  const again = await delSingle('r209-dyn-x1', S);
  expect(again.status).toBe(200);
  expect(again.json, '没有备份可删:计数全 0').toEqual(OK0);
});

test('X1u 设置页单个删除_归属不明(会话记录是软链接):什么都不删,只计入 skippedUnknown', async () => {
  wipeMainBackups();
  const b = base(); const d = dynDir('x1u'); const U = sidOf(63);
  fs.mkdirSync(outside(), { recursive: true }); fs.writeFileSync(outside('u.jsonl'), `${userLine('u')}\n`);
  fs.mkdirSync(d, { recursive: true }); fs.symlinkSync(outside('u.jsonl'), path.join(d, `${U}.jsonl`));
  const bk = [hb(U, b - H, tok('a')), bakTs(U, b - 2 * H)];
  for (const n of bk) put(d, n, 50, b);
  const r = await delSingle('r209-dyn-x1u', U);
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ ...OK0, skippedUnknown: 2 });
  expect(names(d).filter((n) => n !== `${U}.jsonl`).sort(), '备份一份不少').toEqual([...bk].sort());
});

test('X2 设置页全部清理:present/gone/elsewhere 的四种形态全删(不受14天/3份限制),留归属不明、未来文件、名字对不上的、子目录、软链接、点开头与软链接工作区目录;再删一次得0', async () => {
  wipeMainBackups();
  const b = base(); const a1 = dynDir('all1'); const a2 = dynDir('all2'); const a3 = dynDir('all3'); const a4 = dynDir('all4');
  const [S1, S2, S3, U] = [71, 72, 73, 74].map(sidOf);
  putSession(a1, S1); putSession(a4, S3); fs.mkdirSync(a2, { recursive: true }); fs.mkdirSync(a3, { recursive: true });
  let freed = 0; let n = 0;
  const del = (dir, name, size, mt) => { put(dir, name, size, mt ?? b); freed += size; n += 1; };
  for (let i = 1; i <= 5; i += 1) del(a1, hb(S1, b - i * H, tok('a')), 10 + i);
  del(a1, hb(S1, b - 20 * DAY, tok('b')), 16); del(a1, bakPlain(S1), 17, b - 30 * DAY);
  del(a2, hb(sidOf(72), b - H, tok('a')), 21); del(a2, hbOld(sidOf(72), b - 2 * H), 22);
  del(a3, hb(S3, b - H, tok('a')), 31);
  const keep = [hb(S1, b + 10 * DAY, tok('c')), hb(S1, b - H, 'a'.repeat(23)), `${S1}.jsonl.archived`];
  for (const k of keep) put(a1, k, 50, b);
  fs.mkdirSync(path.join(a1, hb(S1, b - 7 * H, tok('d'))), { recursive: true });
  fs.mkdirSync(outside(), { recursive: true }); fs.writeFileSync(outside('keep.txt'), 'k\n');
  fs.symlinkSync(outside('keep.txt'), path.join(a1, hb(S1, b - 8 * H, tok('e'))));
  fs.writeFileSync(outside('u.jsonl'), `${userLine('u')}\n`); fs.symlinkSync(outside('u.jsonl'), path.join(a1, `${U}.jsonl`));
  const unk = [hb(U, b - H, tok('a')), hb(U, b - 2 * H, tok('a'))]; for (const k of unk) put(a1, k, 41, b);
  const hid = path.join(mainR(), '.r209-hidden'); putSession(hid, sidOf(75)); put(hid, hb(sidOf(75), b - H, tok('a')), 60, b);
  const lt = outside('linkdir'); putSession(lt, sidOf(76)); put(lt, hb(sidOf(76), b - H, tok('a')), 60, b); fs.symlinkSync(lt, path.join(mainR(), 'r209-dyn-link'));

  const r = await delAll();
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(r.json).toEqual({ ...OK0, deleted: n, freedBytes: freed, skippedUnknown: 2 });
  expect(names(a1).sort(), 'present 组:只剩会话记录与不该删的').toEqual([`${S1}.jsonl`, `${U}.jsonl`, ...keep, hb(S1, b - 7 * H, tok('d')), hb(S1, b - 8 * H, tok('e')), ...unk].sort());
  expect(names(a2), 'gone 组删光').toEqual([]);
  expect(names(a3), 'elsewhere 组删光').toEqual([]);
  expect(names(a4), '别的目录里的会话记录还在').toEqual([`${S3}.jsonl`]);
  expect(backupNamesOf(hid, sidOf(75)).length, '点开头的目录不是工作区目录:里面的备份不动').toBe(1);
  expect(backupNamesOf(lt, sidOf(76)).length, '软链接工作区目录:链接目标里的备份不动').toBe(1);
  const again = await delAll();
  expect(again.json.deleted, '重复全部清理:这次没有可删的').toBe(0);
  expect(again.json.freedBytes).toBe(0);
  const list = await listBackups();
  expect(list.json.totalCount, '清完后列表里没有备份').toBe(0);
  expect(list.json.sessions).toEqual([]);
});

test('X3 请求体一律忽略:带 {files:[...],path:"../x"} 只按路径参数删;无法解析的 JSON 体被全局拦成 400 且一份不删', async () => {
  wipeMainBackups();
  const b = base(); const d = dynDir('x3'); const S = sidOf(81);
  putSession(d, S); put(d, 'keep.txt', 20, b);
  const bk = [hb(S, b - H, tok('a')), hb(S, b - 2 * H, tok('b'))];
  for (const n of bk) put(d, n, 30, b);
  const bad = await rawRequest('DELETE', `/api/history-backups/r209-dyn-x3/${S}`, '{bad');
  expect(bad.status, '无法解析的 JSON 请求体').toBe(400);
  expect(names(d).sort(), '400 时不删任何文件').toEqual([...bk, 'keep.txt', `${S}.jsonl`].sort());
  const ok = await api('DELETE', `/api/history-backups/r209-dyn-x3/${S}`, { files: [`${S}.jsonl`, 'keep.txt'], path: '../x', projectHash: '..', sessionId: 'x' });
  expect(ok.status).toBe(200);
  expect(ok.json).toEqual({ ...OK0, deleted: 2, freedBytes: 60 });
  expect(names(d).sort(), '请求体里点名的会话记录与别的文件都还在').toEqual(['keep.txt', `${S}.jsonl`]);
});

test('X6 没有对应路由的请求不删文件:DELETE /api/history-backups、POST /api/history-backups/all、已删除的 GET/DELETE /api/bak-files(也不再返回 items)', async () => {
  wipeMainBackups();
  const b = base(); const d = dynDir('x6'); const S = sidOf(82);
  putSession(d, S);
  const bk = [hb(S, b - H, tok('a')), bakTs(S, b - 2 * H), bakPlain(S)];
  for (const n of bk) put(d, n, 30, b - (n === bakPlain(S) ? 30 * DAY : 0));
  const expected = [...bk, `${S}.jsonl`].sort();
  const noSuffix = await api('DELETE', '/api/history-backups');
  expect(noSuffix.status, 'DELETE /api/history-backups 没有路由').toBeGreaterThanOrEqual(400);
  const post = await api('POST', '/api/history-backups/all', {});
  expect(post.status, 'POST /api/history-backups/all 没有路由').toBeGreaterThanOrEqual(400);
  const getOld = await api('GET', '/api/bak-files');
  expect(Array.isArray(getOld.json?.items), 'GET /api/bak-files 不应再返回 items 列表').toBe(false);
  await api('DELETE', '/api/bak-files', { files: [path.join(d, bakPlain(S))], paths: [path.join(d, bakPlain(S))] });
  expect(names(d).sort(), '以上请求之后,磁盘上一份不少').toEqual(expected);
});

test('X4a 设置页单个删除_删不掉(目录只读,POSIX):响应 failed=份数、deleted=0,文件原样在', async () => {
  test.skip(process.platform === 'win32', '目录只读的办法只适用 POSIX');
  wipeMainBackups();
  const b = base(); const d = dynDir('x4a'); const S = sidOf(84);
  putSession(d, S);
  const bk = [hb(S, b - H, tok('a')), hb(S, b - 2 * H, tok('b')), bakTs(S, b - 3 * H)];
  for (const n of bk) put(d, n, 30, b);
  fs.chmodSync(d, 0o555);
  try {
    const r = await delSingle('r209-dyn-x4a', S);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.json).toEqual({ ...OK0, failed: 3 });
    expect(names(d).sort()).toEqual([...bk, `${S}.jsonl`].sort());
  } finally { fs.chmodSync(d, 0o755); }
});

test('X4b 工作区目录读不了(POSIX,权限 000):单个删除 500 HISTBAK_DELETE_FAILED「清理失败(EACCES)」;列表与全部清理计入 skippedDirs=1,其余目录照常', async () => {
  test.skip(process.platform === 'win32', '目录权限 000 只适用 POSIX');
  wipeMainBackups();
  const b = base(); const bad = dynDir('x4b'); const okd = dynDir('x4c'); const S = sidOf(85); const T2 = sidOf(86);
  putSession(bad, S); put(bad, hb(S, b - H, tok('a')), 30, b); putSession(okd, T2); put(okd, hb(T2, b - H, tok('a')), 30, b);
  fs.chmodSync(bad, 0o000);
  try {
    const one = await delSingle('r209-dyn-x4b', S);
    expect(one.status).toBe(500);
    expect(one.json).toEqual({ ok: false, code: 'HISTBAK_DELETE_FAILED', error: '清理失败(EACCES)' });
    const list = await listBackups();
    expect(list.status).toBe(200);
    expect(list.json.skippedDirs).toBe(1);
    expect(list.json.sessions.map((s) => s.sessionId)).toEqual([T2]);
    const all = await delAll();
    expect(all.status).toBe(200);
    expect(all.json).toEqual({ ...OK0, deleted: 1, freedBytes: 30, skippedDirs: 1 });
  } finally { fs.chmodSync(bad, 0o755); }
  expect(backupNamesOf(bad, S).length, '读不了的目录里的备份没动').toBe(1);
});

test('X5 名字恰为 all 的工作区目录:只能经两段路由 DELETE /api/history-backups/all/<会话编号> 删它里面某个会话的备份', async () => {
  wipeMainBackups();
  const b = base(); const d = path.join(mainR(), 'all'); const S = sidOf(87);
  try {
    putSession(d, S); const bk = [hb(S, b - H, tok('a')), hbOld(S, b - 2 * H)]; for (const n of bk) put(d, n, 25, b);
    const r = await delSingle('all', S);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.json).toEqual({ ...OK0, deleted: 2, freedBytes: 50 });
    expect(names(d), '只剩会话记录').toEqual([`${S}.jsonl`]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
