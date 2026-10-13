// r150c 验收:工具面板(MCP 服务器 · 插件)返工的几条。
//
//   M1 面板打开后 5 秒内点「刷新」,刷新的结果被丢掉(上一轮引入的回归)。
//      上一轮给面板的读取加了"只采纳最后发起的那次":挂载后第 5 秒有一次静默读取(读后端缓存,立刻返回),
//      它比用户点的「刷新」(?fresh=1,要等健康检查)发起得晚、回来得早 —— 于是「刷新」的结果回来时已经
//      不是"最后发起的",被丢弃,界面停在缓存里的旧列表。切换插件成功后的重读同样会被它抢掉。
//   S6 以 - 开头的插件名会被命令行当成选项:拒绝(400),命令不执行。
//   S7 停用 / 启用命令失败(可能其实已经生效)时,后端的列表缓存也要作废。
//   S8 切换失败时开关回滚(原来没有用例看这一条)。
//
// "慢的强制读取"用浏览器侧的请求拦截挂住再放行(helpers/ui.mjs 的 holdFreshReads),延迟由测试决定,
// 不靠任何进程的启动先后。假 claude 见 helpers/fake-claude.mjs。只由 run.sh 调起(临时 HOME、端口 6700–6999)。
import { test, expect } from '@playwright/test';
import { initialState, writeState, readState, readCalls, clearCalls, setMcpListDelay, setToggleMode, SYNCED_MCP } from './helpers/fixtures.mjs';
import { boot, openToolsTab, pluginCard, refreshButton, mcpRowCount, holdFreshReads, holdAllReads } from './helpers/ui.mjs';

const enc = encodeURIComponent;
const BIO = 'bio-research@synced';
const pluginByName = (data, name) => (data.plugins || []).find((p) => p.name === name);
const getMcp = async (request, fresh = false) => {
  const r = await request.get(fresh ? '/api/mcp?fresh=1' : '/api/mcp');
  expect(r.ok(), `GET /api/mcp 应成功(实得 ${r.status()})`).toBeTruthy();
  return r.json();
};
const syncedStatus = (name) => readState().synced.find((p) => p.name === name).status;

/** 回到初始场景,并让后端把缓存作废后完整重建一次(之后后端缓存里是初始状态)。 */
async function reset(request) {
  setMcpListDelay(0);
  setToggleMode(null);
  writeState(initialState());
  const put = await request.put(`/api/plugins/${enc('data@synced')}/enable`);
  expect(put.ok(), '启用接口应成功').toBeTruthy();
  writeState(initialState());
  clearCalls();
  return getMcp(request, true);
}
/** 面板挂载后第 5 秒有一次静默读取。等到挂载后 7 秒,保证它已经发出并回来。 */
const waitPastSilentRead = async (page, mountedAt) => { await page.waitForTimeout(Math.max(0, 7000 - (Date.now() - mountedAt))); };
/** 记录一张卡片 data-enabled 的变化序列(第一项是当前值)。 */
const watchEnabled = (card) => card.evaluate((el) => {
  window.__r150cSeq = [el.getAttribute('data-enabled')];
  new MutationObserver(() => { window.__r150cSeq.push(el.getAttribute('data-enabled')); }).observe(el, { attributes: true, attributeFilter: ['data-enabled'] });
});
const enabledSeq = (page) => page.evaluate(() => window.__r150cSeq.join(','));

/** 在应用之外改一个同步插件的状态(相当于用户在终端里跑了 claude plugin enable / disable):只有强制读取读得到。 */
function setSyncedStatusOutside(name, status) {
  const state = readState();
  state.synced.find((p) => p.name === name).status = status;
  writeState(state);
}

test('M1 面板打开后 5 秒内点「刷新」:第 5 秒的静默读取先回来、刷新的结果后回来 —— 界面最终是刷新的结果', async ({ page, request }) => {
  await reset(request);
  await boot(page);
  await openToolsTab(page, '插件');
  const mountedAt = Date.now();
  const card = pluginCard(page, BIO);
  await expect(card).toHaveAttribute('data-enabled', 'true');

  const hold = await holdFreshReads(page);
  await refreshButton(page).click();
  await expect.poll(() => hold.count(), { message: '「刷新」发的强制读取应被挂住', timeout: 4_000 }).toBe(1);
  await waitPastSilentRead(page, mountedAt);   // 第 5 秒的静默读取此时已经发出并回来(状态还没变:它读到的是启用)
  expect(hold.count(), '强制读取应仍在路上').toBe(1);
  await expect(card).toHaveAttribute('data-enabled', 'true');

  // 静默读取回来之后,插件在应用之外被停用;放行「刷新」—— 只有它读得到这个变化
  setSyncedStatusOutside('bio-research', 'disabled');
  await hold.release();
  await expect(card, '「刷新」的结果回来后应显示停用(原来:它不是"最后发起的那次",结果被丢弃,要再点一次)').toHaveAttribute('data-enabled', 'false');
});

test('M1 切换插件成功后的重读还在路上时,第 5 秒的静默读取先回来 —— 重读的结果仍被采纳', async ({ page, request }) => {
  await reset(request);
  await boot(page);
  await openToolsTab(page, '插件');
  const mountedAt = Date.now();
  await expect(pluginCard(page, BIO)).toHaveAttribute('data-enabled', 'true');
  await expect(pluginCard(page, 'design@synced')).toHaveAttribute('data-enabled', 'false');

  const hold = await holdFreshReads(page);
  await pluginCard(page, BIO).getByTestId('plugin-toggle').click();
  await expect.poll(() => readCalls(), { timeout: 4_000 }).toContain(`disable ${BIO}`);
  await expect.poll(() => hold.count(), { message: '切换成功后的重读(强制)应被挂住', timeout: 4_000 }).toBe(1);
  await waitPastSilentRead(page, mountedAt);
  expect(hold.count()).toBe(1);
  await expect(pluginCard(page, 'design@synced')).toHaveAttribute('data-enabled', 'false');

  // 静默读取回来之后,另一个插件在应用之外被启用;放行重读 —— 只有它读得到
  setSyncedStatusOutside('design', 'enabled');
  await hold.release();
  await expect(pluginCard(page, 'design@synced'), '重读的结果应被采纳(原来:被第 5 秒的静默读取抢掉)').toHaveAttribute('data-enabled', 'true');
  await expect(pluginCard(page, BIO)).toHaveAttribute('data-enabled', 'false');
  await openToolsTab(page, 'MCP 服务器');
  await expect.poll(() => mcpRowCount(page, SYNCED_MCP.design), { message: '重读带回来的 MCP 列表里应有刚启用的插件的 MCP', timeout: 15_000 }).toBe(1);
  expect(await mcpRowCount(page, SYNCED_MCP['bio-research']), '已停用插件带来的 MCP 不在列表里').toBe(0);
});

test('S8 停用命令失败(什么都没改):开关先显示停用,接口报失败后回到启用 —— 这一步不靠任何重读', async ({ page, request }) => {
  await reset(request);
  setToggleMode('fail');
  await boot(page);
  await openToolsTab(page, '插件');
  const card = pluginCard(page, BIO);
  await expect(card).toHaveAttribute('data-enabled', 'true');
  // 把面板之后的所有列表读取都挂住(包括失败后的补读):这期间开关回到启用,只能是界面自己回滚的
  const hold = await holdAllReads(page);
  await watchEnabled(card);
  await card.getByTestId('plugin-toggle').click();
  await expect.poll(() => readCalls(), { message: '停用命令应确实发出过', timeout: 10_000 }).toContain(`disable ${BIO}`);
  await expect.poll(() => enabledSeq(page), { message: '开关应先变成停用、失败后回到启用', timeout: 15_000 }).toMatch(/^true,false,true$/);
  await hold.release();
  await page.waitForTimeout(1500);   // 补读回来之后也不该再变(后端的真实状态就是启用)
  expect(await enabledSeq(page)).toBe('true,false,true');
  expect(syncedStatus('bio-research'), '命令失败:插件状态没有变').toBe('loaded');
});

test('S7 停用命令报失败但其实已经生效:后端的列表缓存也作废 —— 之后的普通读取读到真实状态,面板随之显示停用', async ({ page, request }) => {
  const before = await reset(request);
  expect(pluginByName(before, BIO).enabled).toBe(true);
  setToggleMode('fail-after');
  const put = await request.put(`/api/plugins/${enc(BIO)}/disable`);
  expect(put.status(), '命令以非零码退出:接口报失败').toBe(500);
  expect(syncedStatus('bio-research'), '前提:命令其实已经生效').toBe('disabled');
  const after = await getMcp(request);
  expect(pluginByName(after, BIO).enabled, '失败时也要作废缓存:普通读取应读到真实状态(原来:读到缓存里的"启用")').toBe(false);

  // 界面:开关先显示停用 → 接口报失败,回滚成启用 → 补读拿到真实状态(已停用)
  await reset(request);
  setToggleMode('fail-after');
  await boot(page);
  await openToolsTab(page, '插件');
  const card = pluginCard(page, BIO);
  await expect(card).toHaveAttribute('data-enabled', 'true');
  await watchEnabled(card);
  await card.getByTestId('plugin-toggle').click();
  await expect.poll(() => enabledSeq(page), { message: '回滚之后的补读应拿到真实状态(已停用)', timeout: 15_000 }).toMatch(/^true,false,true,false$/);
});

test('S6 以 - 开头的插件名(会被命令行当成选项)一律拒绝:返回 400,命令不执行;合法名字照旧', async ({ request }) => {
  await reset(request);
  const calls = [
    ['put', '/api/plugins/-x/enable'],
    ['put', '/api/plugins/-x/disable'],
    ['put', '/api/plugins/--help/disable'],
    ['post', '/api/plugins/-x/update'],
    ['delete', '/api/plugins/-x'],
    ['post', `/api/plugins/${enc('foo@-bar')}/update`],   // 更新时 @ 后面那段会单独传给命令行(marketplace update)
  ];
  for (const [method, path] of calls) {
    const r = await request[method](path);
    expect(r.status(), `${method.toUpperCase()} ${path}`).toBe(400);
  }
  expect(readCalls(), '假 claude 不应收到任何 enable / disable').toEqual([]);
  const ok = await request.put(`/api/plugins/${enc('data@synced')}/enable`);
  expect(ok.status(), '合法名字照旧').toBe(200);
  expect(readCalls()).toEqual(['enable data@synced']);
});
