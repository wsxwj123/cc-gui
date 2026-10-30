#!/usr/bin/env node
// r152b:同一会话的空闲进程手上还有活的后台任务时,配置变化(思考强度、设置文件、会话常驻关……)沿用原进程,
// 不再关旧开新另起第二个进程(命令行有后台任务时输入关了也不退出,会和新进程同时写同一份会话记录)。
//   ① 纯函数 decideIdleSlotReuse(chat.js):真 import,兼容键用真 chatCompatKey 生成。覆盖:新鲜后台命令 /
//      新鲜后台子代理 → 'defer';陈旧登记 / 没有任务 → 'close';cwd 不一致 / 键解析失败 → 'close';
//      会话常驻关:有活任务 'defer'、没有 'close';配置一致且常驻开 → 'reuse'(回归)。
//   ② App.jsx 源码形状(照 check-r151v-hidden-autotitle.mjs 的做法):从源码取出提示常量与 if 语句原文,
//      代入替身求值 —— 只在 respJson.configDeferred === true 时出提示;窗格还在 → setProviderSwitchNotice,
//      已切走 → leaveSessionNotice;位置在"发送失败即抛错"之后、"孤儿流复判 return"之前。
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
const keyOf = (cwd, effort) => chatCompatKey({
  workingDir: cwd, effort, appendSystemPrompt: '', promptSuggestions: undefined, globalRead: false,
  dirs: [cwd], maxBudgetUsd: null, acw: null, genui: true, ams: null, amm: null,
});
/** 旧进程按 low 起、本次请求换成 high(同一工作目录)—— 兼容键不一致的典型场景。 */
const effortChanged = () => {
  const cwd = projDir();
  const slotCompatKey = keyOf(cwd, 'low');
  const reuseKey = keyOf(cwd, 'high');
  assert.notEqual(slotCompatKey, reuseKey, '前置:思考强度不同 → 兼容键不同');
  return { cwd, slotCompatKey, reuseKey };
};
const decide = ({ slotCompatKey, reuseKey, wantKeepAlive = true, liveTasks, workingDir, now = NOW }) =>
  decideIdleSlotReuse({ slotCompatKey, reuseKey, wantKeepAlive, liveTasks, workingDir, now });

// ── ① 纯函数 ──
check('1 新鲜的活后台命令 + 兼容键不一致 → defer(沿用原进程)', () => {
  const { cwd, slotCompatKey, reuseKey } = effortChanged();
  const lt = tasks(shell(60_000));
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: lt, workingDir: cwd }), 'defer');
  assert.equal(lt.size, 1, '纯函数不改 liveTasks');
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: tasks(shell(SHELL_TASK_FRESH_MS - 60_000)), workingDir: cwd }), 'defer', '后台命令窗口内(近 2 小时)仍算活');
});
check('2 新鲜的活后台子代理(及 kind 缺省的 unknown)+ 兼容键不一致 → defer', () => {
  const { cwd, slotCompatKey, reuseKey } = effortChanged();
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: tasks(subagent(10 * 60_000)), workingDir: cwd }), 'defer');
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: tasks({ kind: 'unknown', createdAt: NOW - 1000 }), workingDir: cwd }), 'defer');
});
check('3 陈旧登记(终态通知丢了、过了新鲜度窗口)不算活 → close;陈旧与新鲜混着 → defer', () => {
  const { cwd, slotCompatKey, reuseKey } = effortChanged();
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: tasks(shell(STALE_MS)), workingDir: cwd }), 'close', '陈旧后台命令');
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: tasks(subagent(STALE_MS)), workingDir: cwd }), 'close', '陈旧后台子代理');
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: tasks(shell(STALE_MS), subagent(STALE_MS)), workingDir: cwd }), 'close', '全是陈旧');
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: tasks(shell(STALE_MS), subagent(5 * 60_000)), workingDir: cwd }), 'defer', '有一条新鲜即算活');
});
check('4 没有后台任务 → close(与修复前一样关旧开新)', () => {
  const { cwd, slotCompatKey, reuseKey } = effortChanged();
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: new Map(), workingDir: cwd }), 'close', '空 Map');
  assert.equal(decide({ slotCompatKey, reuseKey, liveTasks: undefined, workingDir: cwd }), 'close', '没有 liveTasks');
});
check('5 兼容键里的工作目录与本次请求不同 → close(不延后),即使有新鲜活后台命令', () => {
  const cwdA = projDir('wt-a');
  const cwdB = projDir('wt-b');
  const slotCompatKey = keyOf(cwdA, 'low');
  assert.equal(decide({ slotCompatKey, reuseKey: keyOf(cwdB, 'low'), liveTasks: tasks(shell(1000)), workingDir: cwdB }), 'close', '只换了工作目录');
  assert.equal(decide({ slotCompatKey, reuseKey: keyOf(cwdB, 'high'), liveTasks: tasks(subagent(1000)), workingDir: cwdB }), 'close', '工作目录与思考强度都换了');
  assert.equal(decide({ slotCompatKey, reuseKey: keyOf(cwdA, 'high'), wantKeepAlive: false, liveTasks: tasks(shell(1000)), workingDir: cwdB }), 'close', '会话常驻关时同样不延后');
});
check('6 兼容键解析不出 / 没有 cwd → 按不一致处理 → close', () => {
  const cwd = projDir();
  const reuseKey = keyOf(cwd, 'high');
  for (const bad of ['不是 JSON', '', undefined, null, 'null', '42', '"字符串"', '{}', JSON.stringify({ cwd: 5 }), JSON.stringify({ effort: 'low' })]) {
    assert.equal(decide({ slotCompatKey: bad, reuseKey, liveTasks: tasks(shell(1000)), workingDir: cwd }), 'close', `slotCompatKey=${JSON.stringify(bad)}`);
  }
});
check('7 会话常驻关(keepAlive:false):有新鲜活任务 → defer(兼容键一致也一样);没有 / 陈旧 → close', () => {
  const cwd = projDir();
  const key = keyOf(cwd, 'low');
  assert.equal(decide({ slotCompatKey: key, reuseKey: key, wantKeepAlive: false, liveTasks: tasks(shell(1000)), workingDir: cwd }), 'defer', '只差 keepAlive、带活后台命令');
  assert.equal(decide({ slotCompatKey: key, reuseKey: keyOf(cwd, 'high'), wantKeepAlive: false, liveTasks: tasks(subagent(1000)), workingDir: cwd }), 'defer', 'keepAlive 关且思考强度变了、带活后台子代理');
  assert.equal(decide({ slotCompatKey: key, reuseKey: key, wantKeepAlive: false, liveTasks: new Map(), workingDir: cwd }), 'close', '没有任务');
  assert.equal(decide({ slotCompatKey: key, reuseKey: key, wantKeepAlive: false, liveTasks: tasks(shell(STALE_MS)), workingDir: cwd }), 'close', '陈旧登记');
});
check('8 回归:兼容键一致且会话常驻开 → reuse(有没有后台任务都一样,不出 defer)', () => {
  const cwd = projDir();
  const key = keyOf(cwd, 'low');
  assert.equal(decide({ slotCompatKey: key, reuseKey: key, liveTasks: new Map(), workingDir: cwd }), 'reuse');
  assert.equal(decide({ slotCompatKey: key, reuseKey: key, liveTasks: tasks(shell(1000)), workingDir: cwd }), 'reuse');
  assert.equal(decide({ slotCompatKey: key, reuseKey: key, liveTasks: tasks(shell(1000)), workingDir: projDir('elsewhere') }), 'reuse', '键一致时不看工作目录(键里本就含 cwd)');
});
check('9 now 缺省取当前时间', () => {
  const { cwd, slotCompatKey, reuseKey } = effortChanged();
  assert.equal(decideIdleSlotReuse({ slotCompatKey, reuseKey, wantKeepAlive: true, liveTasks: new Map([['t', { kind: 'shell', createdAt: Date.now() }]]), workingDir: cwd }), 'defer');
  assert.equal(decideIdleSlotReuse({ slotCompatKey, reuseKey, wantKeepAlive: true, liveTasks: new Map([['t', { kind: 'shell', createdAt: Date.now() - STALE_MS }]]), workingDir: cwd }), 'close');
});

// ── ② App.jsx 源码形状 ──
const app = readFileSync(join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
const countOf = (src, s) => src.split(s).length - 1;
/** 从 start 处的 `if (` 起取出整条 if 语句(到与其 `{` 配对的 `}`)。 */
function ifStatementAt(src, start) {
  const open = src.indexOf('{', start);
  assert.ok(open > start, 'if 语句没有花括号');
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('if 语句括号不配对');
}
const NOTICE_DEF = /^const CONFIG_DEFERRED_NOTICE = '([^'\n]+)';$/m;
const IF_HEAD = 'if (respJson.configDeferred === true) {';

check('10 提示常量:单行文案含"后台任务""生效",点明供应商也算设置改动;与 SESSION_BUSY_QUEUED_NOTICE 放在一起', () => {
  const m = app.match(NOTICE_DEF);
  assert.ok(m, '找不到 CONFIG_DEFERRED_NOTICE 的单行定义');
  for (const word of ['后台任务', '生效', '供应商', '思考强度', '沿用']) assert.ok(m[1].includes(word), `文案缺"${word}":${m[1]}`);
  const lineOf = (needle) => app.slice(0, app.indexOf(needle)).split('\n').length;
  const busyLine = lineOf('const SESSION_BUSY_QUEUED_NOTICE = ');
  const ownLine = lineOf('const CONFIG_DEFERRED_NOTICE = ');
  assert.ok(Math.abs(ownLine - busyLine) <= 3, `两个常量相隔 ${Math.abs(ownLine - busyLine)} 行`);
});
check('11 提示只挂在 respJson.configDeferred === true 上:代入求值,只有严格 true 出提示;在原会话 → setProviderSwitchNotice,已切走 → leaveSessionNotice', () => {
  assert.equal(countOf(app, '.configDeferred'), 1, 'App.jsx 里只有一处读 configDeferred 字段(注释里提到的不算)');
  assert.equal(countOf(app, IF_HEAD), 1, `找不到(或不止一处)${IF_HEAD}`);
  assert.equal(countOf(app, 'CONFIG_DEFERRED_NOTICE'), 3, '常量 = 定义 1 处 + if 块里 2 处');
  const stmt = ifStatementAt(app, app.indexOf(IF_HEAD));
  assert.equal(countOf(stmt, 'CONFIG_DEFERRED_NOTICE'), 2, '两处使用都在这条 if 语句里');
  const NOTICE = app.match(NOTICE_DEF)[1];
  const run = (respJson, paneOn) => {
    const calls = [];
    const fn = new Function('respJson', 'paneStillOn', 'setProviderSwitchNotice', 'leaveSessionNotice', 'sessionQueueKey', 'CONFIG_DEFERRED_NOTICE', stmt);
    fn(respJson, (k) => { assert.equal(k, 'sess-key', 'paneStillOn 判的是发送时那个会话'); return paneOn; },
      (n) => calls.push(['set', n]), (k, t) => calls.push(['leave', k, t]), 'sess-key', NOTICE);
    return calls;
  };
  assert.deepEqual(run({ ok: true, pid: 1, reused: true, configDeferred: true }, true), [['set', { text: NOTICE, ownerKey: 'sess-key' }]]);
  assert.deepEqual(run({ ok: true, pid: 1, reused: true, configDeferred: true }, false), [['leave', 'sess-key', NOTICE]]);
  for (const resp of [{ ok: true, pid: 1, reused: true }, { ok: true, pid: 1 }, { configDeferred: false }, { configDeferred: 'true' }, { configDeferred: 1 }, { configDeferred: null }]) {
    for (const paneOn of [true, false]) assert.deepEqual(run(resp, paneOn), [], `应答 ${JSON.stringify(resp)} 不该出提示`);
  }
});
check('12 位置:读应答之后、"发送失败即抛错"之后、"孤儿流复判 return"之前(切走了也留言)', () => {
  const at = (needle, from = 0) => { const i = app.indexOf(needle, from); assert.ok(i >= 0, `找不到锚点 ${needle}`); return i; };
  const respAt = at('const respJson = await res.json();');
  const throwAt = at('if (!res.ok || !respJson.pid) throw new Error(', respAt);
  const ifAt = at(IF_HEAD, respAt);
  const orphanAt = at('if (queueKeyFor(getLocalSession()) !== sessionQueueKey) return;', respAt);
  assert.ok(throwAt < ifAt && ifAt < orphanAt, `次序不对:抛错 ${throwAt} / 提示 ${ifAt} / 孤儿复判 ${orphanAt}`);
  assert.ok(orphanAt - respAt < 8000, '三处应在同一段应答处理里');
});

// ── ③ chat.js 源码形状 ──
check('13 chat.js:复用块经 decideIdleSlotReuse 判定;configDeferred 只以条件展开进复用应答', () => {
  const chat = readFileSync(join(ROOT, 'server', 'routes', 'chat.js'), 'utf8');
  assert.equal(countOf(chat, 'decideIdleSlotReuse({ slotCompatKey: s.compatKey, reuseKey, wantKeepAlive, liveTasks: s.liveTasks, workingDir })'), 1, '复用循环调用判定函数');
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
