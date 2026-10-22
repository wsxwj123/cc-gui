// r151s 静默超时可设置 —— 验收(设置页部分)。S13–S15 依据 .devflow/r151s-stall-timeout-接口.md 的"行为清单":
//   S13 「会话」tab 有 stall-timeout-select,四个选项/默认值/选 never 的说明/刷新后保持/接口一致 ·
//   S14 偏好文件写不进去时选 10 分钟 → 卡片出现错误文字、下拉回到原值 · S15 设置搜索「静默」「超时」能找到「静默超时」并定位到这张卡片。
// 页面来源 = vite dev server(源码直出),/api 代理到 run.sh 起的共享隔离实例(临时 HOME)。每条用例开头自己摆好偏好文件的起点,
// 不依赖别的用例留下的状态;只经页面操作和 HTTP 观察,不 import 产品代码。
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import {
  STALL_URL, boot, reloadApp, openSessionSettings, stallSelect, openSettingsWithSearch,
  readSelect, chooseOption, clearStallKey, sharedPrefsFile, makePrefsUnwritable,
} from './helpers/ui-s.mjs';

test.describe.configure({ timeout: 180_000 });

const OPTIONS = [
  { text: '5 分钟', value: '5m' },
  { text: '10 分钟', value: '10m' },
  { text: '20 分钟', value: '20m' },
  { text: '只提示，不结束', value: 'never' },
];
const getStall = async () => {
  const r = await fetch(STALL_URL(), { signal: AbortSignal.timeout(10_000) });
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
};
/** 页面上现在显示的非空文字行(去重集合):用来判断"出现了新的文字"。 */
const visibleLines = async (page) => new Set((await page.locator('body').innerText()).split('\n').map((l) => l.trim()).filter(Boolean));
const ERROR_WORDS = /失败|错误|出错|无法|未能|不能|拒绝|只读|权限/;

test('S13 「会话」tab 有 stall-timeout-select:四个选项文字与顺序正确、默认显示 5 分钟;选「只提示，不结束」后出现含「需要手动点停止」的说明;刷新后仍是所选值;GET 得 never', async ({ page }) => {
  clearStallKey();   // 起点:偏好文件里没设过
  await boot(page);
  await openSessionSettings(page);
  const sel = stallSelect(page);
  await expect(sel, '「会话」tab 里应有静默超时下拉 data-testid="stall-timeout-select"').toBeVisible({ timeout: 10_000 });
  const first = await readSelect(sel);
  expect(first.options, `下拉的四个选项(文字与值)应依次是 5 分钟 / 10 分钟 / 20 分钟 / 只提示，不结束(下拉元素类型:${first.kind})`).toEqual(OPTIONS);
  expect({ text: first.text, value: first.value }, '没设过时下拉应显示 5 分钟').toEqual({ text: '5 分钟', value: '5m' });
  await expect(page.getByText('需要手动点停止'), '没选「只提示，不结束」时不应出现手动点停止的说明').toHaveCount(0);

  await chooseOption(page, sel, '只提示，不结束');
  await expect(page.getByText('需要手动点停止').first(), '选「只提示，不结束」后卡片里应出现含「需要手动点停止」的说明').toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await getStall()).body, { message: '选完后 GET /api/prefs/stall-timeout 应得 never', timeout: 10_000 }).toEqual({ ok: true, value: 'never' });

  await reloadApp(page);
  if (!(await stallSelect(page).isVisible().catch(() => false))) await openSessionSettings(page);
  await expect(stallSelect(page), '刷新后设置页里仍应有静默超时下拉').toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => { const i = await readSelect(stallSelect(page)); return { text: i.text, value: i.value }; },
    { message: '刷新页面后下拉仍应是「只提示，不结束」', timeout: 10_000 }).toEqual({ text: '只提示，不结束', value: 'never' });
  await expect(page.getByText('需要手动点停止').first(), '刷新后选着 never 时说明文字仍在').toBeVisible({ timeout: 10_000 });
  expect(await getStall(), '刷新之后 GET 仍得 never').toEqual({ status: 200, body: { ok: true, value: 'never' } });
});

test('S14 偏好文件写不进去(.claude-gui 只读)时选 10 分钟:保存返回 500 STORAGE_WRITE_FAILED,卡片里出现错误文字,下拉回到原来的值 5 分钟,偏好文件不变', async ({ page }) => {
  clearStallKey();   // 起点:没设过,原值 = 5 分钟
  const bytesBefore = fs.readFileSync(sharedPrefsFile());
  await boot(page);
  await openSessionSettings(page);
  const sel = stallSelect(page);
  await expect(sel, '「会话」tab 里应有静默超时下拉').toBeVisible({ timeout: 10_000 });
  const orig = await readSelect(sel);
  expect({ text: orig.text, value: orig.value }, '前置:原来的值是 5 分钟').toEqual({ text: '5 分钟', value: '5m' });
  const linesBefore = await visibleLines(page);

  let restore = null;
  try {
    restore = makePrefsUnwritable();
    const putSeen = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/prefs/stall-timeout' && r.request().method() === 'PUT', { timeout: 15_000 });
    await chooseOption(page, sel, '10 分钟');
    const resp = await putSeen;
    let body = null; try { body = await resp.json(); } catch { body = null; }
    expect({ status: resp.status(), ok: body && body.ok, code: body && body.code, hasErrorText: Boolean(body && typeof body.error === 'string' && body.error.length > 0) },
      `写盘失败时保存接口应回 500 {ok:false, code:"STORAGE_WRITE_FAILED", error}(应答:${JSON.stringify(body)})`)
      .toEqual({ status: 500, ok: false, code: 'STORAGE_WRITE_FAILED', hasErrorText: true });

    await expect.poll(async () => {
      const now = await visibleLines(page);
      const fresh = [...now].filter((l) => !linesBefore.has(l));
      return fresh.filter((l) => ERROR_WORDS.test(l) || (body.error.length <= 200 && l.includes(body.error)));
    }, { message: '保存失败后页面上应出现新的错误文字(含失败/错误/无法等字样,或接口返回的 error 原文)', timeout: 10_000 }).not.toEqual([]);

    await expect.poll(async () => { const i = await readSelect(sel); return { text: i.text, value: i.value }; },
      { message: '保存失败后下拉应回到原来的值 5 分钟', timeout: 10_000 }).toEqual({ text: '5 分钟', value: '5m' });
  } finally {
    if (restore) restore();
  }
  expect(fs.readFileSync(sharedPrefsFile()).equals(bytesBefore), '保存失败后偏好文件应逐字节不变').toBe(true);
  expect(await getStall(), '保存失败后 GET 仍得原值 5m').toEqual({ status: 200, body: { ok: true, value: '5m' } });
});

test('S15 设置页搜索框输入「静默」或「超时」:结果里有「静默超时」,点开后页面定位到这张卡片', async ({ page }) => {
  clearStallKey();
  await boot(page);
  const box = await openSettingsWithSearch(page);
  const hits = () => page.locator('button:visible').filter({ hasText: '静默超时' });
  for (const kw of ['静默', '超时']) {
    await box.fill('');
    await box.fill(kw);
    await expect(box, `搜索框里应是 ${kw}`).toHaveValue(kw);
    await expect(hits().first(), `搜索「${kw}」的结果里应有「静默超时」`).toBeVisible({ timeout: 8_000 });
  }
  await box.fill('');
  await box.fill('静默');
  const hit = hits().first();
  await expect(hit, '搜索「静默」的结果里应有「静默超时」').toBeVisible({ timeout: 8_000 });
  await hit.click();
  await expect(stallSelect(page), '点开「静默超时」结果后,这张卡片里的下拉应出现并滚进视口').toBeInViewport({ timeout: 10_000 });
  await expect(page.getByText('静默超时').first(), '定位到的卡片标题「静默超时」应可见').toBeVisible({ timeout: 5_000 });
});
