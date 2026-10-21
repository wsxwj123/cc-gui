#!/usr/bin/env node
// r151c 派工 4:给模型的两个工具(进程内 MCP 服务 ccgui-sessions)。临时 HOME;chat.js 用 SDK 替身(只为看冷启 options 与
// canUseTool);工具服务本身用真 SDK 建、经 MCP 内存通道调用。端口 6900–6990,跳过 6710。覆盖(接口 r151c §4 错误总表工具部分):
//   ① 开关开:冷启 options 带 ccgui-sessions、list_sessions 免确认、send_message 照既有规则;关后同一进程不再免确认、新进程没有服务。
//   ② 工具表与形状:两个工具、描述写明标题与目录名会随请求发给 provider、zod 只声明类型(没有长度上限);类型不对 → SDK 的
//      "MCP error -32602: Input validation error",处理函数不被调用、一条不发。
//   ③ list_sessions:{self,sessions,truncated}、不含自己、倒序、30 项、短 id、name 清洗、inbound、query、超 100 字。
//   ④ 整次失败的先后:关(XS_DISABLED)→ 发送方 id 取不到(XS_INTERNAL)→ 长度 / 数量 / 空白(XS_INVALID_INPUT)→ 超 8 个 →
//      超 32768 字节 → 本回合超 16 → 读会话列表失败 / 写盘失败(XS_INTERNAL);都是一条不发。
//   ⑤ 单项失败(不存在 / 重名附 candidates / 自己 / 满 50)不影响其它目标、不算报错;失败项不计入 16。
//   ⑥ 用户 / 本地 / 项目配置里的同名服务:冷启时记一行日志;照样挂 GUI 的服务,但 list_sessions 不免确认(.mcp.json 往上逐级找)。
// node tests/unit/check-r151c-xs-tools.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync, utimesSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { registerR151bSdkStub } from './helpers/r151b-sdk-stub.mjs';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151c-tools-')));
const HOME = join(TMP, 'home'); const BIN = join(TMP, 'bin'); const WORK = join(TMP, 'work'); const SHADOW = join(TMP, 'shadow');
const XS_DIR = join(HOME, '.claude-gui', 'xsession');
for (const d of [join(HOME, '.claude', 'sessions'), join(XS_DIR, 'bodies'), BIN, WORK, SHADOW]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k)) delete process.env[k];
writeFileSync(join(BIN, 'claude'), '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.296 (Claude Code)";;\n  --help) echo "Usage: claude [options]";;\nesac\nexit 0\n');
chmodSync(join(BIN, 'claude'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
const PREFS = join(HOME, '.claude-gui', 'prefs.json');
const ENABLED_AT = new Date(Date.now() - 60_000).toISOString();
// r151q:新用户第一次经接口打开总开关时会同时写 xsInboundDefault:'auto';本单测按新用户形态(没单独设置的会话 → auto)。
let prefs = { xsEnabled: true, xsEnabledAt: ENABLED_AT, xsInboundDefault: 'auto', customTitles: {} };
const savePrefs = () => writeFileSync(PREFS, JSON.stringify(prefs));

// ── 会话:自己 A + 31 个按时间排开的 + 标题带引号 / 尖括号 / 控制字符的 + 两个重名 + 一个待处理已满 50 的 ──
const PROJ_DIR = join(HOME, '.claude', 'projects', WORK.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(PROJ_DIR, { recursive: true });
const NOW = Date.now();
let age = 0;
// 与 check-r151b-xsession-sessions 同形状的会话记录(提问 + 回答),修改时间 = 最近活动;标题由偏好 customTitles 指定
const mk = (title, minutesAgo = (age += 1)) => {
  const sid = randomUUID();
  prefs.customTitles[sid] = title;
  const tEnd = NOW - minutesAgo * 60_000;
  const b = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: WORK, sessionId: sid, version: '2.1.296', gitBranch: '' };
  const user = { ...b, type: 'user', uuid: `${sid}-u0`, parentUuid: null, timestamp: new Date(tEnd - 1000).toISOString(), message: { role: 'user', content: title } };
  const reply = { ...b, type: 'assistant', uuid: `${sid}-a1`, parentUuid: `${sid}-u0`, timestamp: new Date(tEnd).toISOString(),
    message: { id: `m-${sid}`, type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'r' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } };
  const f = join(PROJ_DIR, `${sid}.jsonl`);
  writeFileSync(f, [{ type: 'summary', summary: 's', leafUuid: `${sid}-a1` }, user, reply].map((l) => JSON.stringify(l)).join('\n') + '\n');
  utimesSync(f, new Date(tEnd), new Date(tEnd));
  return sid;
};
const A = mk('R151C 工具 发送方', 0.5);
const DIRTY = mk('  R151C "引号"<尖>\t制表\u0007铃  ', 0.7);
const OTHERS = Array.from({ length: 31 }, (_, i) => mk(`R151C 工具 ${i}`));
const DUP = 'R151C 工具 重名';
const D1 = mk(DUP); const D2 = mk(DUP);
const FULL = mk('R151C 工具 已满');
savePrefs();

registerR151bSdkStub();
const calls = (globalThis.__r151bSdkCalls ||= []);
globalThis.__r151bSdkControl = { reply: () => 'ok' };
const { default: express } = await import('express');
const chat = await import('../../server/routes/chat.js');
const xs = await import('../../server/services/xsession.js');
const store = await import('../../server/services/xsession-store.js');
const xsRoutes = await import('../../server/routes/xsession.js');
const tools = await import('../../server/services/xsession-tools.js');
const { normalizeXsSourceName } = await import('../../server/services/xsession-envelope.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  for (let p = 6990; p >= 6900; p--) {
    if (p === 6710) continue;
    const free = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('6900-6990 没有空闲端口');
}
const app = express();
app.use(express.json());
app.use('/api', chat.default);
app.use('/api', xsRoutes.default);
const port = await freePort();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const settlesWithin = (p, ms) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);
const LS = 'mcp__ccgui-sessions__list_sessions'; const SM = 'mcp__ccgui-sessions__send_message';

try {
  eq([tools.XS_LIST_SESSIONS_TOOL, tools.XS_SEND_MESSAGE_TOOL], [LS, SM], '完整工具名');

  // ── ① 冷启挂服务、槽级放行;关开关后同一进程不再免确认、新进程没有服务 ──
  xs.syncXsRuntimeHooks(true);
  const n0 = calls.length;
  const r1 = await api('POST', '/chat', { prompt: 'r151c 工具 冷启', cwd: WORK, permissionMode: 'default', keepAlive: true });
  eq(r1.status, 200, `开着冷启 200(${JSON.stringify(r1.body).slice(0, 160)})`);
  const on = calls[n0].options;
  ok(on.mcpServers && on.mcpServers['ccgui-sessions'] && on.mcpServers['ccgui-sessions'].type === 'sdk' && on.mcpServers['ccgui-sessions'].instance, '开着:options.mcpServers 带进程内服务 ccgui-sessions');
  eq(await on.canUseTool(LS, {}, { toolUseID: 'r151c-t1' }), { behavior: 'allow', updatedInput: {} }, 'list_sessions 免确认(本槽经挂接点挂上的)');
  ok(!(await settlesWithin(on.canUseTool(SM, { to: 'x', message: 'y' }, { toolUseID: 'r151c-t2' }), 300)), 'send_message 不免确认(default 档走既有权限卡)');
  writeFileSync(PREFS, JSON.stringify({ ...prefs, xsEnabled: false }));
  xs.syncXsRuntimeHooks(false);
  ok(!(await settlesWithin(on.canUseTool(LS, {}, { toolUseID: 'r151c-t3' }), 300)), '关开关后同一进程的 list_sessions 不再免确认(挂接点已撤)');
  const n1 = calls.length;
  const r2 = await api('POST', '/chat', { prompt: 'r151c 工具 关时冷启', cwd: WORK, permissionMode: 'default', keepAlive: true });
  eq(r2.status, 200, '关着冷启 200');
  const off = calls[n1].options;
  ok(!off.mcpServers || !off.mcpServers['ccgui-sessions'], '关着:新进程没有 ccgui-sessions');
  ok(!(await settlesWithin(off.canUseTool(LS, {}, { toolUseID: 'r151c-t4' }), 300)), '没挂 GUI 服务的进程里同名工具照既有规则(不免确认)');
  savePrefs();
  xs.syncXsRuntimeHooks(true);

  // 发送方视图:getter 每次现取(同 chat.js 的窄视图)
  const S = { sessionId: A, runId: `r151c-tools-${randomUUID()}`, turnEpoch: 1, guiMode: 'default', cwd: WORK };
  const view = { get sessionId() { return S.sessionId; }, get runId() { return S.runId; }, get turnEpoch() { return S.turnEpoch; }, get guiMode() { return S.guiMode; }, get cwd() { return S.cwd; } };
  const h = xs.xsToolHandlersFor(view);
  const parse = (res) => ({ isError: res.isError === true, json: JSON.parse(res.content[0].text), keys: Object.keys(res) });
  const count = async () => (await store.listXsMessages()).length;
  const whole = async (p, code, label, message) => {
    const before = await count();
    const r = parse(await p);
    eq([r.isError, r.json.error], [true, code], `${label}:整次失败 ${code}`);
    ok(typeof r.json.message === 'string' && r.json.message.length > 0 && Object.keys(r.json).length === 2, `${label}:{"error","message"}`);
    if (message) eq(r.json.message, message, `${label}:文案`);
    eq(await count(), before, `${label}:一条不发`);
  };

  // ── ② 工具表与形状(真 SDK 服务 + MCP 内存通道)──
  const opts = xs.xsSessionOptions(view);
  eq(opts.autoAllow, [LS], '只有 list_sessions 进免确认名单');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await opts.mcpServers['ccgui-sessions'].instance.connect(st);
  const client = new Client({ name: 'r151c-tools-test', version: '1.0.0' });
  await client.connect(ct);
  const listed = (await client.listTools()).tools;
  eq(listed.map((t) => t.name).sort(), ['list_sessions', 'send_message'], '两个工具');
  for (const t of listed) ok(t.description.includes('provider') && t.description.includes('目录名'), `${t.name} 描述写明标题与目录名会随请求发给 provider`);
  const schemaText = JSON.stringify(listed.map((t) => t.inputSchema));
  ok(!/max(Length|Items)|min(Length|Items)/.test(schemaText), `zod 只声明类型,不带长度上限(${schemaText.slice(0, 200)})`);
  const viaMcp = async (name, args) => {
    try { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: r.content?.[0]?.text || '' }; } catch (e) { return { isError: true, text: String(e?.message || e) }; }
  };
  for (const [name, args] of [['send_message', { to: [OTHERS[0]], message: 12345 }], ['send_message', { to: 7, message: 'x' }], ['list_sessions', { query: 5 }]]) {
    const before = await count();
    const r = await viaMcp(name, args);
    ok(r.isError && r.text.includes('MCP error -32602') && r.text.includes('Input validation error'), `${name} 类型不对 → SDK 的参数校验错误(${r.text.slice(0, 120)})`);
    eq(await count(), before, `${name} 类型不对:处理函数不被调用、一条不发`);
  }
  const good = await viaMcp('list_sessions', {});
  ok(!good.isError && JSON.parse(good.text).self.id, '经 MCP 调用成功:一段 JSON 文本');

  // ── ③ list_sessions ──
  const rows = await xsRoutes.loadSessionRows();
  const rowOf = (sid) => rows.find((r) => r.sessionId === sid);
  prefs.xsInbound = { [OTHERS[0].toUpperCase()]: 'auto', [OTHERS[1].toUpperCase()]: 'card' }; savePrefs();
  const L = parse(await h.list_sessions({}));
  eq([L.isError, L.keys, Object.keys(L.json).sort()], [false, ['content'], ['self', 'sessions', 'truncated']], 'list:成功不带 isError,键为 self/sessions/truncated');
  const ref = (await api('GET', `/xsession/sessions?exclude=${A}&limit=30`)).body.sessions;
  eq(L.json.self, { id: (await api('GET', `/xsession/sessions?ids=${A}`)).body.sessions[0].shortId, name: normalizeXsSourceName(rowOf(A).title) }, 'self = 自己的短 id 与清洗后的标题');
  eq(L.json.sessions.map((s) => s.id), ref.map((s) => s.shortId), '不含自己、按最近活动倒序、30 项(与会话列表同口径)');
  eq(L.json.sessions.length, 30, '最多 30 项');
  eq(L.json.truncated, true, '超过 30 个 → truncated');
  // r151k:未显式设置 inbound 的会话默认 auto(不再是 card);显式 card 仍是 card。
  eq(L.json.sessions[0], { id: ref[0].shortId, name: normalizeXsSourceName(ref[0].title), project: ref[0].project, state: ref[0].state, inbound: 'auto' }, '单项字段(未设置 → auto)');
  const dirty = L.json.sessions.find((s) => s.id === ref.find((x) => x.sessionId === DIRTY)?.shortId);
  ok(dirty && dirty.name === normalizeXsSourceName(rowOf(DIRTY).title) && !/["<>\u0000-\u001f]/.test(dirty.name), `标题按来源名规则清洗(${dirty?.name})`);
  eq(L.json.sessions.find((s) => s.name === 'R151C 工具 0')?.inbound, 'auto', 'inbound:接收设置为自动处理的是 auto(id 不分大小写)');
  eq(L.json.sessions.find((s) => s.name === 'R151C 工具 1')?.inbound, 'card', 'inbound:显式 card 仍是 card(未设置与显式 card 可区分)');
  prefs.xsInbound = { [OTHERS[0].toUpperCase()]: 'auto' }; savePrefs(); // 恢复:后续发送用例按默认 auto 走
  const Q = parse(await h.list_sessions({ query: 'r151c 工具 1' })).json;
  eq(Q.sessions.map((s) => s.name).sort(), ['R151C 工具 1', ...Array.from({ length: 10 }, (_, i) => `R151C 工具 1${i}`)].sort(), 'query:标题不分大小写的子串');
  eq(Q.truncated, false, 'query 后不足 30 → truncated:false');
  eq(parse(await h.list_sessions({ query: '长'.repeat(100) })).json.sessions, [], 'query 100 字可以');
  await whole(h.list_sessions({ query: '长'.repeat(101) }), 'XS_INVALID_INPUT', 'query 超 100 字', 'query 必须是不超过 100 字的字符串');

  // ── ④ 整次失败的先后 ──
  const body = 'R151C 工具 正文';
  writeFileSync(PREFS, JSON.stringify({ ...prefs, xsEnabled: false }));
  S.sessionId = null;
  await whole(h.send_message({ to: [], message: '' }), 'XS_DISABLED', '① 关着(先于发送方 id 与长度)');
  await whole(h.list_sessions({ query: '长'.repeat(101) }), 'XS_DISABLED', '① 关着(list)');
  savePrefs();
  await whole(h.send_message({ to: [], message: '' }), 'XS_INTERNAL', '③ 发送方会话 id 取不到(先于长度)');
  await whole(h.list_sessions({}), 'XS_INTERNAL', '③ 发送方会话 id 取不到(list)');
  S.sessionId = A;
  xs.setXsSessionRowsLoader(() => { throw new Error('r151c 读会话列表失败'); });
  await whole(h.send_message({ to: [], message: body }), 'XS_INVALID_INPUT', '④ to 为空(先于读会话列表失败)');
  await whole(h.send_message({ to: [OTHERS[1]], message: body }), 'XS_INTERNAL', '⑧ 读会话列表失败', '发送失败，未投递任何消息');
  await whole(h.list_sessions({}), 'XS_INTERNAL', '⑧ 读会话列表失败(list)', '读取会话列表失败');
  xs.setXsSessionRowsLoader(xsRoutes.loadSessionRows);
  await whole(h.send_message({ to: Array.from({ length: 33 }, (_, i) => `x${i}`), message: body }), 'XS_INVALID_INPUT', '④ to 超 32 项');
  await whole(h.send_message({ to: ['长'.repeat(257)], message: body }), 'XS_INVALID_INPUT', '④ to 单项超 256 字');
  await whole(h.send_message({ to: ['  '], message: body }), 'XS_INVALID_INPUT', '④ to 单项去空白为空');
  await whole(h.send_message({ to: [OTHERS[1]], message: 'b'.repeat(65537) }), 'XS_INVALID_INPUT', '④ message 超 65536 字');
  await whole(h.send_message({ to: [OTHERS[1]], message: ' \n\t　 ' }), 'XS_INVALID_INPUT', '④ message 去空白为空');
  await whole(h.send_message({ to: OTHERS.slice(0, 9), message: body }), 'XS_TOO_MANY_TARGETS', '⑤ 去重后 9 个目标');
  await whole(h.send_message({ to: [OTHERS[1]], message: 'a'.repeat(32769) }), 'XS_BODY_TOO_LARGE', '⑥ 正文 32769 字节');
  await whole(h.send_message({ to: [OTHERS[1]], message: '中'.repeat(10923) }), 'XS_BODY_TOO_LARGE', '⑥ 按字节算(10923 个三字节字)');
  chmodSync(XS_DIR, 0o500);
  try { await whole(h.send_message({ to: [OTHERS[1]], message: body }), 'XS_INTERNAL', '⑧ 写盘失败', '发送失败，未投递任何消息'); } finally { chmodSync(XS_DIR, 0o700); }

  // ── ⑤ 单项失败不影响其它目标;失败项不计入 16;⑦ 本回合超 16 ──
  for (let i = 0; i < store.XS_LIMITS.pendingPerSession; i += 1) await xs.sendManualMessages({ to: [FULL], body: `填满 ${i}`, fromSessionId: null }, rows);
  S.turnEpoch = 2;
  const mixed = parse(await h.send_message({ to: [OTHERS[1], 'R151C 没有这个会话', A, DUP, FULL], message: body }));
  eq(mixed.isError, false, '单项失败整次不算报错');
  eq(mixed.json.results.map((x) => [x.ok, x.error || null]), [[true, null], [false, 'XS_TARGET_NOT_FOUND'], [false, 'XS_SELF_TARGET'], [false, 'XS_TARGET_AMBIGUOUS'], [false, 'XS_INBOX_FULL']], '逐项结果');
  eq(mixed.json.results[3].candidates.map((c) => c.name), [DUP, DUP], '重名附 candidates');
  ok([D1, D2].every((d) => mixed.json.results[3].candidates.some((c) => d.startsWith(c.id))), 'candidates 带短 id');
  const fromA = async (sid) => (await xs.listInboxMessages({ sessionId: sid, statuses: new Set(store.XS_STATUSES) })).filter((m) => m.from.kind === 'session' && m.from.sessionId === A);
  eq((await fromA(OTHERS[1])).length, 1, '能解析的目标照发一条');
  eq([(await fromA(D1)).length, (await fromA(D2)).length, (await fromA(FULL)).length], [0, 0, 0], '重名的与满 50 的都没收到');
  eq(mixed.json.notice, xs.XS_SEND_NOTICE, 'notice');
  const eight = OTHERS.slice(2, 10);
  eq(parse(await h.send_message({ to: eight, message: body })).isError, false, '同一回合再发 8 条(累计 9,失败项不算)');
  await whole(h.send_message({ to: OTHERS.slice(10, 18), message: body }), 'XS_TURN_SEND_LIMIT', '⑦ 本回合 9 + 8 > 16');
  eq(parse(await h.send_message({ to: OTHERS.slice(10, 17), message: body })).isError, false, '9 + 7 = 16 照发');
  S.turnEpoch = 3;
  eq(parse(await h.send_message({ to: [OTHERS[20]], message: body })).isError, false, '下一回合重新计数');

  // ── 新会话首回合:发送方的记录文件晚一点才落盘 → 等它出现后再取标题;一直不出现 → 有限次等待后照常返回 ──
  const late = { ...S, sessionId: randomUUID(), turnEpoch: 1 };
  const hLate = xs.xsToolHandlersFor({ get sessionId() { return late.sessionId; }, get runId() { return late.runId; }, get turnEpoch() { return late.turnEpoch; }, get guiMode() { return late.guiMode; }, get cwd() { return late.cwd; } });
  const lateTitle = 'R151C 工具 晚落盘的发送方';
  setTimeout(() => {
    const sid = mk(lateTitle, 0.1); // mk 生成新 id:把它当成 late 的记录文件改名过去
    prefs.customTitles[late.sessionId] = lateTitle; delete prefs.customTitles[sid]; savePrefs();
    const src = join(PROJ_DIR, `${sid}.jsonl`);
    writeFileSync(join(PROJ_DIR, `${late.sessionId}.jsonl`), readFileSync(src, 'utf8').replaceAll(sid, late.sessionId));
    rmSync(src);
  }, 300);
  const t0 = Date.now();
  const LL = parse(await hLate.list_sessions({})).json;
  eq(LL.self.name, lateTitle, '发送方记录晚落盘:等到后取到自己的标题');
  ok(Date.now() - t0 < 1500, '等待有上限');
  const ghost = randomUUID();
  const hGhost = xs.xsToolHandlersFor({ sessionId: ghost, runId: 'r151c-ghost', turnEpoch: 1, guiMode: 'default', cwd: WORK });
  const t1 = Date.now();
  const G = parse(await hGhost.list_sessions({})).json;
  eq([G.self.id, G.self.name], [ghost.slice(0, 8), '未命名会话'], '记录一直不在:短 id 照算、标题按未命名');
  ok(Date.now() - t1 < 2500, `一直不在时有限次等待后返回(${Date.now() - t1}ms)`);

  // ── ⑥ 同名服务:冷启时记一行日志;用户 / 本地 / 项目配置里有同名服务的会话照样挂 GUI 的服务,但 list_sessions 不免确认 ──
  writeFileSync(join(SHADOW, '.mcp.json'), JSON.stringify({ mcpServers: { 'ccgui-sessions': { command: 'echo' } } }));
  const viewAt = (cwd) => ({ sessionId: A, runId: 'r', turnEpoch: 0, guiMode: 'default', cwd });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  let o6;
  try { o6 = xs.xsSessionOptions(viewAt(SHADOW)); } finally { console.warn = origWarn; }
  ok(warns.some((w) => w.includes('项目') && w.includes('同名 MCP 服务 ccgui-sessions')), `同名服务记一行日志(${warns.join(' | ').slice(0, 200)})`);
  eq([o6.mcpServers['ccgui-sessions']?.type, o6.autoAllow], ['sdk', []], '项目配置(.mcp.json)里有同名服务:照样挂 GUI 的服务,list_sessions 不进免确认名单');
  mkdirSync(join(SHADOW, 'sub', 'deeper'), { recursive: true });
  eq(xs.xsSessionOptions(viewAt(join(SHADOW, 'sub', 'deeper'))).autoAllow, [], '.mcp.json 在上级目录也算');
  const n6 = calls.length;
  const r6 = await api('POST', '/chat', { prompt: 'r151c 工具 同名服务', cwd: SHADOW, permissionMode: 'default', keepAlive: true });
  eq(r6.status, 200, `同名服务的工作目录冷启 200(${JSON.stringify(r6.body).slice(0, 160)})`);
  const sh = calls[n6].options;
  ok(sh.mcpServers?.['ccgui-sessions']?.type === 'sdk', '冷启 options 照样带 GUI 的 ccgui-sessions');
  ok(!(await settlesWithin(sh.canUseTool(LS, {}, { toolUseID: 'r151c-t6' }), 300)), '同名服务的会话里 list_sessions 不免确认(default 档走既有权限卡)');
  const CJ = join(HOME, '.claude.json');
  let cj0 = '{}';
  try { cj0 = readFileSync(CJ, 'utf-8'); } catch { /* 没有 */ }
  const SRV = { 'ccgui-sessions': { command: 'echo' } };
  const pastInterval = () => sleep(xs.XS_CLAUDE_JSON_MIN_MS + 150); // ~/.claude.json 有最短间隔缓存:改完等过间隔再看
  try {
    writeFileSync(CJ, JSON.stringify({ mcpServers: SRV })); await pastInterval();
    eq(xs.xsSessionOptions(viewAt(WORK)).autoAllow, [], '用户配置(~/.claude.json 的 mcpServers)里有同名服务 → 不免确认');
    writeFileSync(CJ, JSON.stringify({ projects: { [WORK]: { mcpServers: SRV } } })); await pastInterval();
    eq(xs.xsSessionOptions(viewAt(join(WORK, 'pkg'))).autoAllow, [], '本地配置(~/.claude.json 的 projects[目录])里有同名服务 → 该目录及子目录不免确认');
    writeFileSync(CJ, JSON.stringify({ projects: { [`${WORK}-other`]: { mcpServers: SRV } }, mcpServers: { other: { command: 'echo' } } })); await pastInterval();
    eq(xs.xsSessionOptions(viewAt(WORK)).autoAllow, [LS], '前缀相似的别的目录、不同名的服务不算 → 照常免确认');
    // 审计 S2:本地级两边都按真实路径比(符号链接),macOS / Windows 不分大小写
    const LINK = join(TMP, 'work-link');
    symlinkSync(WORK, LINK);
    mkdirSync(join(WORK, 'pkg'), { recursive: true }); // 会话的工作目录是真实存在的目录
    writeFileSync(CJ, JSON.stringify({ projects: { [LINK]: { mcpServers: SRV } } })); await pastInterval();
    eq(xs.xsSessionOptions(viewAt(WORK)).autoAllow, [], '本地配置的键是指向工作目录的符号链接 → 也算同名,不免确认');
    writeFileSync(CJ, JSON.stringify({ projects: { [WORK]: { mcpServers: SRV } } })); await pastInterval();
    eq(xs.xsSessionOptions(viewAt(join(LINK, 'pkg'))).autoAllow, [], '工作目录经符号链接进来 → 也算同名,不免确认');
    if (process.platform === 'darwin' || process.platform === 'win32') {
      writeFileSync(CJ, JSON.stringify({ projects: { [WORK.toUpperCase()]: { mcpServers: SRV } } })); await pastInterval();
      eq(xs.xsSessionOptions(viewAt(WORK)).autoAllow, [], '本地配置的键大小写不同 → 也算同名,不免确认');
    }
    // 审计 S2:~/.claude.json 解析失败 → 按"有同名"(失败时不免确认)
    writeFileSync(CJ, '{broken'); await pastInterval();
    eq(xs.xsSessionOptions(viewAt(WORK)).autoAllow, [], '~/.claude.json 解析失败 → 按有同名处理,不免确认');
    rmSync(CJ, { force: true }); await pastInterval();
    eq(xs.xsSessionOptions(viewAt(WORK)).autoAllow, [LS], '~/.claude.json 不存在 = 没配 → 照常免确认');
  } finally { writeFileSync(CJ, cj0); }
  // 审计 S2:企业托管配置 managed-mcp.json(平台固定路径;单测经参数换成临时文件)
  eq(xs.XS_MANAGED_MCP_PATH, join(process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code', 'managed-mcp.json'), '托管配置路径按平台固定');
  const MF = join(TMP, 'managed-mcp.json');
  await pastInterval();
  eq(xs.shadowingXsServerScopes(WORK, { managedPath: MF }), [], '托管配置不存在 → 不算');
  writeFileSync(MF, JSON.stringify({ mcpServers: { other: { command: 'echo' } } }));
  eq(xs.shadowingXsServerScopes(WORK, { managedPath: MF }), [], '托管配置里只有别的服务 → 不算');
  writeFileSync(MF, JSON.stringify({ mcpServers: SRV }));
  eq(xs.shadowingXsServerScopes(WORK, { managedPath: MF }), ['企业托管'], '托管配置里有同名服务 → 算');
  writeFileSync(MF, '{broken');
  eq(xs.shadowingXsServerScopes(WORK, { managedPath: MF }).length, 1, '托管配置读不出 → 按有算');

  await client.close().catch(() => {});
  console.log(`check-r151c-xs-tools: ${checks} 项全部通过`);
} finally {
  server.close();
  try { chmodSync(XS_DIR, 0o700); rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
}
process.exit(0);
