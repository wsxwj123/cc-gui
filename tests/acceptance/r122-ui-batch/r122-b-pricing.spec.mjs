// r122 · B 组:用量页「价格与来源」版块精简(INTERFACE B1–B7 / BRIEF R2)。
// 数据全部用浏览器层请求拦截给定(INTERFACE B7 允许):GET /api/pricing、GET /api/pricing/current、
// POST /api/pricing/refresh、GET /api/pricing?refreshId=…。不联网、不读写任何真实凭据。
// 「修前」= 当前代码:四行说明(范围 / 价目抓取时间 / 各状态计数 / 原币种条数)直接摆在按钮与折叠项之间。
import { test, expect } from '@playwright/test';
import { PLAIN } from './helpers/fixtures.mjs';
import {
  boot, openSessionBySearch, openUsagePanel, routeJson, pricingBlock, outsideFoldText, wholeBlockText, detailsTitled,
} from './helpers/ui.mjs';
import {
  PROVIDER_LABEL, PRICING_PROVIDER_COUNT, currentResolved, currentUnresolved, pricingPayload,
} from './helpers/payloads.mjs';

const REFRESH_BTN = (block) => block.getByRole('button', { name: '刷新价格', exact: true });
const ALL_BTN_RE = new RegExp(`刷新全部\\s*${PRICING_PROVIDER_COUNT}\\s*家`);
const T_REFRESH = /^本次刷新逐家结果/;
const T_SOURCES = /^逐家来源与状态/;
const T_QUOTES = /^原币种报价/;

/**
 * 打桩四个价目接口。返回可观测的计数:posts(POST 的请求体)、polls(带 refreshId 的轮询次数)。
 * 轮询第 1 次报 running、之后报 completed(让"刷新→轮询→终态"这条链真的走一遍)。
 */
async function stubPricing(page, { current = currentResolved(), refreshEntries = 3 } = {}) {
  const seen = { posts: [], polls: 0 };
  await page.route((url) => url.pathname === '/api/pricing', (route) => {
    const refreshId = new URL(route.request().url()).searchParams.get('refreshId');
    let body;
    if (refreshId) {
      seen.polls += 1;
      body = pricingPayload({ refreshEntries: Math.max(refreshEntries, 1), refreshId, refreshStatus: seen.polls === 1 ? 'running' : 'completed' });
    } else {
      body = pricingPayload({ refreshEntries });
    }
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
  });
  await routeJson(page, '/api/pricing/current', current);
  await page.route((url) => url.pathname === '/api/pricing/refresh', (route) => {
    seen.posts.push(route.request().postData() || '');
    return route.fulfill({ status: 202, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ok: true, refreshId: `r122-refresh-${seen.posts.length}`, status: 'running' }) });
  });
  return seen;
}

async function openPricing(page, stubOpts) {
  const seen = await stubPricing(page, stubOpts);
  await boot(page, { fold: null });
  await openSessionBySearch(page, PLAIN.mark);
  await openUsagePanel(page);
  const block = pricingBlock(page);
  await expect(block, '用量面板里应有「价格与来源」版块(标题 + 「刷新价格」按钮)').toHaveCount(1);
  return { block, seen };
}

/** 各状态计数那一行的形态:两个「状态 数字」连排(形如「已更新 18 套餐计价 10」)。 */
const COUNTS_ROW_RE = /(已更新|部分取得|已过期|来源不可用|套餐计价|未映射)[^0-9]{0,14}\d+\s*(已更新|部分取得|已过期|来源不可用|套餐计价|未映射)/;

// ───────────────────────── B1 位置与按钮名 ─────────────────────────

test('B1 版块位置:用量面板里有标题「价格与来源」的版块,内有且只有一个「刷新价格」按钮(按钮名不变)', async ({ page }) => {
  const { block } = await openPricing(page);
  await expect(REFRESH_BTN(block), '「刷新价格」按钮名不变(BRIEF R2-5)').toHaveCount(1);
  await expect(REFRESH_BTN(block), '常态(身份判得出)下按钮可用').toBeEnabled();
});

// ───────────────────────── B2 常态:四行说明不再直接显示 ─────────────────────────

test('B2 常态·范围行:折叠外不出现「范围：」', async ({ page }) => {
  const { block } = await openPricing(page);
  await expect(REFRESH_BTN(block), '前提:常态(按钮可用)').toBeEnabled();
  expect(await wholeBlockText(block), '前提:范围说明(含当前 provider 名)仍在版块里(信息不丢,只是收进折叠)').toContain(PROVIDER_LABEL);
  expect(await outsideFoldText(block), '折叠项之外不得出现「范围：」').not.toContain('范围：');
});

test('B2 常态·抓取时间行:折叠外不出现「价目抓取时间」', async ({ page }) => {
  const { block } = await openPricing(page);
  await expect(REFRESH_BTN(block), '前提:常态(按钮可用)').toBeEnabled();
  expect(await wholeBlockText(block), '前提:「价目抓取时间」仍在版块里(信息不丢)').toContain('价目抓取时间');
  expect(await outsideFoldText(block), '折叠项之外不得出现「价目抓取时间」').not.toContain('价目抓取时间');
});

test('B2 常态·状态计数行:折叠外不出现「已更新 N 套餐计价 N」这类连排计数', async ({ page }) => {
  const { block } = await openPricing(page);
  await expect(REFRESH_BTN(block), '前提:常态(按钮可用)').toBeEnabled();
  expect(await wholeBlockText(block), '前提:各状态计数仍在版块里(信息不丢)').toMatch(/套餐计价\s*1/);
  const outside = await outsideFoldText(block);
  expect(outside, '折叠项之外不得出现「套餐计价 N」').not.toMatch(/套餐计价\s*\d+/);
  expect(outside, '折叠项之外不得出现各状态计数连排的那一行').not.toMatch(COUNTS_ROW_RE);
});

test('B2 常态·原币种行:折叠外不出现「原币种 」(折叠项标题「原币种报价」除外)', async ({ page }) => {
  const { block } = await openPricing(page);
  await expect(REFRESH_BTN(block), '前提:常态(按钮可用)').toBeEnabled();
  expect(await wholeBlockText(block), '前提:各币种条数那句说明仍在版块里(信息不丢)').toContain('不折算成单一币种');
  const outside = await outsideFoldText(block);
  expect(outside, '折叠项之外不得出现「原币种 」').not.toMatch(/原币种 /);
  expect(outside, '折叠项之外不得出现各币种条数那句说明').not.toContain('不折算成单一币种');
});

// ───────────────────────── B3 三个折叠项 ─────────────────────────

test('B3 三个折叠项:原生 <details>,标题分别以三个名字开头,默认都收起', async ({ page }) => {
  const { block } = await openPricing(page, { refreshEntries: 3 });
  await expect(block.locator('details'), '本次有刷新条目时恰好三个折叠项').toHaveCount(3);
  for (const [re, label] of [[T_REFRESH, '本次刷新逐家结果'], [T_SOURCES, '逐家来源与状态'], [T_QUOTES, '原币种报价']]) {
    const d = detailsTitled(block, re);
    await expect(d, `应有标题以「${label}」开头的折叠项`).toHaveCount(1);
    expect(await d.evaluate((el) => el.tagName.toLowerCase()), '折叠机制是原生 <details>').toBe('details');
    expect(await d.evaluate((el) => el.open), `「${label}」默认收起`).toBe(false);
  }
});

test('B3 「本次刷新逐家结果」只在本次有刷新条目时出现:条目为 0 时只剩另外两个折叠项', async ({ page }) => {
  const { block } = await openPricing(page, { refreshEntries: 0 });
  await expect(detailsTitled(block, T_REFRESH), '没有本次刷新条目 → 不出现「本次刷新逐家结果」').toHaveCount(0);
  await expect(detailsTitled(block, T_SOURCES)).toHaveCount(1);
  await expect(detailsTitled(block, T_QUOTES)).toHaveCount(1);
  await expect(block.locator('details')).toHaveCount(2);
});

// ───────────────────────── B4 信息收进折叠 ─────────────────────────

test('B4 展开「逐家来源与状态」:里面有范围说明(含当前 provider 名)', async ({ page }) => {
  const { block } = await openPricing(page);
  const d = detailsTitled(block, T_SOURCES);
  await d.locator('summary').click();
  expect(await d.evaluate((el) => el.open), '前提:已展开').toBe(true);
  await expect(d, `展开后应能看到范围说明(含当前 provider 名「${PROVIDER_LABEL}」)`).toContainText(PROVIDER_LABEL);
});

test('B4 展开「逐家来源与状态」:里面有「价目抓取时间」', async ({ page }) => {
  const { block } = await openPricing(page);
  const d = detailsTitled(block, T_SOURCES);
  await d.locator('summary').click();
  await expect(d, '展开后应能看到「价目抓取时间」').toContainText('价目抓取时间');
});

test('B4 展开「逐家来源与状态」:里面有各状态计数(已更新 2 / 部分取得 1 / 套餐计价 1 / 未映射 1)', async ({ page }) => {
  const { block } = await openPricing(page);
  const d = detailsTitled(block, T_SOURCES);
  await d.locator('summary').click();
  const text = (await d.textContent() || '').replace(/\s+/g, ' ');
  expect(text, '各状态计数应在折叠项里:已更新 2').toMatch(/已更新\s*2(?!\d)/);
  expect(text, '各状态计数应在折叠项里:部分取得 1').toMatch(/部分取得\s*1(?!\d)/);
  expect(text, '各状态计数应在折叠项里:套餐计价 1').toMatch(/套餐计价\s*1(?!\d)/);
  expect(text, '各状态计数应在折叠项里:未映射 1').toMatch(/未映射[^0-9]{0,14}1(?!\d)/);
});

test('B4 展开「逐家来源与状态」:里面有可点的「刷新全部 N 家」,点了会发起刷新请求', async ({ page }) => {
  const { block, seen } = await openPricing(page);
  const d = detailsTitled(block, T_SOURCES);
  await d.locator('summary').click();
  const all = d.getByRole('button', { name: ALL_BTN_RE });
  await expect(all, `「逐家来源与状态」里应有「刷新全部 ${PRICING_PROVIDER_COUNT} 家」入口`).toHaveCount(1);
  await expect(all).toBeVisible();
  await expect(all).toBeEnabled();
  await all.click();
  await expect.poll(() => seen.posts.length, { timeout: 10_000, message: '点「刷新全部」应发起 POST /api/pricing/refresh' }).toBeGreaterThan(0);
  expect(seen.posts[0], '「刷新全部」发起的刷新不应只刷当前这一家').not.toMatch(/"scope"\s*:\s*"current"/);
});

/**
 * 注意:今天「原币种报价」折叠项里的**分币种小标题**本来就写着「CNY · 2 条（单位：每百万 token，不折算成单一币种）」,
 * 所以单凭"不折算成单一币种"这几个字分不出"那句说明有没有收进来"。被收进来的是折叠外那一整句
 * 「原币种 CNY 2 条 · USD 1 条（分别标价，不折算成单一币种；未知维度按 null 留空，不写 0）」——
 * 其中「未知维度按 null 留空」是今天折叠项里没有的信息(BRIEF R2-2:信息不丢),用它当判据。
 */
test('B4 展开「原币种报价」:里面有各币种条数那句说明(含"不折算成单一币种"与"未知维度按 null 留空")', async ({ page }) => {
  const { block } = await openPricing(page);
  const d = detailsTitled(block, T_QUOTES);
  await d.locator('summary').click();
  expect(await d.evaluate((el) => el.open), '前提:已展开').toBe(true);
  const text = (await d.textContent() || '').replace(/\s+/g, ' ');
  expect(text, '展开后应能看到"不折算成单一币种"').toContain('不折算成单一币种');
  expect(text, '那句说明里应有各币种条数(CNY 2 条)').toMatch(/CNY\s*(·\s*)?2\s*条/);
  expect(text, '那句说明里应有各币种条数(USD 1 条)').toMatch(/USD\s*(·\s*)?1\s*条/);
  expect(text, '那句说明的其余信息(未知维度按 null 留空,不写 0)也应收进来,不得丢').toContain('未知维度按 null 留空');
});

// ───────────────────────── B5 例外:身份判不出来 ─────────────────────────

test('B5 例外·原因可见:判不出价目身份时「刷新价格」不可用,折叠外有一行 reason 文字', async ({ page }) => {
  const reason = 'R122 判不出当前 provider 的价目身份(自定义端点未映射到任何预设)';
  const { block } = await openPricing(page, { current: currentUnresolved(reason) });
  await expect(REFRESH_BTN(block), '判不出身份 → 「刷新价格」不可用').toBeDisabled();
  expect(await outsideFoldText(block), '折叠外应显示服务端给的 reason').toContain(reason);
});

test('B5 例外·出路保留:reason 同一行有可点的「刷新全部 N 家」(在折叠外)', async ({ page }) => {
  const reason = 'R122 判不出当前 provider 的价目身份(自定义端点未映射到任何预设)';
  const { block, seen } = await openPricing(page, { current: currentUnresolved(reason) });
  await expect(REFRESH_BTN(block), '前提:「刷新价格」不可用').toBeDisabled();
  const outsideAll = block.locator('button:not(details *)').filter({ hasText: ALL_BTN_RE });
  await expect(outsideAll, `折叠外应有「刷新全部 ${PRICING_PROVIDER_COUNT} 家」`).toHaveCount(1);
  await expect(outsideAll).toBeVisible();
  await expect(outsideAll).toBeEnabled();
  // "同一行":reason 那段文字(文本节点)的几何盒与按钮的几何盒在垂直方向上有重叠
  const sameLine = await outsideAll.evaluate((btn, why) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !(node.textContent || '').includes(why)) node = walker.nextNode();
    if (!node) return { ok: false, why: '找不到 reason 文字所在的文本节点' };
    if (node.parentElement.closest('details')) return { ok: false, why: 'reason 文字落在折叠项里面' };
    const range = document.createRange(); range.selectNodeContents(node);
    const a = range.getBoundingClientRect(); const b = btn.getBoundingClientRect();
    const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return { ok: overlap > 0, overlap: Math.round(overlap), reasonBox: [Math.round(a.top), Math.round(a.bottom)], btnBox: [Math.round(b.top), Math.round(b.bottom)] };
  }, reason);
  expect(sameLine.ok, `「刷新全部」应与 reason 在同一行(垂直上有重叠):${JSON.stringify(sameLine)}`).toBe(true);
  await outsideAll.click();
  await expect.poll(() => seen.posts.length, { timeout: 10_000, message: '点「刷新全部」应发起 POST /api/pricing/refresh' }).toBeGreaterThan(0);
});

// ───────────────────────── B6 结果提示仍在折叠外 ─────────────────────────

test('B6 点「刷新价格」完成后,一句话结果提示显示在折叠外', async ({ page }) => {
  const { block, seen } = await openPricing(page);
  const before = await outsideFoldText(block);
  await REFRESH_BTN(block).click();
  await expect.poll(() => seen.posts.length, { timeout: 10_000, message: '点「刷新价格」应发起 POST /api/pricing/refresh' }).toBe(1);
  expect(seen.posts[0], '主按钮默认只刷当前 provider(既有行为)').toMatch(/"scope"\s*:\s*"current"/);
  await expect.poll(() => seen.polls, { timeout: 30_000, message: '应轮询 GET /api/pricing?refreshId=… 直到终态' }).toBeGreaterThanOrEqual(2);
  await expect(REFRESH_BTN(block), '刷新结束后按钮回到「刷新价格」且可用').toBeEnabled({ timeout: 30_000 });
  await expect.poll(async () => (await outsideFoldText(block)) !== before, { timeout: 20_000, message: '刷新完成后折叠外应多出一句结果提示' }).toBe(true);
  const after = await outsideFoldText(block);
  expect(after.startsWith(before), `结果提示应是追加在折叠外(原有内容不变):\n before=${before}\n after=${after}`).toBe(true);
  const added = after.slice(before.length).trim();
  expect(added.length, '结果提示不得为空').toBeGreaterThan(0);
  expect(added, `结果提示应是一句人话(成功 / 没有可更新 / 已抓过 / 失败 之类),实际:「${added}」`)
    .toMatch(/已更新|没有可更新|已经抓过|上次结果|失败|部分|完成|无需/);
  expect(await detailsTitled(block, T_SOURCES).evaluate((el) => el.open), '结果提示不靠展开折叠项来显示').toBe(false);
});

// ───────────────────────── 自证:判据与读法不是空转 ─────────────────────────

test('自证·"折叠外"读法有效:逐家行只在折叠项里 → 整块文字里有、折叠外文字里没有', async ({ page }) => {
  const { block } = await openPricing(page);
  expect(await wholeBlockText(block), '整块文字应含折叠项里的逐家行(r122-alpha)').toContain('r122-alpha');
  expect(await outsideFoldText(block), '折叠外文字不得含折叠项里的逐家行(含了 = 读法没把 <details> 剔掉,B2 的红就不可信)').not.toContain('r122-alpha');
});

test('自证·折叠项展开读法有效:点「逐家来源与状态」摘要后,里面的逐家行可见', async ({ page }) => {
  const { block } = await openPricing(page);
  const d = detailsTitled(block, T_SOURCES);
  await expect(d.getByText('r122-alpha', { exact: false }).first(), '收起时逐家行不可见').toBeHidden();
  await d.locator('summary').click();
  expect(await d.evaluate((el) => el.open), '点摘要后 open=true').toBe(true);
  await expect(d.getByText('r122-alpha', { exact: false }).first(), '展开后逐家行可见(不可见 = 展开读法坏了,B4 的红就不可信)').toBeVisible();
});
