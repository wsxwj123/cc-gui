#!/usr/bin/env node
// F2 preview 报错采集:记录规整 + 摘要格式化纯逻辑自检。跑法:node tests/unit/check-preview-errors.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizePreviewErr, formatPreviewErrors, PREVIEW_ERR_KEY, ERROR_COLLECTOR,
  resolvePreviewErrLine,
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

// ── normalizePreviewErr:数字行号保留 + mermaid 文本行号解析 ────────
// error 带数字 line → 输出保留 numeric line 字段(供 formatPreviewErrors 定位源码)
assert.equal(normalizePreviewErr({ type: 'error', msg: 'x', line: 7 }).line, 7);
// mermaid 无数字 line,行号藏消息里 → 解析出 numeric line
{
  const n = normalizePreviewErr({ type: 'error', msg: 'Mermaid: Parse error on line 4:\n...' });
  assert.equal(n.line, 4, 'mermaid on line N 解析成 numeric line');
  assert.match(n.text, /行 4/);
}
// 无行号 → line 为 null(不是 undefined 崩溃)
assert.equal(normalizePreviewErr({ type: 'error', msg: 'boom' }).line, null);
// 带 file 的外部脚本错误:即使 message 含 "on line N" 也不从文本复活行号
// (rec.file 非空 → 正则 fallback 关闭;只有无 file 的 mermaid 父页错误才解析文本行号)
{
  const n = normalizePreviewErr({ type: 'error', msg: 'boom on line 5', file: 'https://cdn.x/lib.js' });
  assert.equal(n.line, null, '带 file 的外部错误不从文本复活行号');
  assert.doesNotMatch(n.text, /行 5/, '带 file 不在 text 显示行号');
}
// net/reject/console 无 line 字段(formatPreviewErrors 据此不附片段)
assert.equal(normalizePreviewErr({ type: 'net', url: '/u', status: 500 }).line, undefined);

// ── formatPreviewErrors(errors, source):附源码片段 ────────────────
const SRC = ['<html>', '<body>', '  <script>', '    bad()', '  </script>', '</body>', '</html>'].join('\n');
// 带 file 的外部错误(msg 含 "on line 5")→ 无行号 → 不附源码片段(承接上面正则 fallback 限父页路径)
assert.doesNotMatch(
  formatPreviewErrors([normalizePreviewErr({ type: 'error', msg: 'boom on line 5', file: 'https://cdn.x/lib.js' })], SRC),
  /出错行源码片段/, '带 file 的外部错误不附源码片段');
// 行号还原:error line=4 → 附 ±3 行(1..7)片段,出错行带 > 标记,含该行内容
{
  const errs = [normalizePreviewErr({ type: 'error', msg: 'bad is not defined', line: 4 })];
  const out = formatPreviewErrors(errs, SRC);
  assert.match(out, /出错行源码片段/);
  assert.match(out, /错误 1\(行 4\)/);
  assert.match(out, /> {1,}4 {2}    bad\(\)/, '出错行带 > 标记且为源码第 4 行');
  assert.match(out, /  1 {2}<html>/, '上文含第 1 行');
  assert.match(out, /  7 {2}<\/html>/, '下文含第 7 行');
}
// 无 source → 向后兼容,不附片段(旧行为)
{
  const errs = [normalizePreviewErr({ type: 'error', msg: 'bad', line: 4 })];
  assert.doesNotMatch(formatPreviewErrors(errs), /出错行源码片段/);
}
// 越界不附:行号 > 源码行数(999)/ 负数(-2)→ 无片段
{
  const over = [normalizePreviewErr({ type: 'error', msg: 'x', line: 999 })];
  assert.doesNotMatch(formatPreviewErrors(over, SRC), /出错行源码片段/, '超长行号不附');
  const neg = [normalizePreviewErr({ type: 'error', msg: 'x', line: -2 })];
  assert.doesNotMatch(formatPreviewErrors(neg, SRC), /出错行源码片段/, '负行号不附');
}
// 无行号不附:error 无 line / net 类
{
  const noLine = [
    normalizePreviewErr({ type: 'error', msg: 'no line here' }),
    normalizePreviewErr({ type: 'net', url: '/api', status: 500 }),
  ];
  assert.doesNotMatch(formatPreviewErrors(noLine, SRC), /出错行源码片段/, '无行号不附');
}
// 只为前 5 条带行号错误附片段(总量控制)
{
  const errs = Array.from({ length: 8 }, () =>
    normalizePreviewErr({ type: 'error', msg: 'x', line: 4 }));
  const out = formatPreviewErrors(errs, SRC);
  assert.ok(!/错误 6\(行/.test(out), '第 6 条起不附片段');
  assert.match(out, /错误 5\(行/, '第 5 条仍附片段');
}
// 超长源码行截断(minified 一行几十 KB 不整塞进去)
{
  const bigSrc = 'a'.repeat(5000);
  const errs = [normalizePreviewErr({ type: 'error', msg: 'x', line: 1 })];
  const out = formatPreviewErrors(errs, bigSrc);
  assert.ok(out.length < 1000, '超长源码行被截断');
  assert.match(out, /…/);
}

// ── resolvePreviewErrLine:外部脚本行号防负数/错行 ───────────────
const OFF = 20;  // 假设 shim 前缀 20 行
// inline 脚本(filename 空):行号 > offset → 减偏移还原
assert.equal(resolvePreviewErrLine({ type: 'error', line: 24, file: '' }, OFF).line, 4);
// inline 脚本(about:srcdoc):同样减偏移
assert.equal(resolvePreviewErrLine({ type: 'error', line: 24, file: 'about:srcdoc' }, OFF).line, 4);
// 外部 CDN 脚本(有 filename)→ 删 line,不附片段(减完看似合法却指向不相干源码)
{
  const r = resolvePreviewErrLine({ type: 'error', msg: 'boom', line: 42, file: 'https://cdn.x/lib.js' }, OFF);
  assert.equal(r.line, undefined, '外部脚本 line 被清掉');
  // 下游:normalize 后无行号 → formatPreviewErrors 不附源码片段
  const errs = [normalizePreviewErr(r)];
  assert.doesNotMatch(formatPreviewErrors(errs, SRC), /出错行源码片段/, '外部脚本不附片段');
}
// 跨域脱敏 lineno=0(inline 但行号 <= offset)→ 删 line,不产生负行号
{
  const r = resolvePreviewErrLine({ type: 'error', msg: 'Script error.', line: 0, file: '' }, OFF);
  assert.equal(r.line, undefined, 'lineno=0 被清掉,不减成负数');
  assert.equal(normalizePreviewErr(r).line, null, '下游行号为 null,不附片段');
}
// 无 line / 非 error 类 → 原样返回(不误伤)
assert.equal(resolvePreviewErrLine({ type: 'error', msg: 'x' }, OFF).line, undefined);
assert.equal(resolvePreviewErrLine({ type: 'net', url: '/u', line: 30 }, OFF).line, 30);

// ── ERROR_COLLECTOR 注入脚本 ──────────────────────────────────────
// 是 <script> 字符串、引用约定键、hook 四类来源
assert.match(ERROR_COLLECTOR, /^<script>/);
assert.match(ERROR_COLLECTOR, new RegExp(PREVIEW_ERR_KEY));
assert.match(ERROR_COLLECTOR, /addEventListener\('error'/);
assert.match(ERROR_COLLECTOR, /unhandledrejection/);
assert.match(ERROR_COLLECTOR, /console\.error/);
assert.match(ERROR_COLLECTOR, /window\.fetch/);
// error 事件带上 filename(供父页区分 inline vs 外部脚本)
assert.match(ERROR_COLLECTOR, /e\.filename/);

// ── 注入串可编译性 + srcDoc 结构完整性 ────────────────────────────
// ERROR_COLLECTOR / STORAGE_SHIM 是拼进 iframe srcDoc 的 <script> 字符串模板。改坏一个
// 引号/括号 → 采集器装不上(零徽章);更坏是漏闭合 </script> 吞掉后续用户 HTML,把整页
// 当脚本文本 → 预览完全空白。这类改动 vite build 不会报(模板串内容不被解析),这几条断言
// 是唯一防线。STORAGE_SHIM 住在 ArtifactPreview.jsx(import React,node 不能直接 import),
// 从源码文本抠字面量。
const STORAGE_SHIM = (() => {
  const jsx = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../client/src/components/ArtifactPreview.jsx'),
    'utf8',
  );
  const m = jsx.match(/const STORAGE_SHIM = `([\s\S]*?)`;/);
  assert.ok(m, '能从 ArtifactPreview.jsx 抠出 STORAGE_SHIM 字面量');
  return m[1];
})();

for (const [name, s] of [['ERROR_COLLECTOR', ERROR_COLLECTOR], ['STORAGE_SHIM', STORAGE_SHIM]]) {
  assert.equal((s.match(/<script>/g) || []).length, 1, `${name} 恰好一个 <script>`);
  assert.equal((s.match(/<\/script>/g) || []).length, 1,
    `${name} 恰好一个 </script>(游离/漏闭合会吞掉后续用户 HTML → 预览空白)`);
  const body = s.match(/<script>([\s\S]*)<\/script>/)[1];
  // 内层 JS 编译不过 = 引号/括号被改坏,采集器整个装不上 → 零徽章。
  assert.doesNotThrow(() => new Function(body), `${name} 内层 JS 可编译(new Function 不抛)`);
}

// srcDoc = STORAGE_SHIM + ERROR_COLLECTOR + 用户代码:拼接后用户代码必须原样保留,且注入
// 前缀里所有 <script> 都在用户代码之前闭合(否则用户 HTML 被当脚本文本 → 空白)。
{
  const userCode = '<!DOCTYPE html><html><body><h1>__marker__</h1><script>oops()</scr' + 'ipt></body></html>';
  const srcDoc = STORAGE_SHIM + ERROR_COLLECTOR + userCode;
  assert.ok(srcDoc.includes(userCode), 'srcDoc 完整包含用户代码(未被注入前缀吞掉)');
  const prefix = srcDoc.slice(0, srcDoc.indexOf(userCode));
  assert.equal(
    (prefix.match(/<script>/g) || []).length,
    (prefix.match(/<\/script>/g) || []).length,
    '注入前缀所有 script 标签均已闭合(不吞用户 HTML)',
  );
}

console.log('✓ check-preview-errors: all passed');
