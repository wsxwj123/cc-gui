// r125 · D 组:Provider 列表健壮性(INTERFACE §D D1–D4 / BRIEF P3)。
// 依据只有 .devflow/BRIEF-r125.md 与 .devflow/INTERFACE-r125.md;没看实现代码。
//   D1 / D2 在共享隔离实例的界面上做:失败用浏览器层请求拦截(500 / {} / 超时),请求数用拦截计数。
//   D3 / D4 各自起全新 HOME 的隔离实例(接口层),不碰共享实例;D4 另有一条在界面上边并发打接口边连点的观察。
// 锚点:INTERFACE §D 的 data-testid 优先(provider-switch-list / [data-provider-id] / provider-list-error);
//   当前代码没有 → 列表根与行兜底为探路实测的既有形态(见 helpers/ui.mjs);错误行没有兜底(今天就没有)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createCustomProvider, getProviders } from './helpers/api.mjs';
import { caseRoot, startInstance, stopAll, req } from './helpers/instance.mjs';
import { boot, providerButton, openProviderList, closeProviderList, switchListAny, switchRowsAny, listError, switchList } from './helpers/ui.mjs';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const OFFICIAL = 'builtin-official';

// ═══════════════════════════ D1 失败保留旧列表(界面) ═══════════════════════════
const FAILURES = {
  '500': (route) => route.fulfill({ status: 500, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ error: 'r125 桩 500' }) }),
  '空对象': (route) => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: '{}' }),
  '超时': async (route) => { await settle(1500); await route.abort('timedout'); },   // 拖 1.5s 后按"超时"中断(浏览器侧拿到网络错误)
};

test.describe('D1 失败保留旧列表', () => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server(R125_API_ONLY=1)');

  /** 进应用 → 开列表记下 N(≥2:官方 + 用例自建的自定义)→ 关列表 → 装失败拦截 → 再开列表。返回 { n, release }。 */
  async function showThenBreak(page, kind) {
    await createCustomProvider();
    await boot(page);
    await openProviderList(page);
    await expect.poll(() => switchRowsAny(page).count(), { message: '前提:列表至少显示官方 + 自定义两行' }).toBeGreaterThanOrEqual(2);
    const n = await switchRowsAny(page).count();
    console.log(`[r125] D1 列表锚点路径:${(await switchList(page).count()) ? 'INTERFACE data-testid' : '既有形态兜底'};N=${n}`);
    await closeProviderList(page);
    let failing = true;
    await page.route((url) => url.pathname === '/api/providers', async (route) => { if (!failing) { await route.fallback(); return; } await FAILURES[kind](route); });
    await openProviderList(page);
    await settle(kind === '超时' ? 3000 : 1200);
    return { n, release: () => { failing = false; } };
  }

  for (const kind of Object.keys(FAILURES)) {
    test(`D1-${kind}-1 列表已显示 N 行 → 下一次 /api/providers ${kind} → 再开列表仍显示 N 行(不清空)`, async ({ page }) => {
      const { n } = await showThenBreak(page, kind);
      await expect(switchRowsAny(page), `加载失败(${kind})时应保留上一次成功的 ${n} 行`).toHaveCount(n);
    });

    test(`D1-${kind}-2 /api/providers ${kind} → 列表区出现错误行 provider-list-error,内含「重试」`, async ({ page }) => {
      await showThenBreak(page, kind);
      await expect(listError(page), `加载失败(${kind})时应显示一行可见的错误说明`).toBeVisible();
      await expect(listError(page).getByRole('button', { name: /重试/ }), '错误行里应有「重试」').toBeVisible();
    });
  }

  test('D1-重试 解除拦截后点「重试」→ 错误行消失,列表仍是 N 行', async ({ page }) => {
    const { n, release } = await showThenBreak(page, '500');
    await expect(listError(page), '前提:出现错误行').toBeVisible();
    release();
    await listError(page).getByRole('button', { name: /重试/ }).click({ force: true });
    await expect(listError(page), '重试成功后错误行应消失').toHaveCount(0, { timeout: 10_000 });
    await expect(switchRowsAny(page)).toHaveCount(n);
  });
});

// ═══════════════════════════ D2 反复点击不堆积(界面) ═══════════════════════════
test.describe('D2 反复点击不堆积', () => {
  test.skip(!process.env.R125_UI_BASE, '没有 dev server(R125_API_ONLY=1)');

  test('D2 连续快速点击 provider 按钮 10 次 → 期间 /api/providers 请求数 ≤ 2,列表始终非空', async ({ page }) => {
    await createCustomProvider();
    await boot(page);
    // 让 /api/providers 慢 700ms(模拟慢服务端;返回体不改),让"在途"这个状态可观察;从第一次点击前开始计数
    let counting = false; let count = 0;
    await page.route((url) => url.pathname === '/api/providers', async (route) => { if (counting) count += 1; await settle(700); await route.continue(); });
    const samples = [];
    counting = true;
    for (let i = 0; i < 10; i += 1) {
      await providerButton(page).click({ force: true });
      await settle(80);
      if (await switchListAny(page).isVisible().catch(() => false)) samples.push(await switchRowsAny(page).count());
    }
    await settle(3000);
    counting = false;
    console.log(`[r125] D2 10 次连点期间 /api/providers 请求数 = ${count};列表可见时的行数采样 = ${JSON.stringify(samples)}`);
    expect(count, '10 次连点期间同一时刻最多一个在途请求,总数应 ≤ 2').toBeLessThanOrEqual(2);
    expect(samples.filter((s) => s === 0), '列表可见时任何一次采样都不该是 0 行').toEqual([]);
    if (!(await switchListAny(page).isVisible().catch(() => false))) await providerButton(page).click({ force: true });
    await expect(switchListAny(page)).toBeVisible();
    await expect.poll(() => switchRowsAny(page).count(), { message: '连点结束后列表应非空' }).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════ D3 服务端降级(接口,自起实例) ═══════════════════════════
test.describe('D3 服务端降级', () => {
  test.afterEach(async () => { await stopAll(); });

  /** cc-switch 数据库的两个常见位置(探路实测:隔离实例从不访问任何 cc-switch 路径,两处都种上、以防路径不同)。 */
  const dbCandidates = (home) => [
    path.join(home, '.cc-switch', 'cc-switch.db'),
    path.join(home, 'Library', 'Application Support', 'cc-switch', 'cc-switch.db'),
  ];
  async function bootWith(slug, { corrupt }) {
    const cr = caseRoot(slug);
    if (corrupt) for (const f of dbCandidates(cr.home)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'THIS IS NOT A SQLITE FILE — r125 corrupted fixture\n'); }
    const h = await startInstance(cr, {}, { label: slug });
    const c = await createCustomProvider({ name: `r125 D3 ${slug}` }, h.base);
    const r = await req(h.base, 'GET', '/api/providers');
    console.log(`[r125] D3(${slug}) status=${r.status} warning=${JSON.stringify(r.json?.warning ?? null)} providers=${(r.json?.providers ?? []).map((p) => p.id).join(',')} custom=${(r.json?.customProviders ?? []).length}`);
    return { h, c, r };
  }

  test('D3-a-1 cc-switch 库不存在(全新隔离 HOME):GET /api/providers 仍 200,providers 含内置官方,customProviders 含已配置的自定义项', async () => {
    const { c, r } = await bootWith('d3a-missing', { corrupt: false });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect((r.json?.providers ?? []).map((p) => p.id), 'providers 应含内置官方').toContain(OFFICIAL);
    expect((r.json?.customProviders ?? []).map((p) => p.id), 'customProviders 应含刚配置的自定义项').toContain(c.id);
  });

  test('D3-a-2 cc-switch 库不存在:返回体带非空 warning 说明哪部分没读到', async () => {
    const { r } = await bootWith('d3a-warning', { corrupt: false });
    expect(r.status).toBe(200);
    expect(typeof r.json?.warning === 'string' && r.json.warning.trim().length > 0, `应带非空 warning,实际:${JSON.stringify(r.json?.warning ?? null)}`).toBe(true);
  });

  test('D3-b-1 cc-switch 库文件损坏(两处常见路径都种上垃圾字节):GET /api/providers 仍 200,含内置官方与自定义项,不是整体 500', async () => {
    const { c, r } = await bootWith('d3b-corrupt', { corrupt: true });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect((r.json?.providers ?? []).map((p) => p.id)).toContain(OFFICIAL);
    expect((r.json?.customProviders ?? []).map((p) => p.id)).toContain(c.id);
  });

  test('D3-b-2 cc-switch 库文件损坏:返回体带非空 warning', async () => {
    const { r } = await bootWith('d3b-warning', { corrupt: true });
    expect(r.status).toBe(200);
    expect(typeof r.json?.warning === 'string' && r.json.warning.trim().length > 0, `应带非空 warning,实际:${JSON.stringify(r.json?.warning ?? null)}`).toBe(true);
  });
});

// ═══════════════════════════ D4 复现"反复点击后列表消失"(接口 + 界面观察;P3-4 回归) ═══════════════════════════
const isBadList = (r) => r.status !== 200 || !Array.isArray(r.json?.providers) || !Array.isArray(r.json?.customProviders);
async function hammer(base, { lanes = 20, rounds = 5 }) {
  const bad = [];
  for (let k = 0; k < rounds; k += 1) {
    const rs = await Promise.all(Array.from({ length: lanes }, () => req(base, 'GET', '/api/providers').catch((e) => ({ status: 0, text: String(e), json: null }))));
    for (const r of rs) if (isBadList(r)) bad.push({ status: r.status, body: (r.text || '').slice(0, 160) });
  }
  return bad;
}

test.describe('D4 反复点击后列表消失的复现与回归', () => {
  test.afterEach(async () => { await stopAll(); });

  test('D4-1 回归:20 路并发 GET /api/providers × 5 轮,每一次都是 200 且 providers / customProviders 为数组', async () => {
    const h = await startInstance(caseRoot('d4-concurrent'), {}, { label: 'd4-1' });
    await createCustomProvider({}, h.base);
    const bad = await hammer(h.base, { lanes: 20, rounds: 5 });
    console.log(`[r125] D4-1 并发 20×5:异常返回 ${bad.length} 次 ${JSON.stringify(bad.slice(0, 3))}`);
    expect(bad, '并发读取不该出现非 200 / 非数组返回').toEqual([]);
  });

  test('D4-2 回归:并发读的同时反复写 custom-providers(模拟编辑 / 切换期间读)→ 读到的永远是完整列表', async () => {
    const h = await startInstance(caseRoot('d4-readwrite'), {}, { label: 'd4-2' });
    const c = await createCustomProvider({ name: 'r125 D4 写' }, h.base);
    const writer = (async () => { for (let i = 0; i < 30; i += 1) await req(h.base, 'PUT', `/api/custom-providers/${c.id}`, { name: `r125 D4 写 ${i}`, type: 'openai', baseURL: 'http://127.0.0.1:9/v1', models: ['m1', `m${i}`] }); })();
    const bad = await hammer(h.base, { lanes: 20, rounds: 6 });
    await writer;
    console.log(`[r125] D4-2 边写边读:异常返回 ${bad.length} 次 ${JSON.stringify(bad.slice(0, 3))}`);
    expect(bad).toEqual([]);
    const after = await req(h.base, 'GET', '/api/providers');
    expect((after.json?.customProviders ?? []).map((p) => p.id), '写完之后自定义项仍在').toContain(c.id);
  });

  test('D4-3 半写的 custom-providers.json(截断 JSON):GET /api/providers 仍 200 且 providers 含内置官方(不整体 500)', async () => {
    const h = await startInstance(caseRoot('d4-halfjson'), {}, { label: 'd4-3' });
    const f = path.join(h.home, '.claude-gui', 'custom-providers.json');
    fs.writeFileSync(f, '[{"id":"half","name":"半写"');
    const r = await req(h.base, 'GET', '/api/providers');
    console.log(`[r125] D4-3 半写 json:status=${r.status} custom=${JSON.stringify(r.json?.customProviders ?? null)} warning=${JSON.stringify(r.json?.warning ?? null)}`);
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect((r.json?.providers ?? []).map((p) => p.id)).toContain(OFFICIAL);
  });

  test('D4-4 界面观察:接口被 20 路并发打着的同时连点 provider 按钮 30 次 → 列表可见时从不为 0 行,页面收到的 /api/providers 没有非 200', async ({ page }) => {
    test.skip(!process.env.R125_UI_BASE, '没有 dev server(R125_API_ONLY=1)');
    await createCustomProvider();
    const statuses = [];
    page.on('response', (r) => { if (new URL(r.url()).pathname === '/api/providers') statuses.push(r.status()); });
    await boot(page);
    const base = process.env.R125_API_BASE;
    let stop = false;
    const bg = (async () => { const bad = []; while (!stop) bad.push(...await hammer(base, { lanes: 20, rounds: 1 })); return bad; })();
    const samples = [];
    for (let i = 0; i < 30; i += 1) {
      await providerButton(page).click({ force: true });
      await settle(90);
      if (await switchListAny(page).isVisible().catch(() => false)) samples.push(await switchRowsAny(page).count());
    }
    await settle(1500);
    stop = true;
    const bgBad = await bg;
    console.log(`[r125] D4-4 连点 30 次:页面收到的 /api/providers 状态码分布=${JSON.stringify(Object.fromEntries([...new Set(statuses)].map((s) => [s, statuses.filter((x) => x === s).length])))};列表可见时行数采样=${JSON.stringify(samples)};后台并发异常=${bgBad.length}`);
    expect(statuses.filter((s) => s !== 200), '页面收到的 /api/providers 不该有非 200').toEqual([]);
    // "消失" = 显示过之后又变成 0 行;首次打开、数据还没到时的 0 行是加载态,不算
    const firstShown = samples.findIndex((s) => s > 0);
    expect(firstShown >= 0 ? samples.slice(firstShown).filter((s) => s === 0) : [], '列表显示过之后不该再出现 0 行(这就是用户说的"全部消失")').toEqual([]);
    expect(bgBad, '后台并发读不该出现异常返回').toEqual([]);
  });
});
