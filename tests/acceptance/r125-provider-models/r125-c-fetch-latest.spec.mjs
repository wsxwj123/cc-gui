// r125 · C 组:模型按钮页「拉取最新」(INTERFACE §C C1–C4)。
// 依据只有 .devflow/BRIEF-r125.md 与 .devflow/INTERFACE-r125.md;没看实现代码。
// 目录由浏览器层请求拦截给定 POST /api/provider/fetch-models 的返回体,不联网(拦截装在进应用之后,不影响启动期的自动拉取)。
// 三类 provider:官方 = builtin-official;自定义 = 用例自己建;导入 = 隔离实例里若没有就运行时 skip 并说明。
// 官方 provider 的模型选择存储是全局状态,每条用例前后都清空(PUT /api/provider-models/builtin-official {models:[]})。
import { test, expect } from '@playwright/test';
import { createCustomProvider, switchProvider, getProviders, getModel, getProviderModels, putProviderModels, customModelsOf } from './helpers/api.mjs';
import {
  boot, routeJson, openModelPage, fetchLatestButton, modelPage, modelRowShown, pickModalAny, pickConfirmAny, pickCancelAny,
  boxOf, checkedIds, anchorPath, textOf,
} from './helpers/ui.mjs';

const OFFICIAL = 'builtin-official';
const sorted = (a) => [...a].sort();
const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));
const stub = (models, extra = {}) => ({ ok: true, models, source: 'r125-stub', status: 'available', ...extra });
const availableIds = async () => ((await getModel()).json?.available ?? []).map((m) => m.id);
/** GET /api/provider-models 里某 provider 的条目(INTERFACE 写的是 {[id]:[…]},实测包在 selections 里;两种都认)。 */
const selectionsOf = async (id) => { const j = (await getProviderModels()).json; return (j?.selections ?? j ?? {})[id] ?? null; };
const OFF_CATALOG = ['claude-sonnet-4-6', 'r125-off-new-1', 'r125-off-new-2'];
const CUSTOM_OLD = ['r125-old-a', 'r125-old-b'];
const CUSTOM_CATALOG = ['r125-old-a', 'r125-old-b', 'r125-new-c', 'r125-new-d'];

test.skip(!process.env.R125_UI_BASE, '没有 dev server(R125_API_ONLY=1)');
test.beforeEach(async () => { await putProviderModels(OFFICIAL, []); });
test.afterEach(async () => { await putProviderModels(OFFICIAL, []); });

/** 进应用 → 开模型页 → 装目录拦截 → 点「拉取最新」。 */
async function fetchLatest(page, catalogOrBody) {
  await boot(page);
  await openModelPage(page);
  await routeJson(page, '/api/provider/fetch-models', Array.isArray(catalogOrBody) ? stub(catalogOrBody) : catalogOrBody, { method: 'POST' });
  await fetchLatestButton(page).click({ force: true });
}
async function expectModal(page, why) {
  await expect(pickModalAny(page), why).toBeVisible({ timeout: 10_000 });
  console.log(`[r125] 勾选弹窗锚点路径:${await anchorPath(page)}`);
}
/** 隔离实例里"从 cc-switch 导入的 provider":providers[] 里非官方的一条,或 openaiProviders[] 的第一条;没有则 null。 */
async function findImported() {
  const r = await getProviders();
  return (r.json?.providers ?? []).find((p) => p.id !== OFFICIAL && p.category !== 'official' && !p.isCustom)
    || (r.json?.openaiProviders ?? []).find((p) => !p.isCustom) || null;
}

// ═══════════════════════════ C1 三类 provider 都弹窗 ═══════════════════════════
test.describe('C1 三类 provider 都弹窗', () => {
  test('C1-官方-1 当前为官方 provider:「拉取最新」拉到非空目录 → 勾选窗出现', async ({ page }) => {
    await switchProvider(OFFICIAL);
    await fetchLatest(page, OFF_CATALOG);
    await expectModal(page, '官方 provider 点「拉取最新」也应弹出勾选窗(今天只把目录合并进下拉、不弹窗)');
  });

  test('C1-官方-2 弹窗里当前显示中的模型(claude-sonnet-4-6)预先 checked,新候选未勾', async ({ page }) => {
    await switchProvider(OFFICIAL);
    await fetchLatest(page, OFF_CATALOG);
    await expectModal(page, '前提:弹窗出现');
    await expect(await boxOf(page, 'claude-sonnet-4-6'), '当前显示中的模型应预先勾上').toBeChecked();
    await expect(await boxOf(page, 'r125-off-new-1'), '没显示过的新候选不该预勾').not.toBeChecked();
  });

  test('C1-导入 当前为导入的 provider:「拉取最新」拉到非空目录 → 勾选窗出现,当前显示中的模型预先 checked', async ({ page }) => {
    const imported = await findImported();
    test.skip(!imported, '隔离实例里没有从 cc-switch 导入的 provider(实例不读任何 cc-switch 库路径,也造不出导入项)——本条无法覆盖');
    await switchProvider(imported.id);
    const shown = await availableIds();
    await fetchLatest(page, [...shown.slice(0, 1), 'r125-imp-new-1']);
    await expectModal(page, '导入的 provider 点「拉取最新」也应弹出勾选窗');
    await expect(await boxOf(page, shown[0])).toBeChecked();
    await expect(await boxOf(page, 'r125-imp-new-1')).not.toBeChecked();
  });

  test('C1-自定义 当前为自定义 provider:「拉取最新」拉到非空目录 → 勾选窗出现,白名单里的模型预先 checked', async ({ page }) => {
    const p = await createCustomProvider({ models: CUSTOM_OLD });
    await switchProvider(p.id);
    await fetchLatest(page, CUSTOM_CATALOG);
    await expectModal(page, '自定义 provider 点「拉取最新」应弹出勾选窗(今天已如此)');
    await expect(await boxOf(page, 'r125-old-a')).toBeChecked();
    await expect(await boxOf(page, 'r125-new-c')).not.toBeChecked();
  });
});

// ═══════════════════════════ C2 确认后下拉只显示勾选的 ═══════════════════════════
test.describe('C2 确认后下拉只显示勾选的', () => {
  /** 官方:弹窗里保留 claude-sonnet-4-6、勾上 r125-off-new-1、不勾 r125-off-new-2 → 确认。 */
  async function confirmOfficialSubset(page) {
    await switchProvider(OFFICIAL);
    await fetchLatest(page, OFF_CATALOG);
    await expectModal(page, '前提:官方 provider 点「拉取最新」弹窗');
    await (await boxOf(page, 'r125-off-new-1')).click({ force: true });
    expect(await checkedIds(page), '前提:最终勾选 = claude-sonnet-4-6 + r125-off-new-1').toEqual(sorted(['claude-sonnet-4-6', 'r125-off-new-1']));
    await pickConfirmAny(page).click({ force: true });
    await settle();
  }

  test('C2-官方-1 确认后 GET /api/provider-models 里 builtin-official 的条目 = 勾选集合', async ({ page }) => {
    await confirmOfficialSubset(page);
    await expect.poll(async () => sorted(await selectionsOf(OFFICIAL) ?? []), { timeout: 10_000, message: '官方 provider 的选择应写进每 provider 模型选择存储' })
      .toEqual(sorted(['claude-sonnet-4-6', 'r125-off-new-1']));
  });

  test('C2-官方-2 确认后模型下拉只显示勾选的:含 r125-off-new-1、不含 r125-off-new-2', async ({ page }) => {
    await confirmOfficialSubset(page);
    await openModelPage(page);
    await expect(modelRowShown(page, 'r125-off-new-1'), '勾选的模型应出现在下拉列表').toBeVisible({ timeout: 10_000 });
    await expect(modelRowShown(page, 'r125-off-new-2'), '没勾的模型不该出现在下拉列表').toHaveCount(0);
  });

  test('C2-官方-3 确认后 GET /api/model 的 available 与下拉一致:含 r125-off-new-1、不含 r125-off-new-2', async ({ page }) => {
    await confirmOfficialSubset(page);
    await expect.poll(availableIds, { timeout: 10_000, message: '/api/model 的 available 应含勾选的模型' }).toContain('r125-off-new-1');
    expect(await availableIds(), '/api/model 的 available 不该含没勾的模型').not.toContain('r125-off-new-2');
  });

  /** 自定义:弹窗里勾掉 r125-old-a、勾上 r125-new-c → 确认。 */
  async function confirmCustomSubset(page) {
    const p = await createCustomProvider({ models: CUSTOM_OLD });
    await switchProvider(p.id);
    await fetchLatest(page, CUSTOM_CATALOG);
    await expectModal(page, '前提:自定义 provider 点「拉取最新」弹窗');
    await (await boxOf(page, 'r125-old-a')).click({ force: true });
    await (await boxOf(page, 'r125-new-c')).click({ force: true });
    expect(await checkedIds(page), '前提:最终勾选 = r125-old-b + r125-new-c').toEqual(sorted(['r125-old-b', 'r125-new-c']));
    await pickConfirmAny(page).click({ force: true });
    await settle();
    return p;
  }

  test('C2-自定义-1 确认后模型下拉只显示勾选的:含 r125-new-c、不含被勾掉的 r125-old-a', async ({ page }) => {
    await confirmCustomSubset(page);
    await openModelPage(page);
    await expect(modelRowShown(page, 'r125-new-c'), '新勾的模型应出现在下拉列表').toBeVisible({ timeout: 10_000 });
    await expect(modelRowShown(page, 'r125-old-a'), '被勾掉的模型不该再出现在下拉列表').toHaveCount(0);
  });

  test('C2-自定义-2 确认后 GET /api/model 的 available 恰为勾选集合 [r125-old-b, r125-new-c]', async ({ page }) => {
    const p = await confirmCustomSubset(page);
    await expect.poll(async () => sorted(await customModelsOf(p.id) ?? []), { timeout: 10_000 }).toEqual(sorted(['r125-old-b', 'r125-new-c']));
    expect(sorted(await availableIds()), '/api/model 的 available 应与写回的白名单一致').toEqual(sorted(['r125-old-b', 'r125-new-c']));
  });

  test('C2-手动 用户手动添加过的自定义模型 id 在确认勾选后照旧保留显示', async ({ page }) => {
    const p = await createCustomProvider({ models: CUSTOM_OLD });
    await switchProvider(p.id);
    await boot(page);
    await openModelPage(page);
    const manual = page.getByPlaceholder('自定义模型 ID...').first();
    await expect(manual, '模型页应有「自定义模型 ID...」输入框(既有功能)').toBeVisible();
    await manual.fill('r125-manual-z');
    await manual.press('Enter');
    await settle(600);
    await openModelPage(page);
    await expect(modelRowShown(page, 'r125-manual-z'), '前提:手动添加的 id 出现在下拉列表').toBeVisible({ timeout: 10_000 });
    await routeJson(page, '/api/provider/fetch-models', stub(CUSTOM_CATALOG), { method: 'POST' });
    await fetchLatestButton(page).click({ force: true });
    await expectModal(page, '前提:弹窗出现');
    await (await boxOf(page, 'r125-new-c')).click({ force: true });
    await pickConfirmAny(page).click({ force: true });
    await settle();
    await openModelPage(page);
    await expect(modelRowShown(page, 'r125-new-c'), '新勾的模型应显示').toBeVisible({ timeout: 10_000 });
    await expect(modelRowShown(page, 'r125-manual-z'), '手动添加过的自定义 id 应照旧保留显示').toBeVisible();
  });
});

// ═══════════════════════════ C3 未选择过 = 显示全部 ═══════════════════════════
test.describe('C3 未选择过 = 显示全部', () => {
  test('C3-a 从未做过选择的官方 provider:GET /api/provider-models 无其条目,下拉列出 GET /api/model 给出的每个 claude-* 模型', async ({ page }) => {
    await switchProvider(OFFICIAL);
    expect(await selectionsOf(OFFICIAL) ?? [], '前提:没有选择记录').toEqual([]);
    await boot(page);
    await openModelPage(page);
    const ids = (await availableIds()).filter((id) => /^claude-/.test(id));   // 别名行显示的是名字不是 id,只核对字面 id 的行
    expect(ids.length, '前提:/api/model 至少给出一个 claude-* 模型').toBeGreaterThan(0);
    for (const id of ids) await expect(modelRowShown(page, id), `未选择过时应显示全部:${id}`).toBeVisible();
  });

  test('C3-b 从未做过选择的官方 provider:拉到目录后不做选择(取消)→ 目录里的模型全部显示,且仍没有选择记录', async ({ page }) => {
    await switchProvider(OFFICIAL);
    await fetchLatest(page, ['claude-sonnet-4-6', 'r125-c3-x', 'r125-c3-y']);
    await settle(1000);
    if (await pickModalAny(page).count()) { await pickCancelAny(page).click({ force: true }); await settle(500); }
    await openModelPage(page);
    await expect(modelRowShown(page, 'r125-c3-x'), '与今天一致:拉到的目录全部显示').toBeVisible({ timeout: 10_000 });
    await expect(modelRowShown(page, 'r125-c3-y')).toBeVisible();
    expect(await selectionsOf(OFFICIAL) ?? [], '没做选择就不该写选择记录').toEqual([]);
  });

  test('C3-c 清除选择(PUT 空数组)后 GET /api/model 的 available 回到"从未选择"时的样子', async () => {
    await switchProvider(OFFICIAL);
    const baseline = await availableIds();
    await putProviderModels(OFFICIAL, ['claude-sonnet-4-6']);
    await putProviderModels(OFFICIAL, []);
    expect(await selectionsOf(OFFICIAL) ?? []).toEqual([]);
    expect(await availableIds(), '空数组 = 清除该 provider 的选择,行为回到今天').toEqual(baseline);
  });
});

// ═══════════════════════════ C4 失败不弹窗 ═══════════════════════════
test.describe('C4 失败不弹窗', () => {
  const CASES = [
    ['C4-1 HTTP 500 {error}', { __status: 500, __body: { error: 'r125 桩 500' } }],
    ['C4-2 ok:false 空目录(note 里故意不含「失败」「未返回」)', { ok: false, models: [], status: 'unavailable', note: '上游没有目录(r125 桩)' }],
    ['C4-3 ok:true 但目录为空', { ok: true, models: [], status: 'available', source: 'r125-stub' }],
  ];
  for (const [title, body] of CASES) {
    test(`${title} → 不出现弹窗,模型页出现含「失败」或「未返回」的提示`, async ({ page }) => {
      await switchProvider(OFFICIAL);
      await fetchLatest(page, body);
      await settle(1200);
      await expect(pickModalAny(page), '拉取失败 / 空目录时不该弹勾选窗').toHaveCount(0);
      await expect(fetchLatestButton(page), '模型页应还开着').toBeVisible();
      expect(await textOf(modelPage(page)), '页面应给一句原因(含「失败」或「未返回」)').toMatch(/失败|未返回/);
    });
  }

  test('C4-4 自定义 provider 上 HTTP 500 → 同样不弹窗、给出含「失败」的提示', async ({ page }) => {
    const p = await createCustomProvider({ models: CUSTOM_OLD });
    await switchProvider(p.id);
    await fetchLatest(page, { __status: 500, __body: { error: 'r125 桩 500' } });
    await settle(1200);
    await expect(pickModalAny(page)).toHaveCount(0);
    expect(await textOf(modelPage(page))).toMatch(/失败|未返回/);
  });
});
