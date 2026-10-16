#!/usr/bin/env node
// r151e 偏好写入改严格读(接口 r151e-prefs-read-hardening-接口.md 行为清单 A 1–6、15,对外行为变化 1、2、7 的服务端部分)。
//   ② 写入路径(updatePrefs / updatePrefsStrict / removeSessionFromPrefs / 偏好路由各 PUT)在写队列里严格读:
//      · 文件在、却读不出(权限 000 模拟)→ 抛错 / 回已有的 500,mutator 不跑,文件逐字节不变;
//      · 文件不存在 → 按 {} 新建;
//      · 内容不是合法 JSON 对象(截断的 JSON、[]、null、数字)→ 原字节另存 prefs.json.corrupt-*(逐字节相同),从空白重建、写入成功;
//        备份失败 → 整次放弃、文件不变;别的程序写到一半、随即写完 → 隔一会儿重读到完整内容,不备份;开头带 BOM 的合法文件不算坏。
//   ⑥ 添加项目(PUT /api/settings {_addProject})移出隐藏列表:排在同一条写队列里(前一段写入没完成就等着,两边的改动都留下),
//      不丢别的键;没有可移出的条目不写盘;偏好文件读不出时跳过,添加项目照常 200、文件逐字节不变。
// 断言失败不中断,全部跑完后列出失败项(便于确认"去掉修复则红"时红的是哪几项)。
// 临时 HOME(POSIX 权限模拟读不出);端口 6880–6899。
// node tests/unit/check-r151e-prefs-strict.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, realpathSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cgui-r151e-prefs-')));
const HOME = join(TMP, 'home');
const GUI_DIR = join(HOME, '.claude-gui');
const PREFS = join(GUI_DIR, 'prefs.json');
for (const d of [join(HOME, '.claude', 'projects'), GUI_DIR]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME; process.env.USERPROFILE = HOME; process.env.CGUI_DISABLE_FILE_WATCHER = '1';
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/.test(k) || /^(https?|all)_proxy$/i.test(k) || k === 'CLAUDE_CONFIG_DIR') delete process.env[k];

const { default: express } = await import('express');
const prefsMod = await import('../../server/routes/prefs.js');
const settingsRouter = (await import('../../server/routes/settings.js')).default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
async function freePort() {
  for (let p = 6899; p >= 6880; p--) {
    const free = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(p, '127.0.0.1'); });
    if (free) return p;
  }
  throw new Error('6880-6899 没有空闲端口');
}
const app = express();
app.use(express.json());
app.use('/api', prefsMod.default);
app.use('/api', settingsRouter);
const port = await freePort();
const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let checks = 0;
const failures = [];
const soft = (fn, m) => { checks++; try { fn(); } catch { failures.push(m); } };
const ok = (c, m) => soft(() => assert.ok(c), m);
const eq = (a, b, m) => soft(() => assert.deepEqual(a, b), `${m}(实际 ${JSON.stringify(a)?.slice(0, 160)})`);

const bytes = () => readFileSync(PREFS);
const json = () => JSON.parse(readFileSync(PREFS, 'utf8'));
const backups = () => readdirSync(GUI_DIR).filter((n) => n.startsWith('prefs.json.corrupt')).sort();
const newBackups = (before) => backups().filter((n) => !before.includes(n));
const unreadable = async (fn) => { chmodSync(PREFS, 0o000); try { return await fn(); } finally { chmodSync(PREFS, 0o644); } };
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const SID = randomUUID();
const BASE = { hiddenProjects: ['p1'], customTitles: { [SID]: 'R151E 标题' }, xsEnabled: true, keep: { a: 1 } };
const seed = (obj = BASE) => writeFileSync(PREFS, JSON.stringify(obj, null, 2));
// 偏好路由的全部 PUT(请求体都合法:可读时各回 200,见下方对照)
const PUTS = [
  ['/prefs/hidden-projects', { hidden: ['p2'] }],
  ['/prefs/third-party-auto', { enabled: true }],
  ['/prefs/release-notes-seen', { version: '9.9.9' }],
  ['/prefs/hidden-providers', { hidden: ['x'] }],
  ['/prefs/custom-titles', { sessionId: SID, title: 'R151E 新标题' }],
  ['/prefs/auto-titles', { sessionId: SID, title: 'R151E 自动' }],
  ['/prefs/context-1m', { sessionId: SID, on: true }],
  ['/prefs/session-sync', { kind: 'permissionMode', sessionId: SID, value: 'default' }],
  ['/prefs/display-name', { displayName: 'R151E' }],
  ['/prefs/sidebar-view', { groupMode: 'single' }],
  ['/prefs/pinned', { kind: 'session', id: SID, pinned: true }],
];

try {
  // ── 读不出(行为清单 1–3):整次放弃、抛错 / 回已有的写失败响应,文件逐字节不变 ──
  seed();
  for (const [path, body] of PUTS) eq((await api('PUT', path, body)).status, 200, `对照:可读时 PUT ${path} 回 200`);
  seed();
  const before = bytes();
  for (const [name, fn] of [['updatePrefs', prefsMod.updatePrefs], ['updatePrefsStrict', prefsMod.updatePrefsStrict]]) {
    let ran = false;
    const err = await unreadable(() => rejects(fn((p) => { ran = true; p.hiddenProjects = ['p2']; })));
    eq([err?.code ?? null, ran], ['EACCES', false], `读不出:${name} 把读错误抛回调用方、mutator 没跑`);
    ok(bytes().equals(before), `读不出:${name} 之后文件逐字节不变`);
  }
  for (const [path, body] of PUTS) {
    const r = await unreadable(() => api('PUT', path, body));
    eq(r.status, 500, `读不出:PUT ${path} 回已有的 500`);
    ok(bytes().equals(before), `读不出:PUT ${path} 之后文件逐字节不变`);
  }
  const third = await unreadable(() => api('PUT', '/prefs/third-party-auto', { enabled: false }));
  eq(third.body?.code, 'STORAGE_WRITE_FAILED', '读不出:third-party-auto 的 500 仍是 STORAGE_WRITE_FAILED(不新增错误码)');
  const delErr = await unreadable(() => rejects(prefsMod.removeSessionFromPrefs(SID)));
  eq(delErr?.code ?? null, 'EACCES', '读不出:删会话的偏好清理抛错(删会话接口那边 catch 掉,返回不变)');
  ok(bytes().equals(before), '读不出:删会话的偏好清理不写盘,文件逐字节不变');
  await prefsMod.removeSessionFromPrefs(SID);
  ok(!(SID in (json().customTitles || {})) && json().keep?.a === 1, '对照:可读时删会话照常清掉它的自定义标题、别的键不动');

  // ── 文件不存在(行为清单 4):照旧新建 ──
  unlinkSync(PREFS);
  eq((await api('PUT', '/prefs/hidden-projects', { hidden: ['p2'] })).status, 200, '文件不存在:PUT 回 200');
  eq(json(), { hiddenProjects: ['p2'] }, '文件不存在:按 {} 新建');
  unlinkSync(PREFS);
  await prefsMod.updatePrefsStrict((p) => { p.k = 1; });
  eq(json(), { k: 1 }, '文件不存在:updatePrefsStrict 同样按 {} 新建');

  // ── 内容坏了(行为清单 6):原字节另存 prefs.json.corrupt-*,从空白重建,写入成功 ──
  for (const bad of ['{"hiddenProjects": [', '[]', 'null', '42']) {
    writeFileSync(PREFS, bad);
    const b0 = backups();
    const r = await api('PUT', '/prefs/hidden-projects', { hidden: ['p2'] });
    eq(r.status, 200, `内容 ${bad}:写入照常成功`);
    eq(json(), { hiddenProjects: ['p2'] }, `内容 ${bad}:从空白重建`);
    const added = newBackups(b0);
    eq(added.length, 1, `内容 ${bad}:同目录多出一个 prefs.json.corrupt 开头的备份`);
    ok(added.length === 1 && readFileSync(join(GUI_DIR, added[0])).equals(Buffer.from(bad)), `内容 ${bad}:备份与坏内容逐字节相同`);
  }
  writeFileSync(PREFS, '{"xsEnabled": tr');
  let b0 = backups();
  await prefsMod.updatePrefs((p) => { p.thirdPartyAuto = true; });
  eq([json(), newBackups(b0).length], [{ thirdPartyAuto: true }, 1], 'updatePrefs 同样:先备份,再从空白重建');
  // 备份失败(目录不可写)→ 整次放弃
  writeFileSync(PREFS, '{"half": ');
  b0 = backups();
  chmodSync(GUI_DIR, 0o500);
  let rB;
  try { rB = await api('PUT', '/prefs/hidden-projects', { hidden: ['p3'] }); } finally { chmodSync(GUI_DIR, 0o700); }
  eq(rB.status, 500, '备份失败:整次放弃,回已有的 500');
  eq(readFileSync(PREFS, 'utf8'), '{"half": ', '备份失败:坏文件原样,不被覆盖');
  eq(newBackups(b0), [], '备份失败:不留下半截备份');
  // 别的程序写到一半、随即写完:隔一会儿重读到完整内容,在它上面改;不备份
  writeFileSync(PREFS, '{"keep": {"a": 1}, "hidd');
  b0 = backups();
  const pending = prefsMod.updatePrefs((p) => { p.hiddenProjects = ['p4']; });
  await sleep(30);
  writeFileSync(PREFS, JSON.stringify({ keep: { a: 1 }, hiddenProjects: ['old'] }));
  await pending;
  eq(json(), { keep: { a: 1 }, hiddenProjects: ['p4'] }, '读到写了一半的内容:重读到写完的内容,其它键保留');
  eq(newBackups(b0), [], '读到写了一半的内容:随即写完就不备份');
  // 开头带 UTF-8 BOM 的合法文件不算坏
  writeFileSync(PREFS, `\uFEFF${JSON.stringify({ keep: 2, hiddenProjects: ['old'] })}`);
  b0 = backups();
  eq((await api('PUT', '/prefs/hidden-projects', { hidden: ['p5'] })).status, 200, '开头带 BOM:PUT 回 200');
  eq([json(), newBackups(b0)], [{ keep: 2, hiddenProjects: ['p5'] }, []], '开头带 BOM 的合法文件:不算坏、其它键保留、不备份');

  // ── 内容正常(行为清单 5):只改该改的键 ──
  seed();
  eq((await api('PUT', '/prefs/hidden-projects', { hidden: ['p2'] })).status, 200, '内容正常:PUT 回 200');
  eq(json(), { ...BASE, hiddenProjects: ['p2'] }, '内容正常:只换隐藏列表,其它键原样');

  // ── 添加项目时移出隐藏列表(⑥,行为清单 15、对外行为变化 7)──
  const PROJ = join(TMP, 'r151e-proj');
  mkdirSync(PROJ, { recursive: true });
  const addProject = () => api('PUT', '/settings', { _addProject: PROJ });
  seed({ keep: 3 });
  const first = await addProject();
  const xHash = first.body?.addedHash;
  ok(first.status === 200 && typeof xHash === 'string' && xHash.length > 0, `前置:添加项目 200、应答里有它的 hash(${JSON.stringify(first.body)?.slice(0, 160)})`);
  const F_BASE = { hiddenProjects: ['r151e-other', xHash], customTitles: { [SID]: 'R151E 标题' }, xsEnabled: true };
  seed(F_BASE);
  // 写队列里先排一段"读 → 改 → 写"、卡在改这一步:移出隐藏若走同一条队列,就得等它写完再读,两边的改动都留下
  const gate = deferred();
  const held = prefsMod.updatePrefs(async (p) => { await gate.p; p.displayName = 'R151E 并发'; });
  const adding = addProject();
  await sleep(300);
  eq(json().hiddenProjects, ['r151e-other', xHash], '队列里前一段写入还没完成:移出隐藏在排队,没有绕过队列直接写');
  gate.open();
  await held;
  eq((await adding).status, 200, '排队等到之后:添加项目成功');
  eq(json(), { ...F_BASE, hiddenProjects: ['r151e-other'], displayName: 'R151E 并发' }, '移出了 X,并发写入的键与其它偏好都在(不互相覆盖)');
  const ino = statSync(PREFS).ino;
  const before2 = bytes();
  eq((await addProject()).status, 200, '再加一次(已不在隐藏列表):200');
  ok(statSync(PREFS).ino === ino && bytes().equals(before2), '没有可移出的条目:不写盘');
  seed(F_BASE);
  const before3 = bytes();
  const rU = await unreadable(() => addProject());
  eq(rU.status, 200, '偏好文件读不出:添加项目照常成功');
  ok(bytes().equals(before3), '偏好文件读不出:移出隐藏这一步跳过,文件逐字节不变');

  if (failures.length) {
    console.error(`FAIL check-r151e-prefs-strict:${failures.length}/${checks} 项\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS check-r151e-prefs-strict(${checks} 项)`);
  }
} finally {
  try { chmodSync(PREFS, 0o644); } catch { /* 文件可能不在 */ }
  try { chmodSync(GUI_DIR, 0o700); } catch { /* 同上 */ }
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
