#!/usr/bin/env node
// 白盒:rawResponseSecurityHeaders(读文件接口 raw=1 的安全头判据)。
// 依据:.devflow/r156-raw-content-k3.md §5.1。只有媒体类型精确等于 application/pdf 才豁免 sandbox。
// node tests/unit/check-r156-raw-headers.mjs
import assert from 'node:assert/strict';
import { rawResponseSecurityHeaders } from '../../server/utils/raw-response-headers.js';

const WITH_SANDBOX = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' };
const PDF_ONLY = { 'X-Content-Type-Options': 'nosniff' };
let n = 0;
function expect(input, want, msg) {
  assert.deepEqual(rawResponseSecurityHeaders(input), want, `${msg}: ${JSON.stringify(input)}`);
  n++;
}

// PDF 各种写法 → 只有 nosniff,没有 CSP
for (const ct of ['application/pdf', 'APPLICATION/PDF', 'Application/Pdf', ' application/pdf ',
  'application/pdf; charset=binary', 'application/pdf;foo=bar', 'application/PDF ;x=y']) {
  expect(ct, PDF_ONLY, 'PDF 豁免');
}

// 非 PDF → nosniff + sandbox
for (const ct of ['image/svg+xml', 'image/png', 'image/jpeg', 'video/mp4', 'audio/wav',
  'application/octet-stream', 'text/html', 'application/xml', 'text/plain; charset=utf-8',
  // 近似但不等于 PDF 的媒体类型不得豁免
  'application/pdfx', 'application/x-pdf', 'xapplication/pdf', 'application/pdf+xml',
  'application / pdf', 'text/pdf']) {
  expect(ct, WITH_SANDBOX, '非 PDF 带 sandbox');
}

// 空/异常输入 → 默认安全(带 sandbox),不抛
for (const ct of ['', '   ', ';', undefined, null, 0, 42, {}, [], ['application/pdf'], true]) {
  expect(ct, WITH_SANDBOX, '空/异常输入带 sandbox');
}

// CSP 值恰为 sandbox,不含 allow- 词
const csp = rawResponseSecurityHeaders('image/svg+xml')['Content-Security-Policy'];
assert.equal(csp, 'sandbox'); n++;
assert.ok(!csp.includes('allow-')); n++;

// 每次返回新对象(调用方改了不污染下次)
const a = rawResponseSecurityHeaders('image/png');
a.extra = 'x';
assert.deepEqual(rawResponseSecurityHeaders('image/png'), WITH_SANDBOX); n++;

console.log(`check-r156-raw-headers: ${n} assertions passed`);
