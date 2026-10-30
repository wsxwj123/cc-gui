#!/usr/bin/env node
// r152b(v2):同一会话的空闲进程手上还有活的后台任务时,只有"偏好类"配置变化(思考强度、系统提示追加、输入预测、
// 渲染开关、配置文件指纹)才沿用原进程、延后生效,不另起第二个进程;护栏与正确性类差异(cwd、压缩窗口、外部权限
// 改动、禁用工具、项目设置、MCP、读取范围、花费上限、审核模型、跨会话工具,以及未知的新字段)照旧关旧开新。
//   ① 纯函数 decideIdleSlotReuse(chat.js):真 import。能用真 chatCompatKey 造出差异的字段用真的;造不出的
//      (permEpoch、disToolsMtime、projSettingsMtime、mcpStampMtime、settingsFp、xs)解析基准键、改一个字段再 stringify。
//      每条先核对两个键恰好只差预期的字段,再判结果。
//   ② App.jsx 源码形状(照 check-r151v-hidden-autotitle.mjs 的做法):取出提示常量、if 语句、自消提示的 effect 原文,
//      代入替身求值 —— 只在 respJson.configDeferred === true 时出提示(在原会话带 ttlMs 15 秒,已切走留言);
//      effect 只认有限正数的 ttlMs,其余仍 5 秒。
//   ③ chat.js 源码形状:复用块经 decideIdleSlotReuse 判定;复用应答只在 configDeferred 为真时多带该字段。
// 每条用例换一个临时 HOME,不写真实家目录。每条独立判,一条失败不中断其余。
// HOME=$(mktemp -d) node tests/unit/check-r152b-keep-busy-slot.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP_PREFIX = join(tmpdir(), 'cgui-r152b-');
const madeHomes = [];
const freshHome = () => {
  const home = mkdtempSync(TMP_PREFIX);
  madeHomes.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
};
freshHome(); // import 之前先换 HOME:模块顶层若读家目录,读到的是临时目录

const { decideIdleSlotReuse, chatCompatKey, SHELL_TASK_FRESH_MS } = await import('../../server/routes/chat.js');

let passed = 0;
const failures = [];
function check(label, fn) {
  try { freshHome(); fn(); passed += 1; } catch (e) { failures.push(`✗ ${label}\n    ${String(e?.message || e).split('\n').join('\n    ')}`); }
}

// ── 素材 ──
const NOW = 1_800_000_000_000;
const STALE_MS = SHELL_TASK_FRESH_MS + 60_000; // 比两种新鲜度窗口都长(shell 2h ≥ 其它 kind 30min)
const tasks = (...entries) => new Map(entries.map((e, i) => [`task-${i}`, { toolUseId: `toolu_${i}`, epoch: 1, ...e }]));
const shell = (ageMs) => ({ kind: 'shell', createdAt: NOW - ageMs });
const subagent = (ageMs) => ({ kind: 'subagent', createdAt: NOW - ageMs });
const projDir = (name = 'proj') => { const d = join(process.env.HOME, name); mkdirSync(d, { recursive: true }); return d; };
/** 真 chatCompatKey:基准入参之上覆盖个别项(dirs 固定,换 cwd 时不连带变)。 */
const keyWith = (over = {}) => chatCompatKey({
  workingDir: projDir(), effort: 'low', appendSystemPrompt: '', promptSuggestions: false, globalRead: false,
  dirs: ['/fixed/dir'], maxBudgetUsd: null, acw: null, genui: true, ams: null, amm: null, ...over,
});
/** 解析基准键 → 改字段 → stringify(真 chatCompatKey 在单测里造不出差异的字段用它)。 */
const mutate = (key, fn) => { const o = JSON.parse(key); fn(o); return JSON.stringify(o); };
const diffFields = (a, b) => {
  const x = JSON.parse(a); const y = JSON.parse(b);
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((f) => JSON.stringify(x[f]) !== JSON.stringify(y[f])).sort();
};
const decide = (slotCompatKey, reuseKey, { wantKeepAlive = true, liveTasks = tasks(shell(60_000)), now = NOW } = {}) =>
  decideIdleSlotReuse({ slotCompatKey, reuseKey, wantKeepAlive, liveTasks, now });
/** 先核对两个键恰好只差 fields,再判结果。 */
const expectOn = (slotKey, wantKey, fields, want, opts) => {
  assert.deepEqual(diffFields(slotKey, wantKey), [...fields].sort(), '前置:两个键恰好只差这些字段');
  assert.equal(decide(slotKey, wantKey, opts), want, `差异 ${fields.join('+')} 的判定`);
};

// ── ① 纯函数:偏好类各一条 → defer ──
const PREF_CASES = {
  effort: () => [keyWith(), keyWith({ effort: 'high' })],
  append: () => [keyWith(), keyWith({ appendSystemPrompt: '多一段系统提示追加' })],
  suggest: () => [keyWith({ promptSuggestions: false }), keyWith({ promptSuggestions: true })],
  genui: () => [keyWith(), keyWith({ genui: false })],
  settingsFp: () => { const k = keyWith(); return [k, mutate(k, (o) => { o.settingsFp = 'sha1-changed'; })]; },
};
for (const [field, make] of Object.entries(PREF_CASES)) {
  check(`偏好类 ${field} 变了 + 新鲜活后台命令 → defer(沿用原进程)`, () => {
    const [a, b] = make();
    expectOn(a, b, [field], 'defer');
  });
}
check('偏好类:后台子代理 / kind 缺省(unknown)同样算活任务 → defer;五个偏好字段一起变 → defer', () => {
  const [a, b] = PREF_CASES.effort();
  expectOn(a, b, ['effort'], 'defer', { liveTasks: tasks(subagent(10 * 60_000)) });
  expectOn(a, b, ['effort'], 'defer', { liveTasks: tasks({ kind: 'unknown', createdAt: NOW - 1000 }) });
  const all = mutate(keyWith({ effort: 'high', appendSystemPrompt: 'x', promptSuggestions: true, genui: false }), (o) => { o.settingsFp = 'sha1-changed'; });
  expectOn(keyWith(), all, Object.keys(PREF_CASES), 'defer');
});

// ── ① 纯函数:护栏与正确性类各一条 → close ──
const GUARD_CASES = {
  cwd: () => [keyWith({ workingDir: projDir('wt-a') }), keyWith({ workingDir: projDir('wt-b') })],
  acw: () => [keyWith(), keyWith({ acw: 200000 })],
  gr: () => [keyWith(), keyWith({ globalRead: true })],
  dirs: () => [keyWith(), keyWith({ dirs: ['/fixed/dir', '/another/dir'] })],
  budget: () => [keyWith(), keyWith({ maxBudgetUsd: 5 })],
  ams: () => [keyWith(), keyWith({ ams: 'https://auto-mode.example/v1' })],
  amm: () => [keyWith(), keyWith({ amm: 'claude-haiku-review' })],
  permEpoch: () => { const k = keyWith(); return [k, mutate(k, (o) => { o.permEpoch += 1; })]; },
  disToolsMtime: () => { const k = keyWith(); return [k, mutate(k, (o) => { o.disToolsMtime += 1000; })]; },
  projSettingsMtime: () => { const k = keyWith(); return [k, mutate(k, (o) => { o.projSettingsMtime += 1; })]; },
  mcpStampMtime: () => { const k = keyWith(); return [k, mutate(k, (o) => { o.mcpStampMtime += 1; })]; },
  xs: () => { const k = keyWith(); assert.equal('xs' in JSON.parse(k), false, '前置:基准键没有 xs'); return [k, mutate(k, (o) => { o.xs = 1; })]; },
};
for (const [field, make] of Object.entries(GUARD_CASES)) {
  check(`护栏类 ${field} 变了 + 新鲜活后台命令 → close(关旧开新)`, () => {
    const [a, b] = make();
    expectOn(a, b, [field], 'close');
    expectOn(a, b, [field], 'close', { wantKeepAlive: false });
  });
}
check('偏好与护栏同时变 → close', () => {
  const k = keyWith();
  expectOn(k, mutate(keyWith({ effort: 'high' }), (o) => { o.permEpoch += 1; }), ['effort', 'permEpoch'], 'close');
  expectOn(keyWith({ workingDir: projDir('wt-a') }), keyWith({ workingDir: projDir('wt-b'), effort: 'high' }), ['cwd', 'effort'], 'close');
  expectOn(k, mutate(keyWith({ acw: 200000 }), (o) => { o.settingsFp = 'sha1-changed'; }), ['acw', 'settingsFp'], 'close');
});
check('未知的新字段:有差异 → close;两边相同、只差偏好 → defer', () => {
  const k = keyWith();
  expectOn(k, mutate(k, (o) => { o.futureGuard = 1; }), ['futureGuard'], 'close');
  expectOn(mutate(k, (o) => { o.futureGuard = 1; }), mutate(keyWith({ effort: 'high' }), (o) => { o.futureGuard = 1; }), ['effort'], 'defer');
});
check('会话常驻关(keepAlive:false):键相同 → defer;只差偏好 → defer;没有活任务 → close', () => {
  const k = keyWith();
  assert.equal(decide(k, k, { wantKeepAlive: false }), 'defer');
  expectOn(k, keyWith({ effort: 'high' }), ['effort'], 'defer', { wantKeepAlive: false });
  assert.equal(decide(k, k, { wantKeepAlive: false, liveTasks: new Map() }), 'close');
  assert.equal(decide(k, k, { wantKeepAlive: false, liveTasks: tasks(shell(STALE_MS)) }), 'close');
});
check('没有活任务 / 陈旧登记 → close;陈旧与新鲜混着 → defer', () => {
  const [a, b] = PREF_CASES.effort();
  assert.equal(decide(a, b, { liveTasks: new Map() }), 'close', '空 Map');
  // 直接调(辅助函数 decide 的缺省参数会把 undefined 换成一条活任务)
  assert.equal(decideIdleSlotReuse({ slotCompatKey: a, reuseKey: b, wantKeepAlive: true, liveTasks: undefined, now: NOW }), 'close', '没有 liveTasks');
  assert.equal(decide(a, b, { liveTasks: tasks(shell(STALE_MS)) }), 'close', '陈旧后台命令');
  assert.equal(decide(a, b, { liveTasks: tasks(subagent(STALE_MS)) }), 'close', '陈旧后台子代理');
  assert.equal(decide(a, b, { liveTasks: tasks(shell(STALE_MS), subagent(5 * 60_000)) }), 'defer', '有一条新鲜即算活');
  const lt = tasks(shell(SHELL_TASK_FRESH_MS - 60_000));
  assert.equal(decide(a, b, { liveTasks: lt }), 'defer', '后台命令窗口内(近 2 小时)仍算活');
  assert.equal(lt.size, 1, '纯函数不改 liveTasks');
});
check('兼容键解析不出 / 不是对象 → close', () => {
  const want = keyWith({ effort: 'high' });
  for (const bad of ['不是 JSON', '', undefined, null, 'null', '42', '"字符串"', '[]', '{}', JSON.stringify({ cwd: 5 }), JSON.stringify({ effort: 'low' })]) {
    assert.equal(decide(bad, want), 'close', `slotCompatKey=${JSON.stringify(bad)}`);
  }
  for (const bad of ['不是 JSON', undefined, 'null', '[]']) assert.equal(decide(keyWith(), bad), 'close', `reuseKey=${JSON.stringify(bad)}`);
});
check('回归:键相同且会话常驻开 → reuse(有没有后台任务都一样);now 缺省取当前时间', () => {
  const k = keyWith();
  assert.equal(decide(k, k, { liveTasks: new Map() }), 'reuse');
  assert.equal(decide(k, k), 'reuse');
  const b = keyWith({ effort: 'high' });
  assert.equal(decideIdleSlotReuse({ slotCompatKey: k, reuseKey: b, wantKeepAlive: true, liveTasks: new Map([['t', { kind: 'shell', createdAt: Date.now() }]]) }), 'defer');
  assert.equal(decideIdleSlotReuse({ slotCompatKey: k, reuseKey: b, wantKeepAlive: true, liveTasks: new Map([['t', { kind: 'shell', createdAt: Date.now() - STALE_MS }]]) }), 'close');
});

// ── ② App.jsx 源码形状 ──
const app = readFileSync(join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
const countOf = (src, s) => src.split(s).length - 1;
const countRe = (src, re) => (src.match(re) || []).length;
/** 从 open(一个 `{` 的下标)取到与之配对的 `}`,返回 [open, close]。 */
function braceSpan(src, open) {
  assert.equal(src[open], '{', '起点不是花括号');
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return [open, i]; }
  }
  throw new Error('括号不配对');
}
const NOTICE_DEF = /^const CONFIG_DEFERRED_NOTICE = '([^'\n]+)';$/m;
const NOTICE_MS_DEF = /^const CONFIG_DEFERRED_NOTICE_MS = (\d+);$/m;
const IF_HEAD = 'if (respJson.configDeferred === true) {';
const ifStatement = () => {
  assert.equal(countOf(app, IF_HEAD), 1, `找不到(或不止一处)${IF_HEAD}`);
  const start = app.indexOf(IF_HEAD);
  const [, close] = braceSpan(app, start + IF_HEAD.length - 1);
  return app.slice(start, close + 1);
};

check('App 常量:单行文案含"后台任务""生效",点明供应商;CONFIG_DEFERRED_NOTICE_MS = 15000;与 SESSION_BUSY_QUEUED_NOTICE 放在一起', () => {
  const m = app.match(NOTICE_DEF);
  assert.ok(m, '找不到 CONFIG_DEFERRED_NOTICE 的单行定义');
  for (const word of ['后台任务', '生效', '沿用已有进程', '思考强度', '配置文件', '供应商']) assert.ok(m[1].includes(word), `文案缺"${word}":${m[1]}`);
  const ms = app.match(NOTICE_MS_DEF);
  assert.ok(ms, '找不到 CONFIG_DEFERRED_NOTICE_MS 的定义');
  assert.equal(Number(ms[1]), 15000);
  const lineOf = (needle) => app.slice(0, app.indexOf(needle)).split('\n').length;
  const busyLine = lineOf('const SESSION_BUSY_QUEUED_NOTICE = ');
  for (const own of ['const CONFIG_DEFERRED_NOTICE = ', 'const CONFIG_DEFERRED_NOTICE_MS = ']) {
    assert.ok(Math.abs(lineOf(own) - busyLine) <= 4, `${own.trim()} 与 SESSION_BUSY_QUEUED_NOTICE 相隔 ${Math.abs(lineOf(own) - busyLine)} 行`);
  }
});
check('App 提示只挂在 respJson.configDeferred === true 上:严格 true 才出;在原会话带 ttlMs 15 秒,已切走留言;不用 sticky', () => {
  assert.equal(countOf(app, '.configDeferred'), 1, 'App.jsx 里只有一处读 configDeferred 字段(注释里提到的不算)');
  assert.equal(countRe(app, /\bCONFIG_DEFERRED_NOTICE\b/g), 3, '提示常量 = 定义 1 处 + if 语句里 2 处');
  const stmt = ifStatement();
  assert.equal(countRe(stmt, /\bCONFIG_DEFERRED_NOTICE\b/g), 2, '两处使用都在这条 if 语句里');
  assert.ok(!stmt.includes('sticky'), '不能用 sticky(流接上时会清掉所有 sticky 提示)');
  const NOTICE = app.match(NOTICE_DEF)[1];
  const NOTICE_MS = Number(app.match(NOTICE_MS_DEF)[1]);
  const run = (respJson, paneOn) => {
    const calls = [];
    const fn = new Function('respJson', 'paneStillOn', 'setProviderSwitchNotice', 'leaveSessionNotice', 'sessionQueueKey', 'CONFIG_DEFERRED_NOTICE', 'CONFIG_DEFERRED_NOTICE_MS', stmt);
    fn(respJson, (k) => { assert.equal(k, 'sess-key', 'paneStillOn 判的是发送时那个会话'); return paneOn; },
      (n) => calls.push(['set', n]), (k, t) => calls.push(['leave', k, t]), 'sess-key', NOTICE, NOTICE_MS);
    return calls;
  };
  assert.deepEqual(run({ ok: true, pid: 1, reused: true, configDeferred: true }, true), [['set', { text: NOTICE, ownerKey: 'sess-key', ttlMs: 15000 }]]);
  assert.deepEqual(run({ ok: true, pid: 1, reused: true, configDeferred: true }, false), [['leave', 'sess-key', NOTICE]]);
  for (const resp of [{ ok: true, pid: 1, reused: true }, { ok: true, pid: 1 }, { configDeferred: false }, { configDeferred: 'true' }, { configDeferred: 1 }, { configDeferred: null }]) {
    for (const paneOn of [true, false]) assert.deepEqual(run(resp, paneOn), [], `应答 ${JSON.stringify(resp)} 不该出提示`);
  }
});
check('App 自消提示的 effect:有限正数 ttlMs 按它,其余(缺省 / 0 / 负数 / NaN / Infinity / 字符串 / null)仍 5 秒;sticky 与空提示不计时', () => {
  const ANCHOR = 'if (!providerSwitchNotice || providerSwitchNotice.sticky) return;';
  assert.equal(countOf(app, ANCHOR), 1, '找不到(或不止一处)自消 effect 的锚点');
  const anchorAt = app.indexOf(ANCHOR);
  const headAt = app.lastIndexOf('useEffect(() => {', anchorAt);
  assert.ok(headAt >= 0 && anchorAt - headAt < 400, '锚点前面没有紧挨着的 useEffect');
  const [open, close] = braceSpan(app, headAt + 'useEffect(() => {'.length - 1);
  assert.ok(app.slice(close, close + 30).startsWith('}, [providerSwitchNotice]);'), 'effect 依赖应只有 providerSwitchNotice');
  const body = app.slice(open + 1, close);
  const runEffect = (notice) => {
    const timers = []; const cleared = []; const sets = [];
    const fn = new Function('providerSwitchNotice', 'setProviderSwitchNotice', 'setTimeout', 'clearTimeout', body);
    const cleanup = fn(notice, (v) => sets.push(v), (cb, ms) => { timers.push({ cb, ms }); return `timer-${timers.length}`; }, (id) => cleared.push(id));
    return { timers, cleared, sets, cleanup };
  };
  assert.equal(runEffect(null).timers.length, 0, '没有提示不计时');
  assert.equal(runEffect({ text: 'x', sticky: true, ttlMs: 15000 }).timers.length, 0, 'sticky 不计时');
  const plain = runEffect({ text: 'x' });
  assert.deepEqual(plain.timers.map((t) => t.ms), [5000], '缺省 5 秒');
  plain.timers[0].cb();
  assert.deepEqual(plain.sets, [null], '到点清掉提示');
  plain.cleanup();
  assert.deepEqual(plain.cleared, ['timer-1'], '卸载时清掉计时器');
  assert.deepEqual(runEffect({ text: 'x', ttlMs: 15000 }).timers.map((t) => t.ms), [15000]);
  assert.deepEqual(runEffect({ text: 'x', ttlMs: 1 }).timers.map((t) => t.ms), [1]);
  for (const ttlMs of [0, -1, NaN, Infinity, '15000', null, undefined]) {
    assert.deepEqual(runEffect({ text: 'x', ttlMs }).timers.map((t) => t.ms), [5000], `ttlMs=${String(ttlMs)} 应回落 5 秒`);
  }
});
check('App 位置:读应答之后、"发送失败即抛错"之后、"孤儿流复判 return"之前(切走了也留言)', () => {
  const at = (needle, from = 0) => { const i = app.indexOf(needle, from); assert.ok(i >= 0, `找不到锚点 ${needle}`); return i; };
  const respAt = at('const respJson = await res.json();');
  const throwAt = at('if (!res.ok || !respJson.pid) throw new Error(', respAt);
  const ifAt = at(IF_HEAD, respAt);
  const orphanAt = at('if (queueKeyFor(getLocalSession()) !== sessionQueueKey) return;', respAt);
  assert.ok(throwAt < ifAt && ifAt < orphanAt, `次序不对:抛错 ${throwAt} / 提示 ${ifAt} / 孤儿复判 ${orphanAt}`);
  assert.ok(orphanAt - respAt < 8000, '三处应在同一段应答处理里');
});

// ── ③ chat.js 源码形状 ──
check('chat.js:复用块经 decideIdleSlotReuse 判定;configDeferred 只以条件展开进复用应答', () => {
  const chat = readFileSync(join(ROOT, 'server', 'routes', 'chat.js'), 'utf8');
  assert.equal(countOf(chat, 'decideIdleSlotReuse({ slotCompatKey: s.compatKey, reuseKey, wantKeepAlive, liveTasks: s.liveTasks })'), 1, '复用循环调用判定函数');
  assert.equal(countOf(chat, "const configDeferred = reuseMode === 'defer';"), 1);
  assert.equal(countOf(chat, 'configDeferred: true'), 1, '只有一处产出该字段');
  const reuseResp = chat.split('\n').filter((l) => l.includes("res.json({ ok: true, pid: alivePid, model: s.model, reused: true, runId: alivePid, delivered: true, status: 'running', ...downgradeFields"));
  assert.equal(reuseResp.length, 1, '复用应答一处');
  assert.ok(reuseResp[0].includes('...(configDeferred ? { configDeferred: true } : {})'), `复用应答应条件带字段:${reuseResp[0].trim()}`);
});

for (const home of madeHomes) if (home.startsWith(TMP_PREFIX)) rmSync(home, { recursive: true, force: true });
if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`r152b keep-busy-slot:${passed} 过 / ${failures.length} 败`);
  process.exit(1);
}
console.log(`✓ r152b keep-busy-slot 单测全部通过(${passed} 条)`);
process.exit(0);
