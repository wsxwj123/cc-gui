// r126 探路脚本(不是验收判据;平时跳过,R126_PROBE=1 才跑):黑盒地把界面里跟本轮有关的事实抓一份出来,给写用例用。
//   记录:切换浮层根是否已有 data-testid=provider-switch-list;管理弹窗里的 testid 清单;手机视口下 provider 列表怎么进。
import { test } from '@playwright/test';
import fs from 'node:fs';
import { boot, providerButton, openProviderList, switchList, switchListAny, openProviderManager, manager, closeProviderList } from './helpers/ui.mjs';
import { HOME_DIR } from './helpers/fixtures.mjs';
import { corruptFile, resetFile, HALF } from './helpers/corrupt.mjs';

const dump = (t, v) => console.log(`\n### ${t}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`);
const testids = (loc) => loc.evaluate((el) => [...el.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')).filter((v, i, a) => a.indexOf(v) === i));
const visibleButtons = (page) => page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => ({ title: b.title || '', aria: b.getAttribute('aria-label') || '', text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 30) })).filter((b) => b.title || b.aria || b.text).slice(0, 80));

test.describe('探路', () => {
  test.skip(process.env.R126_PROBE !== '1' || !process.env.R126_UI_BASE, '只在 R126_PROBE=1 且有 dev server 时跑');
  test.afterEach(() => { if (HOME_DIR()) resetFile(HOME_DIR(), 'custom'); });

  test('P1 桌面:切换浮层 / 管理弹窗的锚点与文字(custom-providers.json 已损坏)', async ({ page }) => {
    corruptFile(HOME_DIR(), 'custom', HALF);
    await boot(page);
    dump('provider 按钮 title', await providerButton(page).getAttribute('title'));
    await openProviderList(page);
    dump('provider-switch-list 存在?', await switchList(page).count());
    dump('浮层 testids', await testids(switchListAny(page)));
    dump('浮层文字', (await switchListAny(page).innerText()).replace(/\s+/g, ' ').slice(0, 600));
    dump('浮层 html(前 1500)', (await switchListAny(page).evaluate((el) => el.outerHTML)).slice(0, 1500));
    await closeProviderList(page);
    await openProviderManager(page);
    dump('管理弹窗 testids', await testids(manager(page)));
    dump('管理弹窗文字', (await manager(page).innerText()).replace(/\s+/g, ' ').slice(0, 800));
    dump('管理弹窗里 provider-switch-list 个数', await manager(page).locator('[data-testid="provider-switch-list"]').count());
  });

  test('P2 手机视口:怎么进 provider 列表', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL: process.env.R126_UI_BASE });
    const page = await ctx.newPage();
    try {
      // 手机页没有 panel-dock(上一次探路实测:banner 里是「会话」「新建会话」),不用 boot()
      await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '新建会话' }).first().waitFor({ state: 'visible', timeout: 40_000 });
      dump('手机视口可见按钮', await visibleButtons(page));
      dump('页面 testids', await testids(page.locator('body')));
      dump('provider 按钮(title^=Provider:)可见?', await providerButton(page).isVisible().catch(() => false));
      const drawer = page.getByRole('button', { name: '会话' }).first();
      if (await drawer.isVisible().catch(() => false)) {
        await drawer.click({ force: true });
        await page.waitForTimeout(600);
        dump('点「会话」后可见按钮', await visibleButtons(page));
        dump('点「会话」后 testids', await testids(page.locator('body')));
        dump('点「会话」后文字(前 900)', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 900));
      }
      const candidates = page.locator('button, [role=button], a').filter({ hasText: /provider|Provider|PROVIDER|模型/ });
      dump('文字含 provider/模型 的可点元素数', await candidates.count());
      for (let i = 0; i < Math.min(await candidates.count(), 3); i += 1) {
        const el = candidates.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        dump(`点第 ${i} 个:`, await el.innerText());
        await el.click({ force: true });
        await page.waitForTimeout(700);
        dump('点后 provider-switch-list 个数', await switchList(page).count());
        dump('点后页面 testids', await testids(page.locator('body')));
        dump('点后页面文字(前 700)', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 700));
        break;
      }
      const shot = `${process.env.R126_LOGS || '.'}/probe-mobile.png`;
      await page.screenshot({ path: shot, fullPage: false });
      dump('手机截图', shot);
    } finally { await ctx.close(); }
  });
});
