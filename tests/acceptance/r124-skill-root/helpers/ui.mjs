// r124 界面操作层:只按用户看得见的东西 + 探路实测到的公开锚点定位(data-testid="ext-market" 等)。
// 依据只有 .devflow/BRIEF-r124.md 与 .devflow/INTERFACE-r124.md;没看实现代码。
// 落点(探路实测):面板坞「市场」格子(title 以「扩展市场」开头)→「技能」页签 → 输入框
// (placeholder 以「owner/repo」开头)+「拉取仓库」按钮;导入区那颗按钮的文字就是判据
// (「此源已全部安装」/「一键导入全部(N)」)。
import { expect } from '@playwright/test';

export const API_BASE = process.env.R124_API_BASE || '';

/** 对共享隔离实例直调接口(准备/核对用)。 */
export async function api(method, url, body) {
  if (!API_BASE) throw new Error('R124_API_BASE 未设置(run.sh 负责)');
  const res = await fetch(API_BASE + url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, text, json };
}

/** 进应用并压掉一次性浮层/更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const u of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(u, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await dismissOverlays(page);
}

/** 反复点掉「稍后 / 以后再说 / 已知晓」这类一次性浮层(别用「跳过」当关键词,会误命中产品自己的按钮)。 */
export async function dismissOverlays(page, passes = 6) {
  for (let i = 0; i < passes; i += 1) {
    let hit = false;
    for (const label of ['稍后', '以后再说', '已知晓']) {
      const btn = page.locator('button').filter({ hasText: label }).last();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(120);
        hit = true;
      }
    }
    if (!hit) return;
  }
}

/** 展开面板坞(幂等:已展开就不再点那颗开关)。 */
async function openDock(page) {
  const probe = page.locator('[data-cgui="panel-dock"] button').filter({ hasText: /^通用$/ }).first();
  if (await probe.isVisible().catch(() => false)) return;
  const toggle = page.locator('[data-testid="panel-dock-toggle"]');
  if (await toggle.count()) await toggle.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
}

export const market = (page) => page.getByTestId('ext-market');
export const repoInput = (page) => page.locator('input[placeholder^="owner/repo"]').first();
export const fetchButton = (page) => page.getByRole('button', { name: '拉取仓库', exact: true }).first();

/** 打开「市场」面板并停在「技能」页签(有仓库输入框为准)。 */
export async function openMarketPanel(page) {
  await openDock(page);
  const grid = page.locator('[data-cgui="panel-dock"] button[title^="扩展市场"]').first();
  await expect(grid, '面板坞里应当有「市场」(扩展市场)格子').toBeVisible({ timeout: 10_000 });
  await grid.click({ force: true });
  await expect(market(page), '应进入扩展市场').toBeVisible({ timeout: 15_000 });
  const skillTab = page.getByTestId('ext-market-tab').filter({ hasText: /^技能$/ }).first();
  if (await skillTab.count()) await skillTab.click({ force: true }).catch(() => {});
  await expect(repoInput(page), '技能页签里应有 owner/repo 输入框').toBeVisible({ timeout: 10_000 });
  await dismissOverlays(page);
}

/**
 * 像用户那样拉取一个仓库:填 owner/repo → 点「拉取仓库」→ 等这次 official 请求回来 → 等界面落定。
 * 返回该次 official 响应的 JSON(拿来做前置自证,不作为界面判据)。
 */
export async function fetchRepo(page, repo) {
  const input = repoInput(page);
  await input.click();
  await input.fill(repo);
  await expect(input).toHaveValue(repo);
  const waiting = page.waitForResponse((r) => r.url().includes('/api/skills/official') && decodeURIComponent(r.url()).includes(`repo=${repo}`), { timeout: 30_000 });
  await fetchButton(page).click();
  const resp = await waiting;
  let json = null;
  try { json = await resp.json(); } catch { /* 非 JSON */ }
  await expect(market(page), `拉取后市场页应显示「仓库:${repo}」`).toContainText(`仓库:${repo}`, { timeout: 15_000 });
  await page.waitForTimeout(500);
  return json;
}

/** 市场页整块的可见文本(空白折叠成单个空格)。 */
export const marketText = async (page) => (await market(page).innerText()).replace(/\s+/g, ' ').trim();

/** 导入区那颗按钮的文字(「此源已全部安装」或「一键导入全部(N)」);没有这颗按钮返回 null。 */
export async function importButtonText(page) {
  const btn = market(page).locator('button').filter({ hasText: /一键导入全部|此源已全部安装/ });
  if (!(await btn.count())) return null;
  return (await btn.first().innerText()).replace(/\s+/g, '').trim();
}

/** 「全部N / 未安装N / 已安装N」三颗筛选片的计数。 */
export async function filterCounts(page) {
  const texts = await page.getByTestId('market-installed-filter').allInnerTexts();
  const out = {};
  for (const t of texts) {
    const m = t.replace(/\s+/g, '').match(/^(全部|未安装|已安装)(\d+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * 浏览器侧拦截 official?repo=…,直接喂一份 INTERFACE A 形状的响应(只匹配带 repo 的那条,内置源不受影响)。
 * 用途:把前端"按 count/installed 决定导入区文案"的逻辑与服务端解析隔开来单独判。
 */
export async function mockOfficial(page, payload) {
  await page.route((url) => url.pathname === '/api/skills/official' && url.searchParams.has('repo'), (route) =>
    route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(payload) }));
}

/** 拼一份 official 的响应(INTERFACE A 形状)。 */
export function officialPayload(repo, skills) {
  return { source: 'github', repo, branch: 'main', host: 'github', count: skills.length, truncatedDesc: false, skills };
}
export const skillItem = (id, description, installed, version = '1.0.0') => ({ id, name: id, description, version, installed });
