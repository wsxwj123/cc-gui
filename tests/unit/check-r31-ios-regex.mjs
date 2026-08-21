#!/usr/bin/env node
// r31 钉子:客户端 T2 黑名单正则去 lookbehind(Safari<16.4 白屏回归守卫)。
// 根因:skins.js 顶层字面量正则 `/...(?<![\w$]).../` 在旧 WebKit(Safari/iOS<16.4)是
// 解析期 SyntaxError,而 main.jsx 顶层 import skins.js → 整页白屏。r31 改成等价的无
// lookbehind 写法 `(?:^|[^\w$])`(捕获式,布尔 .test() 与 lookbehind 逐点一致)。
// 钉:①两份黑名单源文件不得再出现 lookbehind;②去 lookbehind 后行为矩阵不回归
// (绕过形态仍拒、prefetch(/匿名 function() 仍放行);③双端 map(String) 逐字一致(复用
// 既有 check-skin-client t1 口径)。
// Run: node tests/unit/check-r31-ios-regex.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { T2_SCRIPT_BLACKLIST } from '../../server/utils/skin-validate.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const clientSrc = read('client/src/utils/skins.js');
const serverSrc = read('server/utils/skin-validate.js');

// 取出各自的「黑名单数组体」(export const ... 到 ];),只扫正则字面量,避免命中注释里
// 保留的 lookbehind 说明文字。
const sliceArr = (src, marker) => {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `${marker} 存在`);
  return src.slice(start, src.indexOf('];', start));
};
const clientArr = sliceArr(clientSrc, 'export const T2_BLACKLIST_CLIENT');
const serverArr = sliceArr(serverSrc, 'export const T2_SCRIPT_BLACKLIST');

// ── ① lookbehind 不得回归(解析期 SyntaxError 只在旧 WebKit 复现,Chromium/Node 测不出,
//    必须源码级钉死)──
const lookbehindRe = /\(\?<[=!]/;
assert.doesNotMatch(clientArr, lookbehindRe, '客户端黑名单数组体不得有 lookbehind');
assert.doesNotMatch(serverArr, lookbehindRe, '服务端黑名单数组体不得有 lookbehind(双端同表)');
// 两条 lookbehind 前缀必须出现在代码注释之外(数组体里的字面量本身不能带兜底形态)
for (const [src, label] of [[clientArr, '客户端'], [serverArr, '服务端']]) {
  assert.ok(src.includes('(?:^|[^\\w$])'), `${label} 黑名单数组体应含无 lookbehind 前缀`);
}

// ── ①b 黑名单必须仍在模块顶层(export const 数组里),字面量随模块加载即解析 ──
// 行首顶格 export(不在函数/块内、不在动态 import 包裹里)—— 旧 WebKit 一进模块即解析,
// 遇 lookbehind 才会整页白屏。
const markerIdx = clientSrc.indexOf('export const T2_BLACKLIST_CLIENT');
const lineStart = clientSrc.lastIndexOf('\n', markerIdx) + 1;
const markerLine = clientSrc.slice(lineStart, clientSrc.indexOf('\n', markerIdx));
assert.equal(markerLine.trim(), 'export const T2_BLACKLIST_CLIENT = [', '客户端黑名单在模块顶层顶格 export');
assert.ok(markerIdx < clientSrc.indexOf('export function validateT2Client'), '客户端黑名单在函数体之前(模块顶层数据,非动态包裹)');
assert.ok(!clientSrc.slice(markerIdx, markerIdx + 60).includes('import('), '客户端黑名单字面量不包裹在动态 import() 内');

// ── ② 去 lookbehind 后的行为矩阵(复用服务端校验器,匹配规则无 lookbehind 的形态)──
{
  const { validateT2Script } = await import('../../server/utils/skin-validate.js');
  // 绕过形态仍拒(same as check-r26-t2-blacklist 反例子集)
  for (const bad of [
    'fetch("/x")', 'fetch ("/x")', 'window["fetch"]("/x")',
    'Function("return 1")()', 'new Function("x")', 'WebSocket ("ws://x")',
    'eval("1")', 'eval ("1")', 'import("m")', 'navigator.sendBeacon("/x")',
    'FETCH("/x")',
  ]) {
    assert.equal(validateT2Script(`const a=1; ${bad};`).ok, false, `r31: 去 lookbehind 仍拒 ${JSON.stringify(bad)}`);
  }
  // 已知误伤仍放行(左边界等价性哨兵)
  assert.equal(validateT2Script('prefetch("/x")').ok, true, 'r31: prefetch( 仍放行(左边界语义保持)');
  assert.equal(validateT2Script('myeval("1")').ok, true, 'r31: myeval( 仍放行(标识符左边界)');
  assert.equal(validateT2Script('setTimeout(function() {}, 100)').ok, true, 'r31: 匿名 function() 仍放行');
  // 注释提及不调用 → 放行
  assert.ok(validateT2Script('// fetch data from nowhere\nconsole.log("x");').ok, 'r31: 注释提及 fetch 放行');
}

// ── ③ 双端逐字一致(map(String)),并确认双端都用了无 lookbehind 前缀 ──
{
  const client = await import('../../client/src/utils/skins.js');
  assert.deepEqual(client.T2_BLACKLIST_CLIENT.map(String), T2_SCRIPT_BLACKLIST.map(String),
    'r31: 双端黑名单逐字一致(check-skin-client t1 同口径)');
  for (const re of client.T2_BLACKLIST_CLIENT) {
    assert.ok(re instanceof RegExp, 'r31: 黑名单条目均为 RegExp');
  }
  // hits source 前缀形态钉死:原 lookbehind 入口现为 `(?:^|[^\w$])` 前缀(防旧形态回潮)。
  // source 串里 `\w` 是字面反斜杠+w,用字面字符串 startsWith 判断(避开正则转义歧义)。
  const PREFIX = '(?:^|[^\\w$])'; // JS 字符串里 \\w = 字面 \w
  const bearing = client.T2_BLACKLIST_CLIENT.filter((r) => r.source.startsWith(PREFIX));
  assert.equal(bearing.length, 5, 'r31: 5 条原 lookbehind 入口已换 (?:^|[^\\w$]) 等价前缀(实际 ' + bearing.length + ')');
}

console.log('PASS check-r31-ios-regex');
