// r125 探路脚本(不是验收判据):把当前实例/界面里跟本轮有关的事实如实抓一份出来,给写用例用。
// 平时跳过;R125_PROBE=1 tests/acceptance/r125-provider-models/run.sh -g '探路' 才跑。
import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { req, createCustomProvider, switchProvider, getProviders, getModel, officialProviderId } from './helpers/api.mjs';
import { caseRoot, startInstance, stopAll, req as ireq } from './helpers/instance.mjs';
import { boot, openImagePanel, openNewImageProviderForm, imagePanel, openProviderManager } from './helpers/ui.mjs';

test.skip(process.env.R125_PROBE !== '1', '探路脚本只在 R125_PROBE=1 时跑');
const dump = (label, obj) => console.log(`\n##### ${label}\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)}`);
const brief = (p) => p && Object.fromEntries(Object.entries(p).filter(([k]) => !/key|token|secret/i.test(k)).map(([k, v]) => [k, typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}…` : v]));

test('探路 P1 既有接口形态:providers / custom-providers / switch / provider-models / model / fetch-models / image-providers', async () => {
  const p0 = await getProviders();
  dump('GET /api/providers status+keys', { status: p0.status, keys: Object.keys(p0.json || {}) });
  dump('providers[] (id/name/type/category/isCurrent…)', (p0.json?.providers ?? []).map((p) => ({ id: p.id, name: p.name, type: p.type, category: p.category, appType: p.appType, format: p.format, isCurrent: p.isCurrent, source: p.source, imported: p.imported, keys: Object.keys(p) })));
  dump('openaiProviders[]', (p0.json?.openaiProviders ?? []).map(brief));
  dump('customProviders[]', (p0.json?.customProviders ?? []).map(brief));
  dump('overrides', p0.json?.overrides);
  dump('其它顶层字段', Object.fromEntries(Object.entries(p0.json || {}).filter(([k]) => !['providers', 'openaiProviders', 'customProviders', 'overrides'].includes(k))));

  const cp = await req('GET', '/api/custom-providers');
  dump('GET /api/custom-providers', { status: cp.status, body: cp.text.slice(0, 600) });

  const created = await createCustomProvider({ name: 'r125 探路自定义' });
  dump('POST /api/custom-providers 回显', brief(created));
  const p1 = await getProviders();
  dump('建完后 customProviders[]', (p1.json?.customProviders ?? []).map(brief));

  const sw = await req('POST', '/api/provider/switch', { id: created.id });
  dump('POST /api/provider/switch {id:自定义}', { status: sw.status, body: sw.text.slice(0, 400) });
  const m1 = await getModel();
  dump('切到自定义后 GET /api/model', { status: m1.status, body: m1.text.slice(0, 800) });
  const p2 = await getProviders();
  dump('切到自定义后 isCurrent 分布', { providers: (p2.json?.providers ?? []).filter((p) => p.isCurrent).map((p) => p.id), custom: (p2.json?.customProviders ?? []).filter((p) => p.isCurrent).map((p) => p.id) });

  const fm1 = await req('POST', '/api/provider/fetch-models', {});
  dump('POST /api/provider/fetch-models {}(当前=自定义,基址回环无人听)', { status: fm1.status, body: fm1.text.slice(0, 500) });

  const putCp = await req('PUT', `/api/custom-providers/${created.id}`, { name: created.name, type: created.type, baseURL: created.baseURL, models: ['r125-old-a', 'r125-new-x'] });
  dump('PUT /api/custom-providers/:id {name,type,baseURL,models}', { status: putCp.status, body: putCp.text.slice(0, 400) });
  const p3 = await getProviders();
  dump('PUT 后该自定义 models', (p3.json?.customProviders ?? []).find((p) => p.id === created.id)?.models);
  const m2 = await getModel();
  dump('PUT 后 GET /api/model', { status: m2.status, body: m2.text.slice(0, 800) });

  const off = await officialProviderId();
  dump('官方 provider id(既有口径)', off);
  const pm0 = await req('GET', '/api/provider-models');
  dump('GET /api/provider-models', { status: pm0.status, body: pm0.text.slice(0, 400) });
  const pmPut = await req('PUT', `/api/provider-models/${off}`, { models: ['r125-sel-1', 'r125-sel-2'] });
  dump(`PUT /api/provider-models/${off}`, { status: pmPut.status, body: pmPut.text.slice(0, 400) });
  const pm1 = await req('GET', '/api/provider-models');
  dump('PUT 后 GET /api/provider-models', { status: pm1.status, body: pm1.text.slice(0, 400) });

  const swb = await req('POST', '/api/provider/switch', { id: off });
  dump('切回官方', { status: swb.status, body: swb.text.slice(0, 300) });
  const m3 = await getModel();
  dump('官方 + provider-models 有选择时 GET /api/model', { status: m3.status, body: m3.text.slice(0, 1200) });
  const fm2 = await req('POST', '/api/provider/fetch-models', {});
  dump('POST /api/provider/fetch-models {}(当前=官方,断外网)', { status: fm2.status, body: fm2.text.slice(0, 500) });
  const pmClr = await req('PUT', `/api/provider-models/${off}`, { models: [] });
  dump('PUT provider-models 空数组', { status: pmClr.status, body: pmClr.text.slice(0, 300) });
  const m4 = await getModel();
  dump('清掉选择后 GET /api/model', { status: m4.status, body: m4.text.slice(0, 1200) });

  const ip0 = await req('GET', '/api/image-providers');
  dump('GET /api/image-providers', { status: ip0.status, body: ip0.text.slice(0, 400) });
  const ipc = await req('POST', '/api/image-providers', { name: 'r125 探路生图', protocol: 'openai', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-r125-x', model: 'img-a', models: ['img-a', 'img-b'], size: '1024x1024' });
  dump('POST /api/image-providers(带 models)', { status: ipc.status, body: ipc.text.slice(0, 600) });
  const ip1 = await req('GET', '/api/image-providers');
  dump('建完后 GET /api/image-providers', { status: ip1.status, body: ip1.text.slice(0, 800) });
  const ifm = await req('POST', '/api/image-providers/fetch-models', { id: ipc.json?.id, baseURL: 'http://127.0.0.1:9/v1', protocol: 'openai' });
  dump('POST /api/image-providers/fetch-models(回环无人听)', { status: ifm.status, body: ifm.text.slice(0, 400) });
});

test('探路 P1b 自起实例 + 文件访问记录:cc-switch 数据库这条路径怎么来的;启动时想出网去哪', async () => {
  const h = await startInstance(caseRoot('probe-fstrace'), {}, { label: 'probe', fsTrace: true });
  try {
    await ireq(h.base, 'GET', '/api/providers');
    await new Promise((r) => setTimeout(r, 800));
    dump('fs 访问记录(匹配 cc-switch|.db|sqlite)', h.trace());
    dump('被断外网预载拒掉的目标', [...new Set(h.blocked())]);
    dump('实例日志尾 40 行', h.log().split('\n').slice(-40).join('\n'));
    // 半写 json:custom-providers.json 截断后 GET /api/providers 会怎样
    const f = path.join(h.home, '.claude-gui', 'custom-providers.json');
    fs.writeFileSync(f, '[{"id":"half","name":"半写"');
    const r = await ireq(h.base, 'GET', '/api/providers');
    dump('custom-providers.json 半写时 GET /api/providers', { status: r.status, body: r.text.slice(0, 400) });
    fs.unlinkSync(f);
    // active-provider.json 半写
    const a = path.join(h.home, '.claude-gui', 'active-provider.json');
    fs.writeFileSync(a, '{"id":"x"');
    const r2 = await ireq(h.base, 'GET', '/api/providers');
    dump('active-provider.json 半写时 GET /api/providers', { status: r2.status, body: r2.text.slice(0, 400) });
    fs.unlinkSync(a);
    // provider-models.json 半写
    const pmf = path.join(h.home, '.claude-gui', 'provider-models.json');
    fs.writeFileSync(pmf, '{"x":[');
    const r3 = await ireq(h.base, 'GET', '/api/providers');
    dump('provider-models.json 半写时 GET /api/providers', { status: r3.status, body: r3.text.slice(0, 400) });
    const r3b = await ireq(h.base, 'GET', '/api/model');
    dump('provider-models.json 半写时 GET /api/model', { status: r3b.status, body: r3b.text.slice(0, 400) });
    fs.unlinkSync(pmf);
    dump('fs 访问记录(全部,含半写探测后)', h.trace());
  } finally { await stopAll(); }
});

async function snapshot(page, scope = 'body') {
  return page.evaluate((scope) => {
    const root = document.querySelector(scope) || document.body;
    const vis = (el) => !!el.getClientRects().length;
    const buttons = [...root.querySelectorAll('button, [role="button"]')].filter(vis).map((b) => ({
      text: (b.innerText || '').trim().slice(0, 60), title: b.getAttribute('title'), aria: b.getAttribute('aria-label'), disabled: b.disabled, testid: b.getAttribute('data-testid'),
    }));
    const inputs = [...root.querySelectorAll('input, textarea, select')].filter(vis).map((i) => ({
      tag: i.tagName, type: i.type, placeholder: i.placeholder, aria: i.getAttribute('aria-label'), value: (i.value || '').slice(0, 60), testid: i.getAttribute('data-testid'), checked: i.checked, disabled: i.disabled,
      options: i.tagName === 'SELECT' ? [...i.options].map((o) => o.value).slice(0, 30) : undefined,
    }));
    const testids = [...root.querySelectorAll('[data-testid]')].filter(vis).map((el) => el.getAttribute('data-testid'));
    return { text: (root.innerText || '').slice(0, 5000), buttons, inputs, testids: [...new Set(testids)] };
  }, scope);
}

/** 弹窗/浮层里 checkbox 的形态(带 label 文本、是否 disabled、周边是否有「已添加」)。 */
async function checkboxFacts(page) {
  return page.evaluate(() => {
    const vis = (el) => !!el.getClientRects().length;
    return [...document.querySelectorAll('input[type=checkbox]')].filter(vis).map((c) => {
      const row = c.closest('label, li, [role=option], [role=row], div');
      return { checked: c.checked, disabled: c.disabled, rowText: (row?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80), rowTestid: row?.getAttribute?.('data-testid'), rowModelId: row?.getAttribute?.('data-model-id') };
    });
  });
}

test('探路 P2 界面:顶栏按钮 / provider 按钮 / 模型按钮页 / 「拉取最新」弹窗形态', async ({ page }) => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server');
  const seen = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) seen.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}${r.postData() ? ' body=' + r.postData().slice(0, 200) : ''}`); });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
  // 先把当前 provider 切成自定义(探路 P1 建的那条若在就用;否则新建)
  const p0 = await getProviders();
  let custom = (p0.json?.customProviders ?? []).find((p) => /r125 探路自定义/.test(p.name)) || await createCustomProvider({ name: 'r125 探路自定义' });
  await switchProvider(custom.id);
  await boot(page);
  await page.waitForTimeout(800);
  const all = await page.evaluate(() => [...document.querySelectorAll('button')].filter((el) => el.getClientRects().length).map((el) => {
    const r = el.getBoundingClientRect();
    return { text: (el.innerText || '').trim().slice(0, 30), title: el.getAttribute('title'), aria: el.getAttribute('aria-label'), testid: el.getAttribute('data-testid'), x: Math.round(r.x), y: Math.round(r.y) };
  }).filter((b) => b.text || b.title || b.aria));
  dump('全部可见按钮(含坐标)', all);
  dump('启动期间 /api 请求', seen.slice());

  // provider 按钮:标题/文字含 provider 或当前 provider 名
  const provBtn = page.locator('button').filter({ hasText: new RegExp(custom.name.slice(0, 8)) }).first();
  const provBtn2 = page.locator('button[title*="provider" i], button[title*="Provider"], button[aria-label*="provider" i]').first();
  dump('provider 按钮候选数(按名字 / 按 title)', [await provBtn.count(), await provBtn2.count()]);
  const target = (await provBtn.count()) ? provBtn : provBtn2;
  if (await target.count()) {
    seen.length = 0;
    await target.click({ force: true });
    await page.waitForTimeout(1200);
    const s = await snapshot(page);
    dump('点 provider 按钮后·请求', seen.slice());
    dump('点 provider 按钮后·testids', s.testids);
    dump('点 provider 按钮后·按钮', s.buttons.slice(0, 80));
    // 浮层 html(找含 provider 名的最近容器)
    const html = await page.evaluate((name) => {
      const leaf = [...document.querySelectorAll('*')].filter((el) => el.getClientRects().length && !el.children.length && (el.textContent || '').includes(name));
      const el = leaf[leaf.length - 1];
      let host = el; for (let i = 0; i < 6 && host?.parentElement; i += 1) host = host.parentElement;
      return host ? host.outerHTML.replace(/\s+/g, ' ').replace(/class="[^"]*"/g, '').slice(0, 4000) : '(没找到)';
    }, custom.name);
    dump('provider 浮层 html(去 class)', html);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // 模型按钮:title 含 模型/model
  const modelBtn = page.locator('button[title*="模型"], button[aria-label*="模型"], button[title*="model" i]').first();
  dump('模型按钮候选数', await modelBtn.count());
  dump('模型按钮候选 title', await page.locator('button[title*="模型"], button[aria-label*="模型"], button[title*="model" i]').evaluateAll((els) => els.map((e) => ({ t: e.getAttribute('title'), a: e.getAttribute('aria-label'), text: (e.innerText || '').trim().slice(0, 30) }))));
  if (await modelBtn.count()) {
    seen.length = 0;
    await modelBtn.click({ force: true });
    await page.waitForTimeout(1200);
    const s = await snapshot(page);
    dump('点模型按钮后·请求', seen.slice());
    dump('点模型按钮后·testids', s.testids);
    dump('点模型按钮后·按钮', s.buttons.filter((b) => /拉取|最新|模型|添加|确认|取消|全选|自定义/.test(`${b.text} ${b.title}`)));
    dump('点模型按钮后·输入框', s.inputs);
    const fetchBtn = page.locator('button').filter({ hasText: /拉取最新/ }).first();
    dump('「拉取最新」按钮数', await fetchBtn.count());
    if (await fetchBtn.count()) {
      // 拦截目录:含已选 r125-old-a 与新候选
      await page.route((url) => url.pathname === '/api/provider/fetch-models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: ['r125-old-a', 'r125-old-b', 'r125-new-c', 'r125-new-d', 'zz-other'] }) }));
      seen.length = 0;
      await fetchBtn.click({ force: true });
      await page.waitForTimeout(1500);
      dump('点「拉取最新」后·请求', seen.slice());
      const s2 = await snapshot(page);
      dump('点「拉取最新」后·testids', s2.testids);
      dump('点「拉取最新」后·checkbox', await checkboxFacts(page));
      dump('点「拉取最新」后·按钮', s2.buttons.filter((b) => /拉取|最新|模型|添加|确认|取消|全选|全不选|关闭|完成|保存|应用/.test(`${b.text} ${b.title}`)));
      dump('点「拉取最新」后·输入框', s2.inputs.filter((i) => i.tag !== 'SELECT'));
      // 弹窗 html
      const html = await page.evaluate(() => {
        const cb = [...document.querySelectorAll('input[type=checkbox]')].filter((el) => el.getClientRects().length)[0];
        let host = cb; for (let i = 0; i < 8 && host?.parentElement; i += 1) host = host.parentElement;
        return host ? host.outerHTML.replace(/\s+/g, ' ').replace(/class="[^"]*"/g, '').slice(0, 5000) : '(没有可见 checkbox)';
      });
      dump('弹窗 html(去 class)', html);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      // 模型下拉列表怎么呈现:重新打开模型页,列出所有可见的模型候选文本
      const s3 = await snapshot(page);
      dump('Esc 后·testids', s3.testids);
      dump('Esc 后·文本', s3.text.slice(0, 1500));
    }
    await page.keyboard.press('Escape');
  }
});

test('探路 P3 界面:生图 provider 表单「拉取模型」弹窗形态 / Provider 管理弹窗里的编辑表单', async ({ page }) => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server');
  const seen = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) seen.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}${r.postData() ? ' body=' + r.postData().slice(0, 200) : ''}`); });
  await boot(page);
  await openImagePanel(page);
  await openNewImageProviderForm(page);
  const s0 = await snapshot(page, '[data-cgui-panel]');
  dump('生图表单·按钮', s0.buttons);
  dump('生图表单·输入框', s0.inputs);
  await page.route((url) => url.pathname === '/api/image-providers/fetch-models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, models: ['img-a', 'img-b', 'img-new-c', 'zz-img'] }) }));
  const btn = imagePanel(page).locator('button').filter({ hasText: /拉取模型/ }).first();
  dump('「拉取模型」按钮数', await btn.count());
  if (await btn.count()) {
    await imagePanel(page).getByPlaceholder('https://api.example.com/v1').first().fill('http://127.0.0.1:9/v1');
    await imagePanel(page).getByPlaceholder('gpt-image-2').first().fill('img-a');
    seen.length = 0;
    await btn.click({ force: true });
    await page.waitForTimeout(1500);
    dump('点「拉取模型」后·请求', seen.slice());
    const s = await snapshot(page);
    dump('点「拉取模型」后·testids', s.testids);
    dump('点「拉取模型」后·checkbox', await checkboxFacts(page));
    dump('点「拉取模型」后·按钮', s.buttons.filter((b) => /拉取|模型|添加|确认|取消|全选|全不选|关闭|完成|保存|应用/.test(`${b.text} ${b.title}`)));
    const html = await page.evaluate(() => {
      const cb = [...document.querySelectorAll('input[type=checkbox]')].filter((el) => el.getClientRects().length)[0];
      let host = cb; for (let i = 0; i < 8 && host?.parentElement; i += 1) host = host.parentElement;
      return host ? host.outerHTML.replace(/\s+/g, ' ').replace(/class="[^"]*"/g, '').slice(0, 5000) : '(没有可见 checkbox)';
    });
    dump('生图弹窗 html(去 class)', html);
    await page.keyboard.press('Escape');
  }
  // 生图表单里"已保存的 provider 编辑态":模型字段长什么样(models 数组怎么呈现)
  await page.keyboard.press('Escape');
  const s1 = await snapshot(page, '[data-cgui-panel]');
  dump('生图面板(表单外)·文本', s1.text.slice(0, 1500));

  // Provider 管理弹窗
  const mgr = await openProviderManager(page).catch((e) => { dump('provider manager 打不开', String(e).slice(0, 200)); return null; });
  if (mgr) {
    const s2 = await snapshot(page, '[data-testid="provider-manager"]');
    dump('Provider 管理弹窗·testids', s2.testids);
    dump('Provider 管理弹窗·按钮', s2.buttons.slice(0, 60));
    dump('Provider 管理弹窗·文本', s2.text.slice(0, 2000));
    await page.keyboard.press('Escape');
  }
});
