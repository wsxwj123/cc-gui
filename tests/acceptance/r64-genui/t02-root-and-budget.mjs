#!/usr/bin/env node
// r64-genui【正常路径 + 边界】§1.2 根对象 / §1.3 资源预算 / §5.3 超预算裁剪。
// 场景:模型写出的 spec 可能巨大、可能深不见底。契约要求"裁掉超出部分照常渲染,不报错",
// 既不能崩,也不能因为超一点点就整块拒渲染(那等于用户白等)。
// Run: node tests/acceptance/r64-genui/t02-root-and-budget.mjs
import assert from 'node:assert/strict';
import { genui } from './lib.mjs';
import { parse, node, countNodes, nest, hasText, t, done } from './lib.mjs';

await genui(); // 未实现时整个文件只报一次"缺少交付物",而不是每条用例各报一遍

const rep = (n, s = 'x') => s.repeat(n);

// ── 根对象 ───────────────────────────────────────────────────────────────
await t('根对象:title / gap / items 原样生效', async () => {
  const r = await parse({ title: '面板', gap: 14, items: [{ type: 'text', content: 'a' }] });
  assert.equal(r.ok, true);
  assert.equal(r.root.title, '面板');
  assert.equal(r.root.gap, 14);
  assert.equal(r.root.items.length, 1);
});

await t('根对象:gap 缺省为 16', async () => {
  const r = await parse({ items: [{ type: 'text', content: 'a' }] });
  assert.equal(r.root.gap, 16, 'gap 缺省值按 §1.2 应为 16');
});

await t('根对象:title 缺省时不存在(不得凭空造标题)', async () => {
  const r = await parse({ items: [{ type: 'text', content: 'a' }] });
  assert.ok(r.root.title === undefined || r.root.title === null || r.root.title === '',
    '实际 title=' + JSON.stringify(r.root.title));
});

await t('根对象:title 超 2000 字符被截断到 2000', async () => {
  const r = await parse({ title: rep(3000), items: [{ type: 'text', content: 'a' }] });
  assert.equal(r.ok, true);
  assert.equal(r.root.title.length, 2000);
  assert.equal(r.notice, null, '截断不报错(§5.3)');
});

await t('裸单组件根:{"type":"text","content":"hi"} 等价于 items:[该组件]', async () => {
  const r = await parse({ type: 'text', content: 'hi' });
  assert.equal(r.ok, true, '裸单组件是合法写法(§1.2)');
  assert.equal(r.root.items.length, 1);
  assert.equal(r.root.items[0].type, 'text');
  assert.equal(r.root.items[0].content, 'hi');
});

await t('panel:true 的围栏首版按普通围栏就地渲染,不报错', async () => {
  const r = await parse({ panel: true, append: true, items: [{ type: 'text', content: 'a' }] });
  assert.equal(r.ok, true, 'panel/append 首版不支持但必须"不报错"(§1.2)');
  assert.equal(r.notice, null, '不得因 panel 字段弹说明条');
  assert.equal(r.root.items.length, 1);
});

await t('gap 为非数字时退回缺省 16,不整块拒渲染', async () => {
  const r = await parse({ gap: 'big', items: [{ type: 'text', content: 'a' }] });
  assert.equal(r.ok, true, '选填字段非法只降级,不牵连整块(§2 表头)');
  assert.equal(r.root.gap, 16);
});

// ── 嵌套深度 ─────────────────────────────────────────────────────────────
await t('嵌套 6 层(远在限内):最内层内容照常渲染', async () => {
  const r = await parse({ items: [nest(6)] });
  assert.equal(r.ok, true);
  assert.ok(hasText(r.root, 'LEAF'), '限内的深层内容不该被吞');
});

await t('嵌套 12 层(远超限):超深子树被丢弃,但祖先照常渲染、不报错', async () => {
  const r = await parse({ items: [nest(12), { type: 'text', content: 'SIBLING' }] });
  assert.equal(r.ok, true, '超深不得导致整块拒渲染');
  assert.ok(!hasText(r.root, 'LEAF'), '第 12 层的内容必须被丢弃(§1.3 深度上限 8)');
  assert.ok(hasText(r.root, 'SIBLING'), '兄弟节点不受牵连(§5 总原则③)');
  assert.equal(r.notice, null, '超预算裁剪不报错(§5.3)');
});

await t('嵌套深度边界:第 8 层保留、第 9 层丢弃', async () => {
  const in8 = await parse({ items: [nest(8)] });
  assert.ok(hasText(in8.root, 'LEAF'), '第 8 层应在限内(上限=8)');
  const in9 = await parse({ items: [nest(9)] });
  assert.ok(!hasText(in9.root, 'LEAF'), '第 9 层应被丢弃');
});

// ── 节点总数 ─────────────────────────────────────────────────────────────
await t('全树 300 个节点:裁到 200 以内,保留的是前缀,不报错', async () => {
  const kids = Array.from({ length: 300 }, (_, i) => ({ type: 'text', content: 'n' + i }));
  const r = await parse({ items: [{ type: 'col', items: kids }] });
  assert.equal(r.ok, true);
  const total = countNodes(r.root.items);
  assert.ok(total <= 200, `全树节点数应 ≤200,实际 ${total}`);
  assert.ok(total >= 100, `不能因为超限就几乎什么都不渲染,实际只剩 ${total}`);
  assert.equal(r.root.items[0].items[0].content, 'n0', '保留的应是靠前的兄弟节点');
  assert.equal(r.notice, null);
});

await t('恰好 1 个节点 / 恰好 items:[] 两个极端不崩', async () => {
  const one = await parse({ items: [{ type: 'text', content: 'a' }] });
  assert.equal(one.ok, true);
  const zero = await parse({ items: [] });
  assert.equal(zero.ok, false, 'items 为空 = 没有一个合法组件,应保留原始代码块(§5.2)');
  assert.equal(zero.notice, null, '此时不显示红条,也不显示"N 个已忽略"灰字');
});

// ── 字符串长度 ───────────────────────────────────────────────────────────
await t('普通字符串字段超 2000 被截断(text.content)', async () => {
  const n = await node({ type: 'text', content: rep(5000) });
  assert.ok(n, 'text 节点不该被丢弃');
  assert.equal(n.content.length, 2000);
});

await t('code 节点代码体上限 12000(不是 2000)', async () => {
  const n = await node({ type: 'code', code: rep(20000), lang: 'js' });
  assert.ok(n, 'code 节点不该被丢弃');
  assert.equal(n.code.length, 12000);
});

await t('mermaid 源码上限 8000', async () => {
  const n = await node({ type: 'mermaid', code: 'flowchart TD\n' + rep(20000) });
  assert.ok(n, 'mermaid 节点不该被丢弃');
  assert.equal(n.code.length, 8000);
});

await t('copy.text 上限 4000', async () => {
  const n = await node({ type: 'copy', text: rep(9000) });
  assert.ok(n);
  assert.equal(n.text.length, 4000);
});

await t('icon 上限 64', async () => {
  const n = await node({ type: 'button', label: 'B', action: 'go', icon: rep(500) });
  assert.ok(n, 'icon 过长只截断,不丢节点');
  assert.equal(n.icon.length, 64);
});

await t('截断按字符计:2000 个中文字符全保留、5000 个截到 2000', async () => {
  const ok2000 = await node({ type: 'text', content: '中'.repeat(2000) });
  assert.equal(ok2000.content.length, 2000, '恰好 2000 不该被砍');
  const cut = await node({ type: 'text', content: '中'.repeat(5000) });
  assert.equal(cut.content.length, 2000);
});

await t('截断不得切出半个 emoji(残缺代理对会让界面显示乱码方块)', async () => {
  const n = await node({ type: 'text', content: '😀'.repeat(3000) });
  assert.ok(n && typeof n.content === 'string');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(n.content), '结尾留下了孤立的高位代理');
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(n.content), '开头留下了孤立的低位代理');
});

// ── 数值夹取(§5.3)────────────────────────────────────────────────────────
const clampCases = [
  ['progress.value=999 夹到 100', { type: 'progress', label: 'P', value: 999 }, (n) => n.value, 100],
  ['progress.value=-5 夹到 0', { type: 'progress', label: 'P', value: -5 }, (n) => n.value, 0],
  ['grid.cols=99 夹到 12', { type: 'grid', items: [{ type: 'text', content: 'a' }], cols: 99 }, (n) => n.cols, 12],
  ['grid.cols=0 夹到 1', { type: 'grid', items: [{ type: 'text', content: 'a' }], cols: 0 }, (n) => n.cols, 1],
  ['grid.cols=-3 夹到 1', { type: 'grid', items: [{ type: 'text', content: 'a' }], cols: -3 }, (n) => n.cols, 1],
  ['scene3d.ambient=5 夹到 2', { type: 'scene3d', meshes: [{ shape: 'box' }], ambient: 5 }, (n) => n.ambient, 2],
  ['scene3d.ambient=-1 夹到 0', { type: 'scene3d', meshes: [{ shape: 'box' }], ambient: -1 }, (n) => n.ambient, 0],
];
for (const [name, spec, pick, want] of clampCases) {
  await t('夹取:' + name, async () => {
    const n = await node(spec);
    assert.ok(n, '越界数值只夹取,不该丢节点');
    assert.equal(pick(n), want);
  });
}

await t('夹取:scene3d 坐标 1e12 夹到 ±1e6,且树里不出现 NaN/Infinity', async () => {
  const n = await node({ type: 'scene3d', meshes: [{ shape: 'box', position: [1e12, -1e12, 0], scale: Infinity }] });
  assert.ok(n, 'scene3d 不该被丢');
  const nums = [];
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') return Object.values(v).forEach(walk);
    if (typeof v === 'number') nums.push(v);
  })(n);
  for (const v of nums) {
    assert.ok(Number.isFinite(v), '出现了非有限数:' + v);
    assert.ok(Math.abs(v) <= 1e6, '坐标未夹取到 ±1e6,实际 ' + v);
  }
});

await t('必填字段类型不对(progress.value="abc")→ 该节点被丢弃并计数', async () => {
  const r = await parse({ items: [{ type: 'progress', label: 'P', value: 'abc' }, { type: 'text', content: 'KEEP' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.root.items.map((x) => x.type), ['text'], '坏节点应消失,兄弟保留');
  assert.equal(r.ignored, 1, '被丢的节点要计入"已忽略"计数');
});

// ── 列表类上限(§5.3):一律截取到上限后渲染,不报错 ─────────────────────────
const arr = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const CAPS = [
  ['list 项 ≤50', { type: 'list', items: arr(80, (i) => 'i' + i) }, (n) => n.items.length, 50],
  ['table 行 ≤50', { type: 'table', columns: ['c'], rows: arr(60, () => ['1']) }, (n) => n.rows.length, 50],
  ['table 列 ≤12', { type: 'table', columns: arr(20, (i) => 'c' + i), rows: [arr(20, () => 'v')] }, (n) => n.columns.length, 12],
  ['keyvalue ≤24 对', { type: 'keyvalue', pairs: arr(40, (i) => ({ key: 'k' + i, value: 'v' })) }, (n) => n.pairs.length, 24],
  ['timeline ≤24 项', { type: 'timeline', items: arr(40, (i) => ({ title: 't' + i })) }, (n) => n.items.length, 24],
  ['steps ≤24 项', { type: 'steps', steps: arr(40, (i) => ({ title: 's' + i })) }, (n) => n.steps.length, 24],
  ['breadcrumb ≤12 项', { type: 'breadcrumb', items: arr(30, (i) => 'b' + i) }, (n) => n.items.length, 12],
  ['chart 每序列 ≤60 点', { type: 'chart', data: arr(100, (i) => ({ label: 'l' + i, value: i })) }, (n) => n.data.length, 60],
  ['plot ≤8 序列', { type: 'plot', series: arr(12, () => ({ expr: 'x' })) }, (n) => n.series.length, 8],
  ['select ≤50 项', { type: 'select', options: arr(80, (i) => 'o' + i) }, (n) => n.options.length, 50],
  ['radio ≤50 项', { type: 'radio', options: arr(80, (i) => 'o' + i) }, (n) => n.options.length, 50],
  ['quiz ≤8 选项', { type: 'quiz', question: 'q', options: arr(12, (i) => ({ label: 'o' + i })) }, (n) => n.options.length, 8],
  ['tabs ≤12 个', { type: 'tabs', tabs: arr(20, (i) => ({ label: 't' + i, items: [] })) }, (n) => n.tabs.length, 12],
  ['accordion ≤24 个', { type: 'accordion', items: arr(40, (i) => ({ title: 'a' + i, items: [] })) }, (n) => n.items.length, 24],
  ['scene3d ≤5 个 mesh', { type: 'scene3d', meshes: arr(8, () => ({ shape: 'box' })) }, (n) => n.meshes.length, 5],
  ['diagram ≤9 节点', { type: 'diagram', kind: 'architecture', nodes: arr(12, (i) => ({ label: 'n' + i, type: 'focal' })) }, (n) => n.nodes.length, 9],
];
for (const [name, spec, pick, cap] of CAPS) {
  await t('上限:' + name, async () => {
    const r = await parse({ items: [spec] });
    assert.equal(r.ok, true, '超上限只截取,不整块拒渲染');
    const n = r.root.items[0];
    assert.ok(n, '节点不该被丢弃(超上限≠非法)');
    assert.equal(pick(n), cap);
    assert.equal(r.notice, null, '截取不报错(§5.3)');
  });
}

await t('上限:diagram ≤12 边', async () => {
  const n = await node({
    type: 'diagram', kind: 'architecture',
    nodes: arr(4, (i) => ({ label: 'n' + i, type: 'focal' })),
    edges: arr(20, () => ({ from: 'n0', to: 'n1', kind: 'solid' })),
  });
  assert.ok(n);
  assert.equal(n.edges.length, 12);
});

await t('上限:table 每一行也被截到 12 列(不能只截表头)', async () => {
  const n = await node({ type: 'table', columns: arr(20, (i) => 'c' + i), rows: arr(3, () => arr(20, () => 'v')) });
  assert.ok(n);
  for (const row of n.rows) assert.equal(row.length, 12, '行宽必须与截断后的表头一致,否则错位');
});

await t('上限:一个围栏里 3 个 scene3d 只保留 2 个(防 WebGL 上下文耗尽)', async () => {
  const s = { type: 'scene3d', meshes: [{ shape: 'box' }] };
  const r = await parse({ items: [s, s, s, { type: 'text', content: 'KEEP' }] });
  assert.equal(r.ok, true);
  assert.equal(r.root.items.filter((x) => x.type === 'scene3d').length, 2);
  assert.ok(r.root.items.some((x) => x.type === 'text'), '其它组件不受影响');
});

await t('上限:file-tree 嵌套 ≤6 层,更深的被丢但上层照常', async () => {
  let deep = { name: 'leaf.txt', type: 'file' };
  for (let i = 0; i < 9; i++) deep = { name: 'd' + i, type: 'dir', children: [deep] };
  const n = await node({ type: 'file-tree', items: [deep] });
  assert.ok(n, 'file-tree 过深不该整体丢弃');
  assert.ok(!hasText(n, 'leaf.txt'), '第 10 层内容应被丢弃');
});

done('t02 根对象与预算');
