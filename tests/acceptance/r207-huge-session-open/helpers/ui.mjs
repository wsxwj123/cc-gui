// r207 页面操作层:只通过页面文案 / role / data-* 锚点、页面发出的请求、假命令行观察文件判断。
import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const CTL = process.env.R207_CTL;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

const hitRow = (page, mark) => page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item').filter({ hasText: mark }).first();
/** 夹具工作区不进侧栏常规列表:在侧栏搜索框搜会话标记,点命中行打开会话。 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索工作区/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(hitRow(page, mark)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await hitRow(page, mark).click();
  try { await expect(search).toHaveValue('', { timeout: 5_000 }); } catch { await search.fill(''); }
}

export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();
export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

export const BODY_504 = { ok: false, code: 'HISTORY_READ_TIMEOUT', error: '读取会话历史超时' };
export const BODY_500 = { ok: false, code: 'HISTORY_READ_FAILED', error: '读取会话历史失败' };
export const isHistoryUrl = (sid, url) => new URL(url).pathname === `/api/sessions/${sid}/messages`;

/** 只拦这一个会话的历史接口 GET;mode: 'pass'(照常走后端)| '504' | '500'。hits 记录每次被拦下的请求 {t, url, mode}。 */
export async function interceptHistory(page, sid, mode) {
  const ctl = { mode, hits: [] };
  await page.route((url) => isHistoryUrl(sid, url.href), (route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.continue();
    ctl.hits.push({ t: Date.now(), url: req.url(), mode: ctl.mode });
    if (ctl.mode === '504') return route.fulfill({ status: 504, contentType: 'application/json', body: JSON.stringify(BODY_504) });
    if (ctl.mode === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify(BODY_500) });
    return route.continue();
  });
  return ctl;
}

export const turnEndFile = (sid) => path.join(CTL, `${sid}.turn-end`);
export const clearTurnEnd = (sid) => { try { fs.unlinkSync(turnEndFile(sid)); } catch { /* 本来就没有 */ } };
export async function waitTurnEnd(sid, timeout = 40_000) {
  const t0 = Date.now();
  while (!fs.existsSync(turnEndFile(sid))) {
    if (Date.now() - t0 > timeout) throw new Error(`等 ${sid} 的回合结束超时(假命令行没写 turn-end)`);
    await sleep(100);
  }
  return Number(fs.readFileSync(turnEndFile(sid), 'utf8')) || Date.now();
}
