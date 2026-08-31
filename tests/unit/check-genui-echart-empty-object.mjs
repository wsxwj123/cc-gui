#!/usr/bin/env node
// r64:sanitizeEChartOption 的"空壳判定"必须区分两种空(上游缺陷,非 M8 引入):
//   ① 原本就空的对象/数组 —— `yAxis:{}` / `grid:{}` / `data:[]` 是合法且常见的
//      "用默认配置"写法,丢掉后 ECharts 抛 `yAxis "0" not found`、整图渲染失败;
//   ② 有内容但全被安全过滤 —— `{tooltip:{formatter:'<script>…'}}` 这类,必须照旧
//      整个丢弃,不给被拦内容留空壳(INTERFACE §5.5:危险字符串整条丢=键被跳过)。
// 上游原实现 `Object.keys(out).length > 0 ? out : undefined` 把两种空一起丢,①被误杀。
//
// 变异自证(逐条实跑过"改坏就红"):
//   A:对象分支退回上游 `Object.keys(out).length > 0 ? out : undefined` → 第 1 组红
//   B:数组分支退回上游 `arr.length > 0 ? arr : undefined`             → 第 2 组红
//   C:对象分支放宽成"永远保留 out"(空壳漏出)                        → 第 3 组红
import assert from 'node:assert/strict';

const { repairGenuiSpec } = await import('../../client/src/genui/upstream/guard.ts');

/** 单节点 spec 修复后取回该节点(被丢弃时返回 undefined)。 */
const one = (node) => repairGenuiSpec({ items: [node] })?.items?.[0];

// ── 1. 原本就空的对象保留(真机复现用例,2026-08-31)────────────────────────────
{
  const n = one({ type: 'echart', option: { xAxis: { data: ['a'] }, yAxis: {}, series: [{ type: 'bar', data: [1] }] } });
  assert.ok(n?.option, 'echart 节点与 option 都应存活');
  assert.deepEqual(n.option.yAxis, {}, 'yAxis:{} 是合法写法,必须原样保留');
  assert.deepEqual(n.option.xAxis, { data: ['a'] }, '同级正常键不受影响');
  assert.deepEqual(n.option.series, [{ type: 'bar', data: [1] }]);

  const m = one({ type: 'echart', option: { grid: {}, xAxis: {}, yAxis: {}, series: [{ type: 'bar', data: [1] }] } });
  assert.deepEqual(m.option.grid, {}, 'grid:{} 保留');
  assert.deepEqual(m.option.xAxis, {}, 'xAxis:{} 保留');
  assert.deepEqual(m.option.yAxis, {}, 'yAxis:{} 保留');
}

// ── 2. 原本就空的数组保留(数组分支同款缺陷)──────────────────────────────────
{
  const n = one({ type: 'echart', option: { xAxis: { data: [] }, yAxis: {}, series: [{ type: 'bar', data: [] }] } });
  assert.deepEqual(n.option.xAxis, { data: [] }, 'data:[] 是合法写法,必须保留');
  assert.deepEqual(n.option.series[0].data, [], 'series[].data:[] 保留');
}

// ── 3. 全被过滤的空壳仍整个丢弃(原有安全语义不放宽)──────────────────────────
{
  const n = one({ type: 'echart', option: { tooltip: { formatter: '<script>x</script>' }, series: [{ type: 'bar', data: [1] }] } });
  assert.ok(n?.option, '其余键存活,节点不整个消失');
  assert.equal(n.option.tooltip, undefined, '唯一键被过滤的 tooltip 整个丢弃,不留 {renderMode} 空壳');

  // 数组同款:唯一元素是外链 → 数组全被过滤 → 不留 [],其空壳父对象也一并丢弃。
  const m = one({ type: 'echart', option: { xAxis: { data: ['https://attacker/x'] }, series: [{ type: 'bar', data: [1] }] } });
  assert.equal(m.option.xAxis, undefined, '全元素被过滤的数组不留空壳,连带空壳父对象丢弃');
}

// ── 4. 正常图表整体不受影响(防"什么都拒也全绿")─────────────────────────────
{
  const option = {
    tooltip: { trigger: 'axis' },
    legend: { data: ['A'] },
    xAxis: { type: 'category', data: ['一', '二'] },
    yAxis: { type: 'value' },
    series: [{ name: 'A', type: 'line', data: [1, 2] }],
  };
  const n = one({ type: 'echart', option });
  assert.deepEqual(
    n.option,
    { ...option, tooltip: { trigger: 'axis', renderMode: 'richText' } },
    '正常 option 原样通过(仅 tooltip.renderMode 按契约强制 richText)',
  );
}

console.log('✅ check-genui-echart-empty-object:yAxis:{}/data:[] 保留 + 全被过滤的空壳仍丢弃 + 正常图表不受影响,全部通过');
