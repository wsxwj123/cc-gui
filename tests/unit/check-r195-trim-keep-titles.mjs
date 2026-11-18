#!/usr/bin/env node
// 单测 r195:按位置截断的三种回退(trim / trim-before-tool / compact-segment after)之后,
// 截掉段里的标题类记录(custom-title / ai-title / tag)按「类型 + 会话编号」每组最新一条,
// 逐字节原样接回会话记录末尾;会话列表的数据源(readSessionTitles,应用自己的读法)读出的
// customTitle / aiTitle 与回退前相同。
// 只 import 已有导出,不 import 新模块(未修代码上也要能加载并跑出红绿);新函数的边界情况
// 全部经这几个已有函数测。夹具全是造的,写在系统临时目录,跑完只删自己建的文件。
// Run: node tests/unit/check-r195-trim-keep-titles.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHistoryOp, HISTORY_OP_NAMES } from '../../server/routes/session-history.js';
import { trimJsonlBeforeTool, compactSegmentJsonl } from '../../server/routes/sessions.js';
import { readSessionTitles } from '../../server/services/session-reader.js';

const S = '5e5e5e5e-0000-4000-8000-000000000001'; // 本会话
const G = '9a9a9a9a-0000-4000-8000-000000000002'; // 祖先编号(分叉 / 续接留下的另一个会话编号)
const SUMMARY = '这是一段固定的摘要文字,代替一次性命令行生成的段落摘要,长度足够用来做测试。';

const J = (o) => JSON.stringify(o);
const at = (n) => `2026-11-18T00:00:${String(n).padStart(2, '0')}.000Z`;
const ct = (name, sid = S) => J({ type: 'custom-title', customTitle: name, sessionId: sid });
const ai = (name, sid = S) => J({ type: 'ai-title', aiTitle: name, sessionId: sid });
const tg = (name, sid = S) => J({ type: 'tag', tag: name, sessionId: sid });
const user = (uuid, parent, text, n, sid = S) => J({
  type: 'user', uuid, parentUuid: parent, timestamp: at(n), sessionId: sid, message: { role: 'user', content: text },
});
const asst = (uuid, parent, n, content = [{ type: 'text', text: '好的' }], sid = S) => J({
  type: 'assistant', uuid, parentUuid: parent, timestamp: at(n), sessionId: sid, message: { role: 'assistant', content },
});
const toolResult = (uuid, parent, toolId, n) => J({
  type: 'user', uuid, parentUuid: parent, timestamp: at(n), sessionId: S,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'done' }] },
});
const toolUse = (id, text) => [{ type: 'text', text }, { type: 'tool_use', id, name: 'Read', input: { file_path: `/${id}` } }];
const MODE = J({ type: 'mode', mode: 'normal', sessionId: S }); // 同形夹具里替换标题行用的惰性记录
const toRaw = (lines) => `${lines.join('\n')}\n`;

// 结果按行拆开(去掉末尾换行带出的那个空串)
function bodyOf(text) {
  const parts = String(text).split('\n');
  assert.equal(parts[parts.length - 1], '', '结果必须以换行结尾');
  return parts.slice(0, -1);
}
// 某类记录的最后一条值(tag 应用不读,这里自己按「后写胜出」读)
function lastOf(text, type, field) {
  let value;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj && obj.type === type && typeof obj[field] === 'string') value = obj[field];
  }
  return value;
}
// 结果 = head 逐行 + tail 逐行(逐字节、同顺序)
function assertHeadTail(text, head, tail, label) {
  const body = bodyOf(text);
  assert.deepEqual(body.slice(body.length - tail.length), tail, `${label}: 末尾是补回的标题行(逐字节、原顺序)`);
  if (head) assert.deepEqual(body.slice(0, body.length - tail.length), head, `${label}: 补回行之前是保留段`);
  assert.equal(body.length, (head ? head.length : body.length - tail.length) + tail.length, `${label}: 行数`);
}

const tmpRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cgui-r195-unit-'));
let fileSeq = 0;
// 应用自己的读法当裁判:写临时文件 → readSessionTitles → 立即删掉该文件
async function titlesOf(text) {
  fileSeq += 1;
  const file = join(tmpRoot, `s${fileSeq}.jsonl`);
  writeFileSync(file, text);
  try { return await readSessionTitles(file); } finally { unlinkSync(file); }
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL ${name}\n     ${String(err?.message || err).split('\n')[0]}`);
  }
}

// ── 夹具 A:截断点(u2,下标 5)之前旧名 / 旧AI名 / 旧标签,之后新名 / 新AI名 / 新标签 ──
const A = [
  ct('旧名'), ai('旧AI名'), tg('旧标签'), // 0 1 2
  user('u1', null, '第一条', 1), // 3
  asst('a1', 'u1', 2), // 4
  user('u2', 'a1', '第二条', 3), // 5 ← 锚点
  asst('a2', 'u2', 4), // 6
  ct('新名'), // 7
  user('u3', 'a2', '第三条', 5), // 8
  asst('a3', 'u3', 6), // 9
  ai('新AI名'), tg('新标签'), // 10 11
];
const A_RAW = toRaw(A);
const A_CUT = 5;
const A_NEW = [A[7], A[10], A[11]];

// ── 夹具 T:回退到工具调用前(行为 3):新名夹在被裁工具的调用行与它的结果行之间;
//    同一回合还有一个并行工具 T0(结果在锚点之后、会被救回),补回行要落在救回行之后 ──
const T = [
  ct('旧名'), ai('旧AI名'), tg('旧标签'), // 0 1 2
  user('u1', null, '第一条', 1), // 3
  asst('a1', 'u1', 2), // 4
  user('u2', 'a1', '第二条', 3), // 5
  asst('a2a', 'u2', 4, toolUse('T0', '先看看')), // 6
  asst('a2b', 'a2a', 5, toolUse('T1', '再看看')), // 7 ← 锚点(裁 T1)
  ct('新名'), // 8 工具还在跑时改的名
  toolResult('r0', 'a2b', 'T0', 6), // 9 → 救回
  toolResult('r1', 'r0', 'T1', 7), // 10 → 随被裁工具一起丢
  ai('新AI名'), // 11
  asst('a3', 'r1', 8), // 12
  tg('新标签'), // 13
];
const T_RAW = toRaw(T);
const T_NEW = [T[8], T[11], T[13]];

try {
  const before = await titlesOf(A_RAW);

  await check('a0 裁判自检:夹具 A 原文读出的是新名 / 新AI名', async () => {
    assert.deepEqual(before, { customTitle: '新名', aiTitle: '新AI名' });
  });

  for (const [label, params] of [['trim(uuid)', { uuid: 'u2' }], ['trim(fromTimestamp)', { fromTimestamp: at(3) }]]) {
    await check(`a1 ${label}:截掉段里的新名 / 新AI名 / 新标签原样补回末尾,标题前后一致`, async () => {
      const r = applyHistoryOp('trim', A_RAW, params);
      assert.equal(r.ok, true);
      assertHeadTail(r.newContent, A.slice(0, A_CUT), A_NEW, label);
      assert.deepEqual(await titlesOf(r.newContent), before, `${label}: readSessionTitles 前后相同`);
      assert.equal(lastOf(r.newContent, 'tag', 'tag'), '新标签');
    });
  }

  await check('a2 trim-before-tool:补回行在救回的 tool_result 之后,标题前后一致', async () => {
    const pure = trimJsonlBeforeTool(T_RAW, 'T1');
    assert.equal(pure.found, true);
    assert.equal(pure.removedFromLine, 7);
    assert.deepEqual(pure.keptLines.slice(-T_NEW.length), T_NEW, '纯函数 keptLines 末尾是补回的标题行');
    const r = applyHistoryOp('trim-before-tool', T_RAW, { toolUseId: 'T1' });
    assert.equal(r.ok, true);
    const body = bodyOf(r.newContent);
    assert.deepEqual(body.slice(-T_NEW.length), T_NEW, '末尾是补回的标题行(逐字节、原顺序)');
    assert.deepEqual(body.slice(0, 7), T.slice(0, 7), '锚点之前原样保留');
    const anchor = JSON.parse(body[7]);
    assert.equal(anchor.uuid, 'a2b');
    assert.deepEqual(anchor.message.content, [{ type: 'text', text: '再看看' }], '锚点那条只留工具之前的块');
    const rescued = JSON.parse(body[8]);
    assert.equal(rescued.message.content[0].tool_use_id, 'T0', '紧跟锚点的是救回的 T0 结果');
    assert.equal(body.length, 9 + T_NEW.length, '没有多出别的行');
    assert.equal(r.compatibility, 'compatible');
    assert.deepEqual(await titlesOf(r.newContent), await titlesOf(T_RAW));
    assert.equal(lastOf(r.newContent, 'tag', 'tag'), '新标签');
  });

  await check('a3 compact-segment after:摘要之后是补回的标题行,标题前后一致', async () => {
    const r = applyHistoryOp('compact-segment', A_RAW, { uuid: 'u2', direction: 'after', model: '' }, { summary: SUMMARY });
    assert.equal(r.ok, true);
    const body = bodyOf(r.newContent);
    assert.deepEqual(body.slice(0, A_CUT), A.slice(0, A_CUT), '保留段原样');
    assert.equal(JSON.parse(body[A_CUT]).isCompactSummary, true, '保留段之后是摘要');
    assert.deepEqual(body.slice(A_CUT + 1), A_NEW, '摘要之后是补回的标题行(逐字节、原顺序)');
    assert.deepEqual(await titlesOf(r.newContent), before);
    assert.equal(lastOf(r.newContent, 'tag', 'tag'), '新标签');
  });

  await check('b compact after:顺序 [保留段…, 摘要, 标题行…],摘要仍是对话链叶子', async () => {
    const r = compactSegmentJsonl(A_RAW, 'u2', 'after', `摘要:${SUMMARY}`);
    assert.equal(r.ok, true);
    const objs = r.lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
    const summaryIdx = objs.findIndex((o) => o.isCompactSummary);
    assert.equal(summaryIdx, A_CUT, '摘要紧跟保留段');
    assert.deepEqual(r.lines.slice(A_CUT + 1), A_NEW, '摘要之后只有补回的标题行');
    // 叶子 = 最后一条带 uuid 的记录(标题行没有 uuid,不进对话链)
    const withUuid = objs.filter((o) => o.uuid);
    const byUuid = new Map(withUuid.map((o) => [o.uuid, o]));
    const chain = [];
    let cur = withUuid[withUuid.length - 1];
    while (cur) {
      chain.unshift(cur);
      if (cur.parentUuid == null) break;
      cur = byUuid.get(cur.parentUuid);
      assert.ok(cur, 'parentUuid 链断裂');
    }
    assert.deepEqual(chain.map((o) => o.uuid), ['u1', 'a1', r.summaryUuid], '链 = u1 → a1 → 摘要');
    assert.equal(chain[2].parentUuid, 'a1', '摘要挂在保留段最后一条消息下');
  });

  await check('c 两个会话编号:G 的「源名2」、本会话的「源名分支1」各取本组最后一条,按原顺序接回', async () => {
    const C = [
      ct('源名', G), // 0
      user('u1', null, '第一条', 1, G), // 1
      asst('a1', 'u1', 2, undefined, G), // 2
      user('u2', 'a1', '第二条', 3, G), // 3 ← 锚点
      asst('a2', 'u2', 4, undefined, G), // 4
      ct('中间名', S), // 5 同组(本会话)更早的一条,应被「源名分支1」取代
      ct('源名2', G), // 6
      ct('源名分支1', S), // 7
    ];
    const raw = toRaw(C);
    const r = applyHistoryOp('trim', raw, { uuid: 'u2' });
    assert.equal(r.ok, true);
    assertHeadTail(r.newContent, C.slice(0, 3), [C[6], C[7]], 'c');
    const t = await titlesOf(r.newContent);
    assert.equal(t.customTitle, '源名分支1');
    assert.deepEqual(t, await titlesOf(raw));
  });

  await check('d 清空:截掉段最后一条 custom-title 是空串 → 补回的是空串那条,读出为空', async () => {
    const D = [ct('旧名'), user('u1', null, '第一条', 1), asst('a1', 'u1', 2), user('u2', 'a1', '第二条', 3),
      asst('a2', 'u2', 4), ct('新名'), ct('')];
    const raw = toRaw(D);
    const r = applyHistoryOp('trim', raw, { uuid: 'u2' });
    assert.equal(r.ok, true);
    assertHeadTail(r.newContent, D.slice(0, 3), [D[6]], 'd');
    const t = await titlesOf(r.newContent);
    assert.equal(t.customTitle, '', '名字被清空,不是旧名');
    assert.deepEqual(t, await titlesOf(raw));
  });

  // ── 守卫(行为 10):这些行都不许被搬到末尾 ──
  const E_HEAD = [ct('旧名'), user('u1', null, '第一条', 1), asst('a1', 'u1', 2), user('u2', 'a1', '第二条', 3),
    asst('a2', 'u2', 4, toolUse('T1', '看一下')), toolResult('r1', 'a2', 'T1', 5)];
  const E_GUARDS = [
    user('g1', 'r1', '请把 "custom-title" 和 "tag" 改掉', 6), // 正文带引号的字样(JSON 里是转义的)
    user('g2', 'g1', 'custom-title 与 ai-title、tag 有什么区别', 7), // 正文不带引号的字样
    J({ type: 'last-prompt', lastPrompt: '第三条', leafUuid: 'g2', sessionId: S }),
    J({ type: 'custom-title', customTitle: '带锚点', leafUuid: 'g2', sessionId: S }),
    J({ type: 'ai-title', aiTitle: '带uuid', uuid: 'g9', sessionId: S }),
    J({ type: 'tag', tag: '带parent', parentUuid: 'g2', sessionId: S }),
    J({ type: 'tag', tag: '带after', afterUuid: 'g2', sessionId: S }),
    J({ type: 'custom-title', customTitle: 123, sessionId: S }),
    asst('g3', 'g2', 8, [{ type: 'tool_use', id: 'T9', name: 'Edit', input: { tag: 'v1', type: 'tag', 'custom-title': '假名' } }]),
    J({ type: 'user', uuid: 'g4', parentUuid: 'g3', timestamp: at(9), sessionId: S,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'T9', content: 'ok' }] },
      toolUseResult: { type: 'tag', tag: '结构化' } }),
    J(['custom-title', 'ai-title', 'tag']),
    J({ type: 'toString', toString: '原型上的名字', tag: 'x' }),
    J({ type: '__proto__', tag: 'x' }),
  ];
  const E_RAW = toRaw([...E_HEAD, ct('新名'), ...E_GUARDS]);
  for (const [label, op, params] of [
    ['trim(uuid)', 'trim', { uuid: 'u2' }],
    ['trim-before-tool', 'trim-before-tool', { toolUseId: 'T1' }],
    ['compact-segment after', 'compact-segment', { uuid: 'u2', direction: 'after', model: '' }],
  ]) {
    await check(`e ${label}:正文含字样的消息、last-prompt、带锚点字段 / 非字符串值 / 结构化 tag 的行都不搬`, async () => {
      const r = applyHistoryOp(op, E_RAW, params, { summary: SUMMARY });
      assert.equal(r.ok, true);
      const body = bodyOf(r.newContent);
      E_GUARDS.forEach((g, i) => assert.ok(!body.includes(g), `守卫行 #${i} 出现在结果里`));
    });
  }

  await check('f 回归:截掉段没有标题行 → trim 结果与原文截断点之前的部分逐字节相同(之前的标题不重复)', async () => {
    const F = [ct('旧名'), ai('旧AI名'), tg('旧标签'), user('u1', null, '第一条', 1), asst('a1', 'u1', 2),
      user('u2', 'a1', '第二条', 3), asst('a2', 'u2', 4),
      J({ type: 'last-prompt', lastPrompt: '第二条', leafUuid: 'a2', sessionId: S }),
      user('u3', 'a2', '第三条', 5), asst('a3', 'u3', 6)];
    const r = applyHistoryOp('trim', toRaw(F), { uuid: 'u2' });
    assert.equal(r.ok, true);
    assert.equal(r.newContent, `${F.slice(0, 5).join('\n')}\n`);
  });

  await check('g 重复补写:截掉段 50 条相同 custom-title → 只多 1 条;再往前回退一次仍只 1 条', async () => {
    const N = ct('新名');
    const Gx = [ct('旧名'), user('u1', null, '第一条', 1), asst('a1', 'u1', 2), user('u2', 'a1', '第二条', 3),
      asst('a2', 'u2', 4), user('u3', 'a2', '第三条', 5), ...Array(50).fill(N), asst('a3', 'u3', 6)];
    const r1 = applyHistoryOp('trim', toRaw(Gx), { uuid: 'u3' });
    assert.equal(r1.ok, true);
    assertHeadTail(r1.newContent, Gx.slice(0, 5), [N], 'g 第一次');
    const r2 = applyHistoryOp('trim', r1.newContent, { uuid: 'u2' });
    assert.equal(r2.ok, true);
    assertHeadTail(r2.newContent, Gx.slice(0, 3), [N], 'g 第二次');
    assert.equal((await titlesOf(r2.newContent)).customTitle, '新名');
  });

  await check('h 吸收收尾补写:补回的是追加段里那条 custom-title;last-prompt、mode 不在结果里', async () => {
    const base = [ct('旧名'), user('u1', null, '第一条', 1), asst('a1', 'u1', 2), user('u2', 'a1', '第二条', 3),
      asst('a2', 'u2', 4), ct('新名')];
    // 模拟命令行收尾补写:同值 custom-title(键顺序不同,逐字节可区分)、last-prompt、mode
    const tail = [J({ type: 'last-prompt', lastPrompt: '第二条', leafUuid: 'a2', sessionId: S }),
      J({ type: 'custom-title', sessionId: S, customTitle: '新名' }), MODE];
    const r = applyHistoryOp('trim', toRaw([...base, ...tail]), { uuid: 'u2' });
    assert.equal(r.ok, true);
    assertHeadTail(r.newContent, base.slice(0, 3), [tail[1]], 'h');
    const body = bodyOf(r.newContent);
    assert.ok(!body.includes(tail[0]), 'last-prompt 不搬');
    assert.ok(!body.includes(MODE), 'mode 不搬');
  });

  await check('i 行为 12:回退到第一条用户消息、截掉段有标题行 → requiresNewSession 为 true', async () => {
    const I = [ct('旧名'), user('u1', null, '第一条', 1), asst('a1', 'u1', 2), ct('新名'), tg('新标签')];
    const r = applyHistoryOp('trim', toRaw(I), { uuid: 'u1' });
    assert.equal(r.ok, true);
    assert.equal(r.requiresNewSession, true);
  });

  await check('j 行尾带 \\r 的标题行连 \\r 一起原样搬', async () => {
    const CR = [ct('旧名'), user('u1', null, '第一条', 1), asst('a1', 'u1', 2), user('u2', 'a1', '第二条', 3),
      asst('a2', 'u2', 4), ct('新名'), ai('新AI名')].map((l) => `${l}\r`);
    const raw = toRaw(CR);
    const r = applyHistoryOp('trim', raw, { uuid: 'u2' });
    assert.equal(r.ok, true);
    assertHeadTail(r.newContent, CR.slice(0, 3), [CR[5], CR[6]], 'j');
    assert.deepEqual(await titlesOf(r.newContent), await titlesOf(raw));
  });

  // ── k:全部历史操作逐个跑。以后新增历史操作,要加进 K_OPS(下面的覆盖检查会提醒)──
  const K = [
    ct('旧名'), ai('旧AI名'), tg('旧标签'), // 0 1 2
    user('u1', null, '第一条', 1), // 3
    asst('a1', 'u1', 2, [{ type: 'thinking', thinking: '想一想', signature: 'sig' }, { type: 'text', text: '好的' }]), // 4
    user('u2', 'a1', '第二条', 3), // 5 ← trim / compact 锚点
    asst('a2', 'u2', 4, toolUse('T1', '看一下')), // 6 ← trim-before-tool 锚点
    ct('新名'), // 7
    toolResult('r1', 'a2', 'T1', 5), // 8
    asst('a3', 'r1', 6), // 9
    ai('新AI名'), tg('新标签'), // 10 11
  ];
  const K_RAW = toRaw(K);
  const K_OPS = [
    ['trim(uuid)', 'trim', { uuid: 'u2' }],
    ['trim(fromTimestamp)', 'trim', { fromTimestamp: at(3) }],
    ['trim-before-tool', 'trim-before-tool', { toolUseId: 'T1' }],
    ['compact-segment before', 'compact-segment', { uuid: 'u2', direction: 'before', model: '' }],
    ['compact-segment after', 'compact-segment', { uuid: 'u2', direction: 'after', model: '' }],
    ['strip-thinking', 'strip-thinking', {}],
    ['repair-official-compat', 'repair-official-compat', {}],
  ];
  const kBefore = await titlesOf(K_RAW);
  await check('k0 K_OPS 覆盖了全部历史操作', async () => {
    for (const name of HISTORY_OP_NAMES) assert.ok(K_OPS.some(([, op]) => op === name), `K_OPS 缺 ${name}`);
  });
  for (const [label, op, params] of K_OPS) {
    await check(`k ${label}:前后标题与最后一条 tag 相同`, async () => {
      const r = applyHistoryOp(op, K_RAW, params, { summary: SUMMARY });
      assert.equal(r.ok, true, `${label} 在夹具 K 上应成功`);
      assert.deepEqual(await titlesOf(r.newContent), kBefore);
      assert.equal(lastOf(r.newContent, 'tag', 'tag'), '新标签');
    });
  }

  await check('l report 按截断下标:trim 的 removedFromLine / keptRecords / removedRecords 与同形夹具一致', async () => {
    const r = applyHistoryOp('trim', A_RAW, { uuid: 'u2' });
    const total = A_RAW.split('\n').length;
    assert.equal(r.report.removedFromLine, A_CUT);
    assert.equal(r.report.keptRecords, A_CUT);
    assert.equal(r.report.removedRecords, total - A_CUT);
    assert.deepEqual(r.affectedRange, { kind: 'lines', fromLine: A_CUT, toLine: total });
    const plain = A.map((l, i) => (A_NEW.includes(l) && i >= A_CUT ? MODE : l));
    const p = applyHistoryOp('trim', toRaw(plain), { uuid: 'u2' });
    assert.deepEqual(r.report, p.report, '与没有标题行的同形夹具相同');
    assert.deepEqual(r.affectedRange, p.affectedRange);
  });

  await check('l report 按截断下标:trim-before-tool 的 removedFromLine / totalLines / keptAssistantBlocks 与同形夹具一致', async () => {
    const r = applyHistoryOp('trim-before-tool', T_RAW, { toolUseId: 'T1' });
    const plain = T.map((l) => (T_NEW.includes(l) ? MODE : l));
    const p = applyHistoryOp('trim-before-tool', toRaw(plain), { toolUseId: 'T1' });
    assert.equal(r.report.removedFromLine, 7);
    assert.equal(r.report.totalLines, T_RAW.split('\n').length);
    assert.equal(r.report.keptAssistantBlocks, 1);
    assert.deepEqual(r.report, p.report, '与没有标题行的同形夹具相同');
    assert.deepEqual(r.affectedRange, p.affectedRange);
  });
} finally {
  rmdirSync(tmpRoot);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
