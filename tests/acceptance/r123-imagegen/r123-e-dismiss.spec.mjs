// r123 · E 组:清空预览的持久化(INTERFACE-r123 §E;BRIEF R5)。界面层,复用 B/C 组已通的面板导航。
// 依据只有 .devflow/BRIEF-r123.md 与 .devflow/INTERFACE-r123.md;没看实现代码。
// 判据:预览区以 [data-testid="image-preview-shot"] 为准;键 cgui-image-dismissed-preview = 被清掉的任务 id,空串/无键 = 没收起。
import { test, expect } from '@playwright/test';
import { req, createProvider, generate, waitTerminal, newSaveDir, history } from './helpers/api.mjs';
import { createFakeUpstream } from './helpers/fake-upstream.mjs';
import { PNG_B64 } from './helpers/images.mjs';
import {
  boot, reloadApp, openImagePanel, openTaskList, imagePanel,
  previewShot, clearButton, imageTab, promptBox, generateButton, providerSelect, readDismissKey, presetDismissKey,
} from './helpers/ui.mjs';

test.describe('E 清空预览的持久化', () => {
  test.skip(!process.env.R123_UI_BASE, '没有 dev server(R123_API_ONLY=1)');
  let up; let provider;
  test.beforeAll(async () => {
    up = createFakeUpstream(); await up.listen();
    const base = up.scenario('/e/v1', ({ method, path: p }) => (method === 'POST' && p === '/images/generations' ? { body: { created: 1, data: [{ b64_json: PNG_B64 }] } } : null));
    provider = await createProvider({ name: `r123 E 组 ${Date.now().toString(36)}`, baseURL: base, savePath: newSaveDir('e') });
  });
  test.afterAll(async () => { await up?.close(); });

  const mark = (tag) => `R123E-${tag}-${Date.now().toString(36)}`;
  /** 用接口造一条已完成任务(同步假上游,毫秒级完成),返回任务 id。 */
  async function makeDone(prompt) {
    const jobId = await generate(provider.id, prompt);
    const e = await waitTerminal(jobId, 20_000);
    expect(e?.status, `前置:任务 ${jobId} 应完成(${JSON.stringify(e)})`).toBe('done');
    return jobId;
  }
  const keyCleared = (v) => v === null || v === '';
  /** E3 的公共前半段:预览可见 → 清空 → 不可见 → 刷新再进 → 仍不可见,且键 = 那条任务 id。 */
  async function dismissAndReload(page, jobId) {
    await boot(page); await openImagePanel(page);
    await expect(previewShot(page), '有已完成任务时预览区应可见(锚点 image-preview-shot)').toBeVisible();
    await clearButton(page).click();
    await expect(previewShot(page), '点「清空」后预览区应不可见').toBeHidden();
    await reloadApp(page); await openImagePanel(page);
    await expect(previewShot(page), '刷新后再进生图页,预览区应仍不可见').toBeHidden();
    expect(await readDismissKey(page), '键应等于被清掉的任务 id').toBe(jobId);
  }

  test('E1-1 契约:导航前预置键 = 最近完成任务 id → 进生图页预览区收起', async ({ page }) => {
    const jobId = await makeDone(mark('e1a'));
    await presetDismissKey(page, jobId);
    await boot(page); await openImagePanel(page);
    await expect(previewShot(page)).toBeHidden();
    // 反向自证:面板确实在(不是因为没打开面板才"不可见")
    await expect(clearButton(page)).toBeVisible();
  });

  test('E1-2 契约:键为空串 = 没有收起 → 预览区可见', async ({ page }) => {
    await makeDone(mark('e1b'));
    await presetDismissKey(page, '');
    await boot(page); await openImagePanel(page);
    await expect(previewShot(page)).toBeVisible();
  });

  test('E3 清空后刷新仍收起:预览可见 → 清空 → 不可见 → reload 再进 → 仍不可见,键 = 该任务 id', async ({ page }) => {
    const jobId = await makeDone(mark('e3'));
    await dismissAndReload(page, jobId);
  });

  test('E4 新任务恢复:E3 之后在生图页提交新任务并等完成 → 预览区可见且显示新图,键被清', async ({ page }) => {
    const jobId = await makeDone(mark('e4-old'));
    await dismissAndReload(page, jobId);
    const newMark = mark('e4-new');
    await providerSelect(page, provider.id).selectOption(provider.id);
    await promptBox(page).fill(newMark);
    await generateButton(page).click();
    await expect(previewShot(page), '新任务完成后预览区应可见').toBeVisible({ timeout: 30_000 });
    expect(keyCleared(await readDismissKey(page)), '键应变为空串或被移除').toBe(true);
    // 显示的是新图:再点一次「清空」,按契约键应等于新任务 id
    const fresh = (await history()).find((e) => e.prompt === newMark);
    expect(fresh?.status, `新任务应在历史里且完成(${JSON.stringify(fresh)})`).toBe('done');
    await clearButton(page).click();
    expect(await readDismissKey(page), '被清掉的应是新任务(证明刚才显示的是新图)').toBe(fresh.id);
  });

  test('E5 重选恢复:E3 之后在任务列表点那条被清掉的任务 → 回到生图页预览区可见,键被清', async ({ page }) => {
    const m = mark('e5');
    const jobId = await makeDone(m);
    await dismissAndReload(page, jobId);
    await openTaskList(page);
    await imagePanel(page).locator(`img[alt="${m}"]`).filter({ visible: true }).first().click();
    await imageTab(page).click();
    await expect(previewShot(page), '重选后预览区应可见').toBeVisible();
    expect(keyCleared(await readDismissKey(page)), '键应被清').toBe(true);
    // 显示的确实是被重选的那张
    await clearButton(page).click();
    expect(await readDismissKey(page)).toBe(jobId);
  });

  test('E6 删除后不残留:E3 之后用接口删掉那条 → 再进生图页显示另一张已完成图,键不再等于已删 id', async ({ page }) => {
    const older = await makeDone(mark('e6-older'));
    const jobId = await makeDone(mark('e6-newer'));
    await dismissAndReload(page, jobId);
    const r = await req('POST', '/api/image/history/delete', { ids: [jobId] });
    expect(r.status, r.text).toBe(200);
    expect(r.json?.removed, r.text).toBe(1);
    await reloadApp(page); await openImagePanel(page);
    await expect(previewShot(page), '还有其它已完成任务时预览区应显示它').toBeVisible();
    expect(await readDismissKey(page), '键不再等于已删除的 id').not.toBe(jobId);
    // 显示的是另一张(更早完成的那条)
    await clearButton(page).click();
    expect(await readDismissKey(page)).toBe(older);
  });
});
