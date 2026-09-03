#!/usr/bin/env node
// r99:DeepSeek「API Error: 400 Content Exists Risk」的识别提示 + 一键回退重发。
//
// 本文件是【黑盒验收测试】:只依据 .devflow/INTERFACE-r99.md 的对外契约写,
// 不看 client/src/utils/contentRisk.js 与 App.jsx 的实现正文。三部分:
//   A. 纯函数契约(classifyUpstreamRefusal / lastUserIndex / locateRiskAnchor /
//      RISK_CONTINUE_PROMPT):真 import 真跑,含正例、反例、边界、不变式。
//   B. 源码锁(JSX 进不了 node,只能读文件做结构断言),逐条抄 INTERFACE §4。
//   C. 零 diff 与既有测试回归(server/** 与 tests/acceptance/** 一行不许改)。
//
// 断言名带 INTERFACE 编号(B*/R*/M*/§*),红了能直接对回契约表。
// 纯函数部分用【动态 import + 逐条 try/catch】:静态 import 一个还不存在的导出会在
// ESM 链接阶段整体抛错,改前看不出到底缺哪几件。
//
// Run: node tests/unit/check-r99-content-risk.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; } };
const count = (s, re) => (s.match(re) || []).length;
// grep -o '<literal>' | wc -l 的等价口径(INTERFACE §4.3 机械口径,不受正则转义影响)
const countF = (s, lit) => s.split(lit).length - 1;

let PASS = 0;
let FAILS = 0;
const failed = [];
function check(name, fn) {
  try {
    fn();
    PASS++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    FAILS++;
    failed.push(name);
    const msg = String((e && e.message) || e).split('\n').slice(0, 4).join('\n      ');
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// A. 纯函数契约(INTERFACE §1)client/src/utils/contentRisk.js
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[A] 纯函数契约 client/src/utils/contentRisk.js');

let MOD = null;
let MODERR = '';
try {
  MOD = await import('../../client/src/utils/contentRisk.js');
} catch (e) {
  MODERR = String((e && e.message) || e);
}
check('R1 contentRisk.js 可被 node 直接 import(零依赖、不碰 window/document)', () => {
  assert.ok(MOD, `import 失败:${MODERR}`);
});

const classify = MOD?.classifyUpstreamRefusal;
const lastUserIndex = MOD?.lastUserIndex;
const locateRiskAnchor = MOD?.locateRiskAnchor;
const PROMPT = MOD?.RISK_CONTINUE_PROMPT;

// ── §1.1 classifyUpstreamRefusal ───────────────────────────────────────
check('§1.1 classifyUpstreamRefusal 已导出且是函数', () => {
  assert.equal(typeof classify, 'function');
});
check("R2 正例:'API Error: 400 Content Exists Risk' → { kind:'content-risk', vendor:'deepseek' }", () => {
  assert.deepEqual(classify('API Error: 400 Content Exists Risk'), { kind: 'content-risk', vendor: 'deepseek' });
});
check("§1.1 正例:裸文案 'Content Exists Risk'(无 API Error 前缀)", () => {
  assert.deepEqual(classify('Content Exists Risk'), { kind: 'content-risk', vendor: 'deepseek' });
});
check("M2 正例:全小写 'content exists risk'(正则须带 i 标志)", () => {
  assert.deepEqual(classify('content exists risk'), { kind: 'content-risk', vendor: 'deepseek' });
});
check("M2 正例:全大写 'CONTENT EXISTS RISK'", () => {
  assert.deepEqual(classify('CONTENT EXISTS RISK'), { kind: 'content-risk', vendor: 'deepseek' });
});
check('§1.1 正例:JSON 错误体内嵌形态(message 字段里)', () => {
  const s = 'API Error: 400 {"error":{"message":"Content Exists Risk","type":"invalid_request_error"}}';
  assert.deepEqual(classify(s), { kind: 'content-risk', vendor: 'deepseek' });
});
check('M3 正例:词间多空白 / 制表符(正则不许写死单个空格)', () => {
  assert.deepEqual(classify('API Error: 429 Content  Exists\tRisk'), { kind: 'content-risk', vendor: 'deepseek' });
});
check('§1.1 不变式:命中时 kind==="content-risk" 且 vendor 是非空字符串', () => {
  const r = classify('Content Exists Risk');
  assert.equal(r.kind, 'content-risk');
  assert.equal(typeof r.vendor, 'string');
  assert.ok(r.vendor.length > 0, 'vendor 不许是空串');
});
check('§1.1 反例:空与非字符串入参一律 null 且不抛错', () => {
  for (const v of ['', null, undefined, 0, {}, []]) {
    assert.strictEqual(classify(v), null, `入参 ${JSON.stringify(v) ?? String(v)} 应得 null`);
  }
});
check("M1 反例:普通 400 'API Error: 400 Bad Request' → null", () => {
  assert.strictEqual(classify('API Error: 400 Bad Request'), null);
});
check("M1 反例:限流 'API Error: 429 Too Many Requests' → null", () => {
  assert.strictEqual(classify('API Error: 429 Too Many Requests'), null);
});
check("B16 反例:401 鉴权 → null(必须继续走 errorAction:'provider')", () => {
  assert.strictEqual(classify('API Error: 401 Unauthorized'), null);
});
check('B17 反例:超窗 prompt is too long → null(必须继续走超窗横幅)', () => {
  assert.strictEqual(classify('API Error: 400 prompt is too long: 131072 tokens > 65536 maximum'), null);
});
check("B18 反例:官方空内容块 400 → null(必须继续走 repair-official)", () => {
  assert.strictEqual(classify('API Error: 400 messages.5.content.0: text content blocks must be non-empty'), null);
});
check('§1.1 反例:thinking 签名错误 → null(继续走自动剥离)', () => {
  assert.strictEqual(classify('400 Invalid signature in thinking block'), null);
});
check('§1.1 反例:会话失效 No conversation found → null', () => {
  assert.strictEqual(classify('No conversation found with session ID: abc'), null);
});
check('M1 反例:含 content/risk/exists 三词但不成短语的句子 → null', () => {
  assert.strictEqual(classify('The content of this risk assessment exists in the report'), null);
});
check('M4 反例:本轮未证实的四家厂商疑似文案一个都不许命中', () => {
  const unproven = [
    ['GLM', '系统检测到输入或生成内容可能包含不安全或敏感内容'],
    ['Kimi', 'The request was rejected because it was considered high risk'],
    ['通义', 'DataInspectionFailed'],
    ['Azure/OpenAI', 'content_filter'],
  ];
  for (const [who, s] of unproven) {
    assert.strictEqual(classify(s), null, `${who} 文案本轮未证实(PLAN §5.2),必须不命中:${s}`);
  }
});

// ── §1.2 lastUserIndex ────────────────────────────────────────────────
const U = (uuid, text) => ({ type: 'user', uuid, text, timestamp: '2026-09-03T00:00:00.000Z' });
const TC = (id, name, input, result) => ({ id, name, input, result, category: 'x' });
const T = (uuid, toolCalls) => ({ type: 'turn', uuid, text: [], thinking: [], toolCalls, blocks: [] });
const base = () => [
  U('u1', '读一下配置'),
  T('t1', [TC('toolA', 'Read', { file_path: '/a' }, 'ok-a'),
    TC('toolB', 'Bash', { command: "sed -n '355,412p' clash.yaml" }, '节点名…')]),
];

check('§1.2 lastUserIndex 已导出且是函数', () => {
  assert.equal(typeof lastUserIndex, 'function');
});
check('§1.2 非数组入参(null/undefined/字符串/对象/空数组)→ -1', () => {
  for (const v of [null, undefined, 'x', {}, []]) {
    assert.strictEqual(lastUserIndex(v), -1, `入参 ${String(v)}`);
  }
});
check('§1.2 只有 turn、没有用户消息 → -1', () => {
  assert.strictEqual(lastUserIndex([T('t1', []), T('t2', [])]), -1);
});
check('M9 [U,T,U,T] → 2(取最后一条用户消息,不是第一条)', () => {
  assert.strictEqual(lastUserIndex([U('u1', 'a'), T('t1', []), U('u2', 'b'), T('t2', [])]), 2);
});
check('§1.2 数组里混有 null / 非对象:跳过且不抛错', () => {
  assert.strictEqual(lastUserIndex([null, U('u1', 'a'), 'x', 7, undefined]), 1);
});
check("M10 用户消息 text 为 '' / 纯空白 → 跳过(不算有效用户消息)", () => {
  assert.strictEqual(lastUserIndex([U('u1', 'a'), U('u2', ''), U('u3', '   \n ')]), 0);
});
check('§1.2 用户消息 text 非字符串(undefined / 数组)→ 跳过', () => {
  assert.strictEqual(lastUserIndex([U('u1', 'a'), U('u2', undefined), U('u3', ['x'])]), 0);
});
check("§1.2 type 为 compact / goal / denial 的条目 → 跳过", () => {
  const arr = [U('u1', 'a'), { type: 'compact', uuid: 'c1', text: 'x' },
    { type: 'goal', uuid: 'g1', text: 'y' }, { type: 'denial', uuid: 'd1', text: 'z' }];
  assert.strictEqual(lastUserIndex(arr), 0);
});
check('§1.2 全是被跳过的条目 → -1', () => {
  assert.strictEqual(lastUserIndex([{ type: 'compact' }, { type: 'goal' }, U('u1', '  ')]), -1);
});

// ── §1.3 locateRiskAnchor ─────────────────────────────────────────────
check('§1.3 locateRiskAnchor 已导出且是函数', () => {
  assert.equal(typeof locateRiskAnchor, 'function');
});
check('§1.3 非法入参(null/undefined/字符串/空数组)→ null', () => {
  for (const v of [null, undefined, 'x', []]) {
    assert.strictEqual(locateRiskAnchor(v), null, `入参 ${String(v)}`);
  }
});
check('§1.3 只有用户消息、无 turn → null', () => {
  assert.strictEqual(locateRiskAnchor([U('u1', 'a'), U('u2', 'b')]), null);
});
check('§1.3 turn 的 toolCalls 为 [] / 缺字段 / 非数组 → null', () => {
  assert.strictEqual(locateRiskAnchor([U('u1', 'a'), T('t1', [])]), null, 'toolCalls=[]');
  assert.strictEqual(locateRiskAnchor([U('u1', 'a'), { type: 'turn', uuid: 't1' }]), null, '缺 toolCalls');
  assert.strictEqual(locateRiskAnchor([U('u1', 'a'), T('t1', 'nope')]), null, 'toolCalls 非数组');
});
check('M6 所有 toolCall 的 result == null(工具悬挂未回)→ null', () => {
  const m = [U('u1', 'a'), T('t1', [TC('toolA', 'Read', {}, null), TC('toolB', 'Bash', {}, undefined)])];
  assert.strictEqual(locateRiskAnchor(m), null);
});
check('R3 base fixture → turnIndex/turnUuid/toolUseId/toolName/carryText 逐字段相等', () => {
  const a = locateRiskAnchor(base());
  assert.ok(a, '不该是 null');
  assert.strictEqual(a.turnIndex, 1);
  assert.strictEqual(a.turnUuid, 't1');
  assert.strictEqual(a.toolUseId, 'toolB');
  assert.strictEqual(a.toolName, 'Bash');
  assert.strictEqual(a.carryText, '');
});
check('§1.3 base fixture 的 toolInput 与传入对象 deepEqual', () => {
  const a = locateRiskAnchor(base());
  assert.deepEqual(a.toolInput, { command: "sed -n '355,412p' clash.yaml" });
});
check('M5 同 turn 内多个有 result 的工具:取最后一个(toolB 而非 toolA)', () => {
  assert.strictEqual(locateRiskAnchor(base()).toolUseId, 'toolB');
});
check('M6 跳过悬挂工具:toolB.result=null 时锚点回落到 toolA', () => {
  const m = base();
  m[1].toolCalls[1].result = null;
  assert.strictEqual(locateRiskAnchor(m).toolUseId, 'toolA');
});
check('§1.3 其后有空 toolCalls 的 turn:锚点仍是 t1(空 turn 不作锚点)', () => {
  const a = locateRiskAnchor([...base(), T('t2', [])]);
  assert.strictEqual(a.turnUuid, 't1');
  assert.strictEqual(a.toolUseId, 'toolB');
});
check("M7 锚点在最后、其后无用户消息 → carryText === ''", () => {
  const m = [...base(), U('u2', '再看看'), T('t2', [TC('toolC', 'Read', {}, 'ok')])];
  const a = locateRiskAnchor(m);
  assert.strictEqual(a.turnUuid, 't2');
  assert.strictEqual(a.toolUseId, 'toolC');
  assert.strictEqual(a.carryText, '', 'carryText 只取锚点之后的用户消息,不许从全历史取');
});
check("R4 锚点之后有两条用户消息 → carryText 取最后一条('还是不行')", () => {
  const a = locateRiskAnchor([...base(), U('u2', '继续'), U('u3', '还是不行')]);
  assert.strictEqual(a.turnUuid, 't1');
  assert.strictEqual(a.toolUseId, 'toolB');
  assert.strictEqual(a.carryText, '还是不行');
});
check("§1.3 锚点之后一条用户消息 → carryText === '继续'", () => {
  assert.strictEqual(locateRiskAnchor([...base(), U('u2', '继续')]).carryText, '继续');
});
check('§1.3 toolCall 缺 id 或缺 name:该项不作锚点', () => {
  const m = [U('u1', 'a'), T('t1', [TC('toolA', 'Read', {}, 'ok'),
    { name: 'Bash', input: {}, result: 'r' }, { id: 'toolX', input: {}, result: 'r' }])];
  assert.strictEqual(locateRiskAnchor(m).toolUseId, 'toolA');
});
check('§1.3 toolCall 全部缺 id/name → null', () => {
  const m = [U('u1', 'a'), T('t1', [{ input: {}, result: 'r' }, { name: 'Bash', result: 'r' }])];
  assert.strictEqual(locateRiskAnchor(m), null);
});
check('M8 不变式:carryText 永远是字符串(不许 undefined / null)', () => {
  for (const m of [base(), [...base(), U('u2', '继续')], [...base(), T('t2', [])]]) {
    const a = locateRiskAnchor(m);
    assert.strictEqual(typeof a?.carryText, 'string');
  }
});
check('§1.3 不变式:m[anchor.turnIndex].uuid === anchor.turnUuid', () => {
  for (const m of [base(), [...base(), U('u2', '继续'), T('t2', [TC('toolC', 'Read', {}, 'ok')])]]) {
    const a = locateRiskAnchor(m);
    assert.ok(a, '不该是 null');
    assert.strictEqual(m[a.turnIndex]?.uuid, a.turnUuid, 'turnIndex 必须真指向 turnUuid 那条');
  }
});
check('§1.3 数组里混有 null / 非对象:跳过且不抛错', () => {
  const a = locateRiskAnchor([null, ...base(), 'x', 7, undefined]);
  assert.strictEqual(a.toolUseId, 'toolB');
});

// ── §1.4 RISK_CONTINUE_PROMPT ─────────────────────────────────────────
check('§1.4 RISK_CONTINUE_PROMPT 是长度 > 20 的字符串', () => {
  assert.equal(typeof PROMPT, 'string');
  assert.ok(PROMPT.length > 20, `实得长度 ${PROMPT?.length}`);
});
check('§1.4 续跑指令含「不要重新执行」与「不要重新读取」(禁止复读污染源)', () => {
  assert.match(PROMPT, /不要重新执行/);
  assert.match(PROMPT, /不要重新读取/);
});
check('M16 续跑指令不含「请重新执行」(那是工具重做原文案,复用会死循环)', () => {
  assert.doesNotMatch(PROMPT, /请重新执行/);
});

// ══════════════════════════════════════════════════════════════════════════
// B. 源码锁(INTERFACE §4)—— JSX 进不了 node,只能读文件做结构断言
// ══════════════════════════════════════════════════════════════════════════
const C = read('client/src/utils/contentRisk.js');
const A = read('client/src/App.jsx');

// 「同块」口径:从标记起,到下一处 2 空格缩进的组件级 const/function/useEffect/return 为止
// (useCallback 体内一律 ≥4 空格缩进),上限 6000 字符。红了先看是不是块切歪了。
function blockOf(src, marker, max = 6000) {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const rest = src.slice(i + marker.length);
  const j = rest.search(/\n {2}(?:const|function|useEffect|return)\b/);
  const end = j < 0 ? Math.min(rest.length, max) : Math.min(j, max);
  return marker + rest.slice(0, end);
}

console.log('\n[B] 源码锁 §4.1 client/src/utils/contentRisk.js');
check('§4.1 contentRisk.js 可读且非空', () => assert.ok(C.length > 0, '文件读不到或为空'));
check('§4.1 四个导出的声明形态逐字存在', () => {
  for (const re of [/export function classifyUpstreamRefusal/, /export function lastUserIndex/,
    /export function locateRiskAnchor/, /export const RISK_CONTINUE_PROMPT/]) {
    assert.match(C, re);
  }
});
check('§4.1 形态表是数组:REFUSAL_PATTERNS = [', () => {
  assert.match(C, /REFUSAL_PATTERNS\s*=\s*\[/);
});
check('M4 count(C, /vendor:/g) === 1(本轮只收录 DeepSeek 一条)', () => {
  assert.strictEqual(count(C, /vendor:/g), 1, '多于 1 条 = 混进了未证实厂商文案');
});
check('§4.1 存在 content…exists…risk 语义的正则', () => {
  assert.ok(/content[^\n]*exists[^\n]*risk/i.test(C));
});
check('§4.1 零 import(纯函数模块,node 能直接跑)', () => {
  assert.strictEqual(count(C, /^import /gm), 0);
});
check('§4.1 不引用浏览器全局:window / document / fetch / localStorage 各 0 次', () => {
  for (const [name, re] of [['window', /\bwindow\b/g], ['document', /\bdocument\b/g],
    ['fetch', /\bfetch\b/g], ['localStorage', /\blocalStorage\b/g]]) {
    assert.strictEqual(count(C, re), 0, `发现 ${name}`);
  }
});
check('M4 反向源码锁:未证实文案字符串一个都不许进 contentRisk.js', () => {
  assert.strictEqual(count(C, /1301|content_filter|DataInspectionFailed|high risk/g), 0);
});
check('M4 反向源码锁:未证实文案也不许出现在 App.jsx', () => {
  assert.strictEqual(count(A, /1301|content_filter|DataInspectionFailed|high risk/g), 0);
});

console.log('\n[B] 源码锁 §4.2 client/src/App.jsx —— 新增部分');
check('§4.2 App.jsx 可读且非空', () => assert.ok(A.length > 0, '文件读不到或为空'));
check("§4.2 从 './utils/contentRisk.js' import 且含三个函数名", () => {
  const m = A.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/utils\/contentRisk\.js'/);
  assert.ok(m, "找不到 from './utils/contentRisk.js' 的 import");
  for (const n of ['classifyUpstreamRefusal', 'lastUserIndex', 'locateRiskAnchor']) {
    assert.ok(m[1].includes(n), `import 名单缺 ${n}`);
  }
});
check('§4.2 打标点:const risk = classifyUpstreamRefusal(msg)', () => {
  assert.match(A, /const risk = classifyUpstreamRefusal\(msg\)/);
});
check("R5 打标:errorAction: 'content-risk'", () => {
  assert.match(A, /errorAction: 'content-risk'/);
});
check("§4.2 渲染:msg.errorAction === 'content-risk'", () => {
  assert.match(A, /msg\.errorAction === 'content-risk'/);
});
check('§4.2 两个新回调声明:runContentRiskRewind / newSessionWithLastUser', () => {
  assert.match(A, /const runContentRiskRewind = useCallback/);
  assert.match(A, /const newSessionWithLastUser = useCallback/);
});
check('R7/B3 主按钮文案逐字:回退到上一条工具输出之前并重发', () => {
  assert.match(A, /回退到上一条工具输出之前并重发/);
});
check('B4 退化按钮文案逐字:回退到上一条消息之前并重新编辑', () => {
  assert.match(A, /回退到上一条消息之前并重新编辑/);
});
check('B12 次要按钮文案含「新开会话」', () => {
  assert.match(A, /新开会话/);
});
check('B2 提示文案含「内容审核」与「每一轮」', () => {
  assert.match(A, /内容审核/);
  assert.match(A, /每一轮/);
});
check('B2 提示文案客观陈述:附近无 emoji、无「一键 / 帮你 / 搞定」式措辞', () => {
  // 锚点用「每一轮」:改前全文件 0 次,是本轮提示文案独有的词;
  //「内容审核」改前也 0 次但改后多处复用(注释/确认框),窗口易串到别处。
  const i = A.indexOf('每一轮');
  assert.ok(i > 0, '找不到提示文案');
  const win = A.slice(Math.max(0, i - 250), i + 250);
  assert.doesNotMatch(win, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u, '提示文案区出现 emoji');
  for (const w of ['一键', '帮你', '搞定']) {
    assert.ok(!win.includes(w), `提示文案区出现营销腔用词「${w}」`);
  }
});
check('M13/B5 runContentRiskRewind 块内含 await confirmDialog( 与 { danger: true }', () => {
  const blk = blockOf(A, 'const runContentRiskRewind = useCallback');
  assert.ok(blk.length > 0, '切不出 runContentRiskRewind 块');
  assert.match(blk, /await confirmDialog\(/, '破坏性操作必须走应用内确认框');
  assert.match(blk, /\{ danger: true \}/);
});
check('B6 确认框取消后早退:confirmDialog 之后 800 字符内有 return', () => {
  // 800 是机械代理口径(确认框文案含工具名+入参+.bak+不压缩,本身就几百字符);
  // 真正的"取消后会话文件/界面/在飞回合均不变"由手验 B6 判定。
  const blk = blockOf(A, 'const runContentRiskRewind = useCallback');
  const i = blk.indexOf('await confirmDialog(');
  assert.ok(i > -1, '块内找不到 await confirmDialog(');
  assert.match(blk.slice(i, i + 800), /\breturn\b/, '点取消必须直接 return,不许继续裁会话');
});
check('B5 确认框文案含备份说明与「不压缩 / 不生成摘要」', () => {
  const blk = blockOf(A, 'const runContentRiskRewind = useCallback');
  assert.match(blk, /\.bak|备份/, '确认框须说明会写备份');
  assert.match(blk, /不压缩|不生成摘要/, '确认框须说明本轮是纯截断、不走摘要');
});
check('R8/M12 主动作复用既有链路:同块内 handleRetryToolRef.current?.( 且带 contentRisk: true', () => {
  const blk = blockOf(A, 'const runContentRiskRewind = useCallback');
  assert.match(blk, /handleRetryToolRef\.current\?\.\(/, '不许自写一套裁剪重发');
  assert.match(blk, /contentRisk: true/);
});
check("B10 退化路径复用既有链路:handleRollbackRef.current?.(… { mode: 'edit' })", () => {
  assert.match(A, /handleRollbackRef\.current\?\.\([^)]*\{ mode: 'edit' \}/);
});
check('B12/M17 新开会话三件套同处出现且带 targetKey', () => {
  const blk = blockOf(A, 'const newSessionWithLastUser = useCallback');
  assert.ok(blk.length > 0, '切不出 newSessionWithLastUser 块');
  for (const [lit, why] of [['newDraftId()', '转 draft'], ['queueKeyFor({ projectHash', '队列键'],
    ['cgui:composer-fill', '预填输入框'], ['targetKey', '预填必须指定窗格,否则落进旧窗格']]) {
    assert.ok(blk.includes(lit), `块内缺 ${lit}(${why})`);
  }
});
check('M11 runContentRiskRewind 块内不出现 compact-segment / summarize-*(本轮不压缩)', () => {
  const blk = blockOf(A, 'const runContentRiskRewind = useCallback');
  assert.strictEqual(countF(blk, 'compact-segment'), 0);
  assert.strictEqual(count(blk, /summarize-after|summarize-before/g), 0);
});
check('B13 两个新回调块内不出现 window.addEventListener(每窗格隔离,不挂全局监听)', () => {
  for (const marker of ['const runContentRiskRewind = useCallback', 'const newSessionWithLastUser = useCallback']) {
    const blk = blockOf(A, marker);
    assert.strictEqual(count(blk, /window\.addEventListener/g), 0, `${marker} 块内挂了全局监听`);
  }
});
check('M14 全文件不出现 window.confirm( 调用(Tauri webview 里是哑的)', () => {
  assert.strictEqual(countF(A, 'window.confirm('), 0);
});
check('§4.2 全文件不出现 alert( / window.alert(', () => {
  assert.strictEqual(countF(A, 'alert('), 0);
});
check('§4.4 新回调必须定义在 handleRollbackRef 赋值 effect 之后(否则撑破 check-rollback-requeue 的块切片)', () => {
  const iRewind = A.indexOf('const runContentRiskRewind = useCallback');
  const iEffect = A.indexOf('useEffect(() => { handleRollbackRef.current = handleRollback; }');
  assert.ok(iEffect > -1, '找不到 handleRollbackRef 赋值 effect(既有锚点被改了?)');
  assert.ok(iRewind > -1, '找不到 runContentRiskRewind');
  assert.ok(iRewind > iEffect,
    'check-rollback-requeue 把 handleRollback 起点到该 effect 之间整段当 rollbackBlock 并锁死 hard:true 恰 2 次;新代码插进这段会误伤');
});

console.log('\n[B] 计数锁 §4.3(口径 = grep -o <literal> | wc -l)');
const S = read('server/routes/sessions.js');
check('R6 App.jsx errorAction 恰 6 次(改前 4:只加"打标"与"渲染"各一处)', () => {
  assert.strictEqual(countF(A, 'errorAction'), 6);
});
check('M12 App.jsx trim-before-tool 恰 1 次(复用既有唯一调用点,不新写 fetch)', () => {
  assert.strictEqual(countF(A, 'trim-before-tool'), 1);
});
check('M11 App.jsx compact-segment 恰 2 次(本轮一次都不调用压缩端点)', () => {
  assert.strictEqual(countF(A, 'compact-segment'), 2);
});
check('§4.3 App.jsx confirmDialog 在 60~61 次之间(改前 59:新增 1~2 处)', () => {
  const n = countF(A, 'confirmDialog');
  assert.ok(n >= 60 && n <= 61, `实得 ${n} 次,应在 [60, 61]`);
});
check('§4.3 App.jsx cgui:composer-fill 恰 5 次(改前 4:新开会话预填 +1)', () => {
  assert.strictEqual(countF(A, 'cgui:composer-fill'), 5);
});
check('§4.3 App.jsx newDraftId() 恰 9 次(改前 8:新开会话转 draft +1)', () => {
  assert.strictEqual(countF(A, 'newDraftId()'), 9);
});
check('§4.3 App.jsx handleRetryTool 恰 8 次(改前 7:新增一次 Ref 调用)', () => {
  assert.strictEqual(countF(A, 'handleRetryTool'), 8);
});
check('§4.3 App.jsx /api/sessions/ 恰 9 次(不变:不新增任何会话端点调用)', () => {
  assert.strictEqual(countF(A, '/api/sessions/'), 9);
});
check('M19 server/routes/sessions.js .bak 恰 28 次(服务端零 diff)', () => {
  assert.ok(S.length > 0, '读不到 server/routes/sessions.js');
  assert.strictEqual(countF(S, '.bak'), 28);
});
check('§2 trim-before-tool 端点仍在服务端(原样复用,不新增不修改)', () => {
  assert.match(S, /router\.post\('\/sessions\/:sessionId\/trim-before-tool'/);
});

console.log('\n[B] 既有行为回归锁 §4.4(改动前后都必须成立)');
check('M18 handleRetryTool 原文案三件套逐字仍在', () => {
  assert.match(A, /请重新执行 \$\{toolCall\.name\} 工具调用/);
  assert.match(A, /<cgui-tool-retry tool=/);
  assert.match(A, /hiddenUserMessage: true/);
});
check('M18 handleRetryTool 乐观截断仍在(_retryTrimToolId ≥2 次 + setRetryActiveUuid(turn.uuid))', () => {
  assert.ok(countF(A, '_retryTrimToolId') >= 2, `实得 ${countF(A, '_retryTrimToolId')} 次`);
  assert.match(A, /setRetryActiveUuid\(turn\.uuid\)/);
});
check('M18 handleRetryTool 停流三件套逐字仍在', () => {
  assert.match(A, /stoppedPidsRef\.current\.add\(String\(_rtPid\)\)/);
  assert.match(A, /hard: true/);
  assert.match(A, /backgroundPidRef\.current = null/);
});
check("B16 既有 provider 错误块逐字仍在", () => {
  assert.match(A, /msg\.errorAction === 'provider' && !mobileChrome/);
});
check('B18 既有 repair-official 错误块逐字仍在', () => {
  assert.match(A, /msg\.errorAction === 'repair-official' && selectedSession\?\.sessionId/);
});
check('M15 三元链其余两支仍在且相距 < 2000 字符(同一表达式的机械代理判据)', () => {
  const a = A.indexOf('isAuthError ?');
  const b = A.indexOf('isOfficialEmptyBlock ?');
  assert.ok(a > -1, '缺 isAuthError ?');
  assert.ok(b > -1, '缺 isOfficialEmptyBlock ?');
  assert.ok(Math.abs(a - b) < 2000, `相距 ${Math.abs(a - b)} 字符,疑似被拆散;三元链顺序由判官人工核对`);
});
check('§4.4 错误分支其它四条自愈判据逐字不变', () => {
  for (const re of [/usage credits required for 1m context/, /invalid signature in thinking/,
    /No conversation found/, /payload too large/]) {
    assert.match(A, re);
  }
});
check('§4.4 handleRollback 签名逐字不变', () => {
  assert.match(A, /const handleRollback = useCallback\(async \(msg, \{ mode, resendText = null, softFiles = false \} = \{\}\) =>/);
});

// ══════════════════════════════════════════════════════════════════════════
// C. 零 diff 与既有测试回归(INTERFACE §2 / §5 / §7.2)
// ══════════════════════════════════════════════════════════════════════════
console.log('\n[C] 零 diff 与既有测试回归');
let BASE = '';
try {
  BASE = execFileSync('git', ['merge-base', 'HEAD', 'master'], { cwd: root, encoding: 'utf8' }).trim();
} catch { BASE = ''; }
const changedIn = (...paths) => execFileSync('git', ['diff', '--name-only', BASE, '--', ...paths],
  { cwd: root, encoding: 'utf8' }).trim();

// r100:原 M19/§2「server/** 与 tests/acceptance/** 自 merge-base 零改动」是分支范围的 git 锁,后续分支改 server/ 必误红;
// 改由判官 git diff 核对。§5「既有单测零改动」同理只保留在本轮分支上有意义,合并后恒绿,不另处理。
// r100:原 §5「tests/unit 自 merge-base 只有新增」同为分支范围 git 锁(别的分支合法改任何既有测试即误红),
// 改由判官核对,不再断言。
// §5 点名的三个 + 本轮改动 token 命中的四个(真实爆炸半径)
for (const t of ['check-official-auth', 'check-session-repair', 'check-esc-action',
  'check-rollback-requeue', 'check-r31-seed-new-session-key',
  'check-r31-composer-fill-draft', 'check-r63-resend-attachments']) {
  check(`§5 既有测试仍绿:${t}.mjs`, () => {
    execFileSync(process.execPath, [join(root, 'tests/unit', `${t}.mjs`)], { cwd: root, stdio: 'pipe' });
  });
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n—— check-r99-content-risk: ${PASS} 绿 / ${FAILS} 红(共 ${PASS + FAILS} 条)——`);
if (FAILS) {
  console.log('红的条目:');
  for (const n of failed) console.log(`  ✗ ${n}`);
  process.exit(1);
}
console.log('✓ check-r99-content-risk: 内容审核拒绝识别/回退锚点定位 + 提示与两个按钮源码锁 + 不压缩/不改服务端 全绿');
