// r125 探路脚本第二批(不是验收判据):cc-switch 路径(加宽记录 + 种损坏文件)/ 生图 provider 编辑入口 /
// 模型页行的呈现 / 确认后的写回请求 / 官方 provider 点「拉取最新」的现状。
// 平时跳过;R125_PROBE=1 tests/acceptance/r125-provider-models/run.sh -g '探路' 才跑。
import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { req, createCustomProvider, createImageProvider, switchProvider, getProviders, getModel } from './helpers/api.mjs';
import { caseRoot, startInstance, stopAll, req as ireq } from './helpers/instance.mjs';
import { boot, reloadApp, openImagePanel, imagePanel } from './helpers/ui.mjs';

test.skip(process.env.R125_PROBE !== '1', '探路脚本只在 R125_PROBE=1 时跑');
const dump = (label, obj) => console.log(`\n##### ${label}\n${typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)}`);

async function checkboxFacts(page) {
  return page.evaluate(() => {
    const vis = (el) => !!el.getClientRects().length;
    return [...document.querySelectorAll('input[type=checkbox]')].filter(vis).map((c) => {
      const row = c.closest('label, li, [role=option], [role=row], div');
      return { checked: c.checked, disabled: c.disabled, rowText: (row?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) };
    });
  });
}
/** 含某按钮文字的最近容器往上 n 层的 html(去 class / svg)。 */
const htmlAround = (page, buttonText, up = 4, max = 6000) => page.evaluate(([t, up, max]) => {
  const b = [...document.querySelectorAll('button')].find((el) => el.getClientRects().length && (el.innerText || '').trim() === t);
  if (!b) return `(没有文字为 ${t} 的按钮)`;
  let host = b; for (let i = 0; i < up && host?.parentElement; i += 1) host = host.parentElement;
  return host.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').replace(/class="[^"]*"/g, '').slice(0, max);
}, [buttonText, up, max]);
const visibleText = (page) => page.evaluate(() => (document.body.innerText || '').replace(/\n{2,}/g, '\n'));

test('探路 P1c 加宽记录:隔离 HOME 下全部路径 / 子进程 / sqlite 模块;再种损坏的 cc-switch 库看 /api/providers', async () => {
  const cr = caseRoot('probe-fstrace2');
  const h = await startInstance(cr, { R125_FS_TRACE_MATCH: `^${cr.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|cc-switch|ccswitch|cc_switch|sqlite|\\.db$`, R125_FS_TRACE_ALL_CHILD: '1' }, { label: 'probe2', fsTrace: true });
  try {
    const r0 = await ireq(h.base, 'GET', '/api/providers');
    dump('基线 GET /api/providers', { status: r0.status, body: r0.text.slice(0, 300) });
    await new Promise((r) => setTimeout(r, 500));
    dump('记录(启动 + 一次 /api/providers)', h.trace());
    // 种损坏文件到两个常见位置
    const cands = [
      path.join(h.home, '.cc-switch', 'cc-switch.db'),
      path.join(h.home, 'Library', 'Application Support', 'cc-switch', 'cc-switch.db'),
      path.join(h.home, '.cc-switch', 'config.json'),
    ];
    for (const f of cands) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, f.endsWith('.json') ? '{"providers":{"claude":{' : 'THIS IS NOT A SQLITE FILE 0123456789'); }
    const r1 = await ireq(h.base, 'GET', '/api/providers');
    dump('种损坏文件后 GET /api/providers', { status: r1.status, body: r1.text.slice(0, 600) });
    const m1 = await ireq(h.base, 'GET', '/api/model');
    dump('种损坏文件后 GET /api/model', { status: m1.status, body: m1.text.slice(0, 200) });
    await new Promise((r) => setTimeout(r, 500));
    dump('记录(种文件后)', h.trace());
    dump('实例日志里含 cc-switch/sqlite/Error 的行', h.log().split('\n').filter((l) => /cc-switch|sqlite|error|Error/i.test(l)).slice(-30));
    // 空的合法 sqlite 库(有头无表)
    for (const f of cands.filter((x) => x.endsWith('.db'))) fs.writeFileSync(f, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4080)]));
    const r2 = await ireq(h.base, 'GET', '/api/providers');
    dump('种"只有文件头"的 sqlite 后 GET /api/providers', { status: r2.status, body: r2.text.slice(0, 600) });
    await new Promise((r) => setTimeout(r, 300));
    dump('记录(最终)', h.trace());
  } finally { await stopAll(); }
});

test('探路 P4 生图 provider:已有条目的编辑入口 / 拉取模型弹窗 / 确认与保存的写回', async ({ page }) => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server');
  const seen = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) seen.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}${r.postData() ? ' body=' + r.postData().slice(0, 300) : ''}`); });
  const p = await createImageProvider({ name: 'r125 探路生图' });
  dump('POST /api/image-providers 回显', p);
  const list = await req('GET', '/api/image-providers');
  dump('GET /api/image-providers', list.text.slice(0, 800));
  await boot(page);
  await openImagePanel(page);
  const panel = imagePanel(page);
  const btns = await panel.locator('button').evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => ({ text: (e.innerText || '').trim().slice(0, 30), title: e.getAttribute('title') })));
  dump('生图面板·可见按钮', btns);
  const selects = await panel.locator('select').evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => ({ value: e.value, options: [...e.options].map((o) => ({ v: o.value.slice(0, 40), t: o.textContent.trim().slice(0, 30) })) })));
  dump('生图面板·select', selects);
  const edit = panel.locator('button[title*="编辑"]').first();
  dump('含「编辑」title 的按钮数', await edit.count());
  if (await edit.count()) {
    await edit.click({ force: true });
    await page.waitForTimeout(600);
    const inputs = await panel.locator('input, textarea').evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => ({ ph: e.placeholder, value: String(e.value || '').slice(0, 60) })));
    dump('编辑表单·输入框', inputs);
    dump('编辑表单·文本', (await panel.innerText()).slice(0, 1500));
    dump('编辑表单·模型输入框附近 html', await htmlAround(page, '拉取模型', 3, 4000));
    await page.route((url) => url.pathname === '/api/image-providers/fetch-models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, models: ['r125-img-old-a', 'r125-img-old-b', 'r125-img-new-c', 'zz-img'] }) }));
    seen.length = 0;
    await panel.locator('button').filter({ hasText: /拉取模型/ }).first().click({ force: true });
    await page.waitForTimeout(1200);
    dump('编辑态点「拉取模型」·请求', seen.slice());
    dump('编辑态点「拉取模型」·checkbox', await checkboxFacts(page));
    dump('弹窗 html', await htmlAround(page, '全不选', 5, 5000));
    // 勾一个新候选 → 确认
    const rowNew = page.locator('label, li, div').filter({ has: page.locator('input[type=checkbox]') }).filter({ hasText: /^r125-img-new-c$/ }).first();
    dump('r125-img-new-c 行数', await rowNew.count());
    await page.locator('input[type=checkbox]').nth(2).click({ force: true }).catch((e) => dump('点第三个 checkbox 失败', String(e).slice(0, 200)));
    await page.waitForTimeout(200);
    dump('勾新候选后·checkbox', await checkboxFacts(page));
    seen.length = 0;
    await page.locator('button').filter({ hasText: /^确认$/ }).first().click({ force: true });
    await page.waitForTimeout(800);
    dump('确认后·请求', seen.slice());
    dump('确认后·表单文本', (await panel.innerText()).slice(0, 1500));
    dump('确认后·输入框', await panel.locator('input, textarea').evaluateAll((els) => els.filter((e) => e.getClientRects().length).map((e) => ({ ph: e.placeholder, value: String(e.value || '').slice(0, 80) }))));
    dump('确认后·GET /api/image-providers models', (await req('GET', '/api/image-providers')).json?.providers?.find((x) => x.id === p.id)?.models);
    seen.length = 0;
    await panel.locator('button').filter({ hasText: /^保存$/ }).first().click({ force: true });
    await page.waitForTimeout(800);
    dump('保存后·请求', seen.slice());
    dump('保存后·GET /api/image-providers models', (await req('GET', '/api/image-providers')).json?.providers?.find((x) => x.id === p.id)?.models);
    // 「浏览」按钮的形态(候选列表)
    dump('保存后·面板文本', (await panel.innerText()).slice(0, 800));
  }
});

test('探路 P5 模型页(自定义 provider):行的呈现 / 确认写回 / 下拉变化 / Esc 与取消', async ({ page }) => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server');
  const seen = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) seen.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}${r.postData() ? ' body=' + r.postData().slice(0, 300) : ''}`); });
  const custom = await createCustomProvider({ name: 'r125 探路P5' });
  await switchProvider(custom.id);
  await boot(page);
  await page.locator('button[title^="模型:"]').first().click({ force: true });
  await page.waitForTimeout(800);
  dump('模型页 html(「拉取最新」往上 5 层)', await htmlAround(page, '拉取最新', 5, 7000));
  await page.route((url) => url.pathname === '/api/provider/fetch-models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, models: ['r125-old-a', 'r125-old-b', 'r125-new-c', 'r125-new-d'] }) }));
  await page.locator('button').filter({ hasText: /拉取最新/ }).first().click({ force: true });
  await page.waitForTimeout(1000);
  dump('弹窗 html(「全不选」往上 5 层)', await htmlAround(page, '全不选', 5, 7000));
  // 测 Esc 关不关
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  dump('Esc 后 checkbox 数', (await checkboxFacts(page)).length);
  dump('Esc 后 页面文本', (await visibleText(page)).slice(0, 600));
  // 重新开
  if (!(await page.locator('button').filter({ hasText: /拉取最新/ }).first().isVisible().catch(() => false))) {
    await page.locator('button[title^="模型:"]').first().click({ force: true });
    await page.waitForTimeout(600);
  }
  await page.locator('button').filter({ hasText: /拉取最新/ }).first().click({ force: true });
  await page.waitForTimeout(1000);
  // 勾 new-c → 确认
  await page.locator('input[type=checkbox]').nth(2).click({ force: true });
  await page.waitForTimeout(200);
  dump('勾 new-c 后·checkbox', await checkboxFacts(page));
  dump('勾 new-c 后·确认 disabled?', await page.locator('button').filter({ hasText: /^确认$/ }).first().isDisabled());
  seen.length = 0;
  await page.locator('button').filter({ hasText: /^确认$/ }).first().click({ force: true });
  await page.waitForTimeout(1200);
  dump('确认后·请求', seen.slice());
  dump('确认后·GET /api/providers custom models', (await getProviders()).json?.customProviders?.find((x) => x.id === custom.id)?.models);
  dump('确认后·GET /api/model', (await getModel()).text.slice(0, 600));
  dump('确认后·页面文本', (await visibleText(page)).slice(0, 900));
  dump('确认后·模型页 html', await htmlAround(page, '拉取最新', 5, 7000));
  // 自定义模型 ID 输入框:手动添加一个
  const custIn = page.getByPlaceholder('自定义模型 ID...').first();
  if (await custIn.count()) {
    await custIn.fill('r125-manual-z');
    await custIn.press('Enter');
    await page.waitForTimeout(800);
    dump('手动添加后·请求', seen.slice(-6));
    dump('手动添加后·页面文本', (await visibleText(page)).slice(0, 900));
    dump('手动添加后·GET /api/model', (await getModel()).text.slice(0, 700));
    dump('手动添加后·GET /api/providers custom models', (await getProviders()).json?.customProviders?.find((x) => x.id === custom.id)?.models);
  }
});

test('探路 P6 模型页(官方 provider):行的呈现 / 点「拉取最新」现状 / 下拉变化', async ({ page }) => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server');
  const seen = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) seen.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}${r.postData() ? ' body=' + r.postData().slice(0, 300) : ''}`); });
  await switchProvider('builtin-official');
  await boot(page);
  dump('启动后 GET /api/model', (await getModel()).text.slice(0, 900));
  await page.locator('button[title^="模型:"]').first().click({ force: true });
  await page.waitForTimeout(800);
  dump('官方·模型页文本', (await visibleText(page)).slice(0, 1200));
  dump('官方·模型页 html', await htmlAround(page, '拉取最新', 5, 7000));
  await page.route((url) => url.pathname === '/api/provider/fetch-models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, models: ['claude-sonnet-4-6', 'opus', 'r125-off-new-1', 'r125-off-new-2'], source: 'official-cli', status: 'available', note: '探路桩' }) }));
  seen.length = 0;
  await page.locator('button').filter({ hasText: /拉取最新/ }).first().click({ force: true });
  await page.waitForTimeout(1500);
  dump('官方·点「拉取最新」后·请求', seen.slice());
  dump('官方·点「拉取最新」后·checkbox 数', (await checkboxFacts(page)).length);
  dump('官方·点「拉取最新」后·页面文本', (await visibleText(page)).slice(0, 1400));
  dump('官方·点「拉取最新」后·GET /api/model', (await getModel()).text.slice(0, 900));
  // 失败形态:拉取返回 ok:false
  await page.unroute((url) => url.pathname === '/api/provider/fetch-models');
  await page.route((url) => url.pathname === '/api/provider/fetch-models', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, models: [], status: 'unavailable', note: '探路:上游不可用' }) }));
  await page.locator('button').filter({ hasText: /拉取最新/ }).first().click({ force: true });
  await page.waitForTimeout(1200);
  dump('官方·拉取失败后·页面文本', (await visibleText(page)).slice(0, 1400));
  await page.unroute((url) => url.pathname === '/api/provider/fetch-models');
  await page.route((url) => url.pathname === '/api/provider/fetch-models', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '探路 500' }) }));
  await page.locator('button').filter({ hasText: /拉取最新/ }).first().click({ force: true });
  await page.waitForTimeout(1200);
  dump('官方·拉取 500 后·页面文本', (await visibleText(page)).slice(0, 1400));
});

test('探路 P7 provider 浮层:行的 html / 快速连点 10 次的请求数 / 500 时列表怎样', async ({ page }) => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server');
  const seen = [];
  page.on('request', (r) => { if (r.url().includes('/api/providers')) seen.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
  await boot(page);
  const provBtn = page.locator('button[title^="Provider:"]').first();
  await provBtn.click({ force: true });
  await page.waitForTimeout(900);
  dump('provider 浮层 html(「管理 Provider」按钮往上 4 层)', await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.getClientRects().length && /管理 Provider/.test(el.innerText || ''));
    if (!b) return '(没找到)';
    let host = b; for (let i = 0; i < 4 && host?.parentElement; i += 1) host = host.parentElement;
    return host.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').replace(/class="[^"]*"/g, '').slice(0, 6000);
  }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  dump('Esc 后浮层还在?', await page.locator('button').filter({ hasText: /管理 Provider/ }).count());
  // 快速连点 10 次
  seen.length = 0;
  for (let i = 0; i < 10; i += 1) { await provBtn.click({ force: true }); await page.waitForTimeout(60); }
  await page.waitForTimeout(1500);
  dump('连点 10 次·/api/providers 请求数', seen.length);
  dump('连点后浮层开着?', await page.locator('button').filter({ hasText: /管理 Provider/ }).count());
  dump('连点后页面文本', (await visibleText(page)).slice(0, 800));
  // 让 /api/providers 500,再开浮层
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.route((url) => url.pathname === '/api/providers', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'r125 探路 500' }) }));
  await provBtn.click({ force: true });
  await page.waitForTimeout(1200);
  dump('500 时浮层文本', (await visibleText(page)).slice(0, 900));
  dump('500 时浮层 html', await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((el) => el.getClientRects().length && /管理 Provider/.test(el.innerText || ''));
    if (!b) return '(没找到「管理 Provider」)';
    let host = b; for (let i = 0; i < 4 && host?.parentElement; i += 1) host = host.parentElement;
    return host.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/\s+/g, ' ').replace(/class="[^"]*"/g, '').slice(0, 3000);
  }));
});
