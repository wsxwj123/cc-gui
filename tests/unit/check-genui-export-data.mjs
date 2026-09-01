#!/usr/bin/env node
// r69:genui 图表导出的**纯数据层**(client/src/genui/host/export-data.js)。
//
// 锁四件事:
//   ① CSV 转义 —— 逗号/引号/换行/首尾空格必须加引号,引号内部翻倍。错一个字符,
//      Excel 打开就是错位的表(一格裂成两格 / 半行跑到下一行)。
//   ② BOM + CRLF —— 没 BOM 的 UTF-8 CSV 在 Excel 里中文全乱码,这是"导出了但没法用"。
//   ③ 公式注入 —— 单元格文本是模型输出,`=`/`+`/`@` 开头的格子 Excel 当公式执行;
//      同时 `-5` 这种负数不能被误伤(它是正常数据)。
//   ④ 分组序列取值口径 —— 必须与 charts.tsx 的渲染口径一致(标签取第一条序列,
//      各序列按同一下标取值),否则导出的表和屏幕上的图对不上。
//
// 变异哨兵(改坏实现 → 本测必红):
//   A. csvCell 去掉引号包裹(`return s` 直接返回) → ①③ 相关断言全红。
//   B. rowsToCsv 去掉 '\uFEFF'(BOM)前缀 → ② 红。
//   C. nodeTable 分组分支改成按各序列自己的 label 列拼 → ④ 红。
//   D. JSON_FIELDS 换成"整个节点原样 JSON.stringify" → 内部键泄漏那条红。
// Run: node tests/unit/check-genui-export-data.mjs
import assert from 'node:assert/strict';
import {
  buildCopyText, buildCsv, exportFileBase, exportFileName, exportPlan, isExportable, nodeTable, rowsToCsv,
} from '../../client/src/genui/host/export-data.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL -', name, '::', e.message); } };

/* ---------------- ① CSV 转义 ---------------- */

const body = (csv) => csv.replace(/^\uFEFF/, '');

for (const [input, expected, why] of [
  ['ab', 'ab', '普通文本不加引号'],
  ['a,b', '"a,b"', '逗号必须加引号'],
  ['a"b', '"a""b"', '引号翻倍并加引号'],
  ['a\nb', '"a\nb"', '换行必须加引号'],
  ['a\r\nb', '"a\r\nb"', 'CRLF 必须加引号'],
  [' a', '" a"', '前导空格必须加引号(否则被 Excel 吃掉)'],
  ['a ', '"a "', '尾随空格必须加引号'],
  [42, '42', '数字原样'],
  [-3.5, '-3.5', '负数原样,不被公式防护误伤'],
  [0, '0', '零不能变空'],
  [null, '', 'null → 空'],
  [undefined, '', 'undefined → 空'],
  [NaN, '', '非有限数 → 空'],
]) {
  t(`CSV 转义 ${JSON.stringify(input)} → ${expected}`, () => {
    assert.equal(body(rowsToCsv([[input]])).replace(/\r\n$/, ''), expected, why);
  });
}

/* ---------------- ② BOM + CRLF ---------------- */

t('CSV 以 UTF-8 BOM 开头(Excel 中文不乱码)', () => {
  assert.ok(rowsToCsv([['甲']]).startsWith('\uFEFF'), '缺 BOM');
});
t('CSV 行分隔是 CRLF', () => {
  assert.equal(body(rowsToCsv([['a'], ['b']])), 'a\r\nb\r\n');
});

/* ---------------- ③ 公式注入 ---------------- */

for (const [cell, why] of [
  ['=1+1', '等号开头'],
  ['+1+1', '加号开头'],
  ['@SUM(A1)', '@ 开头'],
  ['\tcmd', '制表符开头'],
  ['-1+cmd|\' /C calc\'!A0', '减号开头但整体不是数字'],
]) {
  t(`公式注入被中和:${JSON.stringify(cell)}`, () => {
    const out = body(rowsToCsv([[cell]]));
    assert.ok(/^'|^"'/.test(out), `期望被加前导单引号,实得 ${JSON.stringify(out)}`);
  });
}
for (const cell of ['-5', '-0.25', '-1e3']) {
  t(`负数不被公式防护误伤:${cell}`, () => {
    assert.equal(body(rowsToCsv([[cell]])).replace(/\r\n$/, ''), cell);
  });
}

/* ---------------- ④ 分组序列取值口径 ---------------- */

const grouped = {
  type: 'chart',
  series: [
    { label: '甲', data: [{ label: '一月', value: 1 }, { label: '二月', value: 2 }] },
    // 第二条序列故意错位:它只有一个点、且 label 是「二月」。渲染器是**严格按下标**
    // 取值的(charts.tsx:`const d = s.data[i]`),所以屏幕上这个 3 画在「一月」那一组里。
    // 导出必须跟着按下标对齐 —— 改成按 label 找(看起来更"聪明")会让 CSV 与图对不上。
    { label: '乙', data: [{ label: '二月', value: 3 }] },
  ],
};
t('分组序列:表头=标签列 + 各序列名', () => {
  assert.deepEqual(nodeTable(grouped)[0], ['标签', '甲', '乙']);
});
t('分组序列:标签取第一条序列,各序列按同一下标取值', () => {
  assert.deepEqual(nodeTable(grouped).slice(1), [['一月', 1, 3], ['二月', 2, undefined]]);
});
t('分组序列:缺的格子导成空,不导成 0(0 是伪造的数据)', () => {
  assert.equal(body(buildCsv(grouped)), '标签,甲,乙\r\n一月,1,3\r\n二月,2,\r\n');
});
t('单序列 chart:两列表头', () => {
  assert.deepEqual(nodeTable({ type: 'chart', data: [{ label: 'a', value: 1 }] }), [['标签', '值'], ['a', 1]]);
});
t('table:按 columns 长度截齐,缺格补空', () => {
  assert.deepEqual(
    nodeTable({ type: 'table', columns: ['A', 'B'], rows: [[1], [2, 3, 4]] }),
    [['A', 'B'], [1, undefined], [2, 3]],
  );
});
t('空数据 chart 无表格语义', () => {
  assert.equal(nodeTable({ type: 'chart', data: [] }), null);
});
t('只给 option 的 echart 无表格语义(结构任意,不猜)', () => {
  assert.equal(nodeTable({ type: 'echart', option: { series: [{ type: 'bar', data: [1, 2] }] } }), null);
});
t('preset echart 与 chart 同口径', () => {
  assert.deepEqual(nodeTable({ type: 'echart', preset: 'bar', data: [{ label: 'a', value: 1 }] }), [['标签', '值'], ['a', 1]]);
});

/* ---------------- JSON:字段白名单 ---------------- */

t('JSON 只含规格字段,渲染期挂上的内部键进不来', () => {
  const json = JSON.parse(buildCopyText({
    type: 'chart', kind: 'donut', data: [{ label: 'a', value: 1 }],
    __stateKey: 'g:sid:123', _internal: { sessionId: 'S-1' }, action: 'submit',
  }));
  assert.deepEqual(Object.keys(json).sort(), ['data', 'kind', 'type']);
});
t('JSON 不含会话/队列信息(导出物只有该节点的数据)', () => {
  const text = buildCopyText({ type: 'table', columns: ['A'], rows: [[1]], queueKey: 'proj::sid' });
  assert.ok(!text.includes('queueKey') && !text.includes('sid'), text);
});
t('mermaid 复制的是图源码不是 JSON', () => {
  assert.equal(buildCopyText({ type: 'mermaid', code: 'graph TD;A-->B' }), 'graph TD;A-->B');
});
t('diagram 的 JSON 带 nodes/edges', () => {
  const json = JSON.parse(buildCopyText({ type: 'diagram', kind: 'flow', nodes: [{ id: 'a', label: 'A' }], edges: [] }));
  assert.deepEqual(Object.keys(json).sort(), ['edges', 'kind', 'nodes', 'type']);
});

/* ---------------- 文件名 ---------------- */

for (const [title, expected, why] of [
  ['季度营收', '季度营收', '正常标题原样'],
  ['a/b\\c:d*e?f"g<h>i|j', 'a b c d e f g h i j', '路径与 Windows 保留字符清成空格'],
  ['../../etc/passwd', 'etc passwd', '路径穿透片段被清掉'],
  ['.hidden', 'hidden', '前导点掐掉,不导成隐藏文件'],
  ['   ', '图表', '全空白回落类型默认名'],
  ['', '图表', '无标题回落类型默认名'],
]) {
  t(`文件名清洗 ${JSON.stringify(title)} → ${expected}`, () => {
    assert.equal(exportFileBase({ type: 'chart', title }), expected, why);
  });
}
t('文件名清洗掉控制字符', () => {
  assert.equal(exportFileBase({ type: 'chart', title: 'a\u0000b\u001fc' }), 'a b c');
});
t('文件名带时间戳与扩展名', () => {
  assert.equal(exportFileName({ type: 'table' }, 'csv', new Date(2026, 8, 1, 9, 5, 3)), '表格-20260901-090503.csv');
});
t('无标题的类型各有默认名', () => {
  assert.equal(exportFileBase({ type: 'plot' }), '函数图');
  assert.equal(exportFileBase({ type: 'mermaid' }), '图示');
});

/* ---------------- 按钮清单(取舍固化) ---------------- */

for (const [node, expected, why] of [
  [{ type: 'chart', data: [{ label: 'a', value: 1 }] }, { copyLabel: '复制数据', csv: true, png: true }, 'chart 三样全有'],
  [{ type: 'echart', preset: 'bar', data: [{ label: 'a', value: 1 }] }, { copyLabel: '复制数据', csv: true, png: true }, 'preset echart 三样全有'],
  [{ type: 'echart', option: {} }, { copyLabel: '复制数据', csv: false, png: true }, 'option echart 无 CSV'],
  [{ type: 'table', columns: ['A'], rows: [] }, { copyLabel: '复制数据', csv: true, png: false }, 'table 无 PNG'],
  [{ type: 'plot', series: [{ expr: 'x' }] }, { copyLabel: '复制数据', csv: false, png: true }, 'plot 无 CSV(滑块实时值取不到)'],
  [{ type: 'mermaid', code: 'graph TD;A-->B' }, { copyLabel: '复制源码', csv: false, png: true }, 'mermaid 复制源码 + PNG'],
  [{ type: 'diagram', kind: 'flow', nodes: [] }, { copyLabel: '复制数据', csv: false, png: true }, 'diagram 复制 JSON + PNG'],
]) {
  t(`按钮清单 ${node.type}:${why}`, () => assert.deepEqual(exportPlan(node), expected));
}

// 反向:不可导出的类型一律没有工具条(尤其 scene3d —— WebGL 画布未开
// preserveDrawingBuffer,读回必是空白图,给按钮就是骗人)。
for (const type of ['text', 'badge', 'button', 'card', 'row', 'col', 'grid', 'list', 'stat',
  'input', 'select', 'submit', 'quiz', 'code', 'json', 'diff', 'keyvalue', 'timeline',
  'callout', 'steps', 'tabs', 'copy', 'scene3d', 'file-tree', 'progress', 'divider']) {
  t(`${type} 不出导出工具条`, () => {
    assert.equal(isExportable({ type }), false);
    assert.equal(exportPlan({ type }), null);
  });
}
t('未知类型不出工具条', () => assert.equal(isExportable({ type: 'not-a-real-type' }), false));
t('空/畸形节点不崩', () => {
  assert.equal(isExportable(null), false);
  assert.equal(isExportable(undefined), false);
  assert.equal(buildCsv({ type: 'chart' }), null);
});

console.log(`\n[check-genui-export-data] pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);
