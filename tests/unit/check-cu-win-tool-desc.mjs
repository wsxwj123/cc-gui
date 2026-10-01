#!/usr/bin/env node
// r142 / T-5 —— 工具描述的平台化(§3.1 A-2 #10 把 TOOLS 抽成 buildTools(platformName);§6.1 T-5)。
//
// 为什么要测描述:模型只看得见描述。macOS 的描述写着"默认后台定向投递、不抢前台",照搬到 Windows
// 就是假话(Chromium/UWP 后台通道覆盖不到)——模型会据此以为一定成功。
//
// 两条铁律:
//   ① **工具集合与 inputSchema 一个字都不许变**(§6.4 分歧一:12 个工具全保留;
//      check-cu-protocol.mjs:78-81 的"必须保留"断言 + :82-95 的 schema 循环会直接红);
//   ② darwin 的描述与修前基线逐字节相同(fixtures/cu-tools-darwin.json)。
//
// 跑法:node tests/unit/check-cu-win-tool-desc.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAC_TOOLS = JSON.parse(fs.readFileSync(join(HERE, 'r142-helpers', 'fixtures', 'cu-tools-darwin.json'), 'utf8'));
const mcp = await import('../../server/computer-use/mcp-server.js');
const report = makeReport('check-cu-win-tool-desc');

const SIDE_EFFECT = ['left_click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key'];
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));

// ── T5-01 buildTools 必须是纯函数(§A-2 #10)(修前红)──────────────────
await report.check('T5-01', 'mcp-server.js 导出 buildTools(platformName) 纯函数(描述平台化唯一入口)', 'red', () => {
  assert.equal(typeof mcp.buildTools, 'function',
    'mcp-server.js 没有导出 buildTools(platformName);§A-2 #10 要求把 TOOLS 抽成纯函数,否则描述改不了平台又测不了');
  assert.ok(Array.isArray(mcp.buildTools('darwin')) && mcp.buildTools('darwin').length >= 12,
    'buildTools("darwin") 必须返回完整工具数组');
});

// ── T5-02 darwin 描述逐字节不变 + 线上 TOOLS 就是 darwin 那份(修前绿)──
await report.check('T5-02', 'buildTools("darwin") 与修前基线逐字节一致,且 tools/list 用的 TOOLS 就是它', 'green', () => {
  const darwin = typeof mcp.buildTools === 'function' ? mcp.buildTools('darwin') : mcp.TOOLS;
  assert.deepEqual(darwin, MAC_TOOLS, 'macOS 工具描述/ schema 变了(方案要求 darwin 逐字节不变)');
  assert.deepEqual(mcp.TOOLS, MAC_TOOLS, '导出的 TOOLS 必须仍是 darwin 描述(tools/list 直接用它)');
});

// ── T5-03 win32:12 个工具全在,schema 与 mac 完全一致,只有描述可以不同(修前红)──
await report.check('T5-03', 'buildTools("win32") 保留全部 12 个工具,且 inputSchema 与 mac 逐字节相同', 'red', () => {
  assert.equal(typeof mcp.buildTools, 'function', 'buildTools 还不存在(见 T5-01)');
  const win = byName(mcp.buildTools('win32'));
  const mac = byName(MAC_TOOLS);
  assert.deepEqual(Object.keys(win).sort(), Object.keys(mac).sort(),
    '工具集合变了。§6.4 分歧一:12 个工具全部保留(阶段 A 也不许从 tools/list 去掉),否则 check-cu-protocol:78-81 直接红');
  for (const name of Object.keys(mac)) {
    assert.equal(JSON.stringify(win[name].inputSchema), JSON.stringify(mac[name].inputSchema),
      `${name} 的 inputSchema 在 win32 上变了;参数契约是跨平台一致的(check-cu-protocol:82-95 会红)`);
  }
});

// ── T5-04 win32 描述必须说清阶梯,不许照抄 mac 的无条件承诺(修前红)────
await report.check('T5-04', 'win32 的 7 个副作用工具描述:写了阶梯/覆盖边界/显式同意,且与 mac 不同', 'red', () => {
  const win = byName(mcp.buildTools('win32'));
  const mac = byName(MAC_TOOLS);
  const missing = [];
  for (const name of SIDE_EFFECT) {
    const d = String(win[name].description || '');
    if (d === mac[name].description) missing.push(`${name}: 描述与 mac 一模一样(照抄"不抢前台"的承诺)`);
    if (!/UI ?Automation|UIA|元素/i.test(d)) missing.push(`${name}: 没提 UIA/元素级后台通道`);
    if (!/消息投递|PostMessage|窗口消息|直投/.test(d)) missing.push(`${name}: 没说还有消息投递这条降级通道`);
    if (!/覆盖不到|明确报错|无法|不支持的后台|CU_BACKGROUND_UNSUPPORTED/.test(d)) missing.push(`${name}: 没写清覆盖边界/失败会明确报错`);
  }
  assert.deepEqual(missing, [], `win32 工具描述的缺口:\n  ${missing.join('\n  ')}`);
});

// ── T5-05 win32 的 type 不许承诺"一定读回验证"(修前红)────────────────
await report.check('T5-05', 'win32 的 type 描述:读回验证要带 unknown 出口,不许无条件承诺已写入', 'red', () => {
  const d = String(byName(mcp.buildTools('win32')).type.description || '');
  assert.notEqual(d, byName(MAC_TOOLS).type.description, 'type 描述与 mac 相同(照抄了"用读回原文验证")');
  assert.match(d, /unknown|读不回|无法读回|验证不了/,
    `type 描述必须说明读不回时 verification=unknown,实际:${d.slice(0, 200)}`);
});

// ── T5-06 win32 的 foreground 语义必须写成"只有显式同意才走全局"(修前红)──
await report.check('T5-06', 'win32 的前台工具描述:全局投递必须写明"仅在你显式同意后"', 'red', () => {
  const win = byName(mcp.buildTools('win32'));
  const bad = [];
  for (const name of SIDE_EFFECT) {
    const d = String(win[name].description || '');
    if (!/显式同意|显式要求|只有你.*同意|foreground:true/.test(d)) bad.push(name);
  }
  assert.deepEqual(bad, [], `这些工具的描述没说清"全局投递要显式同意":${bad.join(', ')}`);
});

process.exit(report.finish());
