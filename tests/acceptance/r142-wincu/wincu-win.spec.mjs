// r142-wincu / W-01..W-06 —— 伪 win32 隔离实例上的 HTTP 契约(§3.1 A-3 路由层改动 + §4.1 字段分工)。
//
// 跑法:tests/acceptance/r142-wincu/run-isolated.sh --platform win32
// 前置:实例用 helpers/win-preload.mjs 起(process.platform 被改成 win32),HOME = 夹具目录。
//
// ⚠️ 这是"平台分派"验收,不是 Windows API 验收:真机行为见 TEST-PLAN 的 Windows 清单。
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, platform, EnvironmentBlocked, waitFor } from './helpers/harness.mjs';

test.beforeAll(async () => {
  if (platform() !== 'win32') throw new EnvironmentBlocked(`本文件要求 CGUI_TEST_PLATFORM=win32(当前 ${platform()})`);
  const r = await api('/api/computer-use/status');
  if (r.status !== 200) throw new EnvironmentBlocked(`/api/computer-use/status 不可用(HTTP ${r.status})`);
  if (r.body.platform !== 'win32') {
    throw new EnvironmentBlocked(`实例报的 platform 是 ${r.body.platform},不是 win32 —— 预加载没生效?看 run-isolated.sh 的 --import`);
  }
});

test('W-01 Windows 上这张卡必须存在:supported=true 且不再因平台被隐藏', async () => {
  const { body } = await api('/api/computer-use/status');
  expect(body.supported, '§3.1 A-3 #3:supported 判据要认 win32,否则 MCPPanel.jsx:35 仍然 return null').toBe(true);
  expect(body.platform).toBe('win32');
  expect(body.capabilities.screenshot.status, 'Windows 阶段 A 起截图就可用').toBe('available');
});

test('W-02 顶层新字段齐备:appIdKind / inputMode / uiaReady', async () => {
  const { body } = await api('/api/computer-use/status');
  expect(body.appIdKind, '§3.1 A-3 #6:Windows 的应用身份是 exe 路径').toBe('exePath');
  expect(['background', 'background-partial', 'background-message-only', 'global-only', 'none'])
    .toContain(body.inputMode);
  expect(typeof body.uiaReady).toBe('boolean');
  expect(body.capabilities.inputMode, '§4.1 第 1 条:inputMode 由路由层补,不许塞进 capabilityReport 的返回体')
    .toBeUndefined();
});

test('W-03 win32 能力表:前台三件套要显式声明,unsupported 必带 reason', async () => {
  const { body } = await api('/api/computer-use/status');
  const caps = body.capabilities;
  for (const key of ['foregroundClick', 'foregroundType', 'foregroundKey']) {
    expect(caps[key], `§4.1 阶段 A/B 都要有 ${key}`).toBeTruthy();
  }
  for (const [key, entry] of Object.entries(caps)) {
    expect(['available', 'unsupported', 'unverified'], `${key}.status`).toContain(entry.status);
    if (entry.status !== 'available') {
      expect(String(entry.reason || '').length, `${key} 不是 available 却没说清理由(合同第 9 段)`).toBeGreaterThan(4);
    }
  }
  const text = JSON.stringify(caps);
  expect(text, 'win32 能力表里不许再出现 mac 平台借口').not.toMatch(/仅 macOS|只实现 macOS/);
});

test('W-04 doctor 在 Windows 上:accessibility=not-applicable、有 DPI/完整性/UIA 三项,且不误报 CU_PERMISSION_REQUIRED', async () => {
  const { body } = await api('/api/computer-use/doctor', { method: 'POST' });
  expect(body.permissions?.accessibility?.status, '§A-4:Windows 没有 TCC 模型,这一项恒 not-applicable')
    .toBe('not-applicable');
  expect(body.checks?.screenRead?.status).toBe('available');
  for (const key of ['dpiAwareness', 'integrityLevel', 'uia']) {
    expect(body.checks?.[key], `§A-4 要求 doctor 报 ${key}`).toBeTruthy();
  }
  expect(body.code, 'screenRead=available 时不该再要求权限(§A-3 #5:ok 判据的放宽只给 win32)')
    .not.toBe('CU_PERMISSION_REQUIRED');
});

test('W-05 not-applicable 只允许出现在 doctor 的 checks/permissions,不许进 capabilities', async () => {
  const status = await api('/api/computer-use/status');
  const doctor = await api('/api/computer-use/doctor', { method: 'POST' });
  const offenders = [];
  for (const [key, entry] of Object.entries(status.body.capabilities)) {
    if (entry.status === 'not-applicable') offenders.push(`capabilities.${key}`);
  }
  expect(offenders, '§A-4 的唯一边界:not-applicable 进了 capabilities 会破 cu-batch 的枚举断言').toEqual([]);
  expect(JSON.stringify(doctor.body.checks)).toContain('not-applicable');
});

test('W-06 POST /prepare 存在且可用:清掉运行时 → 建 venv-win → 装依赖 → 跑 uia-probe → 写缓存', async () => {
  // 自带前置(2026-10-02 修):旧版要求实例用 --no-venv 起,否则报 ENVIRONMENT_BLOCKED ——
  // 那让"跑一遍 -g W-0"永远带一个红,而且验的其实是"起实例的方式"。
  // 现在自己把夹具里的 venv-win / 依赖戳 / uia 缓存删掉(等价于全新机器),再走 /prepare 重建,
  // 比原来更强:任何配置下都能跑,且真的会执行一次 venv 创建。
  const home = process.env.CGUI_TEST_HOME;
  if (!home) throw new EnvironmentBlocked('CGUI_TEST_HOME 未设置(run-isolated.sh 负责传夹具 HOME)');
  const runtime = path.join(home, '.claude-gui', 'cu-runtime');
  fs.rmSync(path.join(runtime, 'venv-win'), { recursive: true, force: true });
  fs.rmSync(path.join(runtime, 'venv-win.stamp'), { force: true });
  fs.rmSync(path.join(runtime, 'uia-capability.json'), { force: true });

  const before = await api('/api/computer-use/status');
  expect(before.body.runtimeReady, '清掉 venv-win 之后 runtimeReady 必须为 false(前置成立,不是假设)').toBe(false);
  expect(before.body.uiaReady, '缓存也清掉了 ⇒ uiaReady 不能还是 true').toBe(false);

  const r = await api('/api/computer-use/prepare', { method: 'POST', timeoutMs: 120_000 });
  expect(r.status, `§2.5②:PREPARE 是用户主动准备入口(HTTP ${r.status})`).toBe(200);
  expect(r.body.ok, `prepare 应成功:${JSON.stringify(r.body).slice(0, 300)}`).toBe(true);
  expect(r.body.uiaReady, '§2.5②:prepare 顺带跑一次 uia-probe --selftest,回执里要有结论').toBe(true);

  const after = await waitFor(async () => {
    const s = await api('/api/computer-use/status');
    return s.body.runtimeReady ? s.body : null;
  }, { timeoutMs: 20_000 });
  expect(after?.runtimeReady, 'prepare 之后 runtimeReady 必须为真(venv-win + venv-win.stamp 都建出来)').toBe(true);
  expect(after?.uiaReady, 'prepare 写下的 uia 结论要能被 /status 读到').toBe(true);
  expect(after?.inputMode, 'uiaReady=true ⇒ background-partial').toBe('background-partial');

  // 端到端证据:建出来的解释器必须是**能执行的** POSIX 壳脚本(旧夹具把 .mjs 拷成 .exe ⇒ ERR_UNKNOWN_FILE_EXTENSION)
  const py = path.join(runtime, 'venv-win', 'Scripts', 'python.exe');
  expect(fs.existsSync(py), 'Windows venv 布局必须是 venv-win/Scripts/python.exe').toBe(true);
  const head = fs.readFileSync(py, 'utf8').split('\n')[0];
  expect(head, `新解释器必须是 #!/bin/sh 壳脚本,实际首行:${head}`).toBe('#!/bin/sh');
  const probe = spawnSync(py, ['--version'], { encoding: 'utf8' });
  expect(probe.status, `建出来的解释器执行失败(旧缺陷 2 就是这个):${probe.stderr}`).toBe(0);
});
