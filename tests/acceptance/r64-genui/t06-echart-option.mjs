#!/usr/bin/env node
// r64-genui【安全重点 / 错误路径】§5.5 echart full option 净化。
// 场景:full option 模式等于把 ECharts 的原生配置交给模型写。ECharts 有一堆能拉远程图片、
// 能渲染 HTML(tooltip renderMode:'html')、能让标题变成链接的字段。这些都得在进引擎前砍掉。
// 契约注明:"过滤函数"在 JSON 通道恒真、测不出东西,真正要断言的是下面这些字符串怎么处理。
// Run: node tests/acceptance/r64-genui/t06-echart-option.mjs
import assert from 'node:assert/strict';
import { genui } from './lib.mjs';
import { node, nodeR, t, done } from './lib.mjs';

await genui(); // 未实现时整个文件只报一次"缺少交付物",而不是每条用例各报一遍

const opt = (option, extra = {}) => node({ type: 'echart', option, ...extra });
/** 收集树里所有字符串值,用来断言"某个危险串一个都不剩"。 */
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}
function anyFunction(v) {
  if (typeof v === 'function') return true;
  if (Array.isArray(v)) return v.some(anyFunction);
  if (v && typeof v === 'object') return Object.values(v).some(anyFunction);
  return false;
}

await t('正常路径:普通柱状图 option 完整保留', async () => {
  const o = { xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] };
  const n = await opt(o);
  assert.ok(n, 'echart 节点不该被丢弃');
  assert.deepEqual(n.option.xAxis.data, ['a', 'b']);
  assert.deepEqual(n.option.series[0].data, [1, 2]);
});

await t('tooltip.renderMode:"html" 被强制改回 richText(顶层)', async () => {
  const n = await opt({ tooltip: { renderMode: 'html' }, series: [{ type: 'bar', data: [1] }] });
  assert.equal(n.option.tooltip.renderMode, 'richText');
});

await t('tooltip.renderMode:"html" 被强制改回 richText(series 内)', async () => {
  const n = await opt({ series: [{ type: 'bar', data: [1], tooltip: { renderMode: 'html' } }] });
  assert.equal(n.option.series[0].tooltip.renderMode, 'richText');
});

await t('tooltip.renderMode:"html" 被强制改回 richText(baseOption / media 内)', async () => {
  const n = await opt({
    baseOption: { tooltip: { renderMode: 'html' } },
    media: [{ query: { maxWidth: 500 }, option: { tooltip: { renderMode: 'html' } } }],
  });
  assert.equal(n.option.baseOption.tooltip.renderMode, 'richText');
  assert.equal(n.option.media[0].option.tooltip.renderMode, 'richText');
});

const DANGER = [
  ['<script 标签', '<script>alert(1)</script>'],
  ['<ScRiPt 大小写变形', '<ScRiPt>alert(1)</ScRiPt>'],
  ['<img 标签', '<img src=x onerror=alert(1)>'],
  ['<iframe 标签', '<iframe src=x></iframe>'],
  ['<svg 标签', '<svg onload=alert(1)>'],
  ['on...= 事件属性', '<b onclick=alert(1)>x</b>'],
  ['javascript: 协议', 'javascript:alert(1)'],
  ['url() 函数', 'url(https://evil.com/x.png)'],
  ['URL( 大写变形', 'URL(https://evil.com/x.png)'],
  ['http:// 开头', 'http://evil.com/x.png'],
  ['https:// 开头', 'https://evil.com/x.png'],
  ['协议相对 //', '//evil.com/x.png'],
  ['image:// 开头', 'image://https://evil.com/x.png'],
];
for (const [why, s] of DANGER) {
  await t('危险字符串整条丢弃(' + why + ')', async () => {
    const n = await opt({ title: { text: s, subtext: 'SAFE' }, series: [{ type: 'bar', data: [1] }] });
    assert.ok(n, 'echart 节点不该整个消失(只丢那一条键)');
    const all = strings(n.option);
    assert.ok(!all.includes(s), '危险字符串仍留在 option 里:' + JSON.stringify(all.filter((x) => x === s)));
    assert.ok(all.includes('SAFE'), '同层的安全字段不该被牵连');
  });
}

await t('远程图片的三种典型写法都被丢弃(图表不加载任何外部图片)', async () => {
  const n = await opt({
    series: [{ type: 'scatter', data: [[1, 2]], symbol: 'image://http://evil.com/x.png' }],
    graphic: [{ type: 'image', style: { image: 'https://evil.com/y.png' } }],
    backgroundColor: { image: 'https://evil.com/z.png' },
  });
  assert.ok(n);
  const all = strings(n.option).join('|');
  assert.ok(!all.includes('evil.com'), 'option 里仍有远程图片地址:' + all);
});

await t('危险字符串藏在深层数组里同样被丢', async () => {
  const n = await opt({ series: [{ type: 'bar', data: [1], markLine: { data: [{ name: '<script>x</script>', xAxis: 1 }] } }] });
  assert.ok(n);
  assert.ok(!strings(n.option).some((s) => s.includes('<script')), '深层的危险串漏网了');
});

await t('title.link / title.sublink 整键删除(即使值是同源相对路径)', async () => {
  const n = await opt({ title: { text: 'T', link: '/a', sublink: '/b', target: 'blank' } });
  assert.ok(n);
  assert.equal(n.option.title.text, 'T', '标题文字本身要保留');
  assert.ok(!('link' in n.option.title), 'title.link 必须整键删除');
  assert.ok(!('sublink' in n.option.title), 'title.sublink 必须整键删除');
});

await t('函数体字符串不被求值:结果里任何位置都没有 function', async () => {
  const body = 'function(p){return p.value}';
  const n = await opt({ tooltip: { formatter: body }, series: [{ type: 'bar', data: [1] }] });
  assert.ok(n);
  assert.equal(anyFunction(n.option), false, 'option 里出现了真函数 = 有代码通道');
  const f = n.option.tooltip && n.option.tooltip.formatter;
  if (f !== undefined) assert.equal(typeof f, 'string', 'formatter 应当作普通字符串对待');
});

const VOID = [
  ['嵌套深度 > 10', (() => { let o = { v: 1 }; for (let i = 0; i < 14; i++) o = { nest: o }; return o; })()],
  ['任一数组长度 > 500', { series: [{ type: 'bar', data: Array.from({ length: 900 }, (_, i) => i) }] }],
  ['总遍历条目 > 2000', { series: Array.from({ length: 60 }, () => ({ type: 'bar', data: Array.from({ length: 60 }, (_, i) => i) })) }],
];
for (const [why, option] of VOID) {
  await t('option 整体作废(' + why + '):不卡页面,节点回退或不渲染', async () => {
    const t0 = Date.now();
    const { n } = await nodeR({ type: 'echart', option });
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, '超预算的 option 不该被完整遍历,耗时 ' + ms + 'ms');
    assert.ok(!n || n.option === undefined || n.option === null,
      'option 应整体作废(回退 preset 或不渲染),实际仍带着 option');
  });
}

await t('option 与 preset/data 同时给出时 option 优先', async () => {
  const n = await opt({ series: [{ type: 'line', data: [7, 8] }] }, { preset: 'bar', data: [{ label: 'a', value: 1 }] });
  assert.ok(n);
  assert.ok(n.option, 'option 模式应生效');
  assert.deepEqual(n.option.series[0].data, [7, 8]);
});

await t('option 不是对象(字符串/数组/数字)→ 作废,不崩', async () => {
  for (const option of ['{"a":1}', [1, 2, 3], 42, true]) {
    const { n } = await nodeR({ type: 'echart', option, data: [{ label: 'a', value: 1 }] });
    assert.ok(!n || !n.option, 'option=' + JSON.stringify(option).slice(0, 20) + ' 应作废');
  }
});

await t('【安全】option 里的 __proto__ 不污染 Object.prototype', async () => {
  await opt(JSON.parse('{"__proto__":{"cguiEchartPolluted":1},"series":[]}'));
  assert.equal({}.cguiEchartPolluted, undefined, 'Object.prototype 被污染了');
});

await t('【反向】净化后的 option 必须能被 JSON 序列化(不含循环引用/函数/undefined 键)', async () => {
  const n = await opt({ title: { text: 'T' }, series: [{ type: 'bar', data: [1, 2] }] });
  assert.doesNotThrow(() => JSON.stringify(n.option));
});

done('t06 echart option 净化');
