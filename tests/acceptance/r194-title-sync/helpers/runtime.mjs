// r194-title-sync 验收套件的运行时守卫、导航与页面观测。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / data-* 锚点)观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { manifestPath } from './fixtures.mjs';

export class EnvironmentBlocked extends Error {
  constructor(message) { super(`ENVIRONMENT_BLOCKED: ${message}`); this.name = 'EnvironmentBlocked'; }
}

export function getRuntime() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance (use run-isolated.sh)');
  const url = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new EnvironmentBlocked('BASE_URL must be loopback');
  const port = Number(url.port || 80);
  if ([6677, 6689, 6710, 8788, 8789, 8798, 8799].includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port < 6700 || port > 6999) throw new EnvironmentBlocked(`port ${port} is outside the reserved test range (6700-6999)`);
  return { baseURL: url.toString().replace(/\/$/, ''), port };
}

export function fixtureManifest() {
  const file = manifestPath();
  if (!fs.existsSync(file)) throw new EnvironmentBlocked(`missing ${file}; run-isolated.sh creates it`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const OVERLAY_DISMISS = ['关闭指引', '跳过', '稍后', '知道了'];
export async function dismissOverlays(page) {
  for (const name of OVERLAY_DISMISS) {
    const b = page.getByRole('button', { name, exact: true });
    if ((await b.count()) && (await b.first().isVisible().catch(() => false))) {
      await b.first().click().catch(() => {});
      await page.waitForTimeout(150);
    }
  }
}
export async function openApp(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

// ───────────────────────── 页面观测(只靠文案 / role / title / data-cgui 锚点) ─────────────────────────
export const composer = (page) => page.locator('textarea').last();
const projectRow = (page, wsName) => page.locator('[data-cgui="project-row"]').filter({ hasText: wsName }).first();
export const sessionRows = (page) => page.locator('[data-cgui="session-row"]');

/** 展开工作区分组(已展开就不动)。 */
export async function expandGroup(page, wsName) {
  const pr = projectRow(page, wsName);
  await expect(pr, `侧栏里应有工作区 ${wsName}`).toBeVisible({ timeout: 30_000 });
  if ((await pr.getAttribute('aria-expanded')) !== 'true') await pr.click();
  await expect(pr).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
}
export async function collapseGroup(page, wsName) {
  const pr = projectRow(page, wsName);
  if ((await pr.getAttribute('aria-expanded')) === 'true') await pr.click();
  await expect(pr).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
}
/** 点侧栏里文字含 text 的会话行。 */
export async function clickRowWith(page, text) {
  const row = sessionRows(page).filter({ hasText: text }).first();
  await expect(row, `侧栏里应有会话行含「${text}」`).toBeVisible({ timeout: 20_000 });
  await row.click();
}
// 侧栏会话行上的「名字」:行里最后一个叶子 span 的文字(行里还可能有「运行中」之类的状态字,不算名字)。
export async function rowTexts(page) {
  return await sessionRows(page).evaluateAll((rows) => rows.map((r) => {
    const leaves = [...r.querySelectorAll('span')].filter((e) => e.children.length === 0 && e.textContent.trim());
    return (leaves.length ? leaves[leaves.length - 1].textContent : r.innerText).trim();
  }));
}

export async function sendText(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 会话标题:「重命名会话」铅笔旁边的名字;没有返回 null。 */
export async function readTitle(page) {
  const pen = page.getByTitle('重命名会话');
  if (!(await pen.count())) return null;
  return await pen.first().evaluate((b) => { const s = b.parentElement && b.parentElement.querySelector('span'); return s ? s.textContent.trim() : null; });
}
/** 顶栏会话名:顶栏里紧跟在「/」后面的那个名字;没有返回 null。 */
export async function readTopbarName(page) {
  return await page.evaluate(() => {
    const hdr = document.querySelector('[data-cgui="topbar"]');
    if (!hdr) return null;
    for (const el of hdr.querySelectorAll('*')) {
      const prev = el.previousElementSibling;
      if (el.children.length === 0 && prev && prev.textContent.trim() === '/') return el.textContent.trim();
    }
    return null;
  });
}
/** 侧栏 S 那一行:工作区只展开了会话所在的那一组时,就是唯一的行。 */
async function onlyRowText(page) { const t = await rowTexts(page); return t.length === 1 ? t[0] : `(侧栏会话行 ${JSON.stringify(t)})`; }

/** 最多等 ms 毫秒,等「侧栏唯一一行、会话标题、顶栏会话名」三处都等于 want;返回最后一次读数(调用方断言)。 */
export async function waitThreePlaces(page, want, ms) {
  const end = Date.now() + ms;
  let snap;
  for (;;) {
    snap = { row: await onlyRowText(page), title: await readTitle(page), top: await readTopbarName(page) };
    if (snap.row === want && snap.title === want && snap.top === want) return snap;
    if (Date.now() >= end) return snap;
    await page.waitForTimeout(150);
  }
}

/** 行菜单:悬停会话行 → 点「…」(title=会话操作) → 点菜单项。 */
export async function rowMenu(page, rowLocator, item) {
  await rowLocator.hover();
  const wrap = rowLocator.locator('xpath=..');
  await wrap.getByTitle('会话操作').click();
  await page.getByRole('button', { name: item, exact: true }).first().click();
}
/** 在改名输入框里填新名字并回车确认。 */
export async function submitRename(page, name) {
  const input = page.getByPlaceholder(/自定义标题/);
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(name);
  await input.press('Enter');
}

// ───────────────────────── 完成浮条观察器 ─────────────────────────
/** 页面里挂观察器:每 20 毫秒 + 每次 DOM 变动,记录页面上所有含「回复完成」的叶子元素文字的每一次变化,并在第一次出现时抓侧栏各会话行的文字。 */
export async function startBannerWatch(page) {
  await page.evaluate(() => {
    if (window.__r194) { clearInterval(window.__r194.timer); window.__r194.observer.disconnect(); }
    const st = { changes: [], firstEpoch: null, rowsAtFirst: null, last: '[]', timer: 0, observer: null };
    const tick = () => {
      const texts = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /回复完成/.test(e.textContent)).map((e) => e.textContent.trim());
      const key = JSON.stringify(texts);
      if (key === st.last) return;
      st.last = key;
      st.changes.push({ t: Date.now(), texts });
      if (texts.length && st.firstEpoch === null) {
        st.firstEpoch = Date.now();
        st.rowsAtFirst = [...document.querySelectorAll('[data-cgui="session-row"]')].map((r) => {
          const leaves = [...r.querySelectorAll('span')].filter((e) => e.children.length === 0 && e.textContent.trim());
          return (leaves.length ? leaves[leaves.length - 1].textContent : r.innerText).trim();
        });
      }
    };
    st.timer = setInterval(tick, 20);
    st.observer = new MutationObserver(tick);
    st.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__r194 = st;
  });
}
export async function bannerFirstEpoch(page) { return await page.evaluate(() => window.__r194.firstEpoch); }
/** 等浮条出现(返回第一次出现的时刻,epoch 毫秒),超时返回 null。 */
export async function waitBannerAppear(page, untilEpoch) {
  for (;;) {
    const t = await bannerFirstEpoch(page);
    if (t !== null) return t;
    if (Date.now() >= untilEpoch) return null;
    await page.waitForTimeout(100);
  }
}
/** 等浮条消失(最后一次记录是空),最多 ms 毫秒;返回是否已消失。 */
export async function waitBannerGone(page, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(() => window.__r194.last === '[]')) return true;
    if (Date.now() >= end) return false;
    await page.waitForTimeout(200);
  }
}
/** 观察期内出现过的浮条文字(去重)。 */
export async function bannerNamesSeen(page) {
  return await page.evaluate(() => [...new Set(window.__r194.changes.flatMap((c) => c.texts))]);
}
export async function bannerRowsAtFirst(page) { return await page.evaluate(() => window.__r194.rowsAtFirst); }
