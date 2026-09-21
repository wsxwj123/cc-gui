// 探路脚本(不是验收判据):把当前实例/界面里跟本轮有关的事实如实抓一份出来,给写用例用。
// 平时跳过;R123_PROBE=1 tests/acceptance/r123-imagegen/run.sh -g '探路' 才跑。
import { test } from '@playwright/test';
import { req, createProvider, generate, waitTerminal, newSaveDir, history } from './helpers/api.mjs';
import { createFakeUpstream } from './helpers/fake-upstream.mjs';
import { boot, openImagePanel, openTaskList, imagePanel } from './helpers/ui.mjs';
import { PNG_B64 } from './helpers/images.mjs';

test.skip(process.env.R123_PROBE !== '1', '探路脚本只在 R123_PROBE=1 时跑');

test('探路 P1 既有接口形态:提供方增改查、历史条目字段', async () => {
  const up = createFakeUpstream(); await up.listen();
  try {
    const base = up.scenario('/p1/v1', ({ method, path }) => {
      if (method === 'POST' && path === '/images/generations') return { body: { created: 1, data: [{ b64_json: PNG_B64 }] } };
      return null;
    });
    const p = await createProvider({ baseURL: base, savePath: newSaveDir('p1') });
    console.log('[P1] POST provider →', JSON.stringify(p));
    const list = await req('GET', '/api/image-providers');
    console.log('[P1] GET providers →', list.text.slice(0, 600));
    const putA = await req('PUT', `/api/image-providers/${p.id}`, { ...p, name: 'renamed' });
    console.log('[P1] PUT /api/image-providers/:id →', putA.status, putA.text.slice(0, 300));
    const putB = await req('PUT', '/api/image-providers', { ...p, name: 'renamed2' });
    console.log('[P1] PUT /api/image-providers →', putB.status, putB.text.slice(0, 300));
    const jobId = await generate(p.id);
    const first = (await history()).find((e) => e.id === jobId);
    console.log('[P1] 刚提交的条目 →', JSON.stringify(first));
    const done = await waitTerminal(jobId, 20_000);
    console.log('[P1] 终态条目 →', JSON.stringify(done));
    console.log('[P1] 上游收到 →', JSON.stringify(await up.received('/p1/v1')));
    // 一条失败的:看现状 error 长什么样
    const base2 = up.scenario('/p1html', () => ({ status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><html><head><title>New API</title></head><body>hi</body></html>' }));
    const p2 = await createProvider({ baseURL: base2, savePath: newSaveDir('p1b') });
    const j2 = await generate(p2.id);
    console.log('[P1] HTML 失败条目 →', JSON.stringify(await waitTerminal(j2, 20_000)));
    const r = await req('GET', '/api/image/history');
    console.log('[P1] history 顶层键 →', r.json && !Array.isArray(r.json) ? Object.keys(r.json) : 'array');
  } finally { await up.close(); }
});

test('探路 P2 界面:面板坞按钮 / 生图面板里的表单长什么样', async ({ page }) => {
  test.skip(!process.env.R123_UI_BASE, '没有 dev server');
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const url of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-cgui="panel-dock"]').waitFor({ timeout: 40_000 });
  await page.waitForTimeout(1500);
  const dock = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((el) => el.getClientRects().length)
    .map((el) => ({ text: (el.innerText || '').trim().slice(0, 16), title: el.getAttribute('title'), aria: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid') }))
    .filter((b) => b.text || b.title || b.aria));
  console.log('[P2] 可见按钮 =', JSON.stringify(dock));
  const toggle = page.locator('[data-testid="panel-dock-toggle"]').first();
  if (await toggle.isVisible().catch(() => false)) { await toggle.click(); await page.waitForTimeout(400); }
  const dock2 = await page.evaluate(() => [...document.querySelectorAll('[data-cgui="panel-dock"] button')]
    .filter((el) => el.getClientRects().length).map((el) => ({ text: (el.innerText || el.getAttribute('title') || '').trim().slice(0, 14), title: el.getAttribute('title') })));
  console.log('[P2] 面板坞按钮 =', JSON.stringify(dock2));
  const cand = page.locator('[data-cgui="panel-dock"] button').filter({ hasText: /生图|图片|图像|绘图|Image/ }).first();
  if (await cand.count()) {
    await cand.click(); await page.waitForTimeout(1200);
    const facts = await page.evaluate(() => {
      const vis = (el) => el.getClientRects().length > 0;
      const inputs = [...document.querySelectorAll('input, textarea, select')].filter(vis)
        .map((el) => ({ tag: el.tagName, type: el.type, placeholder: el.getAttribute('placeholder'), aria: el.getAttribute('aria-label'), name: el.getAttribute('name'), value: String(el.value || '').slice(0, 40), testid: el.getAttribute('data-testid'), labelText: (el.closest('label')?.innerText || el.labels?.[0]?.innerText || '').trim().slice(0, 30) }));
      const buttons = [...document.querySelectorAll('button')].filter(vis).map((el) => ({ text: (el.innerText || '').trim().slice(0, 16), title: el.getAttribute('title'), testid: el.getAttribute('data-testid') })).filter((b) => b.text || b.title);
      const testids = [...document.querySelectorAll('[data-testid]')].filter(vis).map((el) => el.getAttribute('data-testid'));
      return { inputs, buttons, testids };
    });
    console.log('[P2] 生图面板 =', JSON.stringify(facts, null, 1));
    await page.screenshot({ path: 'tests/acceptance/r123-imagegen/.artifacts/probe-p2-panel.png' });
    // 试着点"添加/新建提供方"一类的按钮
    const add = page.locator('button[title="新增生图 provider"]').first();
    if (await add.count()) {
      await add.click().catch(() => {}); await page.waitForTimeout(800);
      const facts2 = await page.evaluate(() => {
        const vis = (el) => el.getClientRects().length > 0;
        const inputs = [...document.querySelectorAll('input, textarea, select')].filter(vis)
          .map((el) => ({ tag: el.tagName, type: el.type, placeholder: el.getAttribute('placeholder'), aria: el.getAttribute('aria-label'), value: String(el.value || '').slice(0, 40), testid: el.getAttribute('data-testid'), labelText: (el.closest('label')?.innerText || el.labels?.[0]?.innerText || '').trim().slice(0, 30), options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value) : undefined }));
        const buttons = [...document.querySelectorAll('button')].filter(vis).map((el) => ({ text: (el.innerText || '').trim().slice(0, 16), title: el.getAttribute('title'), testid: el.getAttribute('data-testid') })).filter((b) => b.text || b.title);
        return { inputs, buttons };
      });
      console.log('[P2] 点"添加"之后 =', JSON.stringify(facts2, null, 1));
      const formHtml = await page.evaluate(() => {
        const sel = document.querySelector('select');
        let host = sel; for (let i = 0; i < 6 && host?.parentElement; i += 1) host = host.parentElement;
        return host ? host.outerHTML.replace(/\s+/g, ' ').slice(0, 6000) : '(没有 select)';
      });
      console.log('[P2] 表单 html =', formHtml);
      await page.screenshot({ path: 'tests/acceptance/r123-imagegen/.artifacts/probe-p2-form.png' });
    }
  } else {
    console.log('[P2] 面板坞里没找到生图入口');
    await page.screenshot({ path: 'tests/acceptance/r123-imagegen/.artifacts/probe-p2-nopanel.png' });
  }
});

test('探路 P4 生图页预览区 / 清空 / 任务列表条目 / history delete 接口形态', async ({ page }) => {
  test.skip(!process.env.R123_UI_BASE, '没有 dev server');
  const up = createFakeUpstream(); await up.listen();
  try {
    const base = up.scenario('/p4/v1', ({ method, path }) => (method === 'POST' && path === '/images/generations' ? { body: { created: 1, data: [{ b64_json: PNG_B64 }] } } : null));
    const p = await createProvider({ name: 'P4 提供方', baseURL: base, savePath: newSaveDir('p4') });
    const jobId = await generate(p.id, 'R123P4-mark');
    console.log('[P4] job →', JSON.stringify(await waitTerminal(jobId, 20_000)));
    await boot(page); await openImagePanel(page);
    const snap = (label) => page.evaluate((label) => {
      const vis = (el) => el.getClientRects().length > 0;
      const panel = [...document.querySelectorAll('[data-cgui-panel]')].find((el) => /生图（自定义生图 provider）/.test(el.innerText || ''));
      if (!panel) return { label, panel: null };
      const imgs = [...panel.querySelectorAll('img')].map((el) => ({ src: (el.getAttribute('src') || '').slice(0, 140), testid: el.getAttribute('data-testid'), alt: el.alt, visible: vis(el), w: Math.round(el.getBoundingClientRect().width) }));
      const selects = [...panel.querySelectorAll('select')].filter(vis).map((el) => ({ value: el.value, options: [...el.options].map((o) => ({ v: o.value.slice(0, 40), t: o.textContent.trim().slice(0, 30) })) }));
      const buttons = [...panel.querySelectorAll('button')].filter(vis).map((el) => ({ text: (el.innerText || '').trim().slice(0, 16), title: el.getAttribute('title'), testid: el.getAttribute('data-testid') })).filter((b) => b.text || b.title);
      const ls = Object.fromEntries(Object.keys(localStorage).filter((k) => /image|preview|dismiss|生图/i.test(k)).map((k) => [k, String(localStorage.getItem(k)).slice(0, 80)]));
      const textareaVisible = !!panel.querySelector('textarea') && vis(panel.querySelector('textarea'));
      return { label, imgs, selects, buttons, ls, textareaVisible };
    }, label);
    console.log('[P4] 生图页 =', JSON.stringify(await snap('初始'), null, 1));
    await imagePanel(page).getByRole('button', { name: /清空/ }).first().click();
    await page.waitForTimeout(500);
    console.log('[P4] 清空后 =', JSON.stringify(await snap('清空后'), null, 1));
    await openTaskList(page);
    const listHtml = await page.evaluate((mark) => {
      const panel = [...document.querySelectorAll('[data-cgui-panel]')].find((el) => /生图（自定义生图 provider）/.test(el.innerText || ''));
      const leaf = [...panel.querySelectorAll('*')].find((el) => !el.children.length && (el.textContent || '').includes(mark));
      let host = leaf; for (let i = 0; i < 5 && host?.parentElement && host.parentElement !== panel; i += 1) host = host.parentElement;
      return host ? host.outerHTML.replace(/\s+/g, ' ').replace(/class="[^"]*"/g, '').slice(0, 3500) : '(没找到)';
    }, 'R123P4-mark');
    console.log('[P4] 任务列表条目 html =', listHtml);
    await imagePanel(page).getByText('R123P4-mark').first().click();
    await page.waitForTimeout(700);
    console.log('[P4] 点条目后 =', JSON.stringify(await snap('点条目后'), null, 1));
    for (const body of [{ id: 'nope' }, { ids: ['nope'] }]) {
      const r = await req('POST', '/api/image/history/delete', body);
      console.log('[P4] delete', JSON.stringify(body), '→', r.status, r.text.slice(0, 200));
    }
  } finally { await up.close(); }
});
