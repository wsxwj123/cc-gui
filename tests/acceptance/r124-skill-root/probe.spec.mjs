// r124 探路脚本(平时跳过;R124_PROBE=1 才跑):只为摸清技能面板的入口、输入框、按钮与请求形态,
// 不做断言、不进验收计数。输出全部打到 stdout。
import { test } from '@playwright/test';

const PROBE = process.env.R124_PROBE === '1';
const dump = (label, obj) => console.log(`\n##### ${label}\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)}`);

async function snapshot(page) {
  return page.evaluate(() => {
    const vis = (el) => !!el.getClientRects().length;
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(vis).map((b) => ({
      text: (b.innerText || '').trim().slice(0, 60), title: b.getAttribute('title'), aria: b.getAttribute('aria-label'), disabled: b.disabled, testid: b.getAttribute('data-testid'),
    }));
    const inputs = [...document.querySelectorAll('input, textarea, select')].filter(vis).map((i) => ({
      tag: i.tagName, type: i.type, placeholder: i.placeholder, aria: i.getAttribute('aria-label'), value: (i.value || '').slice(0, 60), testid: i.getAttribute('data-testid'), id: i.id,
    }));
    const tabs = [...document.querySelectorAll('[role="tab"], [role="tablist"] *')].filter(vis).map((t) => (t.innerText || '').trim().slice(0, 40));
    return { text: (document.body.innerText || '').slice(0, 6000), buttons, inputs, tabs: [...new Set(tabs)] };
  });
}

test.describe('探路', () => {
  test.skip(!PROBE, '探路脚本只在 R124_PROBE=1 时跑');

  test('探路:技能面板在哪、长什么样', async ({ page }) => {
    const seen = [];
    page.on('request', (r) => { if (r.url().includes('/api/skills')) seen.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}${r.postData() ? ' body=' + r.postData().slice(0, 200) : ''}`); });
    page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
    await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
    for (const u of ['**/api/version-check', '**/api/claude-version-check']) await page.route(u, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-cgui="panel-dock"]').waitFor({ state: 'visible', timeout: 40_000 });
    await page.waitForTimeout(800);
    for (let i = 0; i < 4; i += 1) for (const label of ['稍后', '以后再说', '已知晓']) { const b = page.locator('button').filter({ hasText: label }).last(); if (await b.isVisible().catch(() => false)) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(150); } }

    // 面板坞里的格子
    const toggle = page.locator('[data-testid="panel-dock-toggle"]');
    const probe = page.locator('[data-cgui="panel-dock"] button').filter({ hasText: /^通用$/ }).first();
    if (!(await probe.isVisible().catch(() => false)) && await toggle.count()) { await toggle.click({ force: true }).catch(() => {}); await page.waitForTimeout(600); }
    const labels = [...new Set((await page.locator('[data-cgui="panel-dock"] button').allInnerTexts()).map((s) => s.trim()).filter(Boolean))];
    dump('面板坞格子', labels);

    const skillBtn = page.locator('[data-cgui="panel-dock"] button').filter({ hasText: /技能/ }).first();
    dump('有「技能」格子?', await skillBtn.count());
    if (!(await skillBtn.count())) { dump('整页文本', (await snapshot(page)).text); return; }
    await skillBtn.click({ force: true });
    await page.waitForTimeout(1_500);
    let s = await snapshot(page);
    dump('技能面板·文本', s.text);
    dump('技能面板·按钮', s.buttons);
    dump('技能面板·输入框', s.inputs);
    dump('技能面板·tabs', s.tabs);
    dump('到此为止的 /api/skills 请求', seen);

    // 找"仓库/市场/导入"的入口:按钮或页签
    for (const kw of [/仓库|市场|商店|导入|安装/]) {
      const cands = page.locator('button, [role="tab"]').filter({ hasText: kw });
      dump(`含 ${kw} 的按钮/页签`, await cands.evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => (e.innerText || '').trim().slice(0, 50))));
    }
    // 尝试进入"技能仓库"类页签
    const tabLike = page.locator('button, [role="tab"]').filter({ hasText: /技能仓库|仓库|市场|商店/ }).first();
    if (await tabLike.count()) {
      await tabLike.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1_500);
      s = await snapshot(page);
      dump('进入仓库页后·文本', s.text);
      dump('进入仓库页后·按钮', s.buttons);
      dump('进入仓库页后·输入框', s.inputs);
      dump('请求', seen);
    }
    // 找能填 owner/repo 的输入框
    const repoInput = page.locator('input').filter({ has: page.locator(':scope') }).locator('visible=true').filter({ hasNot: page.locator('[type="checkbox"]') });
    const n = await repoInput.count();
    for (let i = 0; i < n; i += 1) {
      const ph = await repoInput.nth(i).getAttribute('placeholder');
      console.log('input', i, 'placeholder=', ph);
    }
    const target = page.locator('input[placeholder*="owner" i], input[placeholder*="repo" i], input[placeholder*="仓库"], input[placeholder*="github" i]').first();
    dump('候选仓库输入框', await target.count());
    if (await target.count()) {
      await target.fill('acme/no-skills');
      await page.waitForTimeout(300);
      s = await snapshot(page);
      dump('填入后·按钮', s.buttons.filter((b) => /拉|取|加载|获取|查|导入|安装|更新|GitHub|Gitee/i.test(`${b.text} ${b.title} ${b.aria}`)));
      const go = page.locator('button').filter({ hasText: /拉取|获取|加载|查询|抓取|读取|检索|搜索|确定|Go|查看/ }).first();
      if (await go.count()) { await go.click({ force: true }); } else { await target.press('Enter'); }
      await page.waitForTimeout(2_500);
      s = await snapshot(page);
      dump('拉取后·文本', s.text);
      dump('拉取后·按钮', s.buttons);
      dump('拉取后·请求', seen);
    }
  });
});

// ---- 探路 2:「检查更新」发什么请求;导入区按 official 的 count/installed 怎么画(浏览器侧拦截喂数据,只为摸清渲染) ----
import fs from 'node:fs';
import path from 'node:path';
test.describe('探路2', () => {
  test.skip(!PROBE, '探路脚本只在 R124_PROBE=1 时跑');

  test('探路2:检查更新请求 + 导入区渲染', async ({ page }) => {
    // 共享 HOME 里先放一个"本机已装"的技能,好让「检查更新」有东西可查
    const home = process.env.R124_HOME;
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'probe-skill'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'probe-skill', 'SKILL.md'), '---\nname: probe-skill\ndescription: 探路用\nversion: 0.0.1\n---\n');
    const seen = [];
    page.on('request', (r) => { if (r.url().includes('/api/')) seen.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}${r.postData() ? ' body=' + r.postData().slice(0, 300) : ''}`); });
    page.on('response', async (r) => { if (/skills\/(update|check|source)/.test(r.url())) { try { console.log('[response]', r.status(), r.url().replace(/^https?:\/\/[^/]+/, ''), (await r.text()).slice(0, 400)); } catch {} } });
    await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
    for (const u of ['**/api/version-check', '**/api/claude-version-check']) await page.route(u, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-cgui="panel-dock"]').waitFor({ state: 'visible', timeout: 40_000 });
    await page.waitForTimeout(800);
    for (let i = 0; i < 4; i += 1) for (const label of ['稍后', '以后再说', '已知晓']) { const b = page.locator('button').filter({ hasText: label }).last(); if (await b.isVisible().catch(() => false)) { await b.click({ force: true }).catch(() => {}); await page.waitForTimeout(150); } }
    const toggle = page.locator('[data-testid="panel-dock-toggle"]');
    const probe = page.locator('[data-cgui="panel-dock"] button').filter({ hasText: /^通用$/ }).first();
    if (!(await probe.isVisible().catch(() => false)) && await toggle.count()) { await toggle.click({ force: true }).catch(() => {}); await page.waitForTimeout(600); }

    // A) 技能面板 → 检查更新
    await page.locator('[data-cgui="panel-dock"] button[title^="Skill 市场"]').first().click({ force: true });
    await page.waitForTimeout(1_500);
    let s = await snapshot(page);
    dump('技能面板·文本(去头)', s.text.replace(/^[\s\S]*?(Skill 市场)/, '$1').slice(0, 1500));
    seen.length = 0;
    const upd = page.locator('button').filter({ hasText: /检查更新/ }).first();
    dump('检查更新按钮数', await upd.count());
    if (await upd.count()) { await upd.click({ force: true }); await page.waitForTimeout(3_000); }
    dump('点检查更新后·请求', seen);
    s = await snapshot(page);
    dump('点检查更新后·文本(去头)', s.text.replace(/^[\s\S]*?(Skill 市场)/, '$1').slice(0, 1500));

    // B) 市场面板 → 拦截 official 喂不同 count/installed
    await page.locator('[data-cgui="panel-dock"] button[title^="扩展市场"]').first().click({ force: true });
    await page.waitForTimeout(1_500);
    let mocked = null;
    await page.route((url) => url.pathname === '/api/skills/official' && url.searchParams.has('repo'), async (route) => {
      if (!mocked) { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(mocked) });
    });
    const repoInput = page.locator('input[placeholder^="owner/repo"]').first();
    const fetchBtn = page.locator('button').filter({ hasText: /^拉取仓库$/ }).first();
    dump('仓库输入框数 / 拉取仓库按钮数', [await repoInput.count(), await fetchBtn.count()]);
    const sk = (id, desc, installed) => ({ id, name: id, description: desc, version: '1.0.0', installed });
    const scenarios = [
      ['两个都已装', { source: 'github', repo: 'acme/two-skills', branch: 'main', host: 'github', count: 2, truncatedDesc: false, skills: [sk('alpha', '技能甲', true), sk('beta', '技能乙', true)] }],
      ['装了一个', { source: 'github', repo: 'acme/two-skills', branch: 'main', host: 'github', count: 2, truncatedDesc: false, skills: [sk('alpha', '技能甲', true), sk('beta', '技能乙', false)] }],
      ['0 个技能', { source: 'github', repo: 'acme/no-skills', branch: 'main', host: 'github', count: 0, truncatedDesc: false, skills: [] }],
      ['一个根技能未装', { source: 'github', repo: 'acme/solo-skill', branch: 'main', host: 'github', count: 1, truncatedDesc: false, skills: [sk('solo-skill', '单技能仓库', false)] }],
    ];
    for (const [name, payload] of scenarios) {
      mocked = payload;
      seen.length = 0;
      await repoInput.fill(payload.repo);
      await fetchBtn.click({ force: true });
      await page.waitForTimeout(1_800);
      const s2 = await snapshot(page);
      dump(`拦截场景「${name}」·文本(去头)`, s2.text.replace(/^[\s\S]*?(全部源)/, '$1').slice(0, 1600));
      dump(`拦截场景「${name}」·按钮(导入区相关)`, s2.buttons.filter((b) => /导入|安装|全部|跳过|覆盖|返回/.test(`${b.text} ${b.title}`)));
      dump(`拦截场景「${name}」·请求`, seen);
    }
    // 导入区的 DOM 锚点:含「一键导入全部」或「此源已全部安装」的按钮,连同其祖先的 data-testid
    const anchors = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /一键导入全部|此源已全部安装|没有找到技能/.test(b.innerText)).map((b) => {
      const ids = []; let el = b; while (el && el !== document.body) { if (el.getAttribute && el.getAttribute('data-testid')) ids.push(el.getAttribute('data-testid')); el = el.parentElement; }
      return { text: b.innerText.trim(), testid: b.getAttribute('data-testid'), ancestorsTestids: ids, disabled: b.disabled };
    }));
    dump('导入按钮锚点', anchors);
  });
});
