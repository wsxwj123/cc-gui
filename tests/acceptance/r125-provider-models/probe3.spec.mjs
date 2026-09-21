// r125 探路脚本第三批(不是验收判据):三个弹层的最小容器 DOM / 「取消」行为 / 空 models 建项。
import { test } from '@playwright/test';
import { req, createCustomProvider, createImageProvider, switchProvider } from './helpers/api.mjs';
import { boot, openImagePanel, imagePanel } from './helpers/ui.mjs';

test.skip(process.env.R125_PROBE !== '1', '探路脚本只在 R125_PROBE=1 时跑');
const dump = (label, obj) => console.log(`\n##### ${label}\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)}`);
/** 同时罩住全部给定按钮文字的最深容器的 html(去 class / svg / style)。 */
const smallest = (page, texts, max = 9000) => page.evaluate(([texts, max]) => {
  const vis = (el) => !!el.getClientRects().length;
  const btns = texts.map((t) => [...document.querySelectorAll('button')].find((el) => vis(el) && (el.innerText || '').trim() === t));
  if (btns.some((b) => !b)) return `(缺按钮:${texts.filter((t, i) => !btns[i]).join(',')})`;
  let host = btns[0];
  while (host && !btns.every((b) => host.contains(b))) host = host.parentElement;
  if (!host) return '(无公共容器)';
  const tag = (el) => `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}${el.getAttribute('data-testid') ? `[testid=${el.getAttribute('data-testid')}]` : ''}`;
  const chain = []; let e = host; while (e && e !== document.body) { chain.push(tag(e)); e = e.parentElement; }
  return { chain: chain.join(' < '), html: host.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').replace(/ class="[^"]*"/g, '').replace(/ style="[^"]*"/g, '').slice(0, max) };
}, [texts, max]);
const visibleText = (page) => page.evaluate(() => (document.body.innerText || '').replace(/\n{2,}/g, '\n'));

test('探路 P8 空 models 建自定义 provider / 生图 provider 空 models', async () => {
  const r = await req('POST', '/api/custom-providers', { name: 'r125 空白名单', type: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-x', models: [] });
  dump('POST custom-providers models:[]', { status: r.status, body: r.text.slice(0, 300) });
  const r2 = await req('POST', '/api/custom-providers', { name: 'r125 无 models 字段', type: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-x' });
  dump('POST custom-providers 无 models', { status: r2.status, body: r2.text.slice(0, 300) });
});

test('探路 P9 模型页勾选弹窗 / 模型页浮层 / 取消行为(自定义)', async ({ page }) => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server');
  const custom = await createCustomProvider({ name: 'r125 探路P9' });
  await switchProvider(custom.id);
  await boot(page);
  await page.locator('button[title^="模型:"]').first().click({ force: true });
  await page.waitForTimeout(800);
  dump('模型页浮层(拉取最新+关闭)', await smallest(page, ['拉取最新', '关闭'], 12000));
  await page.route((url) => url.pathname === '/api/provider/fetch-models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, models: ['r125-old-a', 'r125-old-b', 'r125-new-c'] }) }));
  await page.locator('button').filter({ hasText: /^拉取最新$/ }).first().click({ force: true });
  await page.waitForTimeout(1000);
  dump('勾选弹窗(全不选+确认)', await smallest(page, ['全不选', '确认'], 9000));
  dump('弹窗开着时可见输入框', await page.evaluate(() => [...document.querySelectorAll('input')].filter((e) => e.getClientRects().length).map((e) => ({ type: e.type, ph: e.placeholder, testid: e.getAttribute('data-testid') }))));
  // 取消
  await page.locator('input[type=checkbox]').nth(2).click({ force: true });
  await page.locator('button').filter({ hasText: /^取消$/ }).first().click({ force: true });
  await page.waitForTimeout(500);
  dump('点取消后:checkbox 数 / 「拉取最新」还可见?', [await page.locator('input[type=checkbox]:visible').count(), await page.locator('button').filter({ hasText: /^拉取最新$/ }).first().isVisible().catch(() => false)]);
  dump('点取消后 GET providers custom models', (await req('GET', '/api/providers')).json?.customProviders?.find((x) => x.id === custom.id)?.models);
  // 再开一次,搜索 + 全选 现状
  if (!(await page.locator('button').filter({ hasText: /^拉取最新$/ }).first().isVisible().catch(() => false))) { await page.locator('button[title^="模型:"]').first().click({ force: true }); await page.waitForTimeout(600); }
  await page.locator('button').filter({ hasText: /^拉取最新$/ }).first().click({ force: true });
  await page.waitForTimeout(800);
  const boxes = page.locator('input[type=text]:visible');
  const n = await boxes.count();
  dump('弹窗开着时可见文本框数', n);
  for (let i = 0; i < n; i += 1) dump(`文本框 ${i} placeholder`, await boxes.nth(i).getAttribute('placeholder'));
  const searchIn = page.locator('input[placeholder="搜索模型…"]:visible').last();
  await searchIn.fill('r125-new');
  await page.waitForTimeout(300);
  dump('搜 r125-new 后 checkbox 行', await page.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')].filter((c) => c.getClientRects().length).map((c) => ({ checked: c.checked, disabled: c.disabled, text: (c.closest('label,li,div')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) }))));
  await page.locator('button').filter({ hasText: /^全选$/ }).first().click({ force: true });
  await searchIn.fill('');
  await page.waitForTimeout(300);
  dump('全选后清空搜索 checkbox 行', await page.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')].filter((c) => c.getClientRects().length).map((c) => ({ checked: c.checked, disabled: c.disabled, text: (c.closest('label,li,div')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) }))));
  await page.keyboard.press('Escape');
});

test('探路 P10 生图勾选弹窗 DOM / 新建表单里全不勾时确认 / provider 浮层 DOM', async ({ page }) => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server');
  const p = await createImageProvider({ name: 'r125 探路P10' });
  await boot(page);
  await openImagePanel(page);
  const panel = imagePanel(page);
  const sel = panel.locator('select').filter({ has: page.locator(`option[value="${p.id}"]`) }).first();
  dump('生图页 provider select 数', await sel.count());
  if (await sel.count()) await sel.selectOption(p.id);
  await panel.locator('button[title="编辑"]').first().click({ force: true });
  await page.waitForTimeout(500);
  await page.route((url) => url.pathname === '/api/image-providers/fetch-models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, models: ['r125-img-old-a', 'r125-img-old-b', 'r125-img-new-c'] }) }));
  await panel.locator('button').filter({ hasText: /拉取模型/ }).first().click({ force: true });
  await page.waitForTimeout(900);
  dump('生图勾选弹窗(全不选+确认)', await smallest(page, ['全不选', '确认'], 9000));
  dump('生图弹窗开着时可见文本框', await page.evaluate(() => [...document.querySelectorAll('input[type=text]')].filter((e) => e.getClientRects().length).map((e) => e.placeholder)));
  await page.locator('button').filter({ hasText: /^取消$/ }).last().click({ force: true });
  await page.waitForTimeout(400);
  dump('取消后·表单还开着?(有「保存」按钮)', await panel.locator('button').filter({ hasText: /^保存$/ }).count());
  await panel.locator('button').filter({ hasText: /^取消$/ }).first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(300);
  // provider 浮层
  await page.locator('button[title^="Provider:"]').first().click({ force: true });
  await page.waitForTimeout(900);
  dump('provider 浮层(管理 Provider 按钮的祖先链 + 含「Claude 官方」按钮的公共容器)', await page.evaluate(() => {
    const vis = (el) => !!el.getClientRects().length;
    const a = [...document.querySelectorAll('button')].find((el) => vis(el) && /管理 Provider/.test(el.innerText || ''));
    const b = [...document.querySelectorAll('button')].find((el) => vis(el) && (el.innerText || '').trim() === 'Claude 官方');
    if (!a || !b) return `(缺:${!a ? '管理' : ''}${!b ? '官方' : ''})`;
    let host = a; while (host && !host.contains(b)) host = host.parentElement;
    const tag = (el) => `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}${el.getAttribute('data-testid') ? `[testid=${el.getAttribute('data-testid')}]` : ''}`;
    const chain = []; let e = host; while (e && e !== document.body) { chain.push(tag(e)); e = e.parentElement; }
    return { chain: chain.join(' < '), html: host.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').replace(/ class="[^"]*"/g, '').replace(/ style="[^"]*"/g, '').slice(0, 7000) };
  }));
  await page.keyboard.press('Escape');
});
