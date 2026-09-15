// CG-10 / CG-11:面板里的授权/撤销对 MCP 侧【同一个实例】的即时生效(§F 的 G2/G3 判据)。
// 为什么必须"同一实例":MCP 进程每次动作都重读 grants.json(没有进程内授权缓存),
// 所以"下一个动作立即生效";重启/重连换实例会把这条证据洗掉。
// MCP 探针复用 cu-batch-20260911 的 helpers/cu-mcp.mjs(§F.0.5),夹具窗口用它的 cu-fixture.mjs。
import { test, expect } from '@playwright/test';
import {
  CuMcp, expectToolError, requireActionTool, uniqueId, windowList,
} from '../cu-batch-20260911/helpers/cu-mcp.mjs';
import {
  disposeFixture, ensureFixture, readTargetDoc, resetTargetDoc, waitForTarget,
} from '../cu-batch-20260911/helpers/cu-fixture.mjs';
import { EnvironmentBlocked, requireFlag, sleep } from './helpers/harness.mjs';
import { expandCandidates, grantFirstCandidate, openCuGrants, setGrantViaApi, waitAppListed, waitCandidateList } from './helpers/ui.mjs';

const FIXTURE = 'com.apple.TextEdit';
const WRITE_WHY = '这条要真的改授权状态(收尾会按原字节还原 grants.json)';

test.afterAll(() => { disposeFixture(); });

/** 轮询同一个实例的 window_list,直到夹具窗口出现(或超时报环境不成立,理由同批次 3 的 waitForTarget)。 */
async function waitFixtureWindow(client, pid, { timeoutMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { windows: [] };
  while (Date.now() < deadline) {
    last = await windowList(client, { allowEmpty: true });
    const hit = last.windows.find((w) => w.pid === pid);
    if (hit) return hit;
    await sleep(400);
  }
  throw new EnvironmentBlocked(
    `同一实例授权后 window_list 仍没列出夹具窗口(pid ${pid})。已知三种成因:应用没被授权;窗口不在操作者当前看的那个 Space`
    + `(开着 Stage Manager / 前台是全屏应用时,产品只列当前可见 Space 的窗口);文档被另一个 TextEdit 进程接管。`
    + `本次列到:${last.windows.map((w) => `${w.pid}:"${w.title}"`).join(', ') || '无'}`,
  );
}

test('CG-10 经面板授权 → 同一个 MCP 实例立刻能查到该应用的窗口', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  const fixture = ensureFixture();
  await waitAppListed(FIXTURE);
  await setGrantViaApi({ bundleId: FIXTURE, granted: false }); // 复位成未授权,别让上一轮留下的状态冒充证据
  const client = await CuMcp.start({ label: 'cg10' });
  try {
    const before = await windowList(client, { allowEmpty: true });
    expect(before.windows.some((w) => w.pid === fixture.pid), '授权前该应用的窗口不该出现').toBe(false);

    await openCuGrants(page);
    await expandCandidates(page);
    await waitCandidateList(page);
    const bundleId = await grantFirstCandidate(page, { prefer: FIXTURE });
    expect(bundleId).toBe(FIXTURE);

    const win = await waitFixtureWindow(client, fixture.pid);
    console.log(`   同一实例授权后看到 #${win.windowId} pid=${win.pid} "${win.title}"`);
  } finally {
    client.close();
  }
});

test('CG-11 经面板撤销 → 同一实例对先前可用的 target 发动作 → CU_APP_NOT_ALLOWED,零投递', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  requireFlag('CU_ALLOW_INPUT', '这条会向夹具窗口发一次定向动作;撤销生效时必须零投递,没生效也只落在可丢弃的夹具窗口里');
  ensureFixture();
  await waitAppListed(FIXTURE);
  await setGrantViaApi({ bundleId: FIXTURE, granted: true });
  const client = await CuMcp.start({ label: 'cg11' });
  try {
    requireActionTool(client, 'type');
    const target = await waitForTarget(client); // 先证明这个 target 在撤销前是可用的
    // 独立判据(夹具文档的 AX 读回)要跑套件的终端有 辅助功能 权限;没有就如实降级并在输出里说明,
    // 不静默当成"验过了"(§F.3:不得用弱观测冒充判据)。
    let axAvailable = true;
    try {
      resetTargetDoc(target);
    } catch (error) {
      // 注意:夹具 helper 抛的是它自己那份 EnvironmentBlocked(与 harness 的不是同一个类),
      // 所以按名字判,不能按 instanceof。
      if (error?.name !== 'EnvironmentBlocked' && !String(error?.message || '').startsWith('ENVIRONMENT_BLOCKED')) throw error;
      axAvailable = false;
      console.log(`   [注] AX 读回不可用,零投递只能靠回执 + window_list 两半证据:${error.message.slice(0, 100)}`);
    }
    const marker = `CG11-SHOULD-NOT-LAND-${uniqueId('x')}`;

    // 经面板撤销(不是 curl、不是改文件)
    await openCuGrants(page);
    const row = page.locator(`[data-testid="cu-grant-row"][data-bundle-id="${FIXTURE}"]`);
    await expect(row, '撤销前该行应在列表里').toBeVisible({ timeout: 15_000 });
    await row.getByTestId('cu-grant-revoke').click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });

    const res = await client.call('type', {
      actionId: uniqueId('cg11'), target: { bundleId: target.bundleId, pid: target.pid, windowId: target.windowId }, text: marker,
    });
    const receipt = expectToolError(res, { code: 'CU_APP_NOT_ALLOWED' });
    expect([receipt.method, receipt.verification].filter((v) => v !== undefined), '失败回执不得声称任何投递').toEqual([]);
    if (axAvailable) expect(readTargetDoc(target), '撤销后的动作必须零投递(夹具文档仍为空)').toBe('');
    const listing = await windowList(client, { allowEmpty: true });
    expect(listing.windows.some((w) => w.pid === target.pid), '撤销后该应用的窗口不该再被列出').toBe(false);
  } finally {
    client.close();
  }
});
