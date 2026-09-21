// r125 · B 组:模型勾选弹窗(INTERFACE §B B1–B5),两处入口各覆盖一遍:
//   (M) 模型按钮页 → 当前 provider 为自定义 provider → 「拉取最新」
//   (I) 生图面板 → 已有生图 provider 的「编辑」表单 → 「拉取模型」
// 依据只有 .devflow/BRIEF-r125.md 与 .devflow/INTERFACE-r125.md;没看实现代码。
// 目录由浏览器层请求拦截给定(/api/provider/fetch-models、/api/image-providers/fetch-models),不联网。
// 锚点:INTERFACE §B 的 data-testid 优先,当前代码没有 → 兜底为探路实测的既有形态(见 helpers/ui.mjs);用了哪条路径打在日志里。
// 每条用例自己建一条 provider(白名单 = 两个"已选"模型),用例之间不共享可变状态。
import { test, expect } from '@playwright/test';
import { createCustomProvider, createImageProvider, switchProvider, customModelsOf, imageModelsOf } from './helpers/api.mjs';
import {
  boot, routeJson, openModelPage, fetchLatestButton, pickModalAny, pickConfirmAny, pickCancelAny, pickSelectAll, pickSelectNone,
  pickSearchAny, boxOf, checkedIds, anchorPath, openImagePanel, openNewImageProviderForm, imageBaseInput, openImageProviderEdit,
  imageFetchModelsButton, imageSaveButton,
} from './helpers/ui.mjs';

const OLD = ['r125-old-a', 'r125-old-b'];
const CATALOG = ['r125-old-a', 'r125-old-b', 'r125-new-c', 'r125-new-d', 'zz-other'];
const IMG_OLD = ['r125-img-old-a', 'r125-img-old-b'];
const IMG_CATALOG = ['r125-img-old-a', 'r125-img-old-b', 'r125-img-new-c', 'r125-img-new-d', 'zz-img'];
const sorted = (a) => [...a].sort();
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

test.skip(!process.env.R125_UI_BASE, '没有 dev server(R125_API_ONLY=1)');

/** 记录写回类请求(反向断言用:关闭弹窗不该产生任何写回)。 */
function watchWrites(page, pathPrefix) {
  const writes = [];
  page.on('request', (r) => { if (['PUT', 'POST', 'DELETE'].includes(r.method()) && new URL(r.url()).pathname.startsWith(pathPrefix)) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  return writes;
}

// ═══════════════════════════ (M) 模型按钮页 · 自定义 provider ═══════════════════════════
test.describe('B·M 模型按钮页(自定义 provider)', () => {
  /** 建 provider → 切过去 → 进应用 → 开模型页 → 拦截目录 → 点「拉取最新」→ 弹窗出现。 */
  async function openPick(page, { models = OLD, catalog = CATALOG } = {}) {
    const p = await createCustomProvider({ models });
    await switchProvider(p.id, models.length ? {} : { model: 'r125-manual-m' });
    await boot(page);
    await openModelPage(page);
    await routeJson(page, '/api/provider/fetch-models', { ok: true, models: catalog, source: 'r125-stub', status: 'available' }, { method: 'POST' });
    await fetchLatestButton(page).click({ force: true });
    await expect(pickModalAny(page), '点「拉取最新」后应弹出勾选窗').toBeVisible({ timeout: 10_000 });
    console.log(`[r125] 勾选弹窗锚点路径:${await anchorPath(page)}`);
    return p;
  }

  test('B1-M-1 已在白名单的模型:checkbox 为 checked 且不带 disabled', async ({ page }) => {
    await openPick(page);
    const box = await boxOf(page, 'r125-old-a');
    await expect(box, '已选模型应预先勾上').toBeChecked();
    await expect(box, '已选模型不得禁用(要能弃选)').toBeEnabled();
  });

  test('B1-M-2 点已在白名单的模型 → 变为未勾选', async ({ page }) => {
    await openPick(page);
    const box = await boxOf(page, 'r125-old-a');
    await expect(box, '前提:已选模型预先勾上').toBeChecked();
    await box.click({ force: true });
    await expect(box, '点一下应能弃选').not.toBeChecked();
  });

  test('B2-M 勾掉一个已选、勾上一个新候选 → 确认 → 写回 = 弹窗里最终勾选的集合', async ({ page }) => {
    const p = await openPick(page);
    await (await boxOf(page, 'r125-old-a')).click({ force: true });
    await (await boxOf(page, 'r125-new-c')).click({ force: true });
    expect(await checkedIds(page), '前提:弹窗里最终勾选的是 old-b + new-c').toEqual(sorted(['r125-old-b', 'r125-new-c']));
    await expect(pickConfirmAny(page)).toBeEnabled();
    await pickConfirmAny(page).click({ force: true });
    await expect.poll(async () => sorted(await customModelsOf(p.id) ?? []), { timeout: 10_000, message: 'GET /api/providers 的 customProviders[].models 应等于最终勾选集合(勾掉的被移除、新勾的加入)' })
      .toEqual(sorted(['r125-old-b', 'r125-new-c']));
  });

  test('B3-M 把所有已勾的都取消 → 确认按钮 disabled', async ({ page }) => {
    await openPick(page);
    for (const id of OLD) await (await boxOf(page, id)).click({ force: true });
    expect(await checkedIds(page), '前提:两个已选模型都已被弃选').toEqual([]);
    await expect(pickConfirmAny(page), '一个都不勾时确认不可用(避免误清空)').toBeDisabled();
  });

  test('B3-M-空 白名单为空的 provider:弹窗里什么都没勾 → 确认按钮 disabled', async ({ page }) => {
    await openPick(page, { models: [] });
    expect(await checkedIds(page), '前提:没有任何预勾').toEqual([]);
    await expect(pickConfirmAny(page)).toBeDisabled();
  });

  test('B4-M-Esc 改了勾选后按 Esc → 白名单逐字不变,且没有任何写回请求', async ({ page }) => {
    const p = await openPick(page);
    const before = await customModelsOf(p.id);
    const writes = watchWrites(page, '/api/custom-providers');
    await (await boxOf(page, 'r125-new-c')).click({ force: true });
    await (await boxOf(page, 'r125-old-a')).click({ force: true }).catch(() => {});
    await page.keyboard.press('Escape');
    await settle();
    expect(await customModelsOf(p.id), '按 Esc 关闭不得改白名单').toEqual(before);
    expect(writes, '按 Esc 关闭不得发出任何写回').toEqual([]);
  });

  test('B4-M-取消 改了勾选后点「取消」→ 白名单逐字不变,且没有任何写回请求', async ({ page }) => {
    const p = await openPick(page);
    const before = await customModelsOf(p.id);
    const writes = watchWrites(page, '/api/custom-providers');
    await (await boxOf(page, 'r125-new-c')).click({ force: true });
    await (await boxOf(page, 'r125-old-a')).click({ force: true }).catch(() => {});
    await pickCancelAny(page).click({ force: true });
    await settle();
    expect(await customModelsOf(p.id), '点「取消」不得改白名单').toEqual(before);
    expect(writes, '点「取消」不得发出任何写回').toEqual([]);
  });

  test('B5-M-全选 搜索框输入前缀后点「全选」→ 只有匹配行被勾上', async ({ page }) => {
    await openPick(page);
    await pickSearchAny(page).fill('r125-new');
    await settle(300);
    await pickSelectAll(page).click({ force: true });
    await pickSearchAny(page).fill('');
    await settle(300);
    expect(await checkedIds(page), '全选只作用于筛选结果:预勾的 old-a/old-b 保持、new-c/new-d 被勾上、zz-other 不动')
      .toEqual(sorted(['r125-old-a', 'r125-old-b', 'r125-new-c', 'r125-new-d']));
  });

  test('B5-M-全不选 全选后按前缀筛选再点「全不选」→ 只有匹配行被取消', async ({ page }) => {
    await openPick(page);
    await pickSelectAll(page).click({ force: true });
    expect(await checkedIds(page), '前提:全选后全部勾上').toEqual(sorted(CATALOG));
    await pickSearchAny(page).fill('r125-new');
    await settle(300);
    await pickSelectNone(page).click({ force: true });
    await pickSearchAny(page).fill('');
    await settle(300);
    expect(await checkedIds(page), '全不选只作用于筛选结果:new-c/new-d 被取消,其余照旧')
      .toEqual(sorted(['r125-old-a', 'r125-old-b', 'zz-other']));
  });
});

// ═══════════════════════════ (I) 生图 provider 表单 ═══════════════════════════
test.describe('B·I 生图 provider 表单', () => {
  /** 建生图 provider → 进应用 → 选中它 → 「编辑」→ 拦截目录 → 点「拉取模型」→ 弹窗出现。 */
  async function openPick(page, { models = IMG_OLD, catalog = IMG_CATALOG } = {}) {
    const p = await createImageProvider({ models, model: models[0] || 'r125-img-x' });
    await boot(page);
    await openImageProviderEdit(page, p.id);
    await routeJson(page, '/api/image-providers/fetch-models', { ok: true, models: catalog }, { method: 'POST' });
    await imageFetchModelsButton(page).click({ force: true });
    await expect(pickModalAny(page), '点「拉取模型」后应弹出勾选窗').toBeVisible({ timeout: 10_000 });
    console.log(`[r125] 勾选弹窗锚点路径:${await anchorPath(page)}`);
    return p;
  }
  /** 弹窗关掉后,表单若还开着就点「保存」(生图表单的写回发生在「保存」)。 */
  async function saveIfOpen(page) {
    if (await imageSaveButton(page).isVisible().catch(() => false)) { await imageSaveButton(page).click({ force: true }); await settle(900); }
  }

  test('B1-I-1 已在 models 里的模型:checkbox 为 checked 且不带 disabled', async ({ page }) => {
    await openPick(page);
    const box = await boxOf(page, 'r125-img-old-a');
    await expect(box, '已选模型应预先勾上').toBeChecked();
    await expect(box, '已选模型不得禁用(要能弃选)').toBeEnabled();
  });

  test('B1-I-2 点已在 models 里的模型 → 变为未勾选', async ({ page }) => {
    await openPick(page);
    const box = await boxOf(page, 'r125-img-old-a');
    await expect(box, '前提:已选模型预先勾上').toBeChecked();
    await box.click({ force: true });
    await expect(box, '点一下应能弃选').not.toBeChecked();
  });

  test('B2-I 勾掉一个已选、勾上一个新候选 → 确认 → 保存 → GET /api/image-providers 的 models = 最终勾选集合', async ({ page }) => {
    const p = await openPick(page);
    await (await boxOf(page, 'r125-img-old-a')).click({ force: true });
    await (await boxOf(page, 'r125-img-new-c')).click({ force: true });
    expect(await checkedIds(page), '前提:弹窗里最终勾选的是 old-b + new-c').toEqual(sorted(['r125-img-old-b', 'r125-img-new-c']));
    await pickConfirmAny(page).click({ force: true });
    await settle(400);
    await saveIfOpen(page);
    await expect.poll(async () => sorted(await imageModelsOf(p.id) ?? []), { timeout: 10_000, message: 'models 应等于最终勾选集合(勾掉的被移除、新勾的加入)' })
      .toEqual(sorted(['r125-img-old-b', 'r125-img-new-c']));
  });

  test('B3-I 把所有已勾的都取消 → 确认按钮 disabled', async ({ page }) => {
    await openPick(page);
    for (const id of IMG_OLD) await (await boxOf(page, id)).click({ force: true });
    expect(await checkedIds(page), '前提:两个已选模型都已被弃选').toEqual([]);
    await expect(pickConfirmAny(page), '一个都不勾时确认不可用(避免误清空)').toBeDisabled();
  });

  test('B3-I-新建 新建生图 provider 表单里拉到目录、什么都没勾 → 确认按钮 disabled', async ({ page }) => {
    await boot(page);
    await openImagePanel(page);
    await openNewImageProviderForm(page);
    await imageBaseInput(page).fill('http://127.0.0.1:9/v1');
    await routeJson(page, '/api/image-providers/fetch-models', { ok: true, models: IMG_CATALOG }, { method: 'POST' });
    await imageFetchModelsButton(page).click({ force: true });
    await expect(pickModalAny(page), '点「拉取模型」后应弹出勾选窗').toBeVisible({ timeout: 10_000 });
    expect(await checkedIds(page), '前提:没有任何预勾').toEqual([]);
    await expect(pickConfirmAny(page)).toBeDisabled();
  });

  test('B4-I-Esc 改了勾选后按 Esc(再保存)→ models 逐字不变', async ({ page }) => {
    const p = await openPick(page);
    const before = await imageModelsOf(p.id);
    await (await boxOf(page, 'r125-img-new-c')).click({ force: true });
    await (await boxOf(page, 'r125-img-old-a')).click({ force: true }).catch(() => {});
    await page.keyboard.press('Escape');
    await settle(400);
    await expect(pickModalAny(page), 'Esc 应关掉勾选窗').toHaveCount(0);
    await saveIfOpen(page);
    expect(await imageModelsOf(p.id), '按 Esc 关闭不得改 models').toEqual(before);
  });

  test('B4-I-取消 改了勾选后点「取消」(再保存)→ models 逐字不变', async ({ page }) => {
    const p = await openPick(page);
    const before = await imageModelsOf(p.id);
    await (await boxOf(page, 'r125-img-new-c')).click({ force: true });
    await (await boxOf(page, 'r125-img-old-a')).click({ force: true }).catch(() => {});
    await pickCancelAny(page).click({ force: true });
    await settle(400);
    await expect(pickModalAny(page), '「取消」应关掉勾选窗').toHaveCount(0);
    await saveIfOpen(page);
    expect(await imageModelsOf(p.id), '点「取消」不得改 models').toEqual(before);
  });

  test('B5-I-全选 搜索框输入前缀后点「全选」→ 只有匹配行被勾上', async ({ page }) => {
    await openPick(page);
    await pickSearchAny(page).fill('r125-img-new');
    await settle(300);
    await pickSelectAll(page).click({ force: true });
    await pickSearchAny(page).fill('');
    await settle(300);
    expect(await checkedIds(page), '全选只作用于筛选结果').toEqual(sorted(['r125-img-old-a', 'r125-img-old-b', 'r125-img-new-c', 'r125-img-new-d']));
  });

  test('B5-I-全不选 全选后按前缀筛选再点「全不选」→ 只有匹配行被取消', async ({ page }) => {
    await openPick(page);
    await pickSelectAll(page).click({ force: true });
    expect(await checkedIds(page), '前提:全选后全部勾上').toEqual(sorted(IMG_CATALOG));
    await pickSearchAny(page).fill('r125-img-new');
    await settle(300);
    await pickSelectNone(page).click({ force: true });
    await pickSearchAny(page).fill('');
    await settle(300);
    expect(await checkedIds(page), '全不选只作用于筛选结果').toEqual(sorted(['r125-img-old-a', 'r125-img-old-b', 'zz-img']));
  });
});
