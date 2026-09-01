#!/usr/bin/env node
// r67b:数据驱动节点的「空壳存活」必须整节点丢弃,不许渲染成误导性的空框。
//
// 真机症状(用户 2026-09-01):让模型画 CCK8 柱状图,模型按 ECharts 习惯写成
// `categories + series:[{name,data:[数字]}]`。守卫剥掉全部未知字段后,节点以
// `{type:'chart',data:[],series:[]}` **空壳存活**,渲染出来是一张只有网格线、
// 没有柱子的空框 —— 零信息**且误导**(看着像"数据真的全是 0")。
// table(只剩表头)、list(空留白)同理。
//
// 契约依据:INTERFACE §5.2「整个 items 里没有一个合法组件 ⟹ 不得渲染成空块」。
// 整块级成立的道理在节点级同样成立;丢弃走既有丢弃路径,自动计入「已忽略」灰字
// (§9.1:块本身渲染成功且有节点被丢弃时显示)。
//
// 口径说明(r67b 查账结论):ignored 计数**任何层级**一视同仁 —— 顶层与嵌套都计。
// 「顶层丢弃看不到灰字」的观感来自另一条契约:一个节点都没活下来(kept=0)时整块
// 退回原始代码块,灰字没有承载它的地方,ignored 恒 0(§5.2 末行 / §9.1)。所以
// 下面凡是断言计数的用例都留一个幸存兄弟,否则测的是退回分支不是计数。
//
// 变异自证(逐条实跑过"改坏就红"):
//   A:删掉 chart 的 `points === 0` 判定(退回 `data === undefined && series === undefined`)
//      → 第 1 组红(ECharts 风格 chart 空壳存活)
//   B:删掉 table 的 `rows.length === 0` 判定                → 第 2 组红
//   C:删掉 list 的 `items.length === 0` 判定                → 第 3 组红
//   D:chart 判据从"总数据点为 0"放宽成"两个数组都空"
//      → 第 1 组「只剩图例的 series」那条红
//   E:合法数据也一起丢(判定写反)                            → 第 4 组红(防"全拒也全绿")
import assert from 'node:assert/strict';

const { parseSpec } = await import('../../client/src/genui/contract.mjs');

/** 幸存兄弟:保证块本身渲染成功,ignored 才有承载它的地方(见上文口径说明)。 */
const KEEP = { type: 'text', content: 'KEEP' };
/** 解析一份 spec(节点 + 幸存兄弟),返回 { types, ignored }。 */
const withKeep = (node) => {
  const r = parseSpec(JSON.stringify({ items: [node, KEEP] }));
  assert.equal(r.ok, true, '有幸存兄弟时块必须渲染,而不是退回代码块');
  return { types: r.root.items.map((x) => x.type), ignored: r.ignored };
};
/** 单节点 spec:活下来返回该节点,被丢弃时整块退回代码块 ⟹ 返回 null。 */
const one = (node) => {
  const r = parseSpec(JSON.stringify({ items: [node] }));
  return r.ok && r.root.items.length ? r.root.items[0] : null;
};

// ── 1. chart:修复后一个数据点都不剩 ⟹ 丢弃 ──────────────────────────────────
{
  // 用户实锤原样用例:ECharts 风格 categories + series[{name,data:[数字]}]。
  // `categories` 不是白名单字段被剥掉;series[].`name` 不是 `label`、data 也不是
  // {label,value} 对象数组 ⟹ repairSeries 整条丢 ⟹ 修复后 data:[] series:[]。
  const echartsStyle = {
    type: 'chart',
    kind: 'bars',
    xLabel: '阿霉素浓度 (μM)',
    yLabel: '细胞存活率 (%)',
    categories: ['0 (Con)', '0.01', '0.1', '0.5', '1', '2', '5', '10'],
    series: [{ name: '4T1 细胞存活率', data: [100, 96.2, 82.4, 61.3, 43.7, 28.5, 15.2, 7.8], color: '#C0392B' }],
  };
  const r = withKeep(echartsStyle);
  assert.deepEqual(r.types, ['text'], 'ECharts 风格 chart 必须整个丢弃,不留空框');
  assert.equal(r.ignored, 1, '丢弃计入「已忽略」灰字');

  // 显式空:原文就写 data:[] / series:[] —— 与"修复后变空"同样处理(空即无信息)。
  assert.deepEqual(withKeep({ type: 'chart', data: [] }).types, ['text'], 'data:[] 丢弃');
  assert.deepEqual(withKeep({ type: 'chart', data: [], series: [] }).types, ['text'], 'data 与 series 双空丢弃');

  // 数据点全非法(缺 value / 缺 label)⟹ 修复后归零 ⟹ 丢弃。
  assert.deepEqual(
    withKeep({ type: 'chart', data: [{ label: 'a' }, { value: 1 }, 'x', null] }).types,
    ['text'],
    '数据点全非法 ⟹ 丢弃',
  );

  // 判据是"总数据点为 0"不是"两个数组都空":只剩图例的 series 一根柱子也画不出。
  assert.deepEqual(
    withKeep({ type: 'chart', series: [{ label: 'A', data: [] }, { label: 'B', data: [] }] }).types,
    ['text'],
    'series 有条目但一个数据点都没有 ⟹ 同样是空壳,丢弃',
  );
}

// ── 2. table:rows 修复后为空 ⟹ 丢弃(孤儿表头零信息)──────────────────────────
{
  assert.deepEqual(withKeep({ type: 'table', columns: ['c1', 'c2'], rows: [] }).types, ['text'], 'rows:[] 丢弃');
  const r = withKeep({ type: 'table', columns: ['浓度', '存活率'], rows: ['不是二维数组', 42, null] });
  assert.deepEqual(r.types, ['text'], 'rows 元素全非法(非数组)⟹ 修复后为空 ⟹ 丢弃');
  assert.equal(r.ignored, 1, '丢弃计入「已忽略」灰字');
  // 每行的单元格全非法(对象/undefined 都不是 string|number)⟹ 行被丢光。
  assert.deepEqual(
    withKeep({ type: 'table', columns: ['c'], rows: [[{ a: 1 }], [[]]] }).types,
    ['text'],
    '单元格全非法 ⟹ 行全丢 ⟹ 节点丢弃',
  );
}

// ── 3. list:items 修复后为空 ⟹ 丢弃 ─────────────────────────────────────────
{
  assert.deepEqual(withKeep({ type: 'list', items: [] }).types, ['text'], 'items:[] 丢弃');
  const r = withKeep({ type: 'list', items: [1, 2, true, null] });
  assert.deepEqual(r.types, ['text'], 'items 全非法(数字/布尔/null)⟹ 修复后为空 ⟹ 丢弃');
  assert.equal(r.ignored, 1, '丢弃计入「已忽略」灰字');
  // 带类型的子节点全被丢弃时,list 自己也成空壳 ⟹ 一并丢弃(子节点各自也已计数)。
  const nested = withKeep({ type: 'list', items: [{ type: 'zzz' }, { type: 'yyy' }] });
  assert.deepEqual(nested.types, ['text'], '子节点全丢 ⟹ list 空壳一并丢弃');
  assert.equal(nested.ignored, 3, '2 个未知子节点 + list 自己 = 3');
}

// ── 4. 合法数据照常存活(防"判定写反/什么都拒也全绿")────────────────────────
{
  const chart = one({ type: 'chart', kind: 'bars', data: [{ label: '0', value: 100 }, { label: '1', value: 43.7 }] });
  assert.equal(chart?.type, 'chart', '正确写法 data:[{label,value}] 的 chart 必须存活');
  assert.equal(chart.data.length, 2, '数据点不丢');

  const grouped = one({ type: 'chart', series: [{ label: 'A', data: [{ label: 'x', value: 1 }] }] });
  assert.equal(grouped?.type, 'chart', 'series-only(分组柱)照常存活');
  assert.equal(grouped.series[0].data.length, 1);

  const table = one({ type: 'table', columns: ['DOX浓度 (μM)', '存活率 (%)'], rows: [['0（对照）', '100.0'], ['1', '43.7']] });
  assert.equal(table?.type, 'table', '带 rows 的 table 必须存活');
  assert.equal(table.rows.length, 2);

  const list = one({ type: 'list', items: ['a', { title: 't', desc: 'd' }] });
  assert.equal(list?.type, 'list', '带合法 items 的 list 必须存活');
  assert.equal(list.items.length, 2);

  // 一份全合法的 spec 不得产生任何「已忽略」。
  const clean = parseSpec(JSON.stringify({ items: [chart, table, list, KEEP] }));
  assert.equal(clean.ok, true);
  assert.equal(clean.ignored, 0, '全合法 spec 不得出现灰字');
}

console.log('✅ check-genui-empty-husk:chart/table/list 空壳丢弃 + 计入已忽略 + 合法数据存活,全部通过');
