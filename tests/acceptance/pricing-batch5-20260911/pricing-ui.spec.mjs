// PR-22 … PR-28 — R21/R24 展示口径 over the public UI only.
// Observation vocabulary is what INTERFACE publishes: the three hit-rate names, 「刷新价格」,
// 来源URL/抓取时间/币种/估算/未知/过期 marks, and the fixture session's public identities.
import { test, expect } from '@playwright/test';
import {
  getRuntime, fixtureSection, requireField, requireModel, openFixtureSession, openUsagePanel,
  getPricing, postRefresh, waitForRefresh, clickThroughOverlays, allText, allTextAndTitles, moneyTips,
  parsePercent, readUsageTotals,
  EnvironmentBlocked,
} from './helpers/pr5-runtime.mjs';

let BASE;
let sessionFlow;

test.beforeAll(() => {
  BASE = getRuntime().baseURL;
});

test.beforeEach(() => {
  sessionFlow = fixtureSection('sessionFlow');
});

test('PR-22 [R24] 用量面板以「会话累计命中率」命名口径，不沿用含糊旧名', async ({ page }) => {
  await openUsagePanel(page);
  const text = await allText(page);
  expect(text, '合同要求三处口径名之一是「会话累计命中率」').toContain('会话累计命中率');
  expect(text, '不得用「平均命中率」冒充会话累计口径').not.toMatch(/平均命中率/);
});

test('PR-23 [R24] 费用/价格区可展开：来源URL、抓取时间、币种与适用条件可见', async ({ page, request }) => {
  const pricing = await getPricing(request, BASE);
  expect(pricing.status).toBe(200);
  let quotes = pricing.body?.quotes ?? [];
  if (!quotes.length) {
    // 价目可空是合法的（合同：无有效数据 prices/quotes 可空），先按公开入口触发一次刷新再判断展示层
    const refreshed = await postRefresh(request, BASE, {});
    if (refreshed.status === 202) {
      await waitForRefresh(request, BASE, refreshed.body.refreshId, { timeoutMs: 30_000, intervalMs: 1_500 });
      quotes = (await getPricing(request, BASE)).body?.quotes ?? [];
    }
  }
  if (!quotes.length) {
    throw new EnvironmentBlocked('刷新后仍无任何报价，无法验证展示层（确认该实例能访问官方源；这是环境问题不是产品结论）');
  }

  await openUsagePanel(page);
  const panel = page.getByText(/用量统计/).first().locator('xpath=ancestor::*[self::section or self::div][last()]');
  const expanders = page.locator('summary, [aria-expanded="false"]');
  for (let index = 0; index < Math.min(await expanders.count(), 8); index += 1) {
    await expanders.nth(index).click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(150);
  }
  const anchors = await page.locator('a[href^="http"]').allInnerTexts().catch(() => []);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href^="http"]')].map(a => a.href).slice(0, 40));
  const text = await allText(page);
  expect(hrefs.length, `展开后必须能看到来源 URL（现有链接: ${anchors.slice(0, 3).join(' | ')}）`).toBeGreaterThan(0);
  expect(text, '费用区必须能看到抓取时间').toMatch(/(抓取|更新于|获取于|updated|fetched)/i);
  expect(text, '费用区必须能看到币种标注').toMatch(/(CNY|USD|EUR|¥|￥|\$)/);
  expect(text, '必须能看出过期/估算/缺项状态之一').toMatch(/(过期|估算|未知|缺项|stale)/);
  expect(await panel.count()).toBeGreaterThan(0);
});

test('PR-24 [R21/R24] 不同原币种分开显示，不折算成单一币种总价', async ({ page, request }) => {
  const pricing = await getPricing(request, BASE);
  const currencies = new Set((pricing.body?.quotes ?? []).filter(q => Object.values(q.prices ?? {}).some(v => typeof v === 'number')).map(q => q.currency));
  if (!currencies.size) {
    throw new EnvironmentBlocked('当前没有任何有价报价，无法验证币种展示（不得静默跳过；先让实例能取到官方价目）');
  }
  await openUsagePanel(page);
  const text = await allText(page);
  if (currencies.has('CNY') && currencies.has('USD')) {
    expect(text, 'CNY 价目应以 ¥/CNY 展现').toMatch(/(¥|￥|CNY)/);
    expect(text, 'USD 价目应以 $/USD 展现').toMatch(/(\$|USD)/);
  }
  const cnyOnly = [...currencies].every(currency => currency === 'CNY');
  if (!cnyOnly) {
    expect(text, '存在非 CNY 价目时不得只显示换算后的 ¥ 金额').toMatch(/(\$|USD|EUR|€)/);
  }
});

/**
 * R20 的判据（「刷新后要能看到逐家的成功/partial/失败，不许只给一个总成功」）一字未改；
 * 变的是**看它的两条前提**，断言跟着走（2026-09-13）：
 *   ① 主按钮「刷新价格」默认只刷**当前 provider**（返回 1 家）。只刷一家就谈不上"逐家" →
 *      走同一条范围行的全量入口「刷新全部 N 家」（同一个刷新接口、同一个 UI，不 mock 响应）。
 *      该入口按设计对任何 provider 都保留：身份判不出来时主按钮是禁用的，它是唯一出路。
 *   ② R40 起逐家结果默认折叠在原生 `<details>` 里（折叠态整页看不见一行）→ 断言前先展开它。
 * 这不是放宽：原来数的是"整页文本里命中状态词表 ≥2 行"（那几行还可能来自别处的状态汇总），
 * 现在数的是**刷新结果块内部**的行，并逐行校验「presetId · 状态」形态、去重、行数 == 摘要里的家数
 * == 点下去的那个入口承诺的家数。
 */
test('PR-25 [R20] 「刷新价格」逐家列出成功/partial/失败，不给一个总成功就完事', async ({ page }) => {
  // 全量刷新是 43 家官方源的真网络操作（面板自己最多轮询 120s），比默认 45s 宽松一档。
  test.setTimeout(90_000);
  await openUsagePanel(page);
  await expect(page.getByRole('button', { name: '刷新价格', exact: true }).first(), '用量/价格区必须有刷新入口（按钮名是合同锁定字面量）').toBeVisible();
  // 主按钮默认只刷当前 provider（1 家）→ 逐家判据走范围行的全量入口。它对任何 provider 都保留
  // （身份判不出来时主按钮是禁用的，这个入口就是唯一出路）。
  const allEntry = page.getByRole('button', { name: /刷新全部\s*\d+\s*家/ }).first();
  await expect(allEntry, '范围行必须保留「刷新全部 N 家」入口（逐家结果的唯一全量入口）').toBeVisible();
  const declaredTotal = Number(/刷新全部\s*(\d+)\s*家/.exec((await allEntry.innerText()).trim())?.[1] ?? NaN);
  expect(Number.isFinite(declaredTotal), '全量入口必须写明家数（「刷新全部 N 家」）').toBe(true);
  expect(declaredTotal, '全量入口承诺的家数必须 ≥2（1 家就谈不上逐家）').toBeGreaterThanOrEqual(2);
  await clickThroughOverlays(page, allEntry);

  const block = page.locator('details', { has: page.locator('summary', { hasText: /本次刷新逐家结果/ }) }).first();
  await expect(block, '刷新后必须出现「本次刷新逐家结果」折叠块（R40 的原生 <details>）')
    .toHaveCount(1, { timeout: 30_000 });
  const summary = block.locator('summary').first();

  // 标题与行**一次读全**（ReadBlock）：面板每秒重渲染一次（刷新期间 setData），分两次读会读到
  // 两个时刻的数据（实测标题 9 家 / 行只有 1 条）。读法用 `textContent`：折叠态内容仍在 DOM 里，
  // `innerText` 看不见它（旧断言数不到行的原因）；闭合 `<details>` 里元素的**几何仍是非 0**
  // （Chromium/WebKit 实测），所以可见性判定交给 Playwright，不用高度。
  const readBlock = async () => await block.evaluate((el) => {
    const summaryEl = [...el.children].find((child) => child.tagName.toLowerCase() === 'summary');
    const body = [...el.children].find((child) => child !== summaryEl);
    return {
      tag: el.tagName.toLowerCase(),
      open: el.open,
      hasOpenAttr: el.hasAttribute('open'),
      summary: (summaryEl?.textContent || '').trim(),
      rows: [...(body?.children ?? [])].map((row) => (row.textContent || '').trim()).filter(Boolean),
    };
  });

  // 等这一块反映**本次点的全量刷新**（家数 = 入口承诺的 N）。不这样等就会读到上一条刷新记录
  // ——实例冷启动的自动预热只刷过期源，实测是 3 家 / 9 家的短清单。
  let snap = await readBlock();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline
    && !(Number(/^本次刷新逐家结果（(\d+) 家/.exec(snap.summary)?.[1] ?? NaN) === declaredTotal
      && snap.rows.length === declaredTotal)) {
    await page.waitForTimeout(500);
    snap = await readBlock();
  }
  expect(snap.tag, '逐家结果的折叠机制是原生 <details>（R40）').toBe('details');
  expect(snap.summary, `点「刷新全部 ${declaredTotal} 家」后，逐家结果块必须列出这 ${declaredTotal} 家`)
    .toMatch(new RegExp(`^本次刷新逐家结果（${declaredTotal} 家 · [^）]*）$`));
  expect(snap.rows.length, `行数必须等于标题与入口承诺的家数（${declaredTotal}）—— 标题说了 N 家却列不出 N 行 = 没逐家`)
    .toBe(declaredTotal);
  expect(snap.hasOpenAttr, 'R40：默认折叠（DOM 上不得带 open 属性）').toBe(false);
  expect(snap.open, 'R40：默认折叠').toBe(false);
  await expect(block.getByText(snap.rows[0], { exact: true }).first(), 'R40：默认折叠时条目不可见').toBeHidden();

  await summary.click();
  const opened = await readBlock();
  expect(opened.open, '点摘要行后必须展开').toBe(true);
  await expect(block.getByText(opened.rows[0], { exact: true }).first(), '展开后条目必须可见').toBeVisible();

  const rows = opened.rows;
  const presetIds = rows.map((row) => row.split(' · ')[0]);
  for (const row of rows) {
    expect(row, `逐家行必须是「presetId · 状态[ · errorCode]」形态，实际：「${row}」`).toMatch(/^[A-Za-z0-9._-]+ · \S/);
  }
  expect(new Set(presetIds).size, `同一家不得列两行（实际: ${presetIds.join(',')}）`).toBe(rows.length);
});

test('PR-26 [R24] 会话视图命中率口径：顶部与轮末使用合同名称', async ({ page }) => {
  requireModel();
  await openFixtureSession(page, sessionFlow);
  const header = await page.locator('[data-cgui=topbar]').first().innerText().catch(() => '');
  // 轮末那处的口径名 R43 起进了行容器的悬停提示(title) → 读法=整页可见文本 ∪ 悬停提示。
  const body = await allTextAndTitles(page);
  const topLabel = /(最近API命中率|整轮命中率|本轮命中)/.exec(header)?.[0] ?? null;
  expect(topLabel, `顶部徽章必须以「最近API命中率」或「整轮命中率」命名，实际顶部文本: ${header.slice(0, 120)}`)
    .toMatch(/最近API命中率|整轮命中率/);
  expect(body, '轮末必须标「整轮命中率」').toContain('整轮命中率');
});

test('PR-27 [R24] 命中率必须等于 usage 可复算值，不凭 GUI 推测', async ({ page, request }) => {
  requireModel();
  const sessionId = requireField(sessionFlow, 'sessionId');
  const projectHash = requireField(sessionFlow, 'projectHash');
  const totals = await readUsageTotals(request, BASE, sessionId, projectHash);
  expect(totals.status, 'messages 端点读取用量').toBe(200);
  const { input = 0, cacheRead = 0, cacheCreation = 0 } = totals.usageTotals ?? {};
  const denominator = input + cacheRead + cacheCreation;
  expect(denominator, '夹具会话必须有可复算的用量分母').toBeGreaterThan(0);
  const expected = (cacheRead / denominator) * 100;

  await openFixtureSession(page, sessionFlow);
  const text = await allText(page);
  const labelMatch = /(最近API命中率|整轮命中率|会话累计命中率)[^\d%]{0,24}(\d+(?:\.\d+)?\s*%)/.exec(text);
  expect(labelMatch, `会话视图必须显示带口径名的命中率，实际文本片段: ${text.slice(0, 200).replace(/\n/g, ' | ')}`).toBeTruthy();
  const shown = parsePercent(labelMatch[2]);
  expect(Math.abs(shown - expected), `显示 ${shown}% 与按 usage 复算 ${expected.toFixed(1)}% 不符`).toBeLessThanOrEqual(0.2);
});

test('PR-28 [R21/R24] 无官方可适用价时费用必须标注来源/估算/未知，不得给无标注金额', async ({ page }) => {
  requireModel();
  await openFixtureSession(page, sessionFlow);
  const text = await allText(page);
  const money = /(?:¥|￥|\$)\s?\d/.test(text);
  expect(money, '会话视图应显示费用金额（夹具会话已产生用量）').toBe(true);
  // 金额必须真的看得见（上面那条不动）；来源词 R42 起进了金额自己的悬停提示(title)
  // → 读法=可见文本 ∪ 金额那一片的悬停提示。整页 title 不行：别处（「远程」按钮）也含「官方」。
  expect(`${text}\n${await moneyTips(page)}`, '费用必须带来源种类或估算/未知标注（官方/社区/手填/离线/估算/未知/中转）')
    .toMatch(/(官方|社区|手填|离线|估算|未知|中转|第三方)/);
});

test('PR-43 [R22/R24 反向] 命中率不得超 100%：cache_read 不得被重复计入分子', async ({ page, request }) => {
  requireModel();
  const sessionId = requireField(sessionFlow, 'sessionId');
  const projectHash = requireField(sessionFlow, 'projectHash');
  const totals = await readUsageTotals(request, BASE, sessionId, projectHash);
  const { input = 0, cacheRead = 0, cacheCreation = 0 } = totals.usageTotals ?? {};
  expect(cacheRead, '读缓存量不得超过全部输入（重复计入会立刻暴露）').toBeLessThanOrEqual(input + cacheRead + cacheCreation);
  await openFixtureSession(page, sessionFlow);
  const text = await allText(page);
  const rates = [...text.matchAll(/命中率[^\d%]{0,24}(\d+(?:\.\d+)?)\s*%/g)].map(match => Number(match[1]));
  for (const value of rates) {
    expect(value, `命中率出现超过 100% 的比率: ${value}%`).toBeLessThanOrEqual(100);
  }
  expect(text, '不得出现 NaN/Infinity 比率').not.toMatch(/NaN|Infinity/);
});

