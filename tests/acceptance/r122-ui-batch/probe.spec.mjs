// 探路脚本(不是验收判据):把当前界面里跟本轮有关的事实如实抓一份出来,给写用例/排查用。
// 平时跳过;R122_PROBE=1 tests/acceptance/r122-ui-batch/run.sh -g '探路' 才跑。
import { test } from '@playwright/test';
import { boot, openSessionBySearch, allStripStates } from './helpers/ui.mjs';
import { FOLD } from './helpers/fixtures.mjs';

test.skip(process.env.R122_PROBE !== '1', '探路脚本只在 R122_PROBE=1 时跑');

test('探路 P1 历史会话的条带状态 + 面板坞里有什么按钮', async ({ page }) => {
  await boot(page, { fold: null });
  await openSessionBySearch(page, FOLD.mark);
  console.log('[P1] strip states =', JSON.stringify(await allStripStates(page)));
  const dock = await page.evaluate(() => [...document.querySelectorAll('[data-cgui="panel-dock"] button, header button, [role=banner] button')]
    .filter((el) => el.getClientRects().length)
    .map((el) => ({ text: (el.innerText || '').trim().slice(0, 20), title: el.getAttribute('title'), aria: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid') })));
  console.log('[P1] dock/header buttons =', JSON.stringify(dock, null, 1));
});

test('探路 P2 设置面板(通用):页签 / 搜索框 / 开关控件长什么样', async ({ page }) => {
  await boot(page, { fold: null });
  await openSessionBySearch(page, FOLD.mark);
  await page.keyboard.press('Meta+0');
  await page.waitForTimeout(1200);
  const facts = await page.evaluate(() => {
    const vis = (el) => el.getClientRects().length > 0;
    const inputs = [...document.querySelectorAll('input, textarea')].filter(vis)
      .map((el) => ({ type: el.type, placeholder: el.getAttribute('placeholder'), aria: el.getAttribute('aria-label') }));
    const switches = [...document.querySelectorAll('[role="switch"], input[type="checkbox"]')].filter(vis)
      .map((el) => ({ tag: el.tagName, role: el.getAttribute('role'), checked: el.getAttribute('aria-checked') ?? el.checked, near: (el.closest('[id]')?.id) || null, text: (el.closest('[id]')?.innerText || '').trim().slice(0, 40) }));
    const ids = [...document.querySelectorAll('[id^="set-"]')].map((el) => ({ id: el.id, visible: vis(el), head: (el.innerText || '').trim().split('\n')[0].slice(0, 30) }));
    const tabs = [...document.querySelectorAll('[role="tab"], [role="tablist"] button')].filter(vis).map((el) => ({ text: (el.innerText || '').trim().slice(0, 16), selected: el.getAttribute('aria-selected') }));
    return { inputs, switches, ids, tabs };
  });
  console.log('[P2] facts =', JSON.stringify(facts, null, 1));
  const dockButtons = await page.evaluate(() => [...document.querySelectorAll('[data-cgui="panel-dock"] button')]
    .filter((el) => el.getClientRects().length).map((el) => (el.innerText || el.getAttribute('title') || '').trim().slice(0, 14)));
  console.log('[P2] dock buttons =', JSON.stringify(dockButtons));
  await page.screenshot({ path: 'tests/acceptance/r122-ui-batch/.artifacts/probe-p2-settings.png', fullPage: false });
});

test('探路 P3 设置搜索的结果列表长什么样 + 输入框一带的按钮(找聊天模式入口)', async ({ page }) => {
  await boot(page, { fold: null });
  await openSessionBySearch(page, FOLD.mark);
  const composerButtons = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    let host = ta; for (let i = 0; i < 4 && host?.parentElement; i += 1) host = host.parentElement;
    return [...(host?.querySelectorAll('button') || [])].map((el) => ({ text: (el.innerText || '').trim().slice(0, 16), title: el.getAttribute('title'), aria: el.getAttribute('aria-label'), pressed: el.getAttribute('aria-pressed') }));
  });
  console.log('[P3] composer buttons =', JSON.stringify(composerButtons, null, 1));
  await page.keyboard.press('Meta+0');
  const search = page.getByPlaceholder(/搜索设置/);
  await search.fill('压缩');
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find((i) => /搜索设置/.test(i.getAttribute('placeholder') || ''));
    let host = input; for (let i = 0; i < 3 && host?.parentElement; i += 1) host = host.parentElement;
    const near = host ? host.outerHTML.replace(/\s+/g, ' ').slice(0, 2500) : null;
    const ids = [...document.querySelectorAll('[id^="set-"]')].filter((el) => el.getClientRects().length).map((el) => el.id);
    return { near, ids };
  });
  console.log('[P3] after search "压缩": visible set-ids =', JSON.stringify(after.ids));
  console.log('[P3] search host html =', after.near);
  await page.screenshot({ path: 'tests/acceptance/r122-ui-batch/.artifacts/probe-p3-search.png' });
});

test('探路 P4 聊天模式入口在哪 + 点设置搜索结果之后发生什么', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page, { fold: null });
  await openSessionBySearch(page, FOLD.mark);
  await page.keyboard.press('Meta+0');
  const search = page.getByPlaceholder(/搜索设置/);
  for (const q of ['折叠', '过程']) {
    await search.fill(q);
    await page.waitForTimeout(500);
    const rows = await page.evaluate(() => {
      const input = [...document.querySelectorAll('input')].find((i) => /搜索设置/.test(i.getAttribute('placeholder') || ''));
      const host = input?.parentElement?.parentElement;
      return [...(host?.querySelectorAll('button') || [])].map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim());
    });
    console.log(`[P4] search "${q}" →`, JSON.stringify(rows));
  }
  await search.fill('生成式');
  await page.waitForTimeout(500);
  const hit = page.locator('button').filter({ hasText: '生成式界面' }).first();
  await hit.click({ timeout: 5_000 });
  await page.waitForTimeout(1000);
  const state = await page.evaluate(() => {
    const el = document.getElementById('set-genui');
    const r = el?.getBoundingClientRect();
    const input = [...document.querySelectorAll('input')].find((i) => /搜索设置/.test(i.getAttribute('placeholder') || ''));
    return { exists: !!el, top: r && Math.round(r.top), bottom: r && Math.round(r.bottom), vh: innerHeight, searchValue: input?.value };
  });
  console.log('[P4] after clicking result: set-genui =', JSON.stringify(state));
  await page.keyboard.press('Escape');
  // 逐页翻设置,找"聊天模式"
  await page.keyboard.press('Meta+0').catch(() => {});
  await page.waitForTimeout(500);
  const mentions = () => page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => /聊天模式|chat mode/i.test(el.getAttribute('title') || '') || (!el.children.length && /聊天模式/.test(el.textContent || '')))
    .map((el) => ({ tag: el.tagName, title: el.getAttribute('title'), text: (el.textContent || '').trim().slice(0, 50), visible: el.getClientRects().length > 0 })));
  console.log('[P4] mentions(now) =', JSON.stringify(await mentions()));
  for (const tab of ['会话', '环境', '权限', '高级']) {
    const b = page.locator('button').filter({ hasText: new RegExp(`^${tab}$`) }).first();
    if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 3_000 }).catch(() => {}); await page.waitForTimeout(500); }
    console.log(`[P4] mentions(tab ${tab}) =`, JSON.stringify(await mentions()));
  }
  // 主题弹层
  await page.keyboard.press('Escape');
  const theme = page.locator('button[title="主题与外观"]').first();
  if (await theme.isVisible().catch(() => false)) { await theme.click({ timeout: 3_000 }).catch(() => {}); await page.waitForTimeout(600); }
  console.log('[P4] mentions(theme popover) =', JSON.stringify(await mentions()));
  const popText = await page.evaluate(() => [...document.querySelectorAll('.glass-popover')].map((e) => (e.innerText || '').replace(/\s+/g, ' ').slice(0, 600)));
  console.log('[P4] theme popover text =', JSON.stringify(popText));
});

test('探路 P5 主题弹层「界面」页 + 会话标题栏「…」菜单里有什么', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page, { fold: null });
  await openSessionBySearch(page, FOLD.mark);
  const theme = page.locator('button[title="主题与外观"]').first();
  await theme.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
  for (const tab of ['界面', '配色', '皮肤']) {
    const b = page.locator('.glass-popover button').filter({ hasText: new RegExp(`^${tab}$`) }).first();
    if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 3_000 }).catch(() => {}); await page.waitForTimeout(500); }
    const txt = await page.evaluate(() => [...document.querySelectorAll('.glass-popover')].map((e) => (e.innerText || '').replace(/\s+/g, ' ').slice(0, 900)));
    console.log(`[P5] theme popover tab ${tab} =`, JSON.stringify(txt));
    const titles = await page.evaluate(() => [...document.querySelectorAll('.glass-popover [title]')].map((e) => e.getAttribute('title')).slice(0, 40));
    console.log(`[P5] titles in tab ${tab} =`, JSON.stringify(titles));
  }
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 450);
  await page.waitForTimeout(300);
  // 会话标题栏里的按钮
  const headerButtons = await page.evaluate(() => [...document.querySelectorAll('main button, [data-testid="pane"] button')]
    .filter((el) => el.getClientRects().length && el.getBoundingClientRect().top < 130)
    .map((el) => ({ text: (el.innerText || '').trim().slice(0, 16), title: el.getAttribute('title'), aria: el.getAttribute('aria-label') })));
  console.log('[P5] session header buttons =', JSON.stringify(headerButtons, null, 1));
});

test('探路 P6 聊天模式开关的 DOM + 打开后条带状态', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page, { fold: null });
  await openSessionBySearch(page, FOLD.mark);
  await page.locator('button[title="主题与外观"]').first().click({ timeout: 5_000 });
  await page.locator('.glass-popover button').filter({ hasText: /^界面$/ }).first().click({ timeout: 5_000 });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const leaf = [...document.querySelectorAll('.glass-popover *')].find((el) => !el.children.length && (el.textContent || '').trim() === '聊天模式');
    const up1 = leaf?.parentElement; const up2 = up1?.parentElement;
    const strip = (h) => (h || '').replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').slice(0, 1200);
    return { leafTag: leaf?.tagName, up1: strip(up1?.outerHTML), up2: strip(up2?.outerHTML) };
  });
  console.log('[P6] leaf =', info.leafTag);
  console.log('[P6] up1 =', info.up1);
  console.log('[P6] up2 =', info.up2);
});
