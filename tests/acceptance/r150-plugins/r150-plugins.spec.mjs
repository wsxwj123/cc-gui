// r150 E 组验收:插件面板看得到账号同步的插件,并能停用 / 启用。
//
// 背景:Claude CLI 会把 claude.ai 账号上启用的插件同步到本机,`claude plugin list` 把它们列在
// 「Synced from claude.ai」一段。它们不在 ~/.claude/plugins/installed_plugins.json 里,而插件面板的列表
// 只读那个文件 —— 面板里看不到它们,用户没有入口整个停用;它们带来的 MCP 却出现在 MCP 列表里。
//
//   E1 后端插件列表返回这一段的插件(来源标记、版本、启用状态;loaded 与 enabled 都算启用)
//   E2 面板把它们单独成组(「账号同步的插件」),每个可停用 / 启用(名字用 <name>@synced),不提供卸载与更新
//   E3 停用 / 启用后,插件列表与 MCP 列表的缓存失效,面板里看得到变化
//
// 假 claude 见 helpers/fake-claude.mjs:plugin list / mcp list 照状态文件输出,enable / disable 改状态文件。
// 只由 run.sh 调起(临时 HOME、端口 6700–6999)。
import { test, expect } from '@playwright/test';
import { initialState, writeState, readState, readCalls, clearCalls, setMcpListDelay, SYNCED_MCP } from './helpers/fixtures.mjs';
import { boot, openToolsTab, syncedGroup, installedGroup, pluginCard, cardNames, refreshButton, mcpRowCount, SYNCED_GROUP_TITLE } from './helpers/ui.mjs';

const enc = encodeURIComponent;
const pluginByName = (data, name) => (data.plugins || []).find((p) => p.name === name);
const mcpNames = (data) => (data.mcpServers || []).map((s) => s.name);
const getMcp = async (request, fresh = false) => {
  const r = await request.get(fresh ? '/api/mcp?fresh=1' : '/api/mcp');
  expect(r.ok(), `GET /api/mcp 应成功(实得 ${r.status()})`).toBeTruthy();
  return r.json();
};

/** 回到初始场景,并让后端把缓存作废后完整重建一次。返回重建后的列表。 */
async function reset(request, state = initialState()) {
  setMcpListDelay(0);
  writeState(state);
  // 借一次"启用 data@synced"让后端把缓存作废(假 claude 会把它置为 enabled,所以之后再把场景写一遍)
  const put = await request.put(`/api/plugins/${enc('data@synced')}/enable`);
  expect(put.ok(), '启用接口应成功').toBeTruthy();
  writeState(state);
  clearCalls();
  return getMcp(request, true);
}

test('E1 后端插件列表返回「Synced from claude.ai」一段的插件:来源标记、版本、启用状态(loaded / enabled 都算启用)', async ({ request }) => {
  const data = await reset(request);
  const design = pluginByName(data, 'design@synced');
  const bio = pluginByName(data, 'bio-research@synced');
  const dat = pluginByName(data, 'data@synced');
  expect(design, '应返回 design@synced').toBeTruthy();
  expect(bio, '应返回 bio-research@synced').toBeTruthy();
  expect(dat, '应返回 data@synced').toBeTruthy();
  expect([design.source, bio.source, dat.source]).toEqual(['synced', 'synced', 'synced']);
  expect([design.version, bio.version, dat.version]).toEqual(['1.2.0', '1.2.0', '3.0.1']);
  expect([design.enabled, bio.enabled, dat.enabled], 'disabled / loaded / enabled').toEqual([false, true, true]);
  // 已安装的两个照旧返回、不带同步标记;与同步段同名的 design@acme-market 的启用状态不被同步段的 disabled 盖掉
  const pua = pluginByName(data, 'pua@pua-skills');
  const designInstalled = pluginByName(data, 'design@acme-market');
  expect(pua && designInstalled, '已安装的插件照旧返回').toBeTruthy();
  expect([pua.source, designInstalled.source].includes('synced')).toBe(false);
  expect(pua.enabled).toBe(true);
  expect(designInstalled.enabled, '同名的同步插件(停用)不许盖掉已安装插件(启用)的状态').toBe(true);
  expect((data.plugins || []).filter((p) => p.name === 'design@synced').length, '同一个插件只出现一次').toBe(1);
});

test('E1 未开同步的环境(标题是 Synced from claude.ai — sync is off in this shell; …)同样返回', async ({ request }) => {
  const state = initialState();
  state.syncHeader = 'Synced from claude.ai — sync is off in this shell; these load only in a synced session:';
  const data = await reset(request, state);
  expect((data.plugins || []).filter((p) => p.source === 'synced').map((p) => p.name).sort()).toEqual(['bio-research@synced', 'data@synced', 'design@synced']);
});

test('E2 面板把账号同步的插件单独成组;组内可停用 / 启用,没有卸载与更新按钮;已安装的一组照旧', async ({ page, request }) => {
  await reset(request);
  await boot(page);
  await openToolsTab(page, '插件');

  const synced = syncedGroup(page);
  await expect(synced, `应有单独的一组「${SYNCED_GROUP_TITLE}」`).toBeVisible();
  await expect(synced).toContainText(SYNCED_GROUP_TITLE);
  expect((await cardNames(synced)).sort(), '同步组里是这三个').toEqual(['bio-research@synced', 'data@synced', 'design@synced']);
  const installed = installedGroup(page);
  expect((await cardNames(installed)).sort(), '已安装组里只有已安装的两个').toEqual(['design@acme-market', 'pua@pua-skills']);

  // 启用状态如实显示
  await expect(pluginCard(page, 'design@synced')).toHaveAttribute('data-enabled', 'false');
  await expect(pluginCard(page, 'bio-research@synced')).toHaveAttribute('data-enabled', 'true');
  await expect(pluginCard(page, 'data@synced')).toHaveAttribute('data-enabled', 'true');
  await expect(pluginCard(page, 'bio-research@synced')).toContainText('1.2.0');

  // 同步组:没有更新、卸载;每张卡片有开关。已安装组(对照):更新、卸载都在
  await expect(synced.locator('button[title^="更新到最新版"]'), '同步的插件不提供更新').toHaveCount(0);
  await expect(synced.locator('button[title^="卸载"]'), '同步的插件不提供卸载').toHaveCount(0);
  await expect(synced.getByTestId('plugin-toggle')).toHaveCount(3);
  await expect(installed.locator('button[title^="更新到最新版"]')).toHaveCount(2);
  await expect(installed.locator('button[title^="卸载"]')).toHaveCount(2);

  // 停用:调的是现有接口,名字是 <name>@synced
  await pluginCard(page, 'bio-research@synced').getByTestId('plugin-toggle').click();
  await expect.poll(() => readCalls(), { message: '假 claude 应收到 plugin disable bio-research@synced', timeout: 15_000 }).toContain('disable bio-research@synced');
  await expect(pluginCard(page, 'bio-research@synced')).toHaveAttribute('data-enabled', 'false');
  expect(readState().synced.find((p) => p.name === 'bio-research').status).toBe('disabled');

  // 启用
  await pluginCard(page, 'design@synced').getByTestId('plugin-toggle').click();
  await expect.poll(() => readCalls(), { message: '假 claude 应收到 plugin enable design@synced', timeout: 15_000 }).toContain('enable design@synced');
  await expect(pluginCard(page, 'design@synced')).toHaveAttribute('data-enabled', 'true');
  // 没有误调卸载 / 更新
  expect(readCalls().every((line) => /^(enable|disable) [a-z-]+@synced$/.test(line)), `只应有对同步插件的 enable / disable(实得 ${JSON.stringify(readCalls())})`).toBe(true);
});

test('E3 停用同步插件后:面板刷新仍是停用,它带来的 MCP 从 MCP 列表里消失;再启用又回来', async ({ page, request }) => {
  await reset(request);
  await boot(page);
  await openToolsTab(page, 'MCP 服务器');
  await refreshButton(page).click();   // 强制完整读一次(含在线状态),MCP 列表里应有同步插件带来的两个
  await expect.poll(() => mcpRowCount(page, SYNCED_MCP['bio-research']), { message: '启用着的同步插件带来的 MCP 应在列表里', timeout: 20_000 }).toBe(1);
  expect(await mcpRowCount(page, SYNCED_MCP.data)).toBe(1);
  expect(await mcpRowCount(page, SYNCED_MCP.design), '停用着的同步插件的 MCP 不在列表里').toBe(0);

  await openToolsTab(page, '插件');
  await expect(pluginCard(page, 'bio-research@synced'), '插件页签里应有 bio-research@synced 的卡片').toBeVisible();
  await pluginCard(page, 'bio-research@synced').getByTestId('plugin-toggle').click();
  await expect.poll(() => readCalls(), { timeout: 15_000 }).toContain('disable bio-research@synced');

  // 不点刷新:MCP 列表自己跟上(停用成功后面板会重读)
  await openToolsTab(page, 'MCP 服务器');
  await expect.poll(() => mcpRowCount(page, SYNCED_MCP['bio-research']), { message: '停用后,它带来的 MCP 应从列表里消失(不用手动刷新)', timeout: 20_000 }).toBe(0);
  await expect.poll(() => mcpRowCount(page, SYNCED_MCP.data), { message: '别的同步插件的 MCP 不受影响', timeout: 20_000 }).toBe(1);

  // 点刷新:仍是停用(后端真实状态,不是界面上的乐观更新)
  await openToolsTab(page, '插件');
  await refreshButton(page).click();
  await expect(pluginCard(page, 'bio-research@synced')).toHaveAttribute('data-enabled', 'false');
  await expect(pluginCard(page, 'data@synced')).toHaveAttribute('data-enabled', 'true');

  // 再启用:MCP 回来
  await pluginCard(page, 'bio-research@synced').getByTestId('plugin-toggle').click();
  await expect.poll(() => readCalls(), { timeout: 15_000 }).toContain('enable bio-research@synced');
  await openToolsTab(page, 'MCP 服务器');
  await expect.poll(() => mcpRowCount(page, SYNCED_MCP['bio-research']), { message: '启用后,它带来的 MCP 应回到列表里', timeout: 20_000 }).toBe(1);
});

test('E3 缓存失效:停用那一刻后台正好有一次慢的列表刷新在跑,它的旧结果不许回头盖掉新状态', async ({ request }) => {
  await reset(request);
  // ① 让缓存作废,然后冷读一次:接口立刻返回,同时后台起一次完整刷新 —— `claude mcp list` 读到的是
  //    "bio-research 还启用着",但要 4 秒后才输出
  await request.put(`/api/plugins/${enc('data@synced')}/enable`);
  setMcpListDelay(4000);
  const cold = await getMcp(request);
  expect(pluginByName(cold, 'bio-research@synced').enabled).toBe(true);
  // ② 后台刷新还在跑的时候停用 bio-research@synced
  const put = await request.put(`/api/plugins/${enc('bio-research@synced')}/disable`);
  expect(put.ok()).toBeTruthy();
  setMcpListDelay(0);
  const afterDisable = await getMcp(request);
  expect(pluginByName(afterDisable, 'bio-research@synced').enabled, '停用后立刻读:应是停用').toBe(false);
  // ③ 等那次慢刷新跑完,再等后端把在线状态补齐(data 的 MCP 出现 = 已经有一次完整刷新的结果了)
  await expect.poll(async () => mcpNames(await getMcp(request)), { message: '后台应补齐在线状态', timeout: 30_000, intervals: [500] }).toContain(SYNCED_MCP.data);
  await new Promise((r) => setTimeout(r, 5000));   // 确保 ① 起的那次慢刷新已经结束
  const settled = await getMcp(request);
  expect(mcpNames(settled), '已停用插件带来的 MCP 不许再出现(旧刷新的结果回头盖掉了缓存)').not.toContain(SYNCED_MCP['bio-research']);
  expect(mcpNames(settled)).toContain(SYNCED_MCP.data);
  expect(pluginByName(settled, 'bio-research@synced').enabled).toBe(false);
});
