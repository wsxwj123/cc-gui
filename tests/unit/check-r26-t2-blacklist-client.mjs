#!/usr/bin/env node
// r26-D5【单测·客户端半】:T2_BLACKLIST_CLIENT 正则集形态矩阵(与服务端
// check-r26-t2-blacklist.mjs 同口径,validateT2Client 是加载前的纵深复验)。
// 双端同表由 check-skin-client.mjs t1 按 String 形态钉死(本文件不重复);
// 这里钉客户端校验器的行为矩阵:绕过形态全拒、注释提及放行、已知误伤钉死防反弹。
// Run: node tests/unit/check-r26-t2-blacklist-client.mjs
import assert from 'node:assert/strict';

// skins.js 顶层 import sessionStore,模块初始化需要最小 window/localStorage 面
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const lsMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: (k) => lsMap.delete(k),
};

const { T2_BLACKLIST_CLIENT, validateT2Client } = await import('../../client/src/utils/skins.js');

// 表形态钉:9 条正则(与服务端条数一致,防回退哨兵)
assert.equal(T2_BLACKLIST_CLIENT.length, 9, '客户端黑名单 9 形态(r26-D5 正则集)');
for (const re of T2_BLACKLIST_CLIENT) {
  assert.ok(re instanceof RegExp, '客户端黑名单条目均为 RegExp(修前为纯子串串)');
}

// ── 正例:绕过形态全拒(修前纯子串全绕)──
const REJECT = [
  'fetch("/x")',
  'fetch ("/x")',                    // 空格绕过
  'fetch\t("/x")',                   // tab 绕过
  'window["fetch"]("/x")',           // 动态属性访问
  "window['fetch']('/x')",
  'Function("return 1")()',          // Function 构造器(无 new)
  'new Function("x")',
  'WebSocket ("ws://x")',            // 空格绕过
  'new WebSocket("ws://x")',
  'eval("1")',
  'eval ("1")',
  'import("m")',
  'import ("m")',
  'new XMLHttpRequest()',
  'navigator.sendBeacon("/x")',
  'navigator . sendBeacon("/x")',
  'FETCH("/x")',                     // 大小写变体
  'const w = window["eval"]; w("1")',
];
for (const bad of REJECT) {
  const r = validateT2Client(`const a = 1; ${bad};`);
  assert.equal(r.ok, false, `拒载:${JSON.stringify(bad)}`);
  assert.ok(r.hits.length > 0 && r.hits.every((h) => typeof h === 'string'), 'hits 为可报给用户的字符串清单');
}

// ── 反例:不调用只提及 → 放行 ──
{
  const ok = validateT2Client('// fetch data from nowhere\ndocument.body.classList.add("x");\nwindow.__cguiSkinDispose = () => {};');
  assert.ok(ok.ok, '注释里出现 fetch 但没调用 → 放行(不误伤哨兵)');
}

// ── 已知误伤(防误不防恶口径,钉为已知行为防反弹)──
{
  assert.equal(validateT2Client('prefetch("/x")').ok, true,
    'r27 起放行:lookbehind 左边界,prefetch( 不命中');
  assert.equal(validateT2Client('setTimeout(function() {}, 100)').ok, true,
    'r27 起放行:匿名 function() 是合法 JS,规则只抓 function(\" 字符串实参构造器形态');
}

// ── hits 清单形状:返回正则 source(与服务端 validateT2Script 同形状)──
{
  const r = validateT2Client('eval("x"); fetch("/y")');
  assert.deepEqual(r.hits.sort(), ['(?:^|[^\\w$])eval\\s*\\(', '(?:^|[^\\w$])fetch\\s*\\('], 'hits = 命中正则的 source 串(r31 去 lookbehind:等价 `(?:^|[^\\w$])` 前缀)');
}

console.log('PASS check-r26-t2-blacklist-client');
