// r172-orbit-switch 验收套件的运行时守卫与导航(脚手架抄自 r159-orbit-random 的 runtime.mjs,端口段改成 6700–6799)。
//
// 铁规:
//   · 只连 127.0.0.1 上的**本套件自己的**隔离实例;6677 / 6689 / 6710 / 8798 / 8799 一律拒,端口只许 6700–6799。
//   · 观测只用接口文件列出的锚点 / 公开文案 / role / data-* 属性;不读源码、不读 React state。
//   · 找不到东西时报"环境不成立"(EnvironmentBlocked),别报成产品缺陷。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { fixtureManifestPath } from './manifest-path.mjs';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class EnvironmentBlocked extends Error {
  constructor(message) {
    super(`ENVIRONMENT_BLOCKED: ${message}`);
    this.name = 'EnvironmentBlocked';
  }
}

export function suitePath(...parts) { return path.join(suiteDir, ...parts); }

export function getRuntime() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance (use run-isolated.sh)');
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new EnvironmentBlocked('BASE_URL must use http or https');
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new EnvironmentBlocked('BASE_URL must be loopback; remote instances are refused');
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if ([6677, 6689, 6710, 8798, 8799].includes(port)) {
    throw new EnvironmentBlocked(`port ${port} is reserved (user / other instances); use run-isolated.sh`);
  }
  if (port < 6700 || port > 6799) throw new EnvironmentBlocked(`port ${port} is outside the reserved test range (6700-6799)`);
  return { baseURL: url.toString().replace(/\/$/, ''), port };
}

export function fixtureManifest() {
  const file = fixtureManifestPath();
  if (!fs.existsSync(file)) {
    throw new EnvironmentBlocked(`missing ${file}; run \`node helpers/fixtures.mjs\` (run-isolated.sh does it for you)`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ───────────────────────── 导航(像真实用户那样点)─────────────────────────
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

/** 每次导航前预置"使用指引已看过"+ 额外的 localStorage 键值(addInitScript 按注册顺序在每次导航时执行,后注册的同名键覆盖先注册的)。 */
export async function primeOverlays(page, presets = {}) {
  await page.addInitScript((p) => {
    try {
      localStorage.setItem('cgui-tour-seen', '1');
      for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v);
    } catch { /* 忽略 */ }
  }, presets);
}

export async function openApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

/** 侧栏搜索 marker → 点结果行 → 夹具会话打开。 */
export async function openSessionByMarker(page, marker) {
  await dismissOverlays(page);
  const search = page.getByRole('textbox', { name: /搜索工作区/ }).first();
  await search.fill(marker);
  const result = page.getByRole('button', { name: new RegExp(marker) }).first();
  await expect(result, `侧栏搜不到夹具会话 ${marker} —— 夹具没落进这个实例的数据根`).toBeVisible({ timeout: 25_000 });
  await result.click({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await dismissOverlays(page);
  await expect(page.locator('[data-turn-uuid]').first()).toBeVisible({ timeout: 30_000 });
}

export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

// ───────────────────────── 真回合(假命令行)的现场控制 ────────────────────────
export function ctlFile(name) { return path.join(fixtureManifest().fakeCtl, name); }

export function writeScenario(scenario) {
  fs.writeFileSync(ctlFile('scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`);
}

/** 在 CTL 目录里放一个名为 name 的文件(假命令行里 pending / wait 事件等的就是它)。 */
export function touchCtl(name) { fs.writeFileSync(ctlFile(name), String(Date.now())); }

/** 放行"停在 result 之前"的回合(scenario.holdBeforeResult)。 */
export function releaseRound() { touchCtl('release'); }

/** 清掉上一轮留下的场景与放行文件(不清的话下一轮的 hold 会立刻被放行)。 */
export function resetCtl() {
  let names = [];
  try { names = fs.readdirSync(fixtureManifest().fakeCtl); } catch { /* 目录还没有 */ }
  for (const name of names) {
    try { fs.unlinkSync(ctlFile(name)); } catch { /* 本来就没有 */ }
  }
}

export async function sendMessage(box, text) {
  await box.fill(text);
  await box.press('Enter');
}

export async function sendInOpenSession(page, text) {
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await sendMessage(box, text);
}

/** 收集页面未捕获异常(不抛错、不白屏)。 */
export function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  return errors;
}
