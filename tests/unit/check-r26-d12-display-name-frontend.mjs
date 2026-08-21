#!/usr/bin/env node
// r26-D12(前端半)【单测】:SettingsPanel.jsx DisplayNameInput 称呼按码点截断。
// 服务端半(PKG-5)见 check-r26-d12-display-name-codepoints.mjs;本文件钉前端半:
//   ①onChange 加码点截断辅助 truncateByCodePoints(maxLength={20} 保留作第一道);
//   ②commit 比较同走码点口径(防 emoji 称呼每次 blur 误判「有变化」多发 PUT);
//   ③双端等长矩阵:前端辅助与服务端 `[...displayName.trim()].slice(0, 20).join('')`
//     同输入等长同值(契约 C-D12);21 emoji → 20 完整 emoji 无孤代理。
// 注:PLAN 原定辅助放 client utils 共用;PKG-6 文件白名单只含 SettingsPanel.jsx,
// 故就地模块级定义(交付报告已注明此偏离,待主会话裁决是否提取)。
// Run: node tests/unit/check-r26-d12-display-name-frontend.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 与 SettingsPanel.jsx 的 truncateByCodePoints 逐字同形的参考实现(行为矩阵用;
// JSX 不可直接 import,本仓对组件逻辑的既有测试口径 = 源码钉 + 同形参考实现行为断言)。
const truncateByCodePoints = (s, n) => [...String(s)].slice(0, n).join('');
// 与服务端 prefs.js 逐字同形的参考实现
const serverForm = (displayName) => [...displayName.trim()].slice(0, 20).join('');

// 孤代理 = 高代理后没跟低代理,或低代理前没有高代理
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ①行为矩阵:21 emoji → 20 个完整 emoji,无孤代理;边界形态精确
{
  const input = '🙂'.repeat(21);
  const out = truncateByCodePoints(input, 20);
  assert.equal([...out].length, 20, 'D12-前端: 21 emoji 截到 20 码点');
  assert.equal(out, '🙂'.repeat(20), 'D12-前端: 截断产物逐字等于 20 个完整 emoji');
  assert.ok(!LONE_SURROGATE_RE.test(out), 'D12-前端: 截断产物不得含孤代理');
  // 矩阵自检:旧 UTF-16 slice 形态在代理对跨界时确实劈出孤代理(证明矩阵能抓 bug)
  // —— 19 BMP + 1 emoji = 21 码元,slice(0,20) 恰把代理对切成「19 BMP + 高代理」
  assert.ok(LONE_SURROGATE_RE.test(('a'.repeat(19) + '🙂').slice(0, 20)), 'D12-前端: 自检 —— 旧 slice(0,20) 形态产出孤代理');
  assert.equal(truncateByCodePoints('a'.repeat(19) + '🙂🙂', 20), 'a'.repeat(19) + '🙂',
    'D12-前端: 边界处 emoji 完整保留');
  assert.equal(truncateByCodePoints('柚子下午好呀', 20), '柚子下午好呀', 'D12-前端: CJK 短串原样');
  assert.equal([...truncateByCodePoints('一二三四五六七八九十一二三四五六七八九十一', 20)].length, 20,
    'D12-前端: 21 个 CJK 截 20');
}

// ②双端等长矩阵(契约 C-D12):同输入前端辅助与服务端形态输出完全一致
{
  const cases = ['🙂'.repeat(21), 'a'.repeat(19) + '🙂🙂', '  带空白称呼  ', '柚'.repeat(25), '', '普通名字', '🎉'.repeat(11) + 'abcdefghij'];
  for (const c of cases) {
    assert.equal(truncateByCodePoints(c.trim(), 20), serverForm(c),
      `D12-前端: 双端同输入必须等长同值(${JSON.stringify(c.slice(0, 10))}…)`);
  }
}

// ③接线源码钉:DisplayNameInput 的 onChange/commit 走码点截断,maxLength 保留
{
  const ui = readFileSync(new URL('../../client/src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
  const start = ui.indexOf('function truncateByCodePoints');
  const end = ui.indexOf('function MaxBudgetInput');
  assert.ok(start > 0 && end > start, 'D12-前端: DisplayNameInput 区段定位失败(锚漂移需换锚)');
  const seg = ui.slice(start, end);
  assert.match(seg, /return \[\.\.\.String\(s\)\]\.slice\(0, n\)\.join\(''\)/, 'D12-前端: 辅助必须按码点展开截断');
  assert.match(seg, /onChange=\{\(e\) => setDraft\(truncateByCodePoints\(e\.target\.value, 20\)\)\}/,
    'D12-前端: onChange 必须经码点截断辅助');
  assert.match(seg, /truncateByCodePoints\(draft\.trim\(\), 20\) !== \(val \|\| ''\)/,
    'D12-前端: commit 比较同走码点口径(防 emoji 称呼误判变化多发 PUT)');
  assert.match(seg, /maxLength=\{20\}/, 'D12-前端: maxLength={20} 保留作第一道');
  assert.ok(!/\.trim\(\)\.slice\(0, 20\)/.test(seg), 'D12-前端: 不得残留 UTF-16 slice 截断(旧形态防复活)');
}

console.log('PASS check-r26-d12-display-name-frontend');
