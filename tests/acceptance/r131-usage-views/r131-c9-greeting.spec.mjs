// r131 · C9(必做小修):招呼语位置 —— 从"顶在页面上沿、中间一大片空白"改成"紧贴用量块标题上方,和用量块一起垂直居中"。
// 判据:① 招呼与用量块顶部行(分页控件)的垂直间隙在一行以内(≤ 40 px);② 整组垂直居中(招呼上方留白 ≈ 输入框上方留白);
//       ③ DOM 顺序仍是 招呼 → home-usage → home-input;④ 输入框仍贴底;⑤ 分屏一个字不动(由 r130 C2b 守);⑥ 孤儿提示仍在输入框上方。
import { test, expect } from '@playwright/test';
import { gotoHome, stubUsage, payload, dayEntry, dayAgo, usage, cards, greeting, homeInput, home, setPaneCount } from './helpers/ui.mjs';

// 用量块的顶部行 = 「总览 | 模型」分页控件所在的那一行(范围控件在同一行右侧)
// r133:「用量总览」标题已删 —— 用量块的顶部行现在由「总览 | 模型」分页控件开头
const title = (page) => page.getByTestId('home-usage-tabs');
const stub = (page) => stubUsage(page, payload({ total: { sessionCount: 2 }, byDay: [dayEntry(dayAgo(1), 1000), dayEntry(dayAgo(3), 500)] }));

test('C9a 招呼与用量块顶部行紧贴(≤40px),不再顶在页面上沿', async ({ page }) => {
  await stub(page);
  await gotoHome(page);
  await expect(cards(page)).toBeVisible();
  const g = await greeting(page).boundingBox();
  const t = await title(page).boundingBox();
  const u = await usage(page).boundingBox();
  expect(g && t && u, '三者都应可见').toBeTruthy();
  expect(t.y - (g.y + g.height), `招呼底边 → 用量块顶部行的间隙应当很小(现在 ${Math.round(t.y - (g.y + g.height))}px)`).toBeLessThanOrEqual(40);
  expect(g.y + g.height).toBeLessThanOrEqual(u.y + 1);
  // 用量块顶边之上就是招呼:两者之间不该再夹着别的块
  expect(u.y - (g.y + g.height)).toBeLessThanOrEqual(40);
});

test('C9b 招呼 + 用量块作为一整组垂直居中(上方留白与下方留白都为正、量级相当)', async ({ page }) => {
  await stub(page);
  await gotoHome(page);
  await expect(cards(page)).toBeVisible();
  const g = await greeting(page).boundingBox();
  const i = await homeInput(page).boundingBox();
  expect(g.y, '招呼上方应当有留白(与输入框之间还有用量块)').toBeGreaterThan(0);
  const gapTop = g.y;
  const gapBottom = i.y - g.y;
  expect(gapBottom, '输入框在招呼下方').toBeGreaterThan(0);
  // 整组居中:招呼不该再贴着页面上沿 —— 上方留白至少占"招呼→输入框"这段的 10%
  expect(gapTop, `上方留白 ${Math.round(gapTop)}px / 下方 ${Math.round(gapBottom)}px`).toBeGreaterThan(gapBottom * 0.1);
});

test('C9c 布局锁:DOM 顺序 招呼→用量→输入框 + 输入框仍贴底 + 分屏分支逐字不变', async ({ page }) => {
  await stub(page);
  await gotoHome(page);
  const order = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const g = q('h2[data-cgui="home-greeting"]'); const u = q('[data-testid="home-usage"]'); const i = q('textarea[data-testid="home-input"]');
    return { gu: Boolean(g.compareDocumentPosition(u) & Node.DOCUMENT_POSITION_FOLLOWING), ui: Boolean(u.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  expect(order.gu, '招呼在 home-usage 之前').toBe(true);
  expect(order.ui, 'home-usage 在输入框之前').toBe(true);
  const h = await home(page).boundingBox();
  const i = await homeInput(page).boundingBox();
  expect((i.y + i.height - h.y) / h.height, '输入框底边 ≥ 首页高度 70%').toBeGreaterThanOrEqual(0.7);
  // 分屏两层 className 与 r130 逐字一致(与 r130 C2b 同一把锁,这里只是就近再钉一次)
  await setPaneCount(page, 2);
  await expect(usage(page)).toHaveCount(0, { timeout: 3000 });
  const classes = await page.evaluate(() => [...document.querySelectorAll('[data-cgui="home"]')].map((x) => [x.className, x.firstElementChild?.className ?? null]));
  for (const [outer, inner] of classes) {
    expect(outer).toBe('flex-1 flex items-center justify-center px-6');
    expect(inner).toBe('w-full max-w-[560px] flex flex-col items-center');
  }
});

test('C9d 375×812:招呼仍在用量标题上方、输入框在视口内、整页不滚', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, baseURL: process.env.R131_UI_BASE, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await ctx.newPage();
  try {
    await stub(page);
    await gotoHome(page);
    await expect(cards(page)).toBeVisible();
    const g = await greeting(page).boundingBox();
    const t = await title(page).boundingBox();
    expect(t.y - (g.y + g.height)).toBeLessThanOrEqual(40);
    expect(await homeInput(page).isVisible()).toBe(true);
    const m = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: innerHeight, sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(m.sh, '整页不滚(溢出在图区内部滚)').toBeLessThanOrEqual(m.ih);
    expect(m.sw, '不横滚').toBeLessThanOrEqual(m.iw);
  } finally { await ctx.close(); }
});
