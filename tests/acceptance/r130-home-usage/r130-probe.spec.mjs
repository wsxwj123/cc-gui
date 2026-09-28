// r130 探路脚本(平时跳过;R130_PROBE=1 run.sh -g 探路):只把当前首页/分屏/斜杠菜单/零项目态的可见事实如实抓出来,不做断言。
import { test } from '@playwright/test';
import { gotoHome, prime, homeInput, setPaneCount, API_BASE } from './helpers/ui.mjs';

const facts = (page) => page.evaluate(() => {
  const homes = [...document.querySelectorAll('[data-cgui="home"]')];
  return {
    homeCount: homes.length,
    homeClass: homes.map((h) => h.className),
    childClass: homes.map((h) => h.firstElementChild?.className ?? null),
    testidsInHome: homes.map((h) => [...h.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))),
    cguiInHome: homes.map((h) => [...h.querySelectorAll('[data-cgui]')].map((e) => e.getAttribute('data-cgui'))),
    greeting: document.querySelector('h2[data-cgui="home-greeting"]')?.textContent?.trim() ?? null,
    paneTestids: [...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')).filter((t) => /pane/.test(t)).filter((t, i, a) => a.indexOf(t) === i),
    homeUsage: document.querySelectorAll('[data-testid="home-usage"]').length,
  };
});

test('探路 首页锚点 / 分屏 className / 斜杠菜单', async ({ page }) => {
  await gotoHome(page);
  console.log('[probe:home]', JSON.stringify(await facts(page)));
  const before = await page.evaluate(() => document.body.innerText);
  await homeInput(page).click();
  await page.keyboard.type('/');
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    roles: [...document.querySelectorAll('[role="listbox"],[role="menu"],[role="option"],[role="menuitem"]')].filter((e) => e.getClientRects().length).map((e) => `${e.getAttribute('role')}:${(e.textContent || '').trim().slice(0, 40)}`).slice(0, 12),
    slashish: [...document.querySelectorAll('[data-testid],[data-cgui]')].map((e) => e.getAttribute('data-testid') || e.getAttribute('data-cgui')).filter((t) => /slash|command|cmd|menu/i.test(t)).filter((t, i, a) => a.indexOf(t) === i),
    text: document.body.innerText,
  }));
  const added = after.text.split('\n').filter((l) => l.trim() && !before.includes(l)).slice(0, 15);
  console.log('[probe:slash]', JSON.stringify({ roles: after.roles, slashish: after.slashish, added }));
  await page.keyboard.press('Escape');
  await setPaneCount(page, 2);
  await page.waitForTimeout(1500);
  console.log('[probe:split2]', JSON.stringify(await facts(page)));
  await setPaneCount(page, 1);
  await page.waitForTimeout(1500);
  console.log('[probe:split1]', JSON.stringify(await facts(page)));
});

test('探路 零项目态(/api/projects 打成空)与 /api/projects 形状', async ({ page }) => {
  const real = await (await fetch(`${API_BASE}/api/projects`)).json().catch(() => null);
  console.log('[probe:projects-shape]', JSON.stringify({ isArray: Array.isArray(real), keys: real && !Array.isArray(real) ? Object.keys(real) : null, len: Array.isArray(real) ? real.length : null, sample: JSON.stringify(real).slice(0, 300) }));
  await page.route((u) => u.pathname === '/api/projects', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(real) ? [] : Object.fromEntries(Object.entries(real || {}).map(([k, v]) => [k, Array.isArray(v) ? [] : v]))) }));
  await prime(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  console.log('[probe:empty]', JSON.stringify({
    ...(await facts(page)),
    homeInput: await homeInput(page).count(),
    cgui: await page.evaluate(() => [...document.querySelectorAll('[data-cgui]')].map((e) => e.getAttribute('data-cgui')).filter((t, i, a) => a.indexOf(t) === i)),
    text: (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400),
  }));
});

test('探路 用量面板里与"时段/北京时间/UTC"有关的文案与 title', async ({ page }) => {
  const { openUsagePanel } = await import('./helpers/ui.mjs');
  await gotoHome(page);
  await openUsagePanel(page);
  const facts2 = await page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map((l) => l.trim()).filter((l) => /北京|UTC|时段|峰|折扣|分档/.test(l));
    const titles = [...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).filter((t) => /北京|UTC|时段|峰/.test(t));
    const hidden = [...document.querySelectorAll('details')].map((d) => (d.textContent || '').replace(/\s+/g, ' ').slice(0, 120)).filter((t) => /北京|UTC|时段|峰/.test(t));
    return { lines: [...new Set(lines)].slice(0, 20), titles: [...new Set(titles)].slice(0, 10), hidden: hidden.slice(0, 5) };
  });
  console.log('[probe:usage-panel]', JSON.stringify(facts2));
});

// ── C13 探路(2026-09-28 补):单屏新布局下,输入「/」「@」后新挂载的浮层子树根是什么、祖先链里谁在裁剪、裁掉多少 ──
const snapshotAll = (page) => page.evaluate(() => { window.__r130Before = new Set(document.querySelectorAll('*')); });
const describe = (el) => {
  const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
  return { tag: el.tagName.toLowerCase(), testid: el.getAttribute('data-testid'), cgui: el.getAttribute('data-cgui'), role: el.getAttribute('role'), cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 140),
    pos: cs.position, ox: cs.overflowX, oy: cs.overflowY, z: cs.zIndex, radius: cs.borderTopLeftRadius, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], hasInput: Boolean(el.querySelector('[data-testid="home-input"]')) };
};
const newSubtrees = (page) => page.evaluate((describeSrc) => {
  const describe = new Function(`return (${describeSrc})`)();
  const before = window.__r130Before; const all = [...document.querySelectorAll('*')];
  const added = all.filter((e) => !before.has(e)); const roots = added.filter((e) => !added.includes(e.parentElement));
  const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  return roots.filter(visible).map((root) => {
    const chain = []; let p = root.parentElement; while (p && p !== document.documentElement) { chain.push(describe(p)); p = p.parentElement; }
    return { root: describe(root), text: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 160), chain, vp: [innerWidth, innerHeight] };
  });
}, describe.toString());
for (const [w, h] of [[1440, 900], [375, 812]]) {
  test(`探路 C13 ${w}×${h}:输入「/」「@」后的浮层根与祖先链`, async ({ page }) => {
    const { stubUsage, payload, dayEntry, dayAgo, measureBox, describeMeasure } = await import('./helpers/ui.mjs');
    await page.setViewportSize({ width: w, height: h });
    await stubUsage(page, payload({ byDay: [1, 2, 3, 5, 8, 13, 21, 34].map((n, i) => dayEntry(dayAgo(n), (i + 1) * 1000 + i)) }));
    await gotoHome(page);
    await page.waitForTimeout(1500);
    // 判据健全性:对两个肯定完整可见的元素(八卡容器、输入框)跑同一套量法,三项都该"无超出 / 四角命中"——否则是量法自己有问题
    for (const id of ['home-usage-cards', 'home-input']) {
      const eh = await page.getByTestId(id).elementHandle();
      if (eh) console.log(`[probe:c13:sanity:${w}x${h}:${id}]`, describeMeasure(await measureBox(eh)));
    }
    for (const ch of ['/', '@']) {
      await homeInput(page).click();
      await homeInput(page).fill('');
      await page.waitForTimeout(300);
      await snapshotAll(page);
      await page.keyboard.type(ch);
      await page.waitForTimeout(1000);
      console.log(`[probe:c13:${w}x${h}:${ch}]`, JSON.stringify(await newSubtrees(page)));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
  });
}
