// r142-wincu / W-D01..W-D03 —— macOS 侧"一字不改"的反向守卫。
//
// 为什么必须有:整套 Windows 补齐都在同一个 capabilityReport / 同一个路由里动手,最容易的回归
// 就是"顺手把 mac 也改了"(§4.1 第 1 条、§A-3 #5 的"限定 win32"、§4.1 第 7 条的 ok 判据)。
//
// 跑法:tests/acceptance/r142-wincu/run-isolated.sh --platform darwin(实例不带平台伪装)
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { api, platform, worktree, EnvironmentBlocked } from './helpers/harness.mjs';

const MAC_BASELINE = JSON.parse(fs.readFileSync(
  path.join(worktree, 'tests', 'unit', 'r142-helpers', 'fixtures', 'cu-mac-baseline.json'), 'utf8'));

test.beforeAll(async () => {
  if (platform() !== 'darwin') throw new EnvironmentBlocked(`本文件要求 CGUI_TEST_PLATFORM=darwin(当前 ${platform()})`);
  const r = await api('/api/computer-use/status');
  if (r.status !== 200) throw new EnvironmentBlocked(`/api/computer-use/status 不可用(HTTP ${r.status})`);
});

test('W-D01 darwin 能力表与修前基线逐字节一致', async () => {
  const { body } = await api('/api/computer-use/status');
  expect(body.capabilities, '§4.1:mac 输出逐字节不变(新键只在 win32 出现)').toEqual(MAC_BASELINE.capabilityReportDarwin.capabilities);
  expect(body.lockscreen).toEqual(MAC_BASELINE.capabilityReportDarwin.lockscreen);
});

test('W-D02 darwin 的 /status 不带 win32 专属顶层字段', async () => {
  const { body } = await api('/api/computer-use/status');
  expect(body.appIdKind, '§A-3 #6:这三个字段只在 win32 出').toBeUndefined();
  expect(body.inputMode).toBeUndefined();
  expect(body.uiaReady).toBeUndefined();
  expect(body.supported).toBe(true);
});

test('W-D03 darwin 的 doctor 判据不许被放宽(accessibility 不可用时仍 CU_PERMISSION_REQUIRED)', async () => {
  const { body } = await api('/api/computer-use/doctor', { method: 'POST' });
  // 本机夹具的 doctor 输出是 win32 风格的 accessibility=not-applicable;mac 侧读它必须仍判"没权限"。
  if (body.checks?.accessibility?.status === 'available') {
    throw new EnvironmentBlocked('本机 mac 真的拿到了辅助功能权限,这条反向守卫不成立;请在无权限的环境跑');
  }
  expect(body.ok, '§A-3 #5:ok 判据的放宽**只允许 win32**').toBe(false);
  expect(body.code).toBe('CU_PERMISSION_REQUIRED');
});
