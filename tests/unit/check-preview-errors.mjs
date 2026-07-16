#!/usr/bin/env node
// F2 preview 报错采集:记录规整 + 摘要格式化纯逻辑自检。跑法:node tests/unit/check-preview-errors.mjs
import assert from 'node:assert/strict';
import {
  normalizePreviewErr, formatPreviewErrors, PREVIEW_ERR_KEY, ERROR_COLLECTOR,
} from '../../client/src/utils/previewErrors.js';

// ── normalizePreviewErr ──────────────────────────────────────────
// 运行时错误带行列号 → text 含 (行 N:col)
{
  const n = normalizePreviewErr({ type: 'error', msg: 'x is not defined', line: 12, col: 5 });
  assert.equal(n.type, 'error');
  assert.match(n.text, /x is not defined \(行 12:5\)/);
}
// error 无行号 → 不带括号
assert.doesNotMatch(normalizePreviewErr({ type: 'error', msg: 'boom' }).text, /行/);
// error 缺 msg → 兜底文案,不崩
assert.match(normalizePreviewErr({ type: 'error' }).text, /脚本错误/);

// net 带 status + url
{
  const n = normalizePreviewErr({ type: 'net', url: 'https://a.com/x', status: 404 });
  assert.match(n.text, /HTTP 404/);
  assert.match(n.text, /https:\/\/a\.com\/x/);
}
// net 网络错(无 status,有 err)
assert.match(normalizePreviewErr({ type: 'net', url: '/u', err: 'Failed to fetch' }).text, /请求失败: Failed to fetch/);

// reject / console 走 msg
assert.equal(normalizePreviewErr({ type: 'reject', msg: 'nope' }).type, 'reject');
assert.equal(normalizePreviewErr({ type: 'console', msg: 'oops' }).text, 'oops');

// 未知/缺失 type → 归到 error(失败方向:仍可见,不丢)
assert.equal(normalizePreviewErr({ msg: 'hi' }).type, 'error');
assert.equal(normalizePreviewErr({ type: 'weird', msg: 'hi' }).type, 'error');

// 非法输入 → null(调用方跳过)
assert.equal(normalizePreviewErr(null), null);
assert.equal(normalizePreviewErr('str'), null);

// 超长 msg 截断(防爆屏)
{
  const n = normalizePreviewErr({ type: 'console', msg: 'a'.repeat(1000) });
  assert.ok(n.text.length < 400, '超长消息被截断');
  assert.match(n.text, /…$/);
}

// sig 去重:同类型同内容 → 同 sig(父页据此去重)
{
  const a = normalizePreviewErr({ type: 'net', url: '/u', status: 500 });
  const b = normalizePreviewErr({ type: 'net', url: '/u', status: 500 });
  assert.equal(a.sig, b.sig, '相同记录 sig 一致');
  const c = normalizePreviewErr({ type: 'net', url: '/u', status: 404 });
  assert.notEqual(a.sig, c.sig, '不同 status sig 不同');
}

// ── formatPreviewErrors ──────────────────────────────────────────
// 空 → ''(无错误不产出、UI 零打扰)
assert.equal(formatPreviewErrors([]), '');
assert.equal(formatPreviewErrors(null), '');

// 多条 → 编号列表 + 中文标签 + 代码围栏
{
  const errs = [
    normalizePreviewErr({ type: 'error', msg: 'ReferenceError: y', line: 3 }),
    normalizePreviewErr({ type: 'net', url: '/api', status: 404 }),
  ];
  const out = formatPreviewErrors(errs);
  assert.match(out, /捕获到 2 条报错/);
  assert.match(out, /1\. \[运行时错误\] ReferenceError: y \(行 3\)/);
  assert.match(out, /2\. \[网络请求\] HTTP 404/);
  assert.match(out, /```/);
}

// 超量摘要截断
{
  const many = Array.from({ length: 200 }, (_, i) =>
    normalizePreviewErr({ type: 'console', msg: 'line-' + i + '-' + 'z'.repeat(50) }));
  const out = formatPreviewErrors(many);
  assert.match(out, /已截断/);
}

// ── ERROR_COLLECTOR 注入脚本 ──────────────────────────────────────
// 是 <script> 字符串、引用约定键、hook 四类来源
assert.match(ERROR_COLLECTOR, /^<script>/);
assert.match(ERROR_COLLECTOR, new RegExp(PREVIEW_ERR_KEY));
assert.match(ERROR_COLLECTOR, /addEventListener\('error'/);
assert.match(ERROR_COLLECTOR, /unhandledrejection/);
assert.match(ERROR_COLLECTOR, /console\.error/);
assert.match(ERROR_COLLECTOR, /window\.fetch/);

console.log('✓ check-preview-errors: all passed');
