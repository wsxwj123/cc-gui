// r125 探路脚本第四批(不是验收判据):模型页浮层的容器结构(官方 / 自定义),给 modelPage 定位器用。
import { test } from '@playwright/test';
import { createCustomProvider, switchProvider } from './helpers/api.mjs';
import { boot, modelButton, fetchLatestButton } from './helpers/ui.mjs';

test.skip(process.env.R125_PROBE !== '1', '探路脚本只在 R125_PROBE=1 时跑');
const dump = (label, obj) => console.log(`\n##### ${label}\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)}`);

/** 从「拉取最新」按钮往上走,直到祖先里出现文字逐字等于 modelId 的元素;打印祖先链与该祖先的精简 html。 */
const structure = (page, modelId) => page.evaluate((modelId) => {
  const vis = (el) => !!el.getClientRects().length;
  const btn = [...document.querySelectorAll('button')].find((el) => vis(el) && (el.innerText || '').trim() === '拉取最新');
  if (!btn) return '(没有「拉取最新」)';
  const exact = (root) => [...root.querySelectorAll('*')].some((el) => vis(el) && !el.children.length && (el.textContent || '').trim() === modelId);
  const tag = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}${el.getAttribute('data-testid') ? `[testid=${el.getAttribute('data-testid')}]` : ''}${el.getAttribute('data-cgui') ? `[data-cgui=${el.getAttribute('data-cgui')}]` : ''}`;
  let host = btn; const chain = [];
  while (host && host !== document.body && !exact(host)) { chain.push(tag(host)); host = host.parentElement; }
  const out = { chainFromButton: chain.join(' > '), rootTag: host ? tag(host) : null, rootTextHead: (host?.innerText || '').replace(/\s+/g, ' ').slice(0, 300) };
  // 根的直接子元素概览
  out.children = host ? [...host.children].map((c) => ({ tag: tag(c), text: (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80), inputs: [...c.querySelectorAll('input')].map((i) => i.placeholder || i.type) })) : [];
  // 一行模型的 html
  const leaf = host ? [...host.querySelectorAll('*')].find((el) => vis(el) && !el.children.length && (el.textContent || '').trim() === modelId) : null;
  let row = leaf; for (let i = 0; i < 3 && row?.parentElement && row.tagName !== 'BUTTON'; i += 1) row = row.parentElement;
  out.rowHtml = row ? row.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').replace(/ class="[^"]*"/g, '').slice(0, 1500) : null;
  out.ancestorsOfRoot = (() => { const a = []; let e = host?.parentElement; while (e && e !== document.body) { a.push(tag(e)); e = e.parentElement; } return a.join(' > '); })();
  return out;
}, modelId);

test('探路 P11 模型页浮层结构:官方 / 自定义;手动添加自定义模型 ID 的行为', async ({ page }) => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server');
  const seen = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) seen.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}${r.postData() ? ' body=' + r.postData().slice(0, 200) : ''}`); });
  await switchProvider('builtin-official');
  await boot(page);
  await modelButton(page).click({ force: true });
  await page.waitForTimeout(800);
  dump('官方·结构', await structure(page, 'claude-sonnet-4-6'));
  dump('官方·可见输入框', await page.evaluate(() => [...document.querySelectorAll('input')].filter((e) => e.getClientRects().length).map((e) => e.placeholder || e.type)));
  await page.keyboard.press('Escape');
  const p = await createCustomProvider({ name: 'r125 探路P11', models: ['r125-old-a', 'r125-old-b'] });
  await switchProvider(p.id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-cgui="panel-dock"]').waitFor({ timeout: 40_000 });
  await page.waitForTimeout(800);
  await modelButton(page).click({ force: true });
  await page.waitForTimeout(800);
  dump('自定义·结构', await structure(page, 'r125-old-a'));
  const manual = page.getByPlaceholder('自定义模型 ID...').first();
  dump('自定义·有「自定义模型 ID...」输入框?', await manual.count());
  if (await manual.count()) {
    seen.length = 0;
    await manual.fill('r125-manual-z');
    await manual.press('Enter');
    await page.waitForTimeout(900);
    dump('手动添加后·请求', seen.slice());
    dump('手动添加后·「拉取最新」还可见?', await fetchLatestButton(page).isVisible().catch(() => false));
    if (!(await fetchLatestButton(page).isVisible().catch(() => false))) { await modelButton(page).click({ force: true }); await page.waitForTimeout(600); }
    dump('手动添加后·结构(以 r125-manual-z 为锚)', await structure(page, 'r125-manual-z'));
    dump('手动添加后·页面可见文本(去头)', (await page.evaluate(() => document.body.innerText)).replace(/\n{2,}/g, '\n').slice(0, 1200));
    // 手动添加后 GET /api/model
    const m = await fetch(`${process.env.R125_API_BASE}/api/model`).then((r) => r.text());
    dump('手动添加后 GET /api/model', m.slice(0, 600));
  }
});
