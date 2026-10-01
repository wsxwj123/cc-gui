#!/usr/bin/env node
// r142 / T-8 —— uiaReady 的缓存读取(§2.5③④:探测→缓存→读取;§6.1 T-8)。
//
// 为什么需要它:UIA 能不能用只有 Windows 侧的 Python 知道,而 capabilityReport 是**同步纯函数**
// (Express 请求里不能 spawn)。所以结论落在 ~/.claude-gui/cu-runtime/uia-capability.json,
// 面板读缓存。缓存读错 = 面板对"点击还能不能用"给出错误承诺。
//
// 测法:在**本进程**里先改掉 os.userInfo/homedir(与 q8 夹具同款手法),再 import cu-common,
// 这样 RUNTIME_DIR 指向假家目录;四个状态(有/无/坏 JSON/戳不符)逐个造。不改产品代码、不碰真家目录。
//
// 跑法:node tests/unit/check-cu-uia-cache.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BASE = join(HERE, 'r142-helpers', '.artifacts', 't8-cache');
fs.rmSync(BASE, { recursive: true, force: true });
const HOME = join(BASE, 'home');
const RUNTIME = join(HOME, '.claude-gui', 'cu-runtime');
fs.mkdirSync(RUNTIME, { recursive: true });

// 必须在 import cu-common 之前改掉家目录来源
const realUserInfo = os.userInfo;
os.userInfo = (...args) => ({ ...realUserInfo(...args), homedir: HOME });
os.homedir = () => HOME;
syncBuiltinESMExports();

const cu = await import('../../server/computer-use/cu-common.js');
const CACHE = join(RUNTIME, 'uia-capability.json');
const report = makeReport('check-cu-uia-cache');

/** 当前平台(本机 darwin)生效的依赖戳;与 mcp-server.js:36 同款算法。 */
function activeStamp() {
  const src = fs.readFileSync(join(ROOT, 'server', 'computer-use', 'mcp-server.js'), 'utf8');
  const win = /const PY_DEPS_WIN = \[([^\]]*)\]/.exec(src);
  const mac = /const PY_DEPS = \[([^\]]*)\]/.exec(src);
  const pick = process.platform === 'win32' ? win : mac;
  const deps = (pick ? pick[1] : mac[1]).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return createHash('sha256').update(deps.join('|')).digest('hex');
}
const writeCache = (obj) => fs.writeFileSync(CACHE, typeof obj === 'string' ? obj : JSON.stringify(obj));
const rmCache = () => fs.rmSync(CACHE, { force: true });

// ── T8-01 缺省:没有缓存文件(修前红)────────────────────────────────
await report.check('T8-01', 'readUiaCapability() 导出;缓存缺失时回 {uia:false, reason:"尚未探测"}', 'red', () => {
  assert.equal(typeof cu.readUiaCapability, 'function',
    'cu-common.js 必须导出 readUiaCapability()(§2.5④:同步读缓存,不 spawn)');
  rmCache();
  const got = cu.readUiaCapability();
  assert.equal(got.uia, false, `没有缓存却说 uia=${got.uia};面板会承诺一个不存在的后台通道`);
  assert.match(String(got.reason || ''), /尚未探测|未探测|no.*cache/i, `缺省 reason 应说明"尚未探测",实际 ${JSON.stringify(got)}`);
});

// ── T8-02 有效缓存:戳对上才算数(修前红)──────────────────────────────
await report.check('T8-02', '缓存有效(version=1 / uia=true / depsStamp 对得上)时回 uia:true 与 comtypes 版本', 'red', () => {
  assert.equal(typeof cu.readUiaCapability, 'function', 'readUiaCapability 还不存在(见 T8-01)');
  writeCache({ version: 1, uia: true, checkedAt: new Date().toISOString(), comtypes: '1.4.11', depsStamp: activeStamp() });
  const got = cu.readUiaCapability();
  assert.equal(got.uia, true, `戳对得上却说 uia=false:${JSON.stringify(got)}`);
  assert.equal(got.comtypes, '1.4.11', `comtypes 版本没读出来:${JSON.stringify(got)}`);
});

// ── T8-03 坏 JSON:不许抛,降级成"没探测到"(修前红)──────────────────
await report.check('T8-03', '缓存是坏 JSON / 不是对象时,readUiaCapability() 不抛异常且回 uia:false', 'red', () => {
  writeCache('{"version":1,"uia":');
  const a = cu.readUiaCapability();
  assert.equal(a.uia, false, `坏 JSON 竟然被当成 uia=true:${JSON.stringify(a)}`);
  writeCache('"just a string"');
  const b = cu.readUiaCapability();
  assert.equal(b.uia, false, `非对象缓存竟然被当成 uia=true:${JSON.stringify(b)}`);
});

// ── T8-04 依赖戳不符:平台切换/重装即失效(§2.5③)(修前红)─────────────
await report.check('T8-04', 'depsStamp 不符(含"Windows 写的缓存拿到 mac 上用")时缓存失效', 'red', () => {
  const winStamp = createHash('sha256').update(['mss', 'Pillow', 'comtypes>=1.4.0'].join('|')).digest('hex');
  writeCache({ version: 1, uia: true, checkedAt: new Date().toISOString(), comtypes: '1.4.11', depsStamp: winStamp });
  const got = cu.readUiaCapability();
  assert.equal(got.uia, false,
    '依赖戳不符(平台切换/依赖表变了)时缓存必须失效,否则 Windows 上装了 comtypes 的结论会被 mac 读到,反之亦然');
});

// ── T8-05 读取路径与纯函数打通:不注入 uia 时走缓存(修前红)──────────
await report.check('T8-05', 'win32 报告在不注入 uia 时走缓存:戳对的 true 缓存 ⇒ backgroundClick.coverage=partial', 'red', () => {
  writeCache({ version: 1, uia: true, checkedAt: new Date().toISOString(), comtypes: '1.4.11', depsStamp: activeStamp() });
  const caps = cu.capabilityReport({ platformName: 'win32' }).capabilities;
  assert.equal(caps.backgroundClick.coverage, 'partial',
    `缓存说 UIA 可用,能力表却没反映出来:${JSON.stringify(caps.backgroundClick)}`);
  writeCache({ version: 1, uia: false, checkedAt: new Date().toISOString(), depsStamp: activeStamp() });
  const caps2 = cu.capabilityReport({ platformName: 'win32' }).capabilities;
  assert.equal(caps2.backgroundClick.coverage, 'narrow',
    `缓存说 UIA 不可用,能力表却还是 partial:${JSON.stringify(caps2.backgroundClick)}`);
});

// ── T8-06 mac 不碰缓存(修前绿:darwin 分支与这两个新东西无关)─────────
await report.check('T8-06', 'darwin 报告不受缓存影响(哪怕缓存写着 uia:true)', 'green', () => {
  const BASELINE = JSON.parse(fs.readFileSync(join(HERE, 'r142-helpers', 'fixtures', 'cu-mac-baseline.json'), 'utf8'));
  writeCache({ version: 1, uia: true, checkedAt: new Date().toISOString(), comtypes: '1.4.11', depsStamp: activeStamp() });
  assert.deepEqual(cu.capabilityReport({ platformName: 'darwin' }), BASELINE.capabilityReportDarwin,
    'mac 的能力表被 uia 缓存影响了(§4.1:mac 分支完全不碰这两个新东西)');
});

fs.rmSync(BASE, { recursive: true, force: true });
process.exit(report.finish());
