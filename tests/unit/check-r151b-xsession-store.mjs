#!/usr/bin/env node
// r151b T-X2:跨会话收件箱存储(server/services/xsession-store.js)与 GET/PUT /api/xsession/config、总开关闸门。
// 临时 HOME;不起 claude 进程(SDK 换成 helpers/r151b-sdk-stub.mjs);端口在 6800–6899 里挑。
// node tests/unit/check-r151b-xsession-store.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, statSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-xstore-')));
const HOME = join(TMP, 'home');
mkdirSync(join(HOME, '.claude', 'projects'), { recursive: true });
mkdirSync(join(HOME, '.claude-gui'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CGUI_DISABLE_FILE_WATCHER = '1';
registerR151bSdkStub();

const XS = join(HOME, '.claude-gui', 'xsession');
const MSG = join(XS, 'messages.json');
const BODIES = join(XS, 'bodies');
const PREFS = join(HOME, '.claude-gui', 'prefs.json');
const storeUrl = new URL('../../server/services/xsession-store.js', import.meta.url).href;
let n = 0;
const freshStore = () => import(`${storeUrl}?i=${n++}`); // 新的模块实例 = 模拟服务重启
const mode = (p) => statSync(p).mode & 0o777;
const rec = (to, status = 'pending', extra = {}) => ({
  id: randomUUID(), createdAt: new Date().toISOString(), status, from: { kind: 'user', sessionId: null, title: '' },
  to: { sessionId: to }, bodyBytes: 1, via: null, heldReason: status === 'pending' ? 'target-card' : null, ...extra,
});
let checks = 0;
const ok = (v, msg) => { assert.ok(v, msg); checks += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks += 1; };

try {
  // ── 存储:懒加载,读不建目录 ────────────────────────────────────────────────
  const S = await freshStore();
  const B = randomUUID();
  const C = randomUUID();
  eq(await S.listXsMessages(), [], '没有文件时是空表');
  eq((await S.pendingCountsBySession()).size, 0, '没有待处理');
  ok(!existsSync(XS), '只读不建 ~/.claude-gui/xsession/');

  // ── 新消息:先正文后元数据,权限 0700 / 0600 ────────────────────────────────
  const m1 = rec(B);
  const m2 = rec(C);
  const r1 = await S.mutateXsInbox((msgs, tx) => {
    msgs.push(m1, m2);
    tx.putBody(m1.id, '正文一\n第二行');
    tx.putBody(m2.id, 'body two');
    return 'done-1';
  });
  eq(r1, 'done-1', 'mutate 返回 fn 的返回值');
  eq(mode(XS), 0o700, 'xsession 目录 0700');
  eq(mode(BODIES), 0o700, 'bodies 目录 0700');
  eq(mode(MSG), 0o600, 'messages.json 0600');
  eq(mode(join(BODIES, `${m1.id}.txt`)), 0o600, '正文文件 0600');
  eq(await S.readXsBody(m1.id), '正文一\n第二行', '正文逐字');
  eq(JSON.parse(readFileSync(MSG, 'utf8')).messages.map((m) => m.id), [m1.id, m2.id], '元数据按到达先后');
  ok(!readFileSync(MSG, 'utf8').includes('正文一'), '元数据文件里没有正文');
  eq([...(await S.pendingCountsBySession())].sort(), [[B, 1], [C, 1]].sort(), '各会话待处理条数');
  eq(await S.readXsBody('../../etc/passwd'), null, 'id 形状不对的正文读取 → null');

  // ── fn 抛错 / putBody 给已有消息 → 什么都不写 ──────────────────────────────
  const snap = readFileSync(MSG, 'utf8');
  await assert.rejects(S.mutateXsInbox((msgs) => { msgs.length = 0; throw new Error('boom'); }), /boom/);
  await assert.rejects(S.mutateXsInbox((msgs, tx) => { msgs[0].status = 'done'; tx.putBody(m1.id, 'x'); }), /只能给新消息/);
  eq(readFileSync(MSG, 'utf8'), snap, 'fn 抛错后元数据不变');
  eq((await S.listXsMessages()).length, 2, 'fn 抛错后内存不变');
  eq(await S.readXsBody(m1.id), '正文一\n第二行', 'fn 抛错后正文还在');

  // ── 没有变化不写盘 ──────────────────────────────────────────────────────────
  const mt = statSync(MSG).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await S.mutateXsInbox(() => {});
  eq(statSync(MSG).mtimeMs, mt, '没有变化时不写盘');

  // ── 结束即删正文,元数据保留 ────────────────────────────────────────────────
  await S.mutateXsInbox((msgs) => { msgs.find((m) => m.id === m1.id).status = 'done'; });
  ok(!existsSync(join(BODIES, `${m1.id}.txt`)), 'done 后正文文件删除');
  eq(await S.readXsBody(m1.id), null, 'done 后正文读不到');
  eq((await S.listXsMessages()).find((m) => m.id === m1.id).status, 'done', '元数据保留');
  ok(existsSync(join(BODIES, `${m2.id}.txt`)), '其它消息的正文不受影响');

  // ── 串行:并发 30 个写全部生效 ──────────────────────────────────────────────
  const many = Array.from({ length: 30 }, () => rec(B));
  await Promise.all(many.map((m, i) => S.mutateXsInbox((msgs, tx) => { msgs.push(m); tx.putBody(m.id, `p${i}`); })));
  const afterMany = await S.listXsMessages();
  ok(many.every((m) => afterMany.some((x) => x.id === m.id)), '并发写一条不丢');
  eq(await S.readXsBody(many[29].id), 'p29', '并发写的正文各自落盘');
  eq((await S.pendingCountsBySession()).get(B), 30, '并发后计数(m1 已 done 不算)');

  // ── 写失败:状态不变、本次新写的正文删掉 ────────────────────────────────────
  const snap2 = readFileSync(MSG, 'utf8');
  const failing = rec(C);
  chmodSync(XS, 0o500);
  let err = null;
  try { await S.mutateXsInbox((msgs, tx) => { msgs.push(failing); tx.putBody(failing.id, 'nope'); msgs[1].status = 'dismissed'; }); } catch (e) { err = e; }
  chmodSync(XS, 0o700);
  ok(err instanceof S.XsStorageError && err.code === 'STORAGE_WRITE_FAILED', '元数据写失败 → XsStorageError');
  eq(readFileSync(MSG, 'utf8'), snap2, '写失败后元数据文件不变');
  ok(!existsSync(join(BODIES, `${failing.id}.txt`)), '写失败后本次新写的正文删掉');
  ok(existsSync(join(BODIES, `${m2.id}.txt`)), '写失败时没有删别的正文');
  eq((await S.listXsMessages()).find((m) => m.id === m2.id).status, 'pending', '写失败后内存状态不变');

  // ── 容量:超 500 删最旧的已结束,未结束的一条不删 ───────────────────────────
  const done600 = Array.from({ length: 600 }, () => rec(C, 'done'));
  await S.mutateXsInbox((msgs) => { msgs.push(...done600); });
  let all = await S.listXsMessages();
  eq(all.length, 500, '超出时裁到 500');
  ok(all.filter((m) => S.isOpenStatus(m.status)).length === 31, '未结束的全部保留');
  ok(!all.some((m) => m.id === m1.id), '最旧的已结束消息先删');
  eq(all.filter((m) => m.status === 'done').map((m) => m.id), done600.slice(600 - 469).map((m) => m.id), '留下的是最新的已结束消息');
  const open500 = Array.from({ length: 500 }, () => rec(B));
  await S.mutateXsInbox((msgs) => { msgs.push(...open500); });
  all = await S.listXsMessages();
  eq(all.length, 531, '全是未结束时宁可超出也不删');
  ok(all.every((m) => S.isOpenStatus(m.status)), '已结束的都裁掉了');

  // ── 启动恢复:processing / claimed → pending + interrupted;孤儿正文清掉 ──────
  const pr = rec(B, 'processing', { via: 'card', heldReason: null, turn: { pid: 'sdk-1', epoch: 2 } });
  const cl = rec(B, 'claimed', { heldReason: null, token: randomUUID(), heldBefore: 'target-card' });
  const pe = rec(C);
  const dn = rec(C, 'done', { via: 'card', heldReason: null });
  writeFileSync(MSG, JSON.stringify({ version: 1, messages: [pr, cl, pe, dn, { id: 'bad', status: 'pending' }] }));
  rmSync(BODIES, { recursive: true, force: true });
  mkdirSync(BODIES, { recursive: true });
  for (const m of [pr, cl, pe]) writeFileSync(join(BODIES, `${m.id}.txt`), `body-${m.id}`);
  const orphan = randomUUID();
  writeFileSync(join(BODIES, `${orphan}.txt`), 'orphan');
  writeFileSync(join(BODIES, `${dn.id}.txt`), 'leftover');
  const S2 = await freshStore();
  const rec2 = await S2.listXsMessages();
  eq(rec2.map((m) => [m.id, m.status, m.heldReason, m.via]), [
    [pr.id, 'pending', 'interrupted', 'card'], [cl.id, 'pending', 'interrupted', null],
    [pe.id, 'pending', 'target-card', null], [dn.id, 'done', null, 'card'],
  ], '恢复后的状态(形状不对的记录丢弃)');
  ok(!('turn' in rec2[0]) && !('token' in rec2[1]) && !('heldBefore' in rec2[1]), '恢复时清掉 turn / token / heldBefore');
  eq(JSON.parse(readFileSync(MSG, 'utf8')).messages.map((m) => m.status), ['pending', 'pending', 'pending', 'done'], '恢复结果已落盘');
  eq(readdirSync(BODIES).sort(), [pr, cl, pe].map((m) => `${m.id}.txt`).sort(), '孤儿正文与已结束消息的残留正文清掉,未结束的保留');

  // ── 文件损坏:挪开留证,从空表开始,不清正文 ────────────────────────────────
  writeFileSync(MSG, '{ not json');
  const S3 = await freshStore();
  eq(await S3.listXsMessages(), [], '损坏时从空表开始');
  ok(readdirSync(XS).some((f) => f.startsWith('messages.json.corrupt-')), '损坏的文件挪到一边');
  eq(readdirSync(BODIES).length, 3, '损坏时不清正文');

  // ── 读盘出错(不是文件不存在)→ 抛错,不拿空表顶上 ────────────────────────────
  rmSync(MSG, { force: true });
  mkdirSync(MSG);
  const S4 = await freshStore();
  await assert.rejects(S4.listXsMessages());
  await assert.rejects(S4.mutateXsInbox((msgs) => { msgs.push(rec(B)); }));
  rmSync(MSG, { recursive: true, force: true });
  eq(await S4.listXsMessages(), [], '读盘恢复正常后可用');
  checks += 2;

  // ── 路由:config 与总开关闸门 ────────────────────────────────────────────────
  rmSync(XS, { recursive: true, force: true });
  const { default: express } = await import('express');
  const { default: xsRoutes, xsessionBodyErrorHandler } = await import('../../server/routes/xsession.js');
  const { clients } = await import('../../server/broadcast.js');
  const bc = [];
  clients.add({ readyState: 1, send: (m) => bc.push(JSON.parse(m)) });
  const app = express();
  app.use(express.json());
  app.use('/api', xsRoutes);
  app.use('/api', xsessionBodyErrorHandler);
  app.use('/api', (e, _req, res, _next) => res.status(e.status || 500).json({ error: e.message }));
  const canListen = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
  let port = 0;
  for (let p = 6899; p >= 6800; p -= 1) if (await canListen(p)) { port = p; break; }
  ok(port, '6800–6899 有空闲端口');
  const server = app.listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const call = async (method, path, body, raw) => {
    const init = { method, headers: {} };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = raw ? body : JSON.stringify(body); }
    const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json };
  };
  const isErr = (r, status, code, what, error) => {
    eq([r.status, r.body?.ok, r.body?.code], [status, false, code], what);
    if (error) eq(r.body.error, error, `${what}:文案`);
    else ok(typeof r.body.error === 'string' && r.body.error.length > 0, `${what}:error 非空`);
  };
  try {
    // r151c 起 config 多 autoPaused、autoBudget 与 limits 的另三项(接口 r151c §5 第 1 条)
    const DEFAULT_CFG = { enabled: false, autoPaused: false, autoBudget: { limit: 20, windowMs: 600000, used: 0 }, limits: { bodyBytes: 32768, pendingPerSession: 50, chainDepth: 4, targetsPerSend: 8, sendsPerTurn: 16 }, nativeGuard: { lastFailureAt: null }, stored: { unfinished: 0 } };
    let r = await call('GET', '/api/xsession/config');
    eq([r.status, r.body], [200, DEFAULT_CFG], '没有偏好文件:默认值');
    const sid = randomUUID();
    for (const [m, p, b, raw] of [
      ['GET', '/api/xsession/sessions'], ['GET', '/api/XSESSION/Sessions/'], ['GET', '/api/xsession/pending'],
      ['GET', `/api/xsession/messages?sessionId=${sid}`], ['POST', '/api/xsession/messages', { to: [sid], body: 'x' }],
      ['POST', `/api/xsession/messages/${sid}/claim`], ['POST', `/api/xsession/messages/${sid}/release`],
      ['POST', `/api/xsession/messages/${sid}/dismiss`], ['PUT', `/api/xsession/sessions/${sid}/inbound`, { mode: 'auto' }],
      ['GET', '/api/xsession'], ['POST', '/api/xsession/messages', '{ bad json', true], ['POST', '/api/xsession/messages', '"on"', true],
    ]) isErr(await call(m, p, b, raw), 409, 'XS_DISABLED', `关着:${m} ${p}${raw ? ' ' + b : ''}`, '跨会话消息未开启');
    isErr(await call('PUT', '/api/xsession/config', '{ bad', true), 400, 'XS_INVALID_INPUT', '关着:config 的畸形 JSON 仍是 400');
    r = await call('POST', '/api/other', '{ bad', true);
    ok(r.status === 400 && !r.body?.code, '其它路径的畸形 JSON 不归这里管');

    // 偏好文件里的手写非法值:按 false,不改写
    for (const [label, content] of [['"true"', { xsEnabled: 'true', keep: 1 }], ['1', { xsEnabled: 1 }], ['null', { xsEnabled: null }], ['对象', { xsEnabled: {} }], ['损坏', null]]) {
      writeFileSync(PREFS, content === null ? '{ broken' : JSON.stringify(content, null, 2));
      const before = readFileSync(PREFS, 'utf8');
      r = await call('GET', '/api/xsession/config');
      eq([r.status, r.body], [200, DEFAULT_CFG], `xsEnabled=${label}:按 false`);
      isErr(await call('GET', '/api/xsession/sessions'), 409, 'XS_DISABLED', `xsEnabled=${label}:按关处理`);
      eq(readFileSync(PREFS, 'utf8'), before, `xsEnabled=${label}:不改写文件`);
    }

    // PUT 校验:非法请求体 → 400,偏好文件不变
    writeFileSync(PREFS, JSON.stringify({ releaseNotesSeen: '0.2.421', other: { a: 1 } }, null, 2));
    const prefsBefore = readFileSync(PREFS, 'utf8');
    for (const [label, b, raw] of [
      ['数组', '[]', true], ['字符串', '"on"', true], ['null', 'null', true], ['数字', '5', true], ['空对象', {}],
      // r151c(接口 §5 第 2 条):autoPaused:false 改为合法(200),autoPaused:true 仍 400
      ['autoPaused:true', { autoPaused: true }], ['enabled + autoPaused:true', { enabled: true, autoPaused: true }],
      ['chainLimit', { enabled: true, chainLimit: 3 }], ['未知键', { enabled: false, foo: 1 }], ['__proto__ 键', '{"__proto__":{"x":1},"enabled":true}', true],
      ['enabled 字符串', { enabled: 'true' }], ['enabled 数字', { enabled: 1 }], ['enabled null', { enabled: null }],
    ]) {
      isErr(await call('PUT', '/api/xsession/config', b, raw), 400, 'XS_INVALID_INPUT', `PUT ${label}`);
      eq(readFileSync(PREFS, 'utf8'), prefsBefore, `PUT ${label}:偏好文件不变`);
    }
    r = await fetch(`http://127.0.0.1:${port}/api/xsession/config`, { method: 'PUT', body: 'enabled=true', headers: { 'content-type': 'text/plain' } });
    eq(r.status, 400, 'PUT 不是 JSON 的请求体 → 400');
    eq(bc.filter((m) => m.type === 'xs:config'), [], '非法请求不广播');

    // PUT 成功:写偏好(保留其它键)+ 广播(一期没有 autoPaused)
    r = await call('PUT', '/api/xsession/config', { enabled: true });
    eq([r.status, r.body], [200, { ok: true, enabled: true, autoPaused: false }], 'PUT enabled:true');
    eq(bc.filter((m) => m.type === 'xs:config'), [{ type: 'xs:config', enabled: true, autoPaused: false }], '广播 xs:config');
    const saved = JSON.parse(readFileSync(PREFS, 'utf8'));
    eq([saved.xsEnabled, saved.other, saved.releaseNotesSeen], [true, { a: 1 }, '0.2.421'], '只改 xsEnabled');
    eq((await call('GET', '/api/xsession/config')).body.enabled, true, '之后 GET 为 true');
    r = await call('PUT', `/api/xsession/sessions/${sid}/inbound`, { mode: 'auto' });
    isErr(r, 404, 'XS_TARGET_NOT_FOUND', '开着:PUT …/inbound 对不存在的会话 → 404(r151c 起接口存在,接口 §5 第 3 条)');
    isErr(await call('POST', '/api/xsession/messages', '{ bad json', true), 400, 'XS_INVALID_INPUT', '开着:畸形 JSON → 400');

    // 写盘失败 → 500 STORAGE_WRITE_FAILED,不广播,开关不变
    const nBc = bc.length;
    chmodSync(join(HOME, '.claude-gui'), 0o500);
    r = await call('PUT', '/api/xsession/config', { enabled: false });
    chmodSync(join(HOME, '.claude-gui'), 0o700);
    isErr(r, 500, 'STORAGE_WRITE_FAILED', '写盘失败', '保存失败，请重试');
    eq(bc.length, nBc, '写盘失败不广播');
    eq((await call('GET', '/api/xsession/config')).body.enabled, true, '写盘失败后开关不变');

    r = await call('PUT', '/api/xsession/config', { enabled: false });
    eq([r.status, r.body, bc.at(-1)], [200, { ok: true, enabled: false, autoPaused: false }, { type: 'xs:config', enabled: false, autoPaused: false }], 'PUT enabled:false');
    ok(!existsSync(XS), '整段路由测试没有产生 ~/.claude-gui/xsession/');
  } finally {
    await new Promise((r) => server.close(r));
  }
  console.log(`PASS check-r151b-xsession-store(${checks} 项)`);
} finally {
  try { chmodSync(XS, 0o700); } catch {}
  try { chmodSync(join(HOME, '.claude-gui'), 0o700); } catch {}
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);
