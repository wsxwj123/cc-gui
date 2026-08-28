#!/usr/bin/env node
// r64-genui【安全重点 + 正常路径】§2.8 plot 数学表达式。
// 场景:表达式由模型写。如果实现偷懒用 eval / new Function,这里就是一条直通的代码执行通道。
// 契约:只认 x、单个小写字母参数、18 个函数、3 个常量、+ - * / ^ ( ) 和逗号;别的一律无效,
// 无效时"该条曲线不绘制",其余曲线和整个组件照常渲染。
// Run: node tests/acceptance/r64-genui/t07-plot-expr.mjs
import assert from 'node:assert/strict';
import { genui, parse, node, t, done } from './lib.mjs';

const { evalPlotExpr } = await genui();
const near = (got, want, why) => {
  assert.equal(typeof got, 'number', (why || '') + ' 应返回数字,实际 ' + JSON.stringify(got));
  assert.ok(Math.abs(got - want) < 1e-9, (why || '') + ' 期望 ' + want + ',实际 ' + got);
};

// ── 正常求值 ─────────────────────────────────────────────────────────────
const MATH = [
  ['变量 x', 'x', { x: 3 }, 3],
  ['四则运算', '1+2*3-4/2', {}, 5],
  ['括号优先级', '(1+2)*3', {}, 9],
  ['乘方 ^', '2^10', {}, 1024],
  ['一元负号', '-x', { x: 4 }, -4],
  ['小数', '0.5*x', { x: 4 }, 2],
  ['sin', 'sin(pi/2)', {}, 1],
  ['cos', 'cos(0)', {}, 1],
  ['tan', 'tan(0)', {}, 0],
  ['asin', 'asin(1)', {}, Math.PI / 2],
  ['acos', 'acos(1)', {}, 0],
  ['atan', 'atan(1)', {}, Math.PI / 4],
  ['sqrt', 'sqrt(16)', {}, 4],
  ['cbrt', 'cbrt(27)', {}, 3],
  ['exp', 'exp(0)', {}, 1],
  ['ln', 'ln(e)', {}, 1],
  ['abs', 'abs(0-3)', {}, 3],
  ['floor', 'floor(1.7)', {}, 1],
  ['ceil', 'ceil(1.2)', {}, 2],
  ['round', 'round(1.5)', {}, 2],
  ['min 两参', 'min(1,2)', {}, 1],
  ['max 两参', 'max(1,2)', {}, 2],
  ['pow 两参', 'pow(2,10)', {}, 1024],
  ['常量 pi', 'pi', {}, Math.PI],
  ['常量 e', 'e', {}, Math.E],
  ['常量 tau', 'tau', {}, Math.PI * 2],
  ['参数代入', 'a*x', { x: 2, a: 3 }, 6],
  ['未声明的参数取 1', 'a*x', { x: 5 }, 5],
  ['嵌套函数', 'sin(cos(0))', {}, Math.sin(1)],
  ['空格不影响', '  1 +  2 ', {}, 3],
];
for (const [why, expr, params, want] of MATH) {
  await t('求值:' + why + '  ' + expr, () => near(evalPlotExpr(expr, params), want, expr));
}

await t('求值:log 有定义(底数未在契约中钉死,只断言不是无效表达式)', () => {
  const v = evalPlotExpr('log(100)', {});
  assert.equal(typeof v, 'number', 'log 属于 18 个允许函数之一,不该被判为非法');
  assert.ok(Number.isFinite(v));
});

// ── 非法表达式:一律返回 null,且不得抛 ────────────────────────────────────
const BAD = [
  ['属性访问 a.b', 'a.b'],
  ['方括号取值', 'a[0]'],
  ['赋值', 'x=1'],
  ['分号串联', 'x; 1'],
  ['逗号在函数外', '1,2'],
  ['未知标识符 window', 'window'],
  ['未知标识符 constructor', 'constructor'],
  ['未知标识符 this', 'this'],
  ['未知标识符 globalThis', 'globalThis'],
  ['未知标识符 process', 'process'],
  ['未知函数 alert', 'alert(1)'],
  ['未知函数 eval', 'eval("1")'],
  ['未知函数 require', 'require("fs")'],
  ['未知函数 fetch', 'fetch("http://x")'],
  ['import 表达式', 'import("x")'],
  ['立即执行函数', '(function(){return 1})()'],
  ['箭头函数', '(()=>1)()'],
  ['模板串', '`${x}`'],
  ['字符串字面量', '"abc"'],
  ['大写函数名 SIN', 'SIN(1)'],
  ['多字母参数 ab', 'ab*2'],
  ['括号不配对', '((1+2)'],
  ['只有运算符', '+*/'],
  ['空表达式', ''],
  ['纯空白', '   '],
  ['中文', '正弦(x)'],
  ['注释', '1 /* x */ + 2'],
  ['位运算', 'x|1'],
  ['逻辑运算', 'x&&1'],
  ['取模', 'x%2'],
];
for (const [why, expr] of BAD) {
  await t('非法表达式返回 null 且不抛:' + why, () => {
    let v;
    assert.doesNotThrow(() => { v = evalPlotExpr(expr, { x: 1 }); }, 'evalPlotExpr 抛异常了:' + expr);
    assert.equal(v, null, JSON.stringify(expr) + ' 应判为非法(返回 null),实际 ' + JSON.stringify(v));
  });
}

await t('【安全】表达式绝不可能改到全局变量(证明没走 eval / 动态函数构造)', () => {
  globalThis.__cguiPwned = 0;
  const attacks = [
    'globalThis.__cguiPwned=1',
    '(globalThis.__cguiPwned=1)',
    'x)+(globalThis.__cguiPwned=1',
    'constructor.constructor("globalThis.__cguiPwned=1")()',
    'sin(x)+[].constructor.constructor("globalThis.__cguiPwned=1")()',
  ];
  for (const a of attacks) {
    let v; assert.doesNotThrow(() => { v = evalPlotExpr(a, { x: 1 }); }, '抛异常:' + a);
    assert.equal(v, null, '应判为非法:' + a);
  }
  assert.equal(globalThis.__cguiPwned, 0, '表达式执行到了真实代码 = 有 eval / new Function 通道');
  delete globalThis.__cguiPwned;
});

await t('【健壮性】非字符串表达式返回 null,不抛', () => {
  for (const v of [null, undefined, 42, {}, [], true]) {
    let out; assert.doesNotThrow(() => { out = evalPlotExpr(v, {}); }, 'evalPlotExpr(' + String(v) + ') 抛了');
    assert.equal(out, null);
  }
});

await t('【健壮性】超长表达式不卡死(2 万字符,1 秒内返回)', () => {
  const t0 = Date.now();
  const v = evalPlotExpr('1+'.repeat(10000) + '1', { x: 1 });
  assert.ok(Date.now() - t0 < 1000, '超长表达式耗时 ' + (Date.now() - t0) + 'ms');
  assert.ok(v === null || typeof v === 'number', '要么判非法要么算出数,不能返回别的');
});

await t('【健壮性】深层嵌套括号不炸栈(1 千层)', () => {
  let out;
  assert.doesNotThrow(() => { out = evalPlotExpr('('.repeat(1000) + 'x' + ')'.repeat(1000), { x: 1 }); },
    '深层嵌套导致抛异常(栈溢出也算)');
  assert.ok(out === null || typeof out === 'number');
});

// ── plot 节点层面(§2.3 / §2.8 末行)───────────────────────────────────────
await t('三条曲线里一条表达式非法:只丢那条,组件与其余曲线照常渲染', async () => {
  const r = await parse({ items: [{ type: 'plot', series: [
    { expr: 'sin(x)' }, { expr: 'window.alert(1)' }, { expr: 'x^2' },
  ] }] });
  assert.equal(r.ok, true, '一条坏曲线不该让整块拒渲染');
  const n = r.root.items[0];
  assert.equal(n.type, 'plot', 'plot 组件本身要照常渲染');
  assert.equal(n.series.length, 2, '应只保留两条合法曲线');
  assert.deepEqual(n.series.map((s) => s.expr), ['sin(x)', 'x^2']);
  assert.equal(r.notice, null, '不报错(§2.8)');
});

await t('全部曲线都非法:组件仍渲染(不报错、不丢整个节点)', async () => {
  const n = await node({ type: 'plot', series: [{ expr: 'alert(1)' }, { expr: 'a.b' }] });
  assert.ok(n, 'plot 节点不该因为曲线全非法而消失');
  assert.equal(n.series.length, 0);
});

await t('expr 超 512 字符:要么截断到 512、要么该曲线不绘制,不得原样带进渲染', async () => {
  const long = 'x+'.repeat(400) + 'x';
  const n = await node({ type: 'plot', series: [{ expr: long }, { expr: 'x' }] });
  assert.ok(n, 'plot 节点不该消失');
  const kept = n.series.find((s) => s.expr && s.expr.length > 100);
  if (kept) assert.ok(kept.expr.length <= 512, 'expr 上限 512,实际 ' + kept.expr.length);
  assert.ok(n.series.some((s) => s.expr === 'x'), '合法的那条必须保留');
});

await t('每序列参数上限 6', async () => {
  const params = 'abcdefghij'.split('').map((name) => ({ name, value: 1, min: 0, max: 2 }));
  const n = await node({ type: 'plot', series: [{ expr: 'a*x', params }] });
  assert.ok(n);
  assert.equal(n.series[0].params.length, 6);
});

await t('参数名不是单个小写字母时该参数被丢(组件照常)', async () => {
  const n = await node({ type: 'plot', series: [{ expr: 'a*x', params: [
    { name: 'a', value: 1, min: 0, max: 2 },
    { name: 'ab', value: 1, min: 0, max: 2 },
    { name: 'A', value: 1, min: 0, max: 2 },
    { name: '1', value: 1, min: 0, max: 2 },
  ] }] });
  assert.ok(n, 'plot 不该整体消失');
  assert.deepEqual(n.series[0].params.map((p) => p.name), ['a'], '只应保留单个小写字母的参数');
});

await t('plot.kind 非法值降级为缺省,不丢节点', async () => {
  const n = await node({ type: 'plot', series: [{ expr: 'x', kind: 'evil' }] });
  assert.ok(n, 'kind 非法只降级(§2 表头:选填非法值降级为缺省)');
  const k = n.series[0].kind;
  assert.ok(k === undefined || ['line', 'area', 'scatter'].includes(k), '实际 kind=' + k);
});

done('t07 plot 表达式');
