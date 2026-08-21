#!/usr/bin/env node
// r26-D5【单测·服务端半】:T2 黑名单正则化(PLAN D5 验收点形态矩阵)。
//   正例全拒:fetch( / fetch ( / window["fetch"] / Function('return 1') / new Function /
//     WebSocket ( / globalThis 形态属性访问以外的主形态;
//   反例放行:「// fetch data」注释里出现 fetch 但没调用;
//   已知误伤(钉死防「修复」反弹,口径=防误不防恶):prefetch( 命中 /fetch\s*\(/、
//     匿名函数表达式 function(){} 命中 /\bfunction\s*\(/;
//   既有七字样形态(大小写变体)仍全拒(回归哨兵)。
// 客户端同表(skins.js T2_BLACKLIST_CLIENT)由 PKG-8 落地,check-skin-client.mjs t1
// 以 String 形态比对双端(C-D5 串行锁步)。
// Run: node tests/unit/check-r26-t2-blacklist.mjs
import assert from 'node:assert/strict';
import { validateT2Script, T2_SCRIPT_BLACKLIST } from '../../server/utils/skin-validate.js';

// 表形态钉:9 条正则(子串升级为正则集,条数是防回退哨兵)
assert.equal(T2_SCRIPT_BLACKLIST.length, 9, '黑名单 9 形态(r26-D5 正则集)');
for (const re of T2_SCRIPT_BLACKLIST) {
  assert.ok(re instanceof RegExp, '黑名单条目均为 RegExp(修前为纯子串串)');
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
  // 注:`window["WebSocket".toLowerCase()]` 这类运行时计算的属性名不在静态形态面内——
  // 属「不防恶」残余面(口径见 skinPrompt.js 文案),此处不钉拒载。
  'eval("1")',
  'eval ("1")',
  'import("m")',
  'import ("m")',
  'new XMLHttpRequest()',
  'navigator.sendBeacon("/x")',
  'navigator . sendBeacon("/x")',    // 点号两侧空格
  'FETCH("/x")',                     // 大小写变体
  'const w = window["eval"]; w("1")',
];
for (const bad of REJECT) {
  const r = validateT2Script(`const a = 1; ${bad};`);
  assert.equal(r.ok, false, `拒载:${JSON.stringify(bad)}`);
  assert.ok(r.hits.length > 0 && r.hits.every((h) => typeof h === 'string'), 'hits 为可报给用户的字符串清单');
}

// ── 反例:不调用只提及 → 放行 ──
{
  const ok = validateT2Script('// fetch data from nowhere\ndocument.body.classList.add("x");\nwindow.__cguiSkinDispose = () => {};');
  assert.ok(ok.ok, '注释里出现 fetch 但没调用 → 放行(不误伤哨兵)');
}

// ── 已知误伤(防误不防恶口径,钉为已知行为防反弹)──
{
  assert.equal(validateT2Script('prefetch("/x")').ok, false,
    '已知误伤:prefetch( 命中 /fetch\\s*\\(/(拒载方向安全,作者改码可过)');
  assert.equal(validateT2Script('setTimeout(function() {}, 100)').ok, false,
    '已知误伤:匿名 function() 表达式命中 /\\bfunction\\s*\\(/(与 Function 构造器同形,口径内)');
}

// ── hits 清单形状:返回正则 source(供 UI 展示)──
{
  const r = validateT2Script('eval("x"); fetch("/y")');
  assert.deepEqual(r.hits.sort(), ['eval\\s*\\(', 'fetch\\s*\\('], 'hits = 命中正则的 source 串');
}

console.log('PASS check-r26-t2-blacklist');
