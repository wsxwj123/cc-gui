#!/usr/bin/env node
// r142 / T-1 —— capabilityReport 的平台能力表(纯函数)。
// 合同来源:.devflow/PLAN-r142-win-cu.md §4.1(阶段 A / 阶段 B 两张 win32 表 + inputMode 五态)、§6.1 T-1。
//
// 两条口径(与方案的取舍,写在这里免得下一个人猜):
//   1. **darwin 逐字节锁死** —— 方案要求"mac 输出逐字节不变"(§4.1 第 1 条)。基线是修前代码导出的
//      fixtures/cu-mac-baseline.json,一个新键、一个标点都不能变。
//   2. **win32 只锁结构与语义,不锁文案** —— reason 是给人读的解释文本,把方案散文逐字钉成接口会让
//      "改一句人话"变红;所以 win32 侧断言 status/coverage/degradation/键集合 + reason 的语义正则。
//
// 纯函数:capabilityReport({platformName, uia}) 显式注入,不开 GUI、不 spawn、不读磁盘缓存。
// 跑法:node tests/unit/check-cu-capabilities-platform.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'r142-helpers', 'fixtures');
const BASELINE = JSON.parse(fs.readFileSync(join(FIXTURES, 'cu-mac-baseline.json'), 'utf8'));

const cu = await import('../../server/computer-use/cu-common.js');
const report = makeReport('check-cu-capabilities-platform');

const MAC_KEYS = ['screenshot', 'screenshotTarget', 'windowList', 'cursorPosition',
  'backgroundClick', 'backgroundType', 'backgroundKey', 'screenScope', 'lockscreen'];
const WIN_INPUT_KEYS = ['foregroundClick', 'foregroundType', 'foregroundKey'];

// ── §4.1 的三张合法 win32 形态 ────────────────────────────────────────
// 阶段 A(只读):输入全 unsupported;阶段 B:background* 可用 + foreground*(degradation:'global')。
// 每项是 [status, coverage|degradation|null]。
const WIN_STAGE_A = {
  screenshot: ['available', null],
  screenshotTarget: ['unverified', null],
  windowList: ['available', null],
  cursorPosition: ['available', null],
  backgroundClick: ['unsupported', null],
  backgroundType: ['unsupported', null],
  backgroundKey: ['unsupported', null],
  foregroundClick: ['unsupported', null],
  foregroundType: ['unsupported', null],
  foregroundKey: ['unsupported', null],
  screenScope: ['unverified', null],
  lockscreen: ['unverified', null],
};
const WIN_STAGE_B_UIA = {
  ...WIN_STAGE_A,
  backgroundClick: ['available', { coverage: 'partial' }],
  backgroundType: ['available', { coverage: 'partial' }],
  backgroundKey: ['unsupported', null],
  foregroundClick: ['available', { degradation: 'global' }],
  foregroundType: ['available', { degradation: 'global' }],
  foregroundKey: ['available', { degradation: 'global' }],
};
const WIN_STAGE_B_MSG_ONLY = {
  ...WIN_STAGE_B_UIA,
  backgroundClick: ['available', { coverage: 'narrow' }],
  backgroundType: ['available', { coverage: 'narrow' }],
};

function shapeOf(caps) {
  const out = {};
  for (const key of [...MAC_KEYS, ...WIN_INPUT_KEYS]) {
    const entry = caps[key];
    out[key] = entry === undefined
      ? 'MISSING'
      : `${entry.status}${entry.coverage ? `/${entry.coverage}` : ''}${entry.degradation ? `/${entry.degradation}` : ''}`;
  }
  return out;
}
function expectedShape(table) {
  const out = {};
  // 键顺序必须与 shapeOf 的固定顺序一致:JSON.stringify 保留插入顺序,而三张表的字面量把
  // screenScope/lockscreen 写在了 foreground* 之后 ⇒ 直接遍历 Object.entries(table) 得到的键序
  // 与 shapeOf 不同,字符串比较**恒不相等**(T1-02 会永久红,与实现无关)。这里改用同一个键序。
  for (const key of [...MAC_KEYS, ...WIN_INPUT_KEYS]) {
    const [status, extra] = table[key];
    out[key] = `${status}${extra?.coverage ? `/${extra.coverage}` : ''}${extra?.degradation ? `/${extra.degradation}` : ''}`;
  }
  return out;
}
/** 返回命中的形态名;都不命中返回 null。 */
function classifyWin(caps) {
  const shape = shapeOf(caps);
  for (const [name, table] of [['阶段 A(只读)', WIN_STAGE_A], ['阶段 B(uiaReady=true)', WIN_STAGE_B_UIA],
    ['阶段 B(uiaReady=false)', WIN_STAGE_B_MSG_ONLY]]) {
    if (JSON.stringify(shape) === JSON.stringify(expectedShape(table))) return name;
  }
  return null;
}
function shapeTable(shape) {
  return Object.entries(shape).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}
/** §4.1 的 inputMode 五态映射,由能力表推导(路由层必须给同一个值,见 acceptance/r142-wincu)。 */
function deriveInputMode(caps, platformName) {
  if (platformName === 'darwin') return 'background';
  if (platformName !== 'win32') return 'none';
  const click = caps.backgroundClick || {};
  const type = caps.backgroundType || {};
  const fg = caps.foregroundClick || {};
  const anyBackground = click.status === 'available' || type.status === 'available';
  if (!anyBackground) return fg.status === 'available' ? 'global-only' : 'none';
  if (click.coverage === 'partial' || type.coverage === 'partial') return 'background-partial';
  if (click.coverage === 'narrow' || type.coverage === 'narrow') return 'background-message-only';
  return 'background';
}

// ── T1-01 mac 逐字节不变(修前绿:这就是"不许动"的锁)─────────────────
await report.check('T1-01', 'darwin 能力表与修前基线逐字节一致(§4.1「mac 输出逐字节不变」)', 'green', () => {
  const now = cu.capabilityReport({ platformName: 'darwin' });
  assert.deepEqual(now, BASELINE.capabilityReportDarwin,
    'macOS 能力表变了。方案要求 darwin 分支逐字节不变(新键只允许在 win32 出现);\n'
    + `修前:\n${JSON.stringify(BASELINE.capabilityReportDarwin, null, 1)}\n现在:\n${JSON.stringify(now, null, 1)}`);
});

// ── T1-02 win32 报告必须是方案的三张形态之一(修前红)────────────────
await report.check('T1-02', 'win32 能力表落在 §4.1 的三张合法形态之一(阶段 A / 阶段 B±uiaReady)', 'red', () => {
  const caps = cu.capabilityReport({ platformName: 'win32' }).capabilities;
  const shape = shapeOf(caps);
  const hit = classifyWin(caps);
  assert.ok(hit,
    'win32 的能力表既不是阶段 A,也不是阶段 B(uiaReady 真/假)——方案 §4.1 的两张表必须原样落地。\n'
    + `实际:\n${shapeTable(shape)}\n`
    + `期望(三选一):\n[A 阶段只读]\n${shapeTable(expectedShape(WIN_STAGE_A))}\n`
    + `[B 阶段 uiaReady=true]\n${shapeTable(expectedShape(WIN_STAGE_B_UIA))}\n`
    + `[B 阶段 uiaReady=false]\n${shapeTable(expectedShape(WIN_STAGE_B_MSG_ONLY))}`);
});

// ── T1-03 win32 不得再拿"只实现 macOS"当借口(修前红)────────────────
await report.check('T1-03', 'win32 报告的 reason 不得含"仅 macOS/只实现 macOS/无桌面执行层"这类平台借口', 'red', () => {
  const text = JSON.stringify(cu.capabilityReport({ platformName: 'win32' }));
  const bad = [/仅 macOS/, /只实现 macOS/, /Windows 无桌面执行层/];
  const hit = bad.find((re) => re.test(text));
  assert.equal(hit, undefined,
    `win32 能力表里还有平台借口 ${hit}(这正是 FORENSICS 门 4/门 5 的原文):\n${text.slice(0, 600)}`);
});

// ── T1-04 结构不变量:状态词与 reason 必须自洽(修前红:win32 缺 foreground*)─
await report.check('T1-04', 'win32 表的键集合 = mac 九项 + foregroundClick/Type/Key;非 available 必带 reason', 'red', () => {
  const caps = cu.capabilityReport({ platformName: 'win32' }).capabilities;
  const keys = Object.keys(caps);
  for (const key of MAC_KEYS) assert.ok(keys.includes(key), `win32 表缺既有能力项 ${key}(不允许因为"Windows 没有"就删项)`);
  for (const key of WIN_INPUT_KEYS) assert.ok(keys.includes(key), `win32 表缺 ${key}(§4.1:前台工具在 Windows 上要显式声明)`);
  for (const [key, entry] of Object.entries(caps)) {
    assert.ok(['available', 'unsupported', 'unverified'].includes(entry.status),
      `${key}.status=${entry.status} 不在 available/unsupported/unverified 里`);
    if (entry.status !== 'available') {
      assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length >= 4,
        `${key} 不是 available 却没给 reason(合同第 9 段:不得含糊)`);
    }
    if (entry.coverage !== undefined) {
      assert.ok(['partial', 'narrow'].includes(entry.coverage), `${key}.coverage=${entry.coverage} 只能是 partial/narrow`);
      assert.equal(entry.status, 'available', `${key} 有 coverage 却 status=${entry.status}(coverage 只对 available 有意义)`);
    }
    if (entry.degradation !== undefined) {
      assert.equal(entry.degradation, 'global', `${key}.degradation=${entry.degradation} 只能是 global`);
      assert.equal(entry.status, 'available', `${key} 有 degradation 却 status=${entry.status}`);
    }
  }
  assert.ok(caps.screenshot.status === 'available',
    'Windows 阶段 A/B 的截图都必须 available(截图是阶段 A 的全部意义)');
});

// ── T1-05 inputMode 五态(修前红:两张 win32 表推不出方案说的档)──────
await report.check('T1-05', 'inputMode 由能力表推出且落在五态内:win32 阶段 A=none / B±uia=background-*', 'red', () => {
  const stageA = cu.capabilityReport({ platformName: 'win32' }).capabilities;
  const modeA = deriveInputMode(stageA, 'win32');
  const allowed = ['background', 'background-partial', 'background-message-only', 'global-only', 'none'];
  assert.ok(allowed.includes(modeA), `推导出 ${modeA},不在五态里`);
  // 阶段 A 必须推到 none(输入全 unsupported) —— 修前也推得出 none,所以真正的红在下面两行:
  assert.equal(modeA, 'none', '阶段 A(输入全 unsupported)必须推成 none');
  const bTrue = cu.capabilityReport({ platformName: 'win32', uia: true }).capabilities;
  const bFalse = cu.capabilityReport({ platformName: 'win32', uia: false }).capabilities;
  assert.equal(deriveInputMode(bTrue, 'win32'), 'background-partial',
    'uiaReady=true 的 win32 表必须推成 background-partial(coverage:partial)');
  assert.equal(deriveInputMode(bFalse, 'win32'), 'background-message-only',
    'uiaReady=false 的 win32 表必须推成 background-message-only(coverage:narrow)');
  assert.equal(deriveInputMode(cu.capabilityReport({ platformName: 'darwin' }).capabilities, 'darwin'), 'background',
    'mac 必须还是 background');
});

// ── T1-06 uia 入参不得污染 darwin(修前绿)─────────────────────────
await report.check('T1-06', 'darwin 分支不理会 uia 入参(注入 true/false/null 都不变)', 'green', () => {
  for (const uia of [true, false, null, undefined]) {
    assert.deepEqual(cu.capabilityReport({ platformName: 'darwin', uia }),
      BASELINE.capabilityReportDarwin, `darwin + uia=${uia} 的输出变了(§4.1:mac 分支完全不碰这两个新东西)`);
  }
});

// ── T1-07 uiaReady 只影响 coverage,不影响 status(修前红)─────────────
await report.check('T1-07', 'uiaReady 真/假只改 background* 的 coverage;backgroundKey 恒 unsupported', 'red', () => {
  const t = cu.capabilityReport({ platformName: 'win32', uia: true }).capabilities;
  const f = cu.capabilityReport({ platformName: 'win32', uia: false }).capabilities;
  assert.notDeepEqual(t, f, 'uiaReady 真与假的 win32 表必须不同(§2.4 的统一降级语义)');
  for (const key of ['screenshot', 'screenshotTarget', 'windowList', 'cursorPosition', 'backgroundKey',
    'foregroundClick', 'foregroundType', 'foregroundKey', 'screenScope', 'lockscreen']) {
    assert.deepEqual(t[key], f[key], `${key} 不该随 uiaReady 变`);
  }
  assert.equal(t.backgroundClick.status, 'available');
  assert.equal(f.backgroundClick.status, 'available', 'comtypes 缺失时点击仍可用(只是 coverage:narrow),不能翻成 unsupported');
  assert.equal(t.backgroundClick.coverage, 'partial');
  assert.equal(f.backgroundClick.coverage, 'narrow');
  assert.equal(f.backgroundKey.status, 'unsupported', 'backgroundKey 两个 uia 档都不支持(UIA 没有组合键 pattern)');
});

process.exit(report.finish());
