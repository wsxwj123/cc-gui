// UI 层(浏览器)用例的公开导航:坞(panel-dock-toggle)→ rail →「工具」→ 页签「MCP 服务器」
// → 卡片里的「应用授权」区块。
// 导航口径复用 bugs-20260912 套件的 runtime.mjs(§F.0.5 指定的那条),DOM 只用产品自己给的
// data-testid / role / 公开文案 —— 不注入测试专用属性、不读产品内部 state。
import { expect } from '@playwright/test';
import { dismissOverlays, openPanel } from '../../bugs-20260912/helpers/runtime.mjs';
import { EnvironmentBlocked, uiBase, api } from './harness.mjs';

/**
 * 打开「应用授权」区块并返回它的 locator。
 * 前置(§F.0.7):/api/computer-use/status 得回 registered:true —— 卡片只在已注册时渲染这一块。
 * 夹具 HOME 里已备好一份合成的 .claude.json(见 helpers/prepare-home.mjs);为 false 就是环境不成立。
 */
export async function openCuGrants(page) {
  const status = await api('/api/computer-use/status');
  if (status.status !== 200) throw new EnvironmentBlocked(`/api/computer-use/status 不可用(HTTP ${status.status})`);
  if (status.body?.supported !== true) throw new EnvironmentBlocked('computer use 只在 macOS 提供,卡片不会渲染');
  if (status.body?.registered !== true) {
    throw new EnvironmentBlocked('隔离实例的夹具 HOME 里没有 ccgui-computer-use 注册项:卡片只在 registered:true 时渲染 cu-grants,先看 helpers/prepare-home.mjs');
  }
  await page.goto(uiBase(), { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await openPanel(page, '工具'); // 坞 rail 里的短名(PANEL_SHORT.mcp);用 title 长名匹配不到
  const tab = page.getByRole('tab', { name: 'MCP 服务器' });
  await expect(tab, '工具面板要挂出来').toBeVisible({ timeout: 20_000 });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  const grants = page.getByTestId('cu-grants');
  await expect(grants, '桌面操控卡里的「应用授权」区块').toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('cu-grants-title')).toHaveText('应用授权');
  return grants;
}

/** 等某个应用出现在 /apps 的候选名单里(夹具应用刚启动时进程枚举有个滞后)。 */
export async function waitAppListed(bundleId, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];
  while (Date.now() < deadline) {
    const r = await api('/api/computer-use/apps');
    seen = (r.body?.apps || []).map((a) => a.bundleId);
    if (seen.includes(bundleId)) return seen;
    await new Promise((res) => setTimeout(res, 400));
  }
  throw new EnvironmentBlocked(`${bundleId} 一直没出现在 /apps 候选里(当前 ${seen.length} 条:${seen.slice(0, 8).join(', ')})`);
}

/** 展开候选列表(幂等:已展开就不重复点)。 */
export async function expandCandidates(page) {
  const add = page.getByTestId('cu-grant-add');
  await expect(add).toBeVisible();
  if ((await add.getAttribute('aria-expanded')) !== 'true') await add.click();
  await expect(page.getByTestId('cu-apps-note')).toBeVisible({ timeout: 15_000 });
}

/** 等候选列表出结果(排除 loading / unavailable 两种中间态)。 */
export async function waitCandidateList(page, { timeoutMs = 20_000 } = {}) {
  const option = page.getByTestId('cu-app-option').first();
  const empty = page.getByTestId('cu-apps-empty');
  await expect.poll(async () => (await option.count()) > 0 || (await empty.isVisible().catch(() => false)), {
    timeout: timeoutMs, message: '候选列表要出结果(既不是 loading 也没报不可用)',
  }).toBe(true);
}

/**
 * 点一个还没授权的候选项的「授权」,返回它的 bundleId。
 * prefer 指定的 bundleId 优先(用例倾向授权可随时丢弃的夹具应用,而不是操作者正在用的应用)。
 */
export async function grantFirstCandidate(page, { prefer = null } = {}) {
  const buttons = page.getByTestId('cu-app-grant');
  await expect(buttons.first(), '至少要有一个没授权的候选项').toBeVisible({ timeout: 15_000 });
  let target = buttons.first();
  if (prefer) {
    const preferred = page.locator(`[data-testid="cu-app-grant"][data-bundle-id="${prefer}"]`);
    if (await preferred.count()) target = preferred.first();
  }
  const bundleId = await target.getAttribute('data-bundle-id');
  await target.click();
  await expect(page.locator(`[data-testid="cu-app-option"][data-bundle-id="${bundleId}"]`)).toHaveAttribute('data-granted', 'true', { timeout: 15_000 });
  return bundleId;
}

/** 读公开端点的授权名单(bundleId 列表),用作与界面交叉核对的独立观测面。 */
export async function grantedFromServer() {
  const r = await api('/api/computer-use/grants');
  if (r.status !== 200) throw new EnvironmentBlocked(`GET /grants 不可用(HTTP ${r.status})`);
  return (r.body?.apps || []).map((a) => a.bundleId);
}

/** 直接经产品端点安排授权状态(等价于"用户在别处操作过"),界面随后按服务端真值重绘。 */
export async function setGrantViaApi(payload) {
  const r = await api('/api/computer-use/grants', { method: 'POST', body: payload });
  if (r.status !== 200 || r.body?.ok !== true) throw new EnvironmentBlocked(`POST /grants 失败(HTTP ${r.status}):${r.text?.slice(0, 120)}`);
  return r.body;
}
