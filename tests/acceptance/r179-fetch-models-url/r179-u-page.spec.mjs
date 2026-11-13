// r179 · 页面用例 U1–U6(端到端:页面操作 → 真后端 → 本机假上游;不在浏览器层拦截拉取模型的接口)。
// 页面用例共用 run.sh 起的那个共享隔离实例(R179_API_BASE / R179_HOME),每条用例用唯一名字的条目,互不依赖。
import { test, expect } from '@playwright/test';
import { startUpstream, startProxy } from './helpers/fakes.mjs';
import { MSG, STORED_KEY, NEW_KEY, createText, createImage, newSaveDir } from './helpers/common.mjs';
import { boot, openTextProviderEdit, alertDialog, pickModal, pickCancel, openImageProviderEdit, imagePanel, imageBaseInput, imageKeyInput, imageFetchModelsButton } from './helpers/ui.mjs';

const API_BASE = process.env.R179_API_BASE || '';
const HOME = process.env.R179_HOME || '';
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let closers = [];
const track = (fake) => { closers.push(() => fake.close()); return fake; };
test.beforeEach(() => { test.skip(!API_BASE || !process.env.R179_UI_BASE, '没有共享实例 / dev server(R179_API_ONLY=1)时跳过页面用例'); });
test.afterEach(async () => { const l = closers; closers = []; for (const f of l) { try { await f(); } catch { /* 尽力而为 */ } } });

const SAVED_TEXT_MODEL = { id: 'ui-saved-model-1', window: 111000 };
const NEW_TEXT_MODEL = { id: 'ui-new-model-1', window: 222000 };

async function textFixture() {
  const S = track(await startUpstream({ kind: 'openai', models: [SAVED_TEXT_MODEL] }));
  const N = track(await startUpstream({ kind: 'openai', models: [NEW_TEXT_MODEL] }));
  const name = `r179-文本-${uniq()}`;
  const savedBase = `${S.url}/v1`;
  await createText(API_BASE, { name, type: 'openai', baseURL: savedBase, apiKey: STORED_KEY, models: [SAVED_TEXT_MODEL.id] });
  return { S, N, name, savedBase, newBase: `${N.url}/v1` };
}

async function geminiImageFixture() {
  const S = track(await startUpstream({ kind: 'gemini', models: [{ id: 'gemini-ui-image-saved' }] }));
  const N = track(await startUpstream({ kind: 'gemini', models: [{ id: 'gemini-ui-image-new' }] }));
  const PA = track(await startProxy());
  const savedBase = `${S.url}/v1beta`;
  const id = await createImage(API_BASE, { name: `r179-生图-${uniq()}`, protocol: 'gemini', baseURL: savedBase, apiKey: STORED_KEY, model: 'gemini-ui-image-saved', savePath: newSaveDir(HOME), proxyUrl: PA.url });
  return { S, N, PA, id, savedBase, newBase: `${N.url}/v1beta` };
}

test('U1 【复现】文本Provider编辑:改地址并填新Key,点「获取模型」→ 新地址那台收到新Key,已保存那台0次,勾选弹窗是新地址那台的模型', async ({ page }) => {
  const { S, N, name, savedBase, newBase } = await textFixture();
  await boot(page);
  const { addr, key, fetchButton } = await openTextProviderEdit(page, name, savedBase);
  await addr.fill(newBase);
  await key.fill(NEW_KEY);
  await fetchButton.click();
  await expect.poll(() => N.hits.length, { message: '新地址那台应收到请求', timeout: 15_000 }).toBe(1);
  expect(N.hits[0].auth, '新地址那台收到的应是新填的 Key').toBe(`Bearer ${NEW_KEY}`);
  expect(S.hits.length, '已保存那台应 0 次').toBe(0);
  await expect(pickModal(page).getByText(NEW_TEXT_MODEL.id, { exact: true }).first(), '勾选弹窗里应是新地址那台的模型').toBeVisible({ timeout: 15_000 });
  await expect(pickModal(page).getByText(SAVED_TEXT_MODEL.id, { exact: true })).toHaveCount(0);
});

test('U2 【复现】文本Provider编辑:改地址、Key留空,点「获取模型」→ 提示框正文就是固定文案,没有「常见原因」,两台都0次', async ({ page }) => {
  const { S, N, name, savedBase, newBase } = await textFixture();
  await boot(page);
  const { addr, fetchButton } = await openTextProviderEdit(page, name, savedBase);
  await addr.fill(newBase);
  await fetchButton.click();
  const dlg = alertDialog(page);
  await expect(dlg, '应弹出提示框').toBeVisible({ timeout: 15_000 });
  await expect(dlg, '提示框正文应含固定文案').toContainText(MSG, { timeout: 15_000 });
  const text = await dlg.innerText();
  expect(text, '提示框里不应有「常见原因」那一段').not.toContain('常见原因');
  // 正文就是固定文案:除了它,只允许剩下既有的失败标题前缀「拉取模型失败：」与按钮文字(接口文件没写这个前缀要不要保留)
  const rest = text.replace(MSG, '').replace(/拉取模型失败[：:]?/, '').replace(/取消|确定/g, '').trim();
  expect(rest, '提示框里除固定文案外不应再有别的正文').toBe('');
  await page.waitForTimeout(500);
  expect(S.hits.length, '已保存那台应 0 次').toBe(0);
  expect(N.hits.length, '新地址那台应 0 次').toBe(0);
});

test('U3 【复现】生图面板编辑(gemini、已保存条目配了代理):改地址并填新Key、不碰代理 → 新地址那台收到新Key,请求经已保存代理,已保存那台0次', async ({ page }) => {
  const { S, N, PA, id, newBase } = await geminiImageFixture();
  await boot(page);
  await openImageProviderEdit(page, id);
  await imageBaseInput(page).fill(newBase);
  await imageKeyInput(page).fill(NEW_KEY);
  await imageFetchModelsButton(page).click();
  await expect.poll(() => N.hits.length, { message: '新地址那台应收到请求', timeout: 15_000 }).toBeGreaterThan(0);
  expect(N.sawKey(NEW_KEY), '新地址那台收到的应是新填的 Key').toBe(true);
  expect(PA.reached(N), `请求应经已保存的代理到新地址,代理记录 ${JSON.stringify(PA.targets)}`).toBe(true);
  expect(S.hits.length, '已保存那台应 0 次').toBe(0);
});

test('U4 【复现】生图面板编辑:改地址、Key留空,点「拉取模型」→ 提示区文字就是固定文案,没有别的前缀,两台都0次', async ({ page }) => {
  const { S, N, id, newBase } = await geminiImageFixture();
  await boot(page);
  await openImageProviderEdit(page, id);
  await imageBaseInput(page).fill(newBase);
  await imageFetchModelsButton(page).click();
  await expect(imagePanel(page).getByText(MSG, { exact: true }), '提示区文字应逐字等于固定文案(无前缀)').toBeVisible({ timeout: 15_000 });
  expect(await imagePanel(page).innerText(), '不应带「拉取失败」前缀').not.toContain('拉取失败');
  await page.waitForTimeout(500);
  expect(S.hits.length, '已保存那台应 0 次').toBe(0);
  expect(N.hits.length, '新地址那台应 0 次').toBe(0);
});

test('U5 【守卫】两处都不改地址、Key留空:文本点「获取模型」、生图点「拉取模型」→ 已保存那台收到已保存Key,勾选弹窗照常出现', async ({ page }) => {
  const t = await textFixture();
  await boot(page);
  const { fetchButton } = await openTextProviderEdit(page, t.name, t.savedBase);
  await fetchButton.click();
  await expect.poll(() => t.S.hits.length, { message: '文本:已保存那台应收到请求', timeout: 15_000 }).toBe(1);
  expect(t.S.hits[0].auth, '文本:带的应是已保存的 Key').toBe(`Bearer ${STORED_KEY}`);
  expect(t.N.hits.length).toBe(0);
  await expect(pickModal(page).getByText(SAVED_TEXT_MODEL.id, { exact: true }).first(), '文本:勾选弹窗应出现并列出已保存那台的模型').toBeVisible({ timeout: 15_000 });
  await pickCancel(page).click();

  const g = await geminiImageFixture();
  await boot(page);
  await openImageProviderEdit(page, g.id);
  await imageFetchModelsButton(page).click();
  await expect.poll(() => g.S.hits.length, { message: '生图:已保存那台应收到请求', timeout: 15_000 }).toBeGreaterThan(0);
  expect(g.S.sawKey(STORED_KEY), '生图:带的应是已保存的 Key').toBe(true);
  expect(g.N.hits.length).toBe(0);
  await expect(pickModal(page).getByText('gemini-ui-image-saved').first(), '生图:勾选弹窗应出现并列出已保存那台的模型').toBeVisible({ timeout: 15_000 });
});

test('U6 【复现】生图面板编辑:地址框清空 →「拉取模型」不可点且提示「先填写接口地址（baseURL）」;填回已保存值 → 可点且提示改为新文案;两台0次', async ({ page }) => {
  const { S, N, id, savedBase } = await geminiImageFixture();
  await boot(page);
  await openImageProviderEdit(page, id);
  await imageBaseInput(page).fill('');
  await expect(imageFetchModelsButton(page), '地址框为空时按钮应不可点').toBeDisabled();
  await expect(imageFetchModelsButton(page)).toHaveAttribute('title', '先填写接口地址（baseURL）');
  await imageBaseInput(page).fill(savedBase);
  await expect(imageFetchModelsButton(page), '地址填回后按钮应可点').toBeEnabled();
  await expect(imageFetchModelsButton(page)).toHaveAttribute('title', '按表单中的接口地址拉取；密钥留空时使用已保存的密钥，且只发往已保存的地址');
  expect(S.hits.length, '已保存那台应 0 次').toBe(0);
  expect(N.hits.length, '新地址那台应 0 次').toBe(0);
});
