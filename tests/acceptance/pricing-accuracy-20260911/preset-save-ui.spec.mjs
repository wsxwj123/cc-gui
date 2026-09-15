// PA-7xx：E 项在真浏览器里的表现 —— 保存自定义 provider 时撞上内置预设的弹窗（契约 §10.8）。
//
// 入口与定位钩子逐条来自契约，不猜 DOM：
//   §10.12⑤ 路径 A（推荐）：全局事件 `cgui:open-provider-manager` —— 桌面端设置里已没有 Provider 入口；
//   §10.12⑤ 路径 B：data-testid `provider-manager` / `provider-add` / `provider-form` / `provider-baseurl` / `provider-save`；
//   §10.11⑥：弹窗 `preset-suggest` / `preset-suggest-confirm` / `preset-suggest-cancel`。
// 契约未公布钩子的控件（名称 / API Key / 模型 / 内置模板下拉 / 行的「编辑」键）按 placeholder、可访问名、
// title 兜底定位；找不到时报 ENVIRONMENT_BLOCKED 并点名缺什么（见 README「E 项 UI 夹具」一节的脆点说明）。
//
// 期望值一律问契约 §10.8 点名的纯函数 `matchPresetByBaseURL`（导出在 `server/utils/builtin-providers.js`），
// 不写死预设表里的名字与地址、也不按实现反推；只在**契约自己列出的 id**（§10.4 的 ZHIPU_CN_PRESETS）上钉一条。
import { test, expect } from '@playwright/test';
import {
  getRuntime, requireUI, EnvironmentBlocked, presetMatch,
  createCustomProvider, listCustomProviders,
} from './helpers/pa-runtime.mjs';

// 智谱 CN 的 anthropic 协议入口：host=open.bigmodel.cn，命中 §10.4 的 ZHIPU_CN_PRESETS 三条。
const PRESET_URL = 'https://open.bigmodel.cn/api/anthropic';
// host 不在 43 条预设的 host 集合里（§10.8 边界表：不弹）。
const FREE_URL = 'https://pa-not-registered.example/v1';
// 命中 anthropic-official（§10.8「host 逐字相等即命中」）；只在 PA-704 用作夹具地址。
const EDIT_URL = 'https://api.anthropic.com';
const EDIT_NAME = 'PA E 抑制① 编辑行';
const INVALID_URL = 'not a url';

/**
 * 新建表单的默认协议 = openai。
 * 依据：§10.8 的 `opts.type` 是「表单当前协议」，多命中时建议目标「同 type 优先」——
 * 所以要问契约函数就必须给对表单当前的协议；默认值是黑盒实测的（新建表单里「OpenAI 兼容」是激活态，
 * 提交体 `type === 'openai'`）。契约没写这个默认值，见 TEST-PLAN 的「含糊处」。
 */
const FORM_TYPE = 'openai';
const API_KEY_VALUE = 'pa-placeholder';
const MODEL_VALUE = 'pa-ui-model';

const TESTID = {
  manager: 'provider-manager',
  add: 'provider-add',
  form: 'provider-form',
  baseUrl: 'provider-baseurl',
  save: 'provider-save',
};

/**
 * 「本次更新 vX」弹层：数据根还没读过当前版本时，它盖住整页（卡片 pointer-events-auto 会挡点击），
 * 与本事无关。实测（2026-09-12，全新数据根）：不关掉它，本文件**第一条**跑到的用例必然红
 * （`provider-add` 被它 intercept），后面的用例反而绿 —— 这是对"上一个进程留下的已读状态"的依赖。
 * 出现就关掉：卡片的标题栏有关闭键（`title="关闭"`）。
 */
async function dismissReleaseNotes(page) {
  const overlay = page.locator('div.fixed.inset-0').filter({ hasText: '本次更新' }).first();
  const appeared = await overlay.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true).catch(() => false);
  if (!appeared) return;
  await overlay.locator('button[title="关闭"]').first().click();
  await expect(overlay, '「本次更新」弹层必须能被它的关闭键关掉（否则它会挡住整页）').toBeHidden({ timeout: 3_000 });
}

async function openApp(page) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  for (const name of ['关闭指引', '跳过', '稍后']) {
    const button = page.getByRole('button', { name, exact: true }).first();
    if (await button.count() && await button.first().isVisible().catch(() => false)) {
      await button.first().click().catch(() => {});
      await page.waitForTimeout(200);
    }
  }
  await dismissReleaseNotes(page);
}

function formRoot(page) {
  return page.locator(`[data-testid="${TESTID.form}"]`).first();
}

/** 关掉还开着的表单（同一个用例里可能要开两次表单：对照臂 / 复跑）。 */
async function closeOpenForm(page) {
  for (let i = 0; i < 3 && (await page.locator(`[data-testid="${TESTID.form}"]`).count()); i += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}

/** §10.12⑤ 路径 A：全局事件打开 Provider 管理弹窗（找不到就报产品没实现，不当环境问题）。 */
async function openProviderManager(page) {
  await openApp(page);
  const manager = page.locator(`[data-testid="${TESTID.manager}"]`);
  if (!(await manager.count())) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('cgui:open-provider-manager')));
  }
  await expect(manager, '契约 §10.12⑤ 路径 A：cgui:open-provider-manager 必须打开 Provider 管理弹窗')
    .toBeVisible({ timeout: 8_000 });
  return manager;
}

/** §10.12⑤ 路径 A + B：事件开管理弹窗 →「添加 Provider」→ 表单。 */
async function openProviderForm(page) {
  await closeOpenForm(page);
  await openProviderManager(page);
  const add = page.locator(`[data-testid="${TESTID.add}"]`).first();
  await expect(add, '契约 §10.12⑤ 路径 B：管理弹窗里应有 data-testid="provider-add"').toBeVisible();
  await add.click();
  const form = page.locator(`[data-testid="${TESTID.form}"]`).first();
  await expect(form, '契约 §10.12⑤ 路径 B：点「添加 Provider」后应出现 data-testid="provider-form"').toBeVisible();
  return form;
}

/**
 * Base URL 输入框：契约 §10.12⑤ 路径 B 给了 `provider-baseurl`；
 * 该处若缺，路径 C 把它钉在 placeholder 逐字 `Base URL (https://...)` 上。
 * 契约没有要求这个框带 label / aria-label（只公布了 testid 与 placeholder），所以不按 label 找。
 */
async function baseUrlField(page) {
  const byTestId = page.locator(`[data-testid="${TESTID.baseUrl}"]`).first();
  if (await byTestId.count()) return byTestId;
  const byPlaceholder = formRoot(page).locator('input[placeholder^="Base URL"]').first();
  if (await byPlaceholder.count()) return byPlaceholder;
  throw new EnvironmentBlocked('表单里找不到 Base URL 输入框（testid 与 placeholder 都不在）—— 见 README');
}

// 下面三个控件契约没公布钩子，按 placeholder / 元素类型在表单内兜底。
async function nameField(page) {
  const field = formRoot(page).locator('input[placeholder*="名称"]').first();
  if (await field.count()) return field;
  throw new EnvironmentBlocked('表单里找不到名称输入框 —— 见 README');
}

async function apiKeyField(page) {
  const field = formRoot(page).locator('input[placeholder="API Key"]').first();
  if (await field.count()) return field;
  throw new EnvironmentBlocked('表单里找不到 API Key 输入框 —— 见 README');
}

async function modelsField(page) {
  const field = formRoot(page).locator('textarea').first();
  if (await field.count()) return field;
  throw new EnvironmentBlocked('表单里找不到模型输入框（textarea）—— 见 README');
}

async function templateSelect(page) {
  const field = formRoot(page).locator('select').first();
  if (await field.count()) return field;
  throw new EnvironmentBlocked('表单里找不到「内置模板」下拉（§10.8 抑制②要它）—— 见 README');
}

async function save(page) {
  const button = page.locator(`[data-testid="${TESTID.save}"]`).first();
  await expect(button, '契约 §10.12⑤ 路径 B：保存按钮应带 data-testid="provider-save"').toBeVisible();
  await button.click();
}

async function fillNewProvider(page, { name, baseUrl }) {
  await (await nameField(page)).fill(name);
  await (await baseUrlField(page)).fill(baseUrl);
  await (await apiKeyField(page)).fill(API_KEY_VALUE);
  await (await modelsField(page)).fill(MODEL_VALUE);
}

/**
 * 让保存请求不外发，返回**按发生顺序**记录的请求。
 * 新建走 `POST /api/custom-providers`、编辑走 `PUT /api/custom-providers/<id>`，两条都要截住
 * （§10.8「编辑模式同样适用」——只拦 POST 会漏掉编辑态）。
 * GET（列表/详情）`fallback()` 放行给真实例：管理弹窗要靠它渲染出已有的 provider 行。
 */
async function captureSave(page) {
  const records = [];
  await page.route('**/api/custom-providers**', async route => {
    const request = route.request();
    if (request.method() === 'GET') { await route.fallback(); return; }
    records.push({
      method: request.method(),
      url: request.url(),
      body: JSON.parse(request.postData() || '{}'),
    });
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, id: 'pa-ui-capture' }),
    });
  });
  return records;
}

// §10.11⑥ 公布的测试钩子：弹窗根 preset-suggest / 确认 preset-suggest-confirm / 取消 preset-suggest-cancel。
// 优先用 testid（改文案不该让用例红），文字只作兜底。
const TESTID_ROOT = 'preset-suggest';

function presetDialog(page) {
  return page.locator(`[data-testid="${TESTID_ROOT}"]`);
}

function dialogButton(page, text) {
  const testId = text === '保持不变' ? `${TESTID_ROOT}-cancel` : `${TESTID_ROOT}-confirm`;
  return page.locator(`[data-testid="${testId}"]`).or(page.getByRole('button', { name: text, exact: true })).first();
}

/** 不弹窗的判据：既没有弹窗根节点，也没有那两个按钮（二者取其严）。 */
async function expectNoDialog(page, why) {
  await expect.poll(async () => ({
    root: await presetDialog(page).count(),
    cancel: await page.locator(`[data-testid="${TESTID_ROOT}-cancel"]`).count(),
    text: await page.getByRole('button', { name: '保持不变', exact: true }).count(),
  }), { message: why }).toEqual({ root: 0, cancel: 0, text: 0 });
}

/** 管理弹窗里某一行的「编辑」键。行内工具键只有 title 可定位（契约没给 testid）。 */
async function rowEditButton(page, name) {
  const button = page.locator(`[data-testid="${TESTID.manager}"]`)
    .getByText(name, { exact: false }).first()
    .locator('xpath=ancestor::div[.//button[@title="编辑"]][1]//button[@title="编辑"]').first();
  try {
    await button.waitFor({ state: 'attached', timeout: 8_000 }); // 弹窗先出现、列表随后才渲染
  } catch {
    throw new EnvironmentBlocked(`管理弹窗里找不到「${name}」这一行的「编辑」键 —— 见 README`);
  }
  return button;
}

/** PA-704 的夹具：一个 baseURL 撞预设、且能在管理弹窗里被编辑的自定义 provider（按名字复用，重复跑不重复建）。 */
async function ensureEditFixture(request, baseURL) {
  const existing = await listCustomProviders(request, baseURL);
  const sameName = existing.find(provider => provider.name === EDIT_NAME);
  const name = sameName && sameName.baseURL !== EDIT_URL
    ? `${EDIT_NAME} ${Date.now().toString(36)}`
    : EDIT_NAME;
  if (sameName && sameName.baseURL === EDIT_URL) return name;
  const created = await createCustomProvider(request, baseURL, {
    name, type: 'anthropic', baseURL: EDIT_URL, apiKey: API_KEY_VALUE, models: [MODEL_VALUE],
  });
  expect(created.status, `夹具 provider「${name}」必须建得起来`).toBe(200);
  return name;
}

test.beforeEach(async ({ page }) => {
  requireUI();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('PA-701 baseURL 撞上预设 → 保存时弹窗，两键文字逐字为「切到该预设」/「保持不变」', async ({ page }) => {
  const { matchPresetByBaseURL } = await presetMatch();
  const expected = matchPresetByBaseURL(PRESET_URL, { type: FORM_TYPE });
  expect(expected.matched, '夹具地址必须命中预设（§10.8，否则本用例不成立）').toBe(true);

  const records = await captureSave(page);
  await openProviderForm(page);
  await fillNewProvider(page, { name: 'PA UI 弹窗', baseUrl: PRESET_URL });
  await save(page);
  await expect(dialogButton(page, '保持不变'), '弹窗必须给出「保持不变」').toBeVisible({ timeout: 5_000 });
  await expect(dialogButton(page, '切到该预设'), '弹窗必须给出「切到该预设」').toBeVisible();
  await expect(presetDialog(page), '弹窗根节点必须带 data-testid="preset-suggest"（§10.11⑥）').toBeVisible();
  expect(records.length, '用户没做选择之前不得保存').toBe(0);

  const message = await presetDialog(page).innerText();
  expect(message, '§10.8 的 message 模板要说明撞上的是哪一家（{name}）').toContain(expected.preset.name);
  expect(message, '§10.8 的 message 模板要说明撞上的是哪一家（{id}）').toContain(expected.preset.id);
  expect(message, '正文要讲清两个分支（其中一条的说明里含「保持不变」）').toContain('保持不变');
});

test('PA-702 选「保持不变」→ 按用户填的内容原样保存（不得静默替换成预设值）', async ({ page }) => {
  const { matchPresetByBaseURL } = await presetMatch();
  const expected = matchPresetByBaseURL(PRESET_URL, { type: FORM_TYPE });
  expect(expected.matched, '夹具地址必须命中预设（否则本用例不成立）').toBe(true);

  const records = await captureSave(page);

  // 对照臂：同样的表单、同样的填法，只把 Base URL 换成不撞预设的地址 —— 两次提交体除 baseURL 外必须逐字相同。
  await openProviderForm(page);
  await fillNewProvider(page, { name: 'PA UI 原样', baseUrl: FREE_URL });
  await save(page);
  await expect.poll(() => records.length, { message: '对照臂：未命中预设时按今天的行为直接保存' }).toBe(1);
  const control = records[0].body;

  await openProviderForm(page);
  await fillNewProvider(page, { name: 'PA UI 原样', baseUrl: PRESET_URL });
  await save(page);
  await expect(dialogButton(page, '保持不变'), '撞预设时必须先弹窗').toBeVisible({ timeout: 5_000 });
  await dialogButton(page, '保持不变').click();
  await expect.poll(() => records.length, { message: '选「保持不变」后必须真的保存' }).toBe(2);
  const body = records[1].body;

  expect(body.name, '名称保持用户输入').toBe('PA UI 原样');
  expect(body.baseURL, 'Base URL 保持用户输入').toBe(PRESET_URL);
  expect(body.apiKey, '其余字段照常提交').toBe(API_KEY_VALUE);
  for (const candidate of expected.candidates) {
    expect(JSON.stringify(body), `不得把预设 ${candidate.id} 的 id/name/地址写进请求体`)
      .not.toContain(candidate.id);
  }
  expect(body, '「保持不变」= 与对照臂逐字相同，只是 Base URL 是用户填的那个').toEqual({ ...control, baseURL: PRESET_URL });
});

test('PA-703 选「切到该预设」→ 只有 name/type/baseURL 变成预设值，其余字段逐字不动', async ({ page }) => {
  const { matchPresetByBaseURL } = await presetMatch();
  // §10.8：`opts.type` = 表单当前协议，多命中时建议目标「同 type 优先」。新建表单默认 openai（见 FORM_TYPE 说明）。
  const expected = matchPresetByBaseURL(PRESET_URL, { type: FORM_TYPE });
  expect(expected.matched, '夹具地址必须命中预设（否则本用例不成立）').toBe(true);
  expect(expected.preset.type, '同 type 优先：默认 openai 协议下建议目标应是 openai 型预设（§10.8）').toBe(FORM_TYPE);
  expect(expected.preset.id, '§10.4 的 ZHIPU_CN_PRESETS 里，openai 型且声明在前的是 zhipu-glm').toBe('zhipu-glm');

  const records = await captureSave(page);
  await openProviderForm(page);
  await fillNewProvider(page, { name: 'PA UI 切换', baseUrl: PRESET_URL });
  await save(page);
  await expect(dialogButton(page, '切到该预设'), '撞预设时必须先弹窗').toBeVisible({ timeout: 5_000 });
  expect(records.length, '用户没做选择之前不得保存').toBe(0);
  await dialogButton(page, '切到该预设').click();
  await expect.poll(() => records.length, { message: '选「切到该预设」后继续走既有保存流程' }).toBe(1);
  const body = records[0].body;
  expect(body.name).toBe(expected.preset.name);
  expect(body.type).toBe(expected.preset.type);
  expect(body.baseURL).toBe(expected.preset.baseURL);
  expect(body.apiKey, 'API Key 一律不动').toBe(API_KEY_VALUE);
  expect(body.models, '模型列表一律不动').toEqual([MODEL_VALUE]);
});

test('PA-704 抑制①：编辑已有 provider 且没改 Base URL → 不弹窗，直接保存', async ({ page, request }) => {
  const { matchPresetByBaseURL } = await presetMatch();
  const expected = matchPresetByBaseURL(EDIT_URL, { type: FORM_TYPE });
  expect(expected.matched, '夹具地址必须命中预设（命中才谈得上"被抑制"，否则本用例平凡成立）').toBe(true);
  expect(expected.candidates.length, '该 host 在预设表里只应有一条').toBe(1);

  const { baseURL } = getRuntime();
  const name = await ensureEditFixture(request, baseURL);
  const records = await captureSave(page);

  await openProviderManager(page);
  await (await rowEditButton(page, name)).click();
  const form = formRoot(page);
  await expect(form, '编辑态复用同一个表单根（§10.12⑤ 路径 C：标题为「编辑 Provider」）').toBeVisible({ timeout: 5_000 });
  const field = await baseUrlField(page);
  await expect(field, '编辑态必须带出原有 Base URL').toHaveValue(EDIT_URL); // 表单根先出现、字段随后才回填
  const initial = await field.inputValue();

  await save(page);
  await expect.poll(() => records.length, { message: '没改 URL 时不得弹窗打断保存' }).toBe(1);
  expect(records[0].method, '编辑走既有的更新入口').toBe('PUT');
  expect(records[0].body.baseURL, '原样提交编辑前读到的值').toBe(initial);
  await expectNoDialog(page, '抑制① 生效时不弹窗');
});

test('PA-705 抑制②：从内置模板下拉选预设后直接保存 → 不弹窗', async ({ page }) => {
  const { matchPresetByBaseURL, BUILTIN_PROVIDERS } = await presetMatch();
  const template = BUILTIN_PROVIDERS.find(preset => preset.id === 'zhipu-glm');
  expect(template, '预设表里应有 zhipu-glm（§10.4 的 ZHIPU_CN_PRESETS）').toBeTruthy();

  const records = await captureSave(page);
  await openProviderForm(page);
  const select = await templateSelect(page);
  try {
    await select.selectOption({ label: template.name });
  } catch {
    await select.selectOption(template.id);
  }
  await (await apiKeyField(page)).fill(API_KEY_VALUE);
  await (await modelsField(page)).fill(MODEL_VALUE); // 选模板会清空模型框，保存前补上（否则表单拦着不发请求）
  const filled = await (await baseUrlField(page)).inputValue();
  expect(filled.length, '选了模板后 Base URL 应被填上').toBeGreaterThan(0);
  expect(matchPresetByBaseURL(filled, { type: FORM_TYPE }).matched, '模板填的地址必须命中预设，否则"不弹"平凡成立').toBe(true);

  await save(page);
  await expect.poll(() => records.length, { message: '模板填充后未改地址 → 不该弹窗' }).toBe(1);
  expect(records[0].body.baseURL, '模板填的地址原样提交').toBe(filled);
  await expectNoDialog(page, '抑制② 生效时不弹窗');
});

test('PA-706 未命中任何预设 host → 不弹窗，原样保存', async ({ page }) => {
  const { matchPresetByBaseURL } = await presetMatch();
  expect(matchPresetByBaseURL(FREE_URL, { type: FORM_TYPE }).matched, '夹具地址必须真的不在 43 条预设的 host 集合里').toBe(false);

  const records = await captureSave(page);
  await openProviderForm(page);
  await fillNewProvider(page, { name: 'PA UI 未命中', baseUrl: FREE_URL });
  await save(page);
  await expect.poll(() => records.length, { message: '未命中预设时按今天的行为直接保存' }).toBe(1);
  expect(records[0].body.baseURL).toBe(FREE_URL);
  await expectNoDialog(page, 'host 不在预设表时不弹窗');
});

test('PA-707 Base URL 非法（空/非 URL）→ 不弹窗，交给既有校验', async ({ page }) => {
  const { matchPresetByBaseURL } = await presetMatch();
  expect(matchPresetByBaseURL(INVALID_URL, { type: FORM_TYPE }).matched, '§10.8 边界表：非法 URL 返回 {matched:false}').toBe(false);

  const records = await captureSave(page);
  await openProviderForm(page);
  await fillNewProvider(page, { name: 'PA UI 非法', baseUrl: INVALID_URL });
  await save(page);
  await expect.poll(() => records.length, { message: '非法 URL 不该被弹窗挡住，应该直接提交给后端校验' }).toBe(1);
  expect(records[0].body.baseURL).toBe(INVALID_URL);
  await expectNoDialog(page, '非法 URL 不弹预设提示');
});
