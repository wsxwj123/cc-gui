#!/usr/bin/env node
// r141 渲染期身份闸门(client/src/utils/turnIdentity.js)的单测 —— 直接 import 真实实现,不复刻逻辑。
//
// 为什么要有它:这个模块是「同一条回复不再画两遍」的**唯一判据来源**(渲染闸门 A5 与去重键 A2
// 共用),但它此前一条单测都没有(裁判 grep turnIdentity tests/ = 空)。验收用例只覆盖"端到端红/绿",
// 覆盖不到三层判据的真值表与边界 —— 实现被改坏(比如把 ② 的 strip 换成折叠空白、把 ③ 的上界删掉、
// 把 ① 的 srcUuids 分支短路)时,端到端用例可能照样绿。
//
// 负向对照(证明这份单测抓得住改坏):
//   把实现改坏后,用同一个脚本指向变异模块跑,必须非零退出:
//     R141_TURN_IDENTITY_MODULE=/abs/path/to/mutated/turnIdentity.js node tests/unit/check-r141-turn-identity.mjs
//   (默认走 ../../client/src/utils/turnIdentity.js = 被测实现)
//
// 覆盖:① 三层判据各自的真值表;② blocksText 的"逐块拼 + 去空白"两侧同口径;③ 边界(空 blocks /
// 缺 timestamp / blocks 非数组 / srcUuids 非数组或为空 / 缺 roundStartTs);④ 判据③ 的时间窗上界
// 与下界、TAKEOVER_TS_EPS_MS 的语义;⑤ "空窗守门"(更晚更长的一轮不得把唯一可见的副本藏掉)。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = process.env.R141_TURN_IDENTITY_MODULE
  || path.join(HERE, '..', '..', 'client', 'src', 'utils', 'turnIdentity.js');
const { blocksText, turnFingerprint, makeTurnIdentityIndex, localTurnTakenOver, TAKEOVER_TS_EPS_MS } =
  await import(MODULE_PATH);

const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);          // 回合起点
const iso = (ms) => new Date(ms).toISOString();
let n = 0;
const ok = (label) => { n += 1; console.log(`  ✓ ${label}`); };

// ── A. blocksText / turnFingerprint 的口径 ────────────────────────────────────────
{
  assert.equal(blocksText({ blocks: [{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }] }), 'ab',
    'blocksText 必须【逐块直接拼接、不插分隔符】—— 这正是它与历史侧(逐条 push + \'\' join)同形的前提');
  ok('blocksText 逐块拼接不插分隔符');

  assert.equal(blocksText({ blocks: [{ type: 'thinking', content: 'x' }, { type: 'text', content: 'a' },
    { type: 'tool_use', toolCall: {} }, { type: 'text', content: 'b' }] }), 'ab',
  'blocksText 只取 type===\'text\' 的块');
  ok('blocksText 忽略 thinking / tool_use 块');

  assert.equal(blocksText({ blocks: [], text: ['t1', 't2'] }), 't1t2',
    'blocks 为空数组时必须退化到 text(与 msgTextOf 同口径)');
  ok('blocks 为空数组 → 退化 text');

  assert.equal(blocksText({ blocks: null, text: ['t1', 't2'] }), 't1t2', 'blocks 非数组时必须退化 text');
  assert.equal(blocksText({ blocks: 'not-an-array', text: 'plain' }), 'plain', 'blocks 非数组 + text 为字符串 → 退化 text');
  assert.equal(blocksText({ blocks: [{ type: 'thinking', content: 'x' }], text: ['fallback'] }), 'fallback',
    'blocks 全是非 text 块(拼接结果为空)→ 必须退化 text');
  assert.equal(blocksText({}), '', '什么都没有 → 空串(不许抛)');
  assert.equal(blocksText(null), '', 'null → 空串(不许抛)');
  ok('blocks 非数组 / 无非 text 块 / 空对象 / null 全部安全退化');

  // ② 的前提:两侧拼接方式不同(\n 拼 vs '' join),去空白后必须相等
  const local = { blocks: [{ type: 'text', content: 'c1' }, { type: 'text', content: 'c2' }, { type: 'text', content: 'c3' }],
    text: ['c1\nc2\nc3'] };
  const hist = { blocks: [{ type: 'text', content: 'c1' }, { type: 'text', content: 'c2' }, { type: 'text', content: 'c3' }],
    text: ['c1', 'c2', 'c3'] };
  assert.equal(turnFingerprint(local), turnFingerprint(hist),
    '本地(\\n 拼)与历史(\'\' join)的指纹必须相等 —— 判据② 成立的前提');
  assert.equal(turnFingerprint(local), 'c1c2c3', '指纹 = 逐块拼接后去掉全部空白');
  ok('判据② 前提:两侧拼接方式不同但指纹相等');

  // 反例:若把"去空白"换成"折叠空白",两侧不再相等 —— 锁死实现必须用 strip 而不是 fold
  const fold = (s) => s.replace(/\s+/g, ' ').trim();
  assert.notEqual(fold(local.text.join('')), fold(hist.text.join('')),
    '对 text 折叠空白(方案 v1 的错口径)两侧不等("c1 c2 c3" vs "c1c2c3")⇒ 实现必须用 blocksText + strip');
  assert.equal(turnFingerprint({ text: ['a\u3000b\u00a0c'] }), 'abc', '全角空格/不换行空格也属于 \\s,必须一起去掉');
  assert.equal(turnFingerprint({ blocks: [{ type: 'text', content: '' }], text: [''] }), '', '空正文 → 空指纹');
  ok('去空白口径(含全角/不换行空格)+ 空正文 → 空指纹');
}

// ── B. makeTurnIdentityIndex ───────────────────────────────────────────────────
{
  const msgs = [
    { type: 'user', uuid: 'u1', text: ['hi'], timestamp: iso(T0) },
    { type: 'turn', uuid: 't1', text: ['a'], blocks: [{ type: 'text', content: 'a' }], timestamp: iso(T0 + 100) },
    { type: 'btw', uuid: 'b1', text: ['x'], timestamp: iso(T0 + 200) },
    { type: 'turn', uuid: 't2', text: [''], blocks: [], timestamp: iso(T0 + 300) },          // 空指纹
    { type: 'turn', uuid: 't3', text: ['c'], blocks: [{ type: 'text', content: 'c' }] },      // 缺 timestamp
    { type: 'turn', uuid: 't4', text: ['d'], blocks: [{ type: 'text', content: 'd' }], timestamp: 'not-a-date' },
  ];
  const idx = makeTurnIdentityIndex(msgs);
  assert.deepEqual([...idx.turnUuids].sort(), ['t1', 't2', 't3', 't4'], '只收 type===\'turn\' 的 uuid(user/btw 不许进)');
  assert.deepEqual([...idx.fingerprints].sort(), ['a', 'c', 'd'], '空指纹的 turn 不许进指纹集(否则空正文会两两相等)');
  assert.deepEqual(idx.turns.map((t) => t.len), [1],
    '判据③ 候选只收"指纹非空 **且** timestamp 可解析"的 turn(t2 空指纹、t3 缺 ts、t4 坏 ts 全被剔)');
  assert.deepEqual(makeTurnIdentityIndex(null).turnUuids.size, 0, '传 null 不许抛');
  assert.deepEqual(makeTurnIdentityIndex(undefined).turns, [], '传 undefined 不许抛');
  ok('makeTurnIdentityIndex:只收 turn、剔空指纹、剔坏时间戳、null/undefined 安全');
}

// ── C. localTurnTakenOver 三层判据真值表 ────────────────────────────────────────
{
  const histTurn = { type: 'turn', uuid: 'H1', text: ['abc'], blocks: [{ type: 'text', content: 'abc' }], timestamp: iso(T0 + 500) };
  const idx = makeTurnIdentityIndex([histTurn]);
  // base 的正文刻意取【比历史更长且不同】⇒ ②③ 必然不命中,好让 ① 的每条断言都只考 ①
  const base = { type: 'turn', uuid: 'chat-assistant-1', text: ['zzzzzzzz'], blocks: [{ type: 'text', content: 'zzzzzzzz' }],
    timestamp: iso(T0 + 900), roundStartTs: T0 };

  // ① 命中:srcUuids 与历史 uuid 有交集(正文完全不同、时间也不在窗内也一样命中 —— 这就是 ① 的独立性)
  assert.equal(localTurnTakenOver({ ...base, srcUuids: ['X', 'H1'] }, idx), true,
    '判据①:srcUuids ∩ 历史 uuid ≠ ∅ 必须命中(不受正文/时间影响)');
  assert.equal(localTurnTakenOver({ ...base, srcUuids: ['H1'] }, idx), true, '①:单元素交集也命中');
  assert.equal(localTurnTakenOver({ ...base, srcUuids: ['X', 'Y'] }, idx), false, '①:无交集不命中');
  assert.equal(localTurnTakenOver({ ...base, srcUuids: [] }, idx), false, '①:srcUuids 为空数组 = 无数据,不命中');
  assert.equal(localTurnTakenOver({ ...base, srcUuids: 'H1' }, idx), false, '①:srcUuids 非数组 = 无数据,不许当字符串遍历');
  assert.equal(localTurnTakenOver({ ...base, srcUuids: [null, undefined, ''] }, idx), false, '①:集合里只有空值不命中');
  assert.equal(localTurnTakenOver({ ...base, srcUuids: [] , uuid: 'H1' }, idx), false,
    '①:实现要求 srcUuids 非空才走这条 —— 空 srcUuids 时 local.uuid 命中也不认(锁住现状)');
  assert.equal(localTurnTakenOver({ ...base, srcUuids: ['x'], uuid: 'H1' }, idx), true,
    '①:srcUuids 非空时,local.uuid ∈ turnUuids 也算命中');
  ok('判据① 真值表(交集/无交集/空数组/非数组/含空值/local.uuid 分支)');

  // ② 命中:指纹相同
  assert.equal(localTurnTakenOver({ ...base, blocks: [{ type: 'text', content: 'a\nb c' }], text: ['abc'] }, idx), true,
    '判据②:指纹相同(空白差异被抹平)必须命中');
  assert.equal(localTurnTakenOver({ ...base, blocks: [{ type: 'text', content: 'abdz' }] }, idx), false,
    '②:指纹不同不命中(正文比历史长 ⇒ ③ 也不命中,这条只考 ②)');
  assert.equal(localTurnTakenOver({ ...base, blocks: [], text: [''] }, idx), false,
    '②:本地指纹为空 ⇒ 实现**直接 return false**(不进 ③)—— 锁住这条短路');
  ok('判据② 真值表(相同/不同/空指纹短路)');

  // ③ 命中:时间窗内 + 历史不短于本地
  const longTurn = { type: 'turn', uuid: 'H2', text: ['abcdef'], blocks: [{ type: 'text', content: 'abcdef' }], timestamp: iso(T0 + 600) };
  const idx2 = makeTurnIdentityIndex([histTurn, longTurn]);
  assert.equal(localTurnTakenOver({ ...base, blocks: [{ type: 'text', content: 'abcd' }] }, idx2), true,
    '判据③:窗内存在不短于本地的历史 turn 必须命中');
  assert.equal(localTurnTakenOver({ ...base, blocks: [{ type: 'text', content: 'abcdefgh' }] }, idx2), false,
    '③:历史那份更短时不命中(覆盖下限)');
  assert.equal(localTurnTakenOver({ ...base, roundStartTs: T0 + 700, blocks: [{ type: 'text', content: 'abcd' }] }, idx2), false,
    '③:历史 ts 早于 roundStartTs(下界)不命中');
  assert.equal(localTurnTakenOver({ ...base, roundStartTs: T0 + 600, blocks: [{ type: 'text', content: 'abcd' }] }, idx2), true,
    '③:历史 ts == roundStartTs 边界上必须命中(闭区间)');
  ok('判据③ 真值表(覆盖下限 / 时间窗下界)');

  // ③ 的上界:更晚、更长的一轮不得把唯一可见的副本藏掉(= 空窗守门)
  const localTs = T0 + 900;
  const laterTurn = { type: 'turn', uuid: 'H3', text: ['abcdefghij'], blocks: [{ type: 'text', content: 'abcdefghij' }],
    timestamp: iso(localTs + TAKEOVER_TS_EPS_MS + 1) };
  const idx3 = makeTurnIdentityIndex([laterTurn]);
  assert.equal(localTurnTakenOver({ ...base, blocks: [{ type: 'text', content: 'ab' }] }, idx3), false,
    '③ 上界:历史 ts 晚于 local.ts + ε(更晚的一轮)绝不许命中 —— 否则会把唯一可见的副本藏掉 = 空窗');
  const edgeTurn = { ...laterTurn, timestamp: iso(localTs + TAKEOVER_TS_EPS_MS) };
  assert.equal(localTurnTakenOver({ ...base, blocks: [{ type: 'text', content: 'ab' }] }, makeTurnIdentityIndex([edgeTurn])), true,
    '③ 上界:ts == local.ts + ε 边界上命中(闭区间)');
  assert.equal(TAKEOVER_TS_EPS_MS, 2000, 'TAKEOVER_TS_EPS_MS 的语义:副本在流收尾时才推,历史 ts 是消息产生时刻 ⇒ 留 2s 余量');
  ok('判据③ 上界(ε 闭区间)+ TAKEOVER_TS_EPS_MS 语义');

  // ③ 缺锚点:不许命中(少了时间锚就没法排除"更晚更长的一轮")
  assert.equal(localTurnTakenOver({ ...base, roundStartTs: undefined, blocks: [{ type: 'text', content: 'abcd' }] }, idx2), false,
    '③:缺 roundStartTs 时不参与(否则旧条目会被误藏)');
  assert.equal(localTurnTakenOver({ ...base, roundStartTs: 'nope', blocks: [{ type: 'text', content: 'abcd' }] }, idx2), false,
    '③:roundStartTs 非有限数时不参与');
  assert.equal(localTurnTakenOver({ ...base, timestamp: undefined, blocks: [{ type: 'text', content: 'abcd' }] }, idx2), false,
    '③:缺 local.timestamp 时不参与');
  ok('判据③ 缺锚点(uuid 无数据 / 时间锚缺失)一律不命中');

  // 只管 turn:别的类型一律 false(A2 的 user 强口径与 btw/compact 语义不许被碰)
  for (const t of ['user', 'btw', 'compact', 'denial', 'mode-mismatch', 'goal']) {
    assert.equal(localTurnTakenOver({ ...base, type: t, srcUuids: ['H1'] }, idx), false, `类型 ${t} 必须恒 false`);
  }
  assert.equal(localTurnTakenOver(null, idx), false, 'null 条目 → false');
  assert.equal(localTurnTakenOver({ ...base, srcUuids: ['H1'] }, null), false, '索引为 null → false(不许抛)');
  assert.equal(localTurnTakenOver({ ...base, srcUuids: ['H1'] }, undefined), false, '索引为 undefined → false');
  ok('只作用于 turn;null/缺索引安全');
}

// ── D. 现场形态回归(把"双画为什么发生 / 修法怎么治"编码成断言)────────────────────
{
  const uuid = '3e737fd8-1489-41da-84f1-c5700445a980';
  const roundStart = T0;
  const localTs = T0 + 1500;
  // 本地定稿副本:App.jsx :6793 推的那条(\n 拼正文 + 三块 + 过程块 + srcUuids/roundStartTs)
  const copy = {
    type: 'turn', uuid: 'chat-assistant-1790868147077', timestamp: iso(localTs),
    text: ['c1\nc2\nc3'], blocks: [{ type: 'text', content: 'c1' }, { type: 'thinking', content: 'th' },
      { type: 'text', content: 'c2' }, { type: 'text', content: 'c3' }],
    thinking: ['th'], toolCalls: [], srcUuids: [uuid], roundStartTs: roundStart,
  };
  // 历史孪生:session-reader 逐条 push 进 text、blocks 逐块;uuid 与流侧一致
  const twin = {
    type: 'turn', uuid, timestamp: iso(T0 + 1000), text: ['c1', 'c2', 'c3'],
    blocks: [{ type: 'text', content: 'c1' }, { type: 'text', content: 'c2' }, { type: 'text', content: 'c3' }],
  };
  const idx = makeTurnIdentityIndex([twin]);
  assert.equal(localTurnTakenOver(copy, idx), true, '现场形态:副本必须被历史孪生接管(① uuid 精确对账命中)');
  const { srcUuids, ...copyNoUuid } = copy;                    // 修法前的形态:没有身份字段
  assert.equal(turnFingerprint(copyNoUuid), turnFingerprint(twin),
    '即使没有身份字段,② 也认得出同一回合(逐块拼 + 去空白)—— 这是本修法的主治路径');
  assert.equal(localTurnTakenOver({ ...copyNoUuid, roundStartTs: roundStart }, idx), true,
    '② 单独也能命中(不依赖 uuid):证明拆掉 ① 时该场景仍会被治 —— 所以"①-exclusive 用例"必须另外构造');
  ok('现场形态:副本被接管(①/② 各自都能命中)');

  // 反向:历史里没有孪生时(流式期半成品 / 尚未落盘),副本【不许】被藏 = R68/R37 空窗守门
  assert.equal(localTurnTakenOver(copy, makeTurnIdentityIndex([])), false,
    '历史为空 ⇒ 副本必须留着(R68/R37 空窗守门:闸门只做减法,不许提前动手)');
  assert.equal(localTurnTakenOver(copy, makeTurnIdentityIndex([{ ...twin, uuid: 'other', blocks: [{ type: 'text', content: '完全不同' }], text: ['完全不同'] }])), false,
    '历史那份是别的内容(且 uuid 不交、窗口内也不更长)⇒ 不藏');
  ok('空窗守门:没有孪生时副本必须留在屏上');
}

console.log(`✅ check-r141-turn-identity: ${n} 组断言全部通过(模块=${path.relative(process.cwd(), MODULE_PATH)})`);
