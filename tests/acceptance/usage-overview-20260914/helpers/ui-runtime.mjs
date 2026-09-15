// UI 层(浏览器)用例的 helper:界面怎么打开、以及"浏览器里跑的确实是当前源码"这条前提。
//
// 黑盒口径:只用产品自己的公开入口(顶栏坞按钮、面板里的按钮/文案),不注入测试专用属性、
// 不改产品代码。唯一用到的 DOM 钩子是 `data-testid="panel-dock-toggle"` —— 产品自己给的
// 稳定钩子(导引与手机菜单都用它),不是为本套件新加的。
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { worktree, EnvironmentBlocked } from './runtime.mjs';

/**
 * dist 新鲜度预检:浏览器跑的是 `client/dist` 的构建产物,**不是源码**。
 * 源码比 dist 新 → 现在的断言验的是旧前端(红/绿都可能与当前源码无关),直接报环境错。
 * (本仓踩过多次:改了源码没重建,装机版跑的是旧 bundle,排查半天。)
 */
export function assertClientDistFresh() {
  const distDir = path.join(worktree, 'client', 'dist');
  const index = path.join(distDir, 'index.html');
  if (!fs.existsSync(index)) {
    throw new EnvironmentBlocked(`client/dist 不存在(浏览器用例要的是构建产物):cd client && npx vite build`);
  }
  const distAt = fs.statSync(index).mtimeMs;
  const newest = { file: null, ms: 0 };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const ms = fs.statSync(p).mtimeMs;
      if (ms > newest.ms) { newest.ms = ms; newest.file = p; }
    }
  };
  walk(path.join(worktree, 'client', 'src'));
  if (newest.ms > distAt) {
    throw new EnvironmentBlocked(
      `client/dist 比源码旧(${path.relative(worktree, newest.file)} 的 mtime 更新)`
      + ` —— 先 cd client && npx vite build,否则浏览器里跑的不是当前源码`);
  }
  return { distAt, newestSource: newest.file };
}

const OVERLAY_BUTTONS = ['已知晓', '关闭指引', '跳过', '稍后'];

async function dismissOverlays(page) {
  for (const name of OVERLAY_BUTTONS) {
    const b = page.getByRole('button', { name, exact: true });
    if ((await b.count()) && (await b.first().isVisible().catch(() => false))) {
      await b.first().click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

async function clickThrough(page, target, { attempts = 4, timeout = 5000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await dismissOverlays(page);
    try { await target.click({ timeout }); return; } catch (err) {
      if (i === attempts - 1) throw err;
      await page.waitForTimeout(300);
    }
  }
}

/**
 * 打开用量面板:load 应用 → 展开顶栏面板坞 → 点「用量」→ 等面板的慢段挂载。
 * 等「导出 CSV」是必须的:它和那句 stale 提示在同一段里渲染,不等就等于让
 * "提示不出现"这类负向断言在面板还没渲染时通过(恒真)。
 */
export async function openUsagePanel(page, base) {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await dismissOverlays(page);
  await clickThrough(page, page.locator('[data-testid="panel-dock-toggle"]').first());
  await clickThrough(page, page.getByRole('button', { name: '用量', exact: true }).first());
  await expect(page.getByRole('button', { name: '导出 CSV' }).first(),
    '用量面板(慢段)必须挂载 —— 它是后续断言的前提').toBeVisible({ timeout: 20_000 });
}
