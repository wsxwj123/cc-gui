#!/usr/bin/env node
// r64 P1 回归防护(安全审计 05.5 发现):safe-math 函数白名单判据必须是**自有属性**。
//   `FUNCTIONS` 是普通对象字面量,`FUNCTIONS['valueOf']` 命中继承来的
//   `Object.prototype.valueOf`(非 undefined) → `valueOf(x)`/`constructor(x)`/
//   `hasOwnProperty(x)`… 若用 `=== undefined` 判据会**编译通过**,逃过 repairPlotSeries
//   (靠 compileMathExpr===null 判非法丢曲线),留到渲染层 sampleExpr 求值时才抛 →
//   ErrorBoundary 把整块降级成错误卡、同块兄弟组件一起没(违 INTERFACE §2.8 逐曲线隔离)。
//   修法 = safe-math.ts 用 `Object.hasOwn(FUNCTIONS, name)`(与同文件 CONSTANTS/vars 一致)。
//
// 变异哨兵(把 safe-math.ts:180 改回 `if (FUNCTIONS[name] === undefined)` → 本测全红):
//   原型成员形态 evalPlotExpr 会返回非 null / 抛异常,断言 === null 失败。
// Run: node tests/unit/check-genui-safemath-proto.mjs
import assert from 'node:assert/strict';
import { evalPlotExpr } from '../../client/src/genui/contract.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL -', name, '::', e.message); } };

// ① Object.prototype 继承成员作函数调用 → 必须编译期被拒(evalPlotExpr 返回 null)。
for (const name of [
  'valueOf', 'constructor', 'hasOwnProperty', 'isPrototypeOf',
  'toString', 'toLocaleString', 'propertyIsEnumerable', '__defineGetter__',
]) {
  t(`原型成员 ${name}(x) 编译期被拒`, () => {
    let r;
    try { r = evalPlotExpr(`${name}(x)`, { x: 1 }); } catch (e) { r = `THROW:${e.message}`; }
    assert.equal(r, null, `期望 null(非法丢弃),实得 ${JSON.stringify(r)}`);
  });
}

// ② 合法函数不得被误伤(修复只该收紧原型成员,不动真函数)。
for (const [expr, params, expected] of [
  ['sin(x)', { x: 0 }, 0],
  ['cos(x)', { x: 0 }, 1],
  ['sqrt(x)', { x: 4 }, 2],
  ['abs(x)', { x: -3 }, 3],
  ['exp(x)', { x: 0 }, 1],
  ['floor(x)', { x: 2.7 }, 2],
]) {
  t(`合法 ${expr} 仍可求值`, () => {
    const r = evalPlotExpr(expr, params);
    assert.ok(typeof r === 'number' && Math.abs(r - expected) < 1e-9,
      `期望 ≈${expected},实得 ${JSON.stringify(r)}`);
  });
}

console.log(`\n[check-genui-safemath-proto] pass ${pass} / fail ${fail}`);
process.exit(fail ? 1 : 0);
