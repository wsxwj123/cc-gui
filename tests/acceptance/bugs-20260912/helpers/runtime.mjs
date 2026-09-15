// 本套件的运行时守卫与公开 UI 辅助。
//
// 铁规（与其它验收套件同口径）：
//   · 只连 127.0.0.1 上的**本套件自己的**隔离实例；用户正在用的 6677 / 6689 一律拒。
//   · 观测只用公开文案 / role / title / data-* 钩子；不读产品源码里的变量名。
//   · 找不到东西时报"环境不成立"(EnvironmentBlocked)，别报成产品缺陷。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const expectedWorktree = path.resolve(suiteDir, '..', '..', '..');  // 本套件所在 worktree;不钉死本机家目录,显式传 WORKTREE 时仍以 WORKTREE 为准

export class EnvironmentBlocked extends Error {
  constructor(message) {
    super(`ENVIRONMENT_BLOCKED: ${message}`);
    this.name = 'EnvironmentBlocked';
  }
}

export function suitePath(...parts) {
  return path.join(suiteDir, ...parts);
}

export function getRuntime() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance');
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new EnvironmentBlocked('BASE_URL must use http or https');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new EnvironmentBlocked('BASE_URL must be loopback; remote instances are refused');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if ([6677, 6689].includes(port)) {
    throw new EnvironmentBlocked('ports 6677 and 6689 are the user instances; use the suite runner (run-isolated.sh)');
  }
  if (port < 6700) {
    throw new EnvironmentBlocked(`port ${port} is outside the reserved test range (6700+)`);
  }
  const worktree = path.resolve(process.env.WORKTREE || expectedWorktree);
  return { baseURL: url.toString().replace(/\/$/, ''), port, worktree };
}

/** 夹具清单（helpers/fixtures.mjs 生成）。 */
export function fixtureManifest() {
  const file = suitePath('fixture-manifest.local.json');
  if (!fs.existsSync(file)) {
    throw new EnvironmentBlocked(`missing ${file}; run \`node helpers/fixtures.mjs\` (run-isolated.sh does it for you)`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ───────────────────────── 公开 UI 导航 ─────────────────────────
// 本产品没有"按会话寻址的 URL"（任何路径都渲染首页），导航只能像真实用户那样点。

const OVERLAY_DISMISS = ['关闭指引', '跳过', '稍后'];

/** 关掉会遮挡点击的临时浮层（新手引导 / 更新提示）。幂等。 */
export async function dismissOverlays(page) {
  for (const name of OVERLAY_DISMISS) {
    const b = page.getByRole('button', { name, exact: true });
    if ((await b.count()) && (await b.first().isVisible().catch(() => false))) {
      await b.first().click().catch(() => {});
      await page.waitForTimeout(200);
    }
  }
}

export async function clickThroughOverlays(page, target, { attempts = 4, timeout = 5_000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await dismissOverlays(page);
    try {
      await target.click({ timeout });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await page.waitForTimeout(250);
    }
  }
}

export async function openApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  // 顶栏就绪 = 应用挂上了（下面这些钩子与文案都是产品公开契约）。
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 20_000 });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 用侧栏搜索打开夹具会话（marker 必须写在会话内容里，见 fixtures.mjs）。 */
export async function openSession(page, marker) {
  await dismissOverlays(page);
  const search = page.getByRole('textbox', { name: /搜索项目/ }).first();
  await search.fill(marker);
  const result = page.getByRole('button', { name: new RegExp(escapeRegExp(marker)) }).first();
  await expect(result).toBeVisible({ timeout: 20_000 });
  await clickThroughOverlays(page, result);
  await page.keyboard.press('Escape'); // 关搜索浮层
  await expect(page.getByRole('textbox', { name: /打开命令/ }).first()).toBeVisible({ timeout: 20_000 });
  await dismissOverlays(page);
}

// ───────────────────────── 顶栏面板坞（T2 的被测对象） ─────────────────────────
// 坞的公开钩子：data-cgui="panel-dock"（坞容器）、data-testid="panel-dock-toggle"（坞按钮本身）。
// 终端按钮不属于坞（坞 rail 明确排除它），所以"终端开着时坞按钮的身份"是 T2 的全部内容。
export const dockToggle = (page) => page.locator('[data-cgui="panel-dock"] [data-testid="panel-dock-toggle"]');
/** 顶栏常驻「终端」开关（可访问名就叫"终端"，与坞 rail 内按钮不重名）。 */
export const terminalToggle = (page) => page.getByRole('button', { name: '终端', exact: true }).first();

/** 坞按钮当前身份：可访问名里的文字、title、是否点亮、图标是哪一枚。 */
export async function dockIdentity(page) {
  const toggle = dockToggle(page);
  await expect(toggle).toBeVisible();
  return await toggle.evaluate((el) => {
    const svg = el.querySelector('svg');
    return {
      text: (el.textContent || '').trim(),
      title: el.getAttribute('title') || '',
      classes: el.className || '',
      iconClass: svg ? (svg.getAttribute('class') || '') : '',
      iconPath: svg ? Array.from(svg.querySelectorAll('path,rect,line,circle,polyline')).map((n) => n.getAttribute('d') || n.getAttribute('points') || n.tagName).join('|').slice(0, 200) : '',
    };
  });
}

/** 展开面板坞 rail（幂等：已展开时 rail 已经可见）。 */
export async function openDockRail(page) {
  if (await page.locator('span.cgui-dock-rail').first().isVisible().catch(() => false)) return;
  await clickThroughOverlays(page, dockToggle(page));
  await expect(page.locator('span.cgui-dock-rail').first()).toBeVisible();
}

/** 点 rail 里某个面板按钮（按公开文案，如 文件 / 生图 / 通用 / 终端以外）。 */
export async function openPanel(page, label) {
  await openDockRail(page);
  const rail = page.locator('span.cgui-dock-rail').first();
  const button = rail.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}$`) }).first();
  await expect(button).toBeVisible({ timeout: 10_000 });
  await clickThroughOverlays(page, button);
}

/**
 * 收尾：结束本页面开出来的终端 shell。
 * 面板处于收起态时先点顶栏"终端"展开再关。尽力而为、永不抛出。
 */
export async function closePanelTerminals(page) {
  const closeTab = page.getByRole('button', { name: /关闭此标签/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await closeTab.count())) return;
    if (!(await closeTab.first().isVisible().catch(() => false))) {
      await terminalToggle(page).click({ timeout: 4_000 }).catch(() => null);
      await page.waitForTimeout(300);
      continue;
    }
    await closeTab.first().click({ timeout: 4_000 }).catch(() => null);
    await page.waitForTimeout(300);
  }
}
