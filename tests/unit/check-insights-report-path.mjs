// 跨平台审查(0.2.379)建议-4:file:/// 抓出的路径在 Windows 上不是盘符路径。
// Run: node tests/unit/check-insights-report-path.mjs
//
// 覆盖:
//  - file:///C:/x/y/report.html → C:/x/y/report.html(剥掉 /C: 前导斜杠),回落路径排在其后;
//  - mac 形态 file:///Users/… 原样返回、不受影响;
//  - 抓不到 → 只有回落路径一个候选;
//  - 候选里没有重复项,且回落路径始终在末位(读不到时才有机会被用上)。
import assert from 'node:assert/strict';
import { insightsReportCandidates } from '../../server/routes/subscription-usage.js';

const HOME = '/home/tester';
const FALLBACK = '/home/tester/.claude/usage-data/report.html';

// ── 1. Windows 形态 ──────────────────────────────────────────────────────
const win = insightsReportCandidates(
  '报告已生成:file:///C:/Users/wsx/AppData/Local/Temp/report-1731.html\n(可直接打开)',
  HOME,
);
assert.equal(win[0], 'C:/Users/wsx/AppData/Local/Temp/report-1731.html', '盘符前的斜杠要剥掉,否则 readFile 必失败');
assert.notEqual(win[0][0], '/', '返给 readFile 的不得以 / 开头');
assert.equal(win[1], FALLBACK, '回落路径仍在候选里(读不到时才有机会用上)');

// 反斜杠形态(同一条正则也能抓到)同样只剥前导斜杠,不动其余字符
assert.equal(
  insightsReportCandidates('file:///C:/tmp\\report.html', HOME)[0],
  'C:/tmp\\report.html',
  '\\C: 形态剥前导斜杠,盘符后原样',
);

// ── 2. mac 形态不受影响 ──────────────────────────────────────────────────
const mac = insightsReportCandidates('file:///Users/alice/.claude/usage-data/report-1731.html', HOME);
assert.equal(mac[0], '/Users/alice/.claude/usage-data/report-1731.html', 'mac 绝对路径原样返回');
assert.equal(mac[1], FALLBACK);

// 百分号编码仍按原样解码(既有行为)
assert.equal(
  insightsReportCandidates('file:///Users/a%20b/report.html', HOME)[0],
  '/Users/a b/report.html',
  'decodeURIComponent 行为不变',
);
// 非法编码不抛异常(原来会抛在 close 回调里 → 整条请求既不回 200 也不回 500)
assert.equal(
  insightsReportCandidates('file:///Users/a%zz/report.html', HOME)[0],
  '/Users/a%zz/report.html',
  '解不开的编码按原文试读,不炸',
);

// ── 3. 抓不到 → 只有回落 ─────────────────────────────────────────────────
assert.deepEqual(insightsReportCandidates('some output without a url', HOME), [FALLBACK]);
assert.deepEqual(insightsReportCandidates('', HOME), [FALLBACK]);
assert.deepEqual(insightsReportCandidates(undefined, HOME), [FALLBACK]);

// 抓到的路径恰好就是回落路径时不重复列两遍
assert.deepEqual(
  insightsReportCandidates(`file://${FALLBACK}`, HOME),
  [FALLBACK],
  'url 指向的就是回落路径 → 一个候选',
);

// 非 .html 的 file:// 不算命中(保持既有正则口径)
assert.deepEqual(insightsReportCandidates('file:///C:/tmp/report.txt', HOME), [FALLBACK]);

console.log('check-insights-report-path: OK');
