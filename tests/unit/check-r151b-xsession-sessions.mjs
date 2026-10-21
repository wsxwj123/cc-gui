#!/usr/bin/env node
// r151b T-X3:标题共用函数、目标解析(server/services/xsession-resolve.js)与 GET /api/xsession/sessions。
// 临时 HOME(工作区放在 os.tmpdir() 下,不在 /tmp,侧栏列表认得);SDK 换成替身,不起 claude 进程;端口在 6800–6899 里挑。
// node tests/unit/check-r151b-xsession-sessions.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151b-xsess-')));
const HOME = join(TMP, 'home');
const WS = join(TMP, 'ws');
mkdirSync(join(HOME, '.claude', 'projects'), { recursive: true });
mkdirSync(join(HOME, '.claude-gui'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
// PATH 最前面放一个只会回答 --version / --help 的假 claude(同 check-r151b-baseline),不碰本机真 CLI
const BIN = join(TMP, 'bin');
mkdirSync(BIN, { recursive: true });
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
registerR151bSdkStub();

let checks = 0;
const ok = (v, msg) => { assert.ok(v, msg); checks += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks += 1; };

const { assignShortIds, selectXsSessions, resolveTarget } = await import('../../server/services/xsession-resolve.js');
const serverTitle = await import('../../server/utils/session-title.js');
const clientTitle = await import('../../client/src/utils/sessionTitle.js');

try {
  // ── 标题共用:前端转出的就是服务端那一份,优先级链不变 ─────────────────────────
  ok(clientTitle.resolveSessionTitle === serverTitle.resolveSessionTitle, '前端 resolveSessionTitle 转自 server/utils/session-title.js');
  const t = serverTitle.resolveSessionTitle;
  eq([t({ customTitle: 'c', aiTitle: 'a', firstPrompt: 'f' }, 'pc', 'pa'), t({ aiTitle: 'a', firstPrompt: 'f' }, 'pc', 'pa'),
    t({ aiTitle: 'a', firstPrompt: 'f' }, '', 'pa'), t({ firstPrompt: 'f' }, '', 'pa'), t({ firstPrompt: 'f' }), t(null)],
  ['c', 'pc', 'a', 'pa', 'f', ''], '优先级:custom → prefs custom → ai → prefs auto → 首条提问');

  // ── 短 id ────────────────────────────────────────────────────────────────────
  const a1 = 'abcdef12-0000-4000-8000-000000000001';
  const a2 = 'abcdef12-0000-4000-8000-000000000002';
  const b1 = 'abcdef13-1111-4000-8000-000000000001';
  const d1 = '9f8e7d6c-1111-4000-8000-000000000001';
  const d2 = '9f8e7d6c-2111-4000-8000-000000000001';
  let sh = assignShortIds([a1, a2, b1, d1, d2]);
  eq([sh.get(a1), sh.get(a2), sh.get(b1)], [a1, a2, 'abcdef13'], '前 35 位相同 → 加长到全长;不冲突的留 8 位');
  eq([sh.get(d1), sh.get(d2)], ['9f8e7d6c-1', '9f8e7d6c-2'], '加长到刚好不冲突');
  sh = assignShortIds([a1, a1.toUpperCase()]);
  eq([sh.get(a1), sh.get(a1.toUpperCase())], [a1, a1.toUpperCase()], '只差大小写 → 全长');
  eq(assignShortIds([d1]).get(d1), '9f8e7d6c', '只有一个会话 → 8 位');

  // ── 目标解析 ────────────────────────────────────────────────────────────────
  const list = [
    { sessionId: a1, shortId: a1, title: '会话甲', project: 'p1' },
    { sessionId: a2, shortId: a2, title: '重名', project: 'p2' },
    { sessionId: b1, shortId: 'abcdef13', title: '重名', project: 'p3' },
    { sessionId: d1, shortId: '9f8e7d6c-1', title: 'deadbeef', project: 'p4' },
  ];
  eq(resolveTarget(a2, list).session?.sessionId, a2, '完整 id');
  eq(resolveTarget(a2.toUpperCase(), list).session?.sessionId, a2, '完整 id 不分大小写');
  eq(resolveTarget('abcdef13', list).session?.sessionId, b1, '8 位短 id');
  eq(resolveTarget(' 9F8E7D6C ', list).session?.sessionId, d1, '短 id 去空白、不分大小写');
  const amb = resolveTarget('abcdef12', list);
  eq([amb.ok, amb.reason, amb.candidates.map((c) => c.sessionId)], [false, 'ambiguous', [a1, a2]], '前缀命中多个 → ambiguous');
  eq(resolveTarget('会话甲', list).session?.sessionId, a1, '标题');
  const dup = resolveTarget('重名', list);
  eq([dup.reason, dup.candidates], ['ambiguous', [
    { sessionId: a2, shortId: a2, title: '重名', project: 'p2' }, { sessionId: b1, shortId: 'abcdef13', title: '重名', project: 'p3' },
  ]], '重名 → 候选带短 id 与目录名');
  eq(resolveTarget('deadbeef', list).session?.sessionId, d1, '像十六进制但不是 id 前缀 → 按标题');
  eq(resolveTarget('旧标题', list), { ok: false, reason: 'not-found' }, '改名后旧标题 → not-found');
  eq([resolveTarget('', list).reason, resolveTarget(null, list).reason, resolveTarget('abcdef1', list).reason], ['not-found', 'not-found', 'not-found'], '空 / 非字符串 / 不足 8 位');

  // ── 筛选 ────────────────────────────────────────────────────────────────────
  eq(selectXsSessions(list, { query: 'P3' }).map((s) => s.sessionId), [b1], 'query 命中目录名、不分大小写');
  eq(selectXsSessions(list, { limit: 2, exclude: a1.toUpperCase() }).map((s) => s.sessionId), [a2, b1], 'exclude 不分大小写 + limit');
  eq(selectXsSessions(list, { ids: [d1, a1, a1], query: 'zzz', limit: 1 }).map((s) => s.sessionId), [a1, d1], 'ids:query/limit 不起作用,保持列表顺序、不重复');

  // ── 路由:GET /api/xsession/sessions ────────────────────────────────────────
  let seq = 0;
  const base = Date.parse('2026-10-14T00:00:00.000Z');
  function seed({ sid = randomUUID(), firstPrompt = `提问 ${seq}`, extra = [], twoLines = false, noUser = false, ageMin = 0, dirName } = {}) {
    seq += 1;
    const cwd = join(WS, dirName || `proj-${seq}`);
    mkdirSync(cwd, { recursive: true });
    const proj = join(HOME, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(proj, { recursive: true });
    const tEnd = base - ageMin * 60_000;
    const b = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId: sid, version: '2.1.296', gitBranch: '' };
    const user = { ...b, type: 'user', uuid: `${sid}-u0`, parentUuid: null, timestamp: new Date(tEnd - 1000).toISOString(), message: { role: 'user', content: firstPrompt } };
    const reply = { ...b, type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u0`, timestamp: new Date(tEnd).toISOString(),
      message: { id: `m${seq}`, type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'r' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } };
    const lines = noUser ? [{ type: 'ai-title', aiTitle: '没有提问', sessionId: sid }, { ...b, type: 'queue-operation' }, { ...b, type: 'system', timestamp: user.timestamp }]
      : [...(twoLines ? [] : [{ type: 'summary', summary: 's', leafUuid: `${sid}-a1` }]), user, reply, ...extra.map((e) => ({ ...e, sessionId: sid }))];
    const file = join(proj, `${sid}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(file, new Date(tEnd), new Date(tEnd));
    return { sid, cwd };
  }
  const S1 = seed({ firstPrompt: '最新的会话 Alpha', ageMin: 1 });
  const S2 = seed({ extra: [{ type: 'custom-title', customTitle: '手改标题' }, { type: 'ai-title', aiTitle: '自动标题' }], ageMin: 2 });
  const S3 = seed({ extra: [{ type: 'ai-title', aiTitle: 'AI 标题' }], ageMin: 3 }); // prefs 手改压过 jsonl 的 ai-title
  const S4 = seed({ ageMin: 4, dirName: 'Mixed-Case-Dir' }); // prefs 自动标题压过首条提问
  const S5 = seed({ firstPrompt: '只有首条提问', ageMin: 5 });
  const C1 = seed({ sid: a1, ageMin: 6 });
  const C2 = seed({ sid: a2, ageMin: 7 });
  const TWO = seed({ twoLines: true, ageMin: 0 }); // 侧栏列表不认(不足 3 行)
  const NOUSER = seed({ noUser: true, ageMin: 0 }); // 没有用户提问
  const fillers = Array.from({ length: 26 }, (_, i) => seed({ ageMin: 100 + i }));
  writeFileSync(join(HOME, '.claude-gui', 'prefs.json'), JSON.stringify({
    xsEnabled: true, customTitles: { [S3.sid]: 'prefs 手改', [S5.sid]: 42 }, autoTitles: { [S4.sid]: 'prefs 自动' },
  }));
  const XS = join(HOME, '.claude-gui', 'xsession');
  mkdirSync(join(XS, 'bodies'), { recursive: true });
  const msg = (to, status) => ({ id: randomUUID(), createdAt: new Date().toISOString(), status, to: { sessionId: to }, via: null, heldReason: status === 'pending' ? 'target-card' : null });
  // C2 那条 claimed 是"上次进程"留下的:首次读盘时退回 pending / interrupted,算待处理
  const inbox = [msg(S2.sid, 'pending'), msg(S2.sid, 'pending'), msg(S2.sid, 'pending'), msg(S1.sid, 'done'), msg(C1.sid, 'pending'), msg(C2.sid, 'claimed')];
  writeFileSync(join(XS, 'messages.json'), JSON.stringify({ version: 1, messages: inbox }));
  for (const m of inbox) if (m.status !== 'done') writeFileSync(join(XS, 'bodies', `${m.id}.txt`), 'x');

  const { default: express } = await import('express');
  const { default: xsRoutes } = await import('../../server/routes/xsession.js');
  const reader = await import('../../server/services/session-reader.js');
  const chat = await import('../../server/routes/chat.js');
  const app = express();
  app.use(express.json());
  app.use('/api', xsRoutes);
  app.use('/api', chat.default);
  const canListen = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
  let port = 0;
  for (let p = 6899; p >= 6800; p -= 1) if (await canListen(p)) { port = p; break; }
  ok(port, '6800–6899 有空闲端口');
  const server = app.listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const get = async (qs = '') => {
    const r = await fetch(`http://127.0.0.1:${port}/api/xsession/sessions${qs}`);
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body };
  };
  const ids = (r) => r.body.sessions.map((s) => s.sessionId);
  try {
    // 认定口径:与侧栏列表(listProjects + listSessions)逐个相同
    const expected = [];
    for (const p of await reader.listProjects()) for (const s of await reader.listSessions(p.hash)) expected.push(s.sessionId);
    let r = await get('?limit=100');
    eq(r.status, 200, '200');
    eq([...ids(r)].sort(), [...expected].sort(), '哪些记录算会话与侧栏列表相同');
    ok(!ids(r).includes(TWO.sid) && !ids(r).includes(NOUSER.sid), '侧栏不认的(不足 3 行 / 没有用户提问)这里也不列');
    eq(ids(r).slice(0, 7), [S1.sid, S2.sid, S3.sid, S4.sid, S5.sid, C1.sid, C2.sid], '按最近活动倒序');
    const by = Object.fromEntries(r.body.sessions.map((s) => [s.sessionId, s]));
    eq(by[S1.sid], { sessionId: S1.sid, shortId: S1.sid.slice(0, 8), title: '最新的会话 Alpha', project: basename(S1.cwd), projectHash: S1.cwd.replace(/[^A-Za-z0-9]/g, '-'), state: 'stopped', pending: 0,
      lastActivity: new Date(base - 60_000).toISOString(), inbound: 'card', hasProfile: false }, '单项字段齐(r151q:总开关开着、没有 xsInboundDefault → 未设置的 inbound 默认 card;done 不算待处理)');
    eq([by[S2.sid].title, by[S3.sid].title, by[S4.sid].title, by[S5.sid].title], ['手改标题', 'prefs 手改', 'prefs 自动', '只有首条提问'], '标题按既有优先级(prefs 里的非字符串忽略)');
    eq([by[S2.sid].pending, by[C1.sid].pending, by[C2.sid].pending], [3, 1, 1], 'pending 只数 status=pending(上次进程遗留的 claimed 已退回 pending)');
    const store = await import('../../server/services/xsession-store.js');
    await store.mutateXsInbox((msgs) => { msgs.find((m) => m.id === inbox[2].id).status = 'claimed'; });
    eq((await get(`?ids=${S2.sid}`)).body.sessions[0].pending, 2, '本进程里认领后不再算待处理');
    eq([by[C1.sid].shortId, by[C2.sid].shortId], [a1, a2], '前 8 位冲突 → 加长到不冲突');

    r = await get();
    eq(r.body.sessions.length, 30, '默认最多 30 项');
    eq(ids(await get(`?exclude=${S2.sid}&limit=3`)), [S1.sid, S3.sid, S4.sid], 'exclude');
    eq(ids(await get(`?query=${encodeURIComponent('alpha')}`)), [S1.sid], 'query 按标题、不分大小写');
    eq(ids(await get('?query=mixed-case')), [S4.sid], 'query 按目录名、不分大小写');
    r = await get(`?ids=${a1},${randomUUID()},${S5.sid},${S5.sid}&query=zzz&limit=1`);
    eq(ids(r), [S5.sid, C1.sid], 'ids:不存在的跳过、query/limit 不起作用');
    eq(r.body.sessions[1].shortId, a1, '只查一条时短 id 仍按全部会话判冲突');
    eq(ids(await get(`?ids=${a1}&exclude=${a1}`)), [], 'ids 与 exclude 同时给,exclude 照样生效');
    eq((await get(`?query=${encodeURIComponent('长'.repeat(100))}`)).status, 200, 'query 恰好 100 字');
    eq((await get(`?ids=${Array.from({ length: 50 }, () => randomUUID()).join(',')}`)).status, 200, 'ids 恰好 50 个');
    for (const [label, qs] of [
      ['query 101 字', `?query=${encodeURIComponent('长'.repeat(101))}`], ['query 重复', '?query=a&query=b'], ['limit=0', '?limit=0'], ['limit=101', '?limit=101'],
      ['limit=1.5', '?limit=1.5'], ['limit=abc', '?limit=abc'], ['limit 空', '?limit='], ['limit=-1', '?limit=-1'], ['exclude 形状', '?exclude=not-an-id'],
      ['exclude 重复', `?exclude=${a1}&exclude=${a2}`], ['ids 含坏的', `?ids=${a1},zzz`], ['ids 空', '?ids='], ['ids 51 个', `?ids=${Array.from({ length: 51 }, () => randomUUID()).join(',')}`],
    ]) {
      r = await get(qs);
      eq([r.status, r.body?.ok, r.body?.code], [400, false, 'XS_INVALID_INPUT'], `400:${label}`);
    }
    // state:running(回合在跑)/ idle(常驻进程没在跑)/ stopped(没有进程)—— 用 SDK 替身起两个会话进程
    const waitFor = async (fn, what) => { for (let i = 0; i < 200; i += 1) { if (fn()) return; await new Promise((x) => setTimeout(x, 25)); } throw new Error(`等待超时:${what}`); };
    const slotOf = (sid) => chat.getActiveChatProcesses().find((p) => p.sessionId === sid && p.exitCode === null);
    const startTurn = (sid, cwd) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', cwd, sessionId: sid, model: 'r151b-model', permissionMode: 'default', keepAlive: true }) });
    globalThis.__r151bSdkControl = { reply: () => 'ok' };
    eq((await startTurn(S2.sid, S2.cwd)).status, 200, '起 S2 的回合');
    await waitFor(() => slotOf(S2.sid)?.idle, 'S2 回合收尾转常驻');
    globalThis.__r151bSdkControl = { reply: () => 'hold' };
    eq((await startTurn(S1.sid, S1.cwd)).status, 200, '起 S1 的回合(不结束)');
    await waitFor(() => slotOf(S1.sid) && !slotOf(S1.sid).idle, 'S1 回合在跑');
    r = await get(`?ids=${S1.sid},${S2.sid},${S3.sid}`);
    eq(r.body.sessions.map((x) => [x.sessionId, x.state]), [[S1.sid, 'running'], [S2.sid, 'idle'], [S3.sid, 'stopped']], 'state 三种');
    try { chat.closeAllPersistentProcesses(); } catch { /* */ }
    // 没有任何会话目录 → 空表
    rmSync(join(HOME, '.claude', 'projects'), { recursive: true, force: true });
    eq((await get()).body, { sessions: [] }, '还没有任何会话 → 空表');
  } finally {
    await new Promise((r) => server.close(r));
  }
  void fillers;
  console.log(`PASS check-r151b-xsession-sessions(${checks} 项)`);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);
