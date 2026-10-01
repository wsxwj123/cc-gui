#!/usr/bin/env node
// r142 / T-6 —— Windows helper 的契约(§3.1 A-1:子命令名复用 mac 全套 + 只多两个;§6.1 T-6)。
//
// 为什么"子命令名/输出字段"必须逐项对齐:mcp-server 是平台无关的,它按固定子命令 + 固定字段解析
// stdout 的最后一行 JSON(`mcp-server.js:150-157`)。名字或字段对不上,Windows 上就是"每个动作都
// 回 CU_DISPATCH_FAILED",而且看不出原因。
//
// ⚠️ 本文件里除 py 语法编译外,**都是静态断言**(读源码),不是行为验证 —— 真机行为在 TEST-PLAN 的
// Windows 清单里。静态断言的定位:能挡住"文件没写/名字写错/关键 API 没调",挡不住"调了但参数错"。
//
// 跑法:node tests/unit/check-cu-helper-contract.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CU_DIR = join(ROOT, 'server', 'computer-use');
const MAC_HELPER = join(CU_DIR, 'cu_helper.py');
const WIN_HELPER = join(CU_DIR, 'cu_helper_windows.py');
const PY = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
const report = makeReport('check-cu-helper-contract');

const macSrc = fs.readFileSync(MAC_HELPER, 'utf8');
const winSrc = fs.existsSync(WIN_HELPER) ? fs.readFileSync(WIN_HELPER, 'utf8') : null;
/** mac 侧的子命令以 **argparse 自己印的** --help 为准(不是我在测试里手抄的清单)。 */
function macSubcommands() {
  const r = spawnSync(PY, [MAC_HELPER, '--help'], { encoding: 'utf8' });
  const m = /\{([a-z0-9,\-]+)\}/.exec(r.stdout || '');
  return m ? m[1].split(',').sort() : null;
}
function winSubcommands(src) {
  return [...src.matchAll(/add_parser\(\s*["']([^"']+)["']/g)].map((m) => m[1]).sort();
}

// ── T6-01 文件存在且语法可编译(修前红)──────────────────────────────
await report.check('T6-01', 'cu_helper_windows.py 存在,且能通过 Python 语法编译(不写 __pycache__)', 'red', () => {
  assert.ok(fs.existsSync(WIN_HELPER), `缺 ${WIN_HELPER};§3.1 A-1 要求新增这个文件,否则 Windows 没有任何执行层`);
  const r = spawnSync(PY, ['-c', 'import sys;compile(open(sys.argv[1],encoding="utf-8").read(),sys.argv[1],"exec")', WIN_HELPER], { encoding: 'utf8' });
  assert.equal(r.status, 0, `语法编译失败:\n${String(r.stderr).slice(0, 600)}`);
});

// ── T6-02 子命令名集合 = mac 全套 + uia-probe/release-hold(修前红)────
await report.check('T6-02', '子命令集合 = mac 全套 ∪ {uia-probe, release-hold},一个不缺一个不多', 'red', () => {
  const mac = macSubcommands();
  assert.ok(mac, 'mac helper 的 --help 解析失败(夹具故障,不是产品问题)');
  const win = winSubcommands(winSrc || '');
  const missing = mac.filter((s) => !win.includes(s));
  const extra = win.filter((s) => !mac.includes(s) && !['uia-probe', 'release-hold'].includes(s));
  assert.deepEqual(missing, [], `这些 mac 子命令在 Windows helper 里缺失(§A-1:复用全部子命令名,不许缺,阶段 A 也要同名存在):${missing.join(', ')}`);
  assert.deepEqual(extra, [], `Windows helper 多出了方案没认的子命令(多一个名字 = mcp-server 不认识 = 死代码):${extra.join(', ')}`);
  for (const must of ['uia-probe', 'release-hold']) {
    assert.ok(win.includes(must), `缺新子命令 ${must}(§2.5① 的可用性探测 / §3.2 B-2 层 4 的释放入口)`);
  }
});

// ── T6-03 输出字段契约:两份 helper 必须同形(修前红)────────────────
const FIELDS = [
  ['windows', /["']frontmost["']/, 'window_list 的焦点判定(mcp-server.js:737-738 focusMatches)靠它'],
  ['cursor', /["']point["']/, 'cursor_position 回执的 point'],
  ['cursor(local)', /["']local["']/, '未授权全屏范围时的局部坐标'],
  ['apps', /["']bundleId["']/, '面板「添加应用」按 bundleId 收口(routes:248-257)'],
  ['apps(name)', /["']name["']/, '候选名单的显示名'],
  ['doctor', /["']screen_recording["']/, 'doctor 的屏幕读取项(routes:176-181)'],
  ['doctor(accessibility)', /["']accessibility["']/, 'doctor 的辅助功能项'],
  ['doctor(capture_test)', /["']capture_test/, 'doctor 的截图自检项'],
];
await report.check('T6-03', '两份 helper 的输出字段同形(windows.frontmost / cursor.point+local / apps.bundleId+name / doctor.*)', 'red', () => {
  assert.ok(winSrc, 'cu_helper_windows.py 不存在,输出字段无从核对(跨平台解析靠的就是这套字段名)');
  const gaps = [];
  for (const [label, re, why] of FIELDS) {
    if (!re.test(macSrc)) gaps.push(`mac helper 自己就没有 ${label}(夹具口径变了?)`);
    if (!re.test(winSrc)) gaps.push(`Windows helper 缺 ${label}(${why})`);
  }
  assert.deepEqual(gaps, [], gaps.join('\n'));
});

// ── T6-04 静态必备项(§3.1 A-1 / R5 / R7 / §3.2 B-2)(修前红)─────────
await report.check('T6-04', '静态必备:SendInput / DPI 感知 / UTF-8 重配 / 无 sips / 无 pywin32 / hold 机制', 'red', () => {
  const must = [
    [/SendInput/, '全局投递只有 SendInput 一条路(§2.1 阶梯 2)'],
    [/SetProcessDpiAwarenessContext/, '不设 DPI 感知 ⇒ 150% 缩放下坐标全错(§A-1 / R5)'],
    [/reconfigure\(\s*encoding\s*=\s*["']utf-8["']/, 'stdout 必须在任何输出之前重配 UTF-8,否则中文 Windows 下 JSON 乱码(R7)'],
    [/advapi32/, '完整性级别前置检查(UIPI)要 advapi32(R2)'],
    [/hold-\{?[^"']*\}?\.json|hold-%|hold-\{pid\}|hold-["']\s*\+/, '按住状态必须落 hold-<pid>.json(§3.2 B-2 层 2 的磁盘凭据)'],
    [/release-hold/, 'release-hold 子命令(B-2 层 4 / 层 2 的补发抬起入口)'],
  ];
  const banned = [
    [/sips/, '不许再用 sips(FORENSICS ②:它 mac 专有且静默失败)'],
    [/import\s+win32com|from\s+win32com|import\s+pywintypes|import\s+win32api/, '方案钉的是 comtypes,不装 pywin32(§2.4)'],
  ];
  const gaps = [];
  for (const [re, why] of must) if (!re.test(winSrc || '')) gaps.push(`缺 ${re} —— ${why}`);
  for (const [re, why] of banned) if (re.test(winSrc || '')) gaps.push(`出现了不该有的 ${re} —— ${why}`);
  assert.deepEqual(gaps, [], gaps.join('\n'));
});

// ── T6-05 阶段 A 的稳定错误码必须在(§2.3 / §A-1)(修前红)─────────────
await report.check('T6-05', '稳定错误码在 helper 侧存在:CU_AX_UNSUPPORTED(阶段 A)与 CU_INPUT_UNSUPPORTED', 'red', () => {
  for (const code of ['CU_AX_UNSUPPORTED', 'CU_INPUT_UNSUPPORTED']) {
    assert.match(winSrc || '', new RegExp(code),
      `Windows helper 里找不到 ${code};阶段 A 的"同名存在"与稳定码是 mcp-server 侧错误码表的对端(§A-1)`);
  }
});

// ── T6-06 mac helper 的子命令集合冻结(修前绿:改 Windows 不许动 mac)──
await report.check('T6-06', 'mac helper 的 15 个子命令集合不变(Windows 化不许顺手改 mac 执行层)', 'green', () => {
  const EXPECTED = ['app-info', 'apps', 'ax-key', 'ax-state', 'ax-type', 'click', 'cursor', 'doctor', 'drag',
    'key', 'screen-info', 'screenshot', 'scroll', 'type', 'windows'];
  assert.deepEqual(macSubcommands(), EXPECTED, 'mac helper 的子命令集合变了(15 个,一个都不能少/多)');
});

process.exit(report.finish());
