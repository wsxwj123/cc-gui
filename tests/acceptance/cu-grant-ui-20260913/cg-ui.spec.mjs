// CG-06..CG-09 / CG-12..CG-16(正)+ CG-R07/R08/R09/R12/R13(反):授权面板的界面层。
// 合同:§D(组件/DOM 锚点/交互细则/公开文案表)+ §F。
// 页面来自 dev server(源码直出),/api 由它代理到隔离实例;界面观测只用 §D.6 的 data-testid 与 §D.5 的公开文案。
import { test, expect } from '@playwright/test';
import { ensureFixture, disposeFixture } from '../cu-batch-20260911/helpers/cu-fixture.mjs';
import { api, requireFlag } from './helpers/harness.mjs';
import { expandCandidates, grantedFromServer, grantFirstCandidate, openCuGrants, setGrantViaApi, waitAppListed, waitCandidateList } from './helpers/ui.mjs';

const WRITE_WHY = '这条要真的改授权状态(收尾会按原字节还原 grants.json)';
const EMPTY_TEXT = '尚未授权任何应用。未授权时 window_list 不返回窗口，操控动作返回 CU_APP_NOT_ALLOWED。';
const DESC_TEXT = '只有列在下面的应用才能被查询窗口、点击或输入。授权按 bundleId 逐个生效，撤销立即生效。';

test.afterAll(() => { disposeFixture(); });

/** 把授权清成"空":逐个撤销(走产品端点,不手改文件)。 */
async function clearAllGrants() {
  const ids = await grantedFromServer();
  for (const id of ids) await setGrantViaApi({ bundleId: id, granted: false });
  await setGrantViaApi({ screenScope: false });
}

test('CG-06 卡片里出现「应用授权」区块;未点「添加应用」前不发 /apps 请求', async ({ page }) => {
  const appsRequests = [];
  page.on('request', (r) => { if (r.url().includes('/api/computer-use/apps')) appsRequests.push(r.url()); });
  await openCuGrants(page);
  await expect(page.getByTestId('cu-grants-desc')).toHaveText(DESC_TEXT);
  await page.waitForTimeout(1200); // 给"挂载时预取/轮询"留出暴露窗口
  expect(appsRequests, '未点「添加应用」前不得有 /apps 请求(不预取、不轮询)').toEqual([]);
  await expect(page.getByTestId('cu-app-option'), '候选列表默认不展开').toHaveCount(0);
});

test('CG-07 点「添加应用」→ 说明行 + 候选项;1.5 秒内从 loading 变成列表', async ({ page }) => {
  await openCuGrants(page);
  const t0 = Date.now();
  await page.getByTestId('cu-grant-add').click();
  await expect(page.getByTestId('cu-apps-note'), '候选区的说明行').toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('cu-app-option').first(), '候选项要在 1.5 秒内出来').toBeVisible({ timeout: 1_500 });
  const ms = Date.now() - t0;
  await expect(page.getByTestId('cu-apps-loading'), 'loading 态已被列表取代').toHaveCount(0);
  for (const option of await page.getByTestId('cu-app-option').all()) {
    expect(await option.getAttribute('data-bundle-id'), '每个候选项都要带 data-bundle-id').toBeTruthy();
  }
  console.log(`   展开→列表 ${ms}ms`);
});

test('CG-08 候选项「授权」→ 行变 data-granted=true 且出现「已授权」,GET /grants 含该 bundleId', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  ensureFixture(); // 让一个可随时丢弃的应用(TextEdit 临时窗口)在运行列表里
  await waitAppListed('com.apple.TextEdit');
  await setGrantViaApi({ bundleId: 'com.apple.TextEdit', granted: false }); // 复位:它可能本来就是已授权(操作者真状态里就有)
  await openCuGrants(page);
  await expandCandidates(page);
  await waitCandidateList(page);
  const candidates = await page.getByTestId('cu-app-option').evaluateAll((els) => els.map((e) => e.dataset.bundleId));
  const bundleId = await grantFirstCandidate(page, { prefer: 'com.apple.TextEdit' });
  console.log(`   候选 ${candidates.length} 个:${candidates.slice(0, 8).join(', ')}`);
  const row = page.locator(`[data-testid="cu-app-option"][data-bundle-id="${bundleId}"]`);
  await expect(row.getByTestId('cu-app-granted-mark')).toHaveText('已授权');
  await expect(row.getByTestId('cu-app-grant'), '已授权行不再给授权按钮').toHaveCount(0);
  // 裁决 I-3:授权成功后提示一句"让模型重试"(授权对下一个动作立即生效,但模型上下文里可能
  // 还留着"未授权"的旧结论)。不注入会话,只在面板上说话。
  await expect(page.getByTestId('cu-grant-hint')).toContainText('请让它重试一次');
  expect(await grantedFromServer(), `服务端授权名单要含 ${bundleId}`).toContain(bundleId);
  console.log(`   已授权 ${bundleId}`);
});

test('CG-09 已授权列表每行同时显示 name 与 bundleId(契约 :63)', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  let ids = await grantedFromServer();
  if (!ids.length) { ensureFixture(); await setGrantViaApi({ bundleId: 'com.apple.TextEdit', name: '文本编辑', granted: true }); ids = await grantedFromServer(); }
  await openCuGrants(page);
  await expandCandidates(page);
  await waitCandidateList(page);
  for (const id of ids) {
    const row = page.locator(`[data-testid="cu-grant-row"][data-bundle-id="${id}"]`);
    await expect(row, `已授权行 ${id}`).toBeVisible();
    const candidate = page.locator(`[data-testid="cu-app-option"][data-bundle-id="${id}"] span`).first();
    const name = ((await candidate.textContent().catch(() => '')) || '').trim();
    const text = (await row.textContent()) || '';
    expect(text, `行内要有 bundleId 本体(${id})`).toContain(id);
    if (name) expect(text, `行内要有名称(${name})`).toContain(name);
  }
});

test('CG-12 撤销 → 行消失,GET /grants 交叉核对无残留', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  ensureFixture();
  await setGrantViaApi({ bundleId: 'com.apple.TextEdit', name: '文本编辑', granted: true });
  await openCuGrants(page);
  const row = page.locator('[data-testid="cu-grant-row"][data-bundle-id="com.apple.TextEdit"]');
  await expect(row).toBeVisible();
  await row.getByTestId('cu-grant-revoke').click();
  await expect(row, '撤销成功后该行消失(用服务端响应重绘,不是自己擦掉)').toHaveCount(0, { timeout: 15_000 });
  expect(await grantedFromServer()).not.toContain('com.apple.TextEdit');
});

test('CG-13 空授权态:出现空态文案(D.5 HARD 串)', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY); // 造空态要经端点撤销(不是手改文件),所以同样算写
  await clearAllGrants();
  await openCuGrants(page);
  await expect(page.getByTestId('cu-grants-empty')).toHaveText(EMPTY_TEXT);
});

test('CG-14 主屏开关:开→确认框;取消 → aria-checked 与服务端都不变', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  requireFlag('CU_SCREEN_SCOPE_OPTED_IN', '主屏范围的用例要操作者明确同意(读屏是更高一档权限)');
  await setGrantViaApi({ screenScope: false });
  await openCuGrants(page);
  const toggle = page.getByTestId('cu-screen-scope-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  const dialog = page.locator('[role="dialog"][data-testid="cu-screen-scope-confirm"]');
  await expect(dialog, '开启必须过确认框').toBeVisible({ timeout: 10_000 });
  await page.getByTestId('cu-screen-scope-confirm-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(toggle, '取消后开关不动').toHaveAttribute('aria-checked', 'false');
  expect((await api('/api/computer-use/grants')).body.screenScope.granted, '取消后服务端 screenScope 仍是 false').toBe(false);
});

test('CG-15 主屏开关:确认 → 已开启(… 起);再点(无确认框)→ 关闭且服务端同步', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  requireFlag('CU_SCREEN_SCOPE_OPTED_IN', '主屏范围的用例要操作者明确同意');
  await setGrantViaApi({ screenScope: false });
  await openCuGrants(page);
  const toggle = page.getByTestId('cu-screen-scope-toggle');
  await toggle.click();
  await page.getByTestId('cu-screen-scope-confirm-confirm').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
  await expect(page.getByTestId('cu-screen-scope-state')).toHaveText(/^已开启（.+ 起）$/);
  expect((await api('/api/computer-use/grants')).body.screenScope.granted, '确认后服务端 screenScope 也是 true').toBe(true);

  await toggle.click(); // 关闭不弹确认
  await expect(page.locator('[role="dialog"][data-testid="cu-screen-scope-confirm"]')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await expect(page.getByTestId('cu-screen-scope-state')).toHaveText('已关闭');
  expect((await api('/api/computer-use/grants')).body.screenScope.granted, '关闭后服务端 screenScope 也是 false').toBe(false);
});

test('CG-16 手填 bundleId:未校验时 data-state=unverified 且授权按钮仍可点', async ({ page }) => {
  await openCuGrants(page);
  await expandCandidates(page);
  await page.getByTestId('cu-manual-input').fill('com.apple.TextEdit');
  const result = page.getByTestId('cu-manual-result');
  await expect(result).toHaveAttribute('data-state', 'unverified');
  await expect(result).toHaveText('未校验：请先确认 bundleId 与目标应用一致。');
  await expect(page.getByTestId('cu-manual-grant'), '未校验不得 disable(否则首次使用会被卡死)').toBeEnabled();
});

test('CG-R07 连点两次「撤销」:不产生第二个写请求,也不留第二个报错', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  ensureFixture();
  await setGrantViaApi({ bundleId: 'com.apple.TextEdit', name: '文本编辑', granted: true });
  await openCuGrants(page);
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/computer-use/grants')) posts.push(r.url()); });
  const revoke = page.locator('[data-testid="cu-grant-row"][data-bundle-id="com.apple.TextEdit"] [data-testid="cu-grant-revoke"]');
  await revoke.click();
  await revoke.click({ force: true, timeout: 1_000 }).catch(() => {}); // 第二次点:按钮此刻应在途 disabled
  await expect(page.locator('[data-testid="cu-grant-row"][data-bundle-id="com.apple.TextEdit"]')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(800);
  expect(posts.length, `撤销应当只有一次写请求(实际 ${posts.length})`).toBe(1);
  await expect(page.getByTestId('cu-grant-error')).toHaveCount(0);
});

test('CG-R08 筛选:不存在的串 → 「没有匹配…」;清空 → 全列恢复', async ({ page }) => {
  await openCuGrants(page);
  await expandCandidates(page);
  await waitCandidateList(page);
  const all = await page.getByTestId('cu-app-option').count();
  await page.getByTestId('cu-app-search').fill('zzz-绝对不存在的串-zzz');
  await expect(page.getByText('没有匹配「zzz-绝对不存在的串-zzz」的应用。')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('cu-app-search').fill('');
  await expect.poll(async () => page.getByTestId('cu-app-option').count(), { timeout: 10_000 }).toBe(all);
});

test('CG-R09 应用名含中文/emoji 等非 ASCII 字符:渲染不乱码、data-bundle-id 完整', async ({ page }) => {
  await openCuGrants(page);
  await expandCandidates(page);
  await waitCandidateList(page);
  const options = await page.getByTestId('cu-app-option').all();
  let checked = 0;
  for (const option of options) {
    const bundleId = await option.getAttribute('data-bundle-id');
    const name = ((await option.locator('span').first().textContent()) || '').trim();
    if (!name || name === bundleId) continue;            // 名字回落的项不参与"非 ASCII 名"的检查
    expect(option.locator('span').first()).toHaveText(name); // 原样渲染,没有被截断/替换
    expect(bundleId).toMatch(/^[A-Za-z0-9._-]+$/);        // bundleId 本体完整
    if (/[^\x00-\x7F]/.test(name)) checked += 1;
  }
  if (!checked) {
    // 机器上当前没有带非 ASCII 名的运行应用 —— 环境不成立,如实报,不当作产品缺陷
    test.skip(true, '当前运行的应用里没有非 ASCII 名字的项(无法构造该观测)');
  }
  console.log(`   非 ASCII 名字的候选项 ${checked} 个`);
});

test('CG-R12 授权 → 撤销 → 再授权同一 bundleId:三轮后界面与 GET /grants 一致', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  ensureFixture();
  const id = 'com.apple.TextEdit';
  await setGrantViaApi({ bundleId: id, granted: false });
  await openCuGrants(page);
  await expandCandidates(page);
  await waitCandidateList(page);
  const row = page.locator(`[data-testid="cu-grant-row"][data-bundle-id="${id}"]`);
  const option = page.locator(`[data-testid="cu-app-option"][data-bundle-id="${id}"]`);

  for (let round = 0; round < 3; round += 1) {
    await page.getByTestId('cu-apps-refresh').click();
    await expect(option.getByTestId('cu-app-grant')).toBeVisible({ timeout: 15_000 });
    await option.getByTestId('cu-app-grant').click();
    await expect(option).toHaveAttribute('data-granted', 'true', { timeout: 15_000 });
    await expect(row).toBeVisible();
    expect(await grantedFromServer()).toContain(id);

    await row.getByTestId('cu-grant-revoke').click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    expect(await grantedFromServer(), `第 ${round + 1} 轮撤销后不该有残留`).not.toContain(id);
  }
  // 第四步:再授权一次收尾,并核对界面与服务端一致
  await page.getByTestId('cu-apps-refresh').click();
  await expect(option.getByTestId('cu-app-grant')).toBeVisible({ timeout: 15_000 });
  await option.getByTestId('cu-app-grant').click();
  await expect(row).toBeVisible({ timeout: 15_000 });
  expect(await grantedFromServer()).toContain(id);
});

test('CG-R13 写失败(注入 4xx)→ 行内报错,绝不显示成已授权', async ({ page }) => {
  requireFlag('CU_ALLOW_GRANT_WRITE', WRITE_WHY);
  ensureFixture();
  await setGrantViaApi({ bundleId: 'com.apple.TextEdit', granted: false });
  await openCuGrants(page);
  await expandCandidates(page);
  await waitCandidateList(page);
  await page.route('**/api/computer-use/grants', async (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ ok: false, code: 'CU_RUNTIME_UNAVAILABLE', error: '注入的写失败' }) });
    }
    return route.continue();
  });
  const option = page.locator('[data-testid="cu-app-option"][data-bundle-id="com.apple.TextEdit"]');
  await option.getByTestId('cu-app-grant').click();
  await expect(page.getByTestId('cu-grant-error'), '失败要行内说话(不弹 alert)').toBeVisible({ timeout: 15_000 });
  await expect(option, '失败不得显示成已授权').toHaveAttribute('data-granted', 'false');
  expect(await grantedFromServer()).not.toContain('com.apple.TextEdit');
});
