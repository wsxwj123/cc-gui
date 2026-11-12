// r176-api-error-actions 验收套件的运行时守卫、导航与页面观测。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / data-* 锚点)观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { fixtureManifestPath } from './manifest-path.mjs';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function suitePath(...parts) { return path.join(suiteDir, ...parts); }

export class EnvironmentBlocked extends Error {
  constructor(message) {
    super(`ENVIRONMENT_BLOCKED: ${message}`);
    this.name = 'EnvironmentBlocked';
  }
}

export function getRuntime() {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new EnvironmentBlocked('set BASE_URL to the isolated test instance (use run-isolated.sh)');
  const url = new URL(baseURL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new EnvironmentBlocked('BASE_URL must be loopback');
  const port = Number(url.port || 80);
  if ([6677, 6689, 6710, 8798, 8799].includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port < 6700 || port > 6799) throw new EnvironmentBlocked(`port ${port} is outside the reserved test range (6700-6799)`);
  return { baseURL: url.toString().replace(/\/$/, ''), port };
}

export function fixtureManifest() {
  const file = fixtureManifestPath();
  if (!fs.existsSync(file)) throw new EnvironmentBlocked(`missing ${file}; run-isolated.sh creates it`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ───────────────────────── 导航 ─────────────────────────
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

export async function primeOverlays(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
}

export async function openApp(page, { mobile = false } = {}) {
  await primeOverlays(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  if (mobile) {
    await expect(page.getByRole('button', { name: '新建会话' }).first(), '手机页应挂好(有「新建会话」)').toBeVisible({ timeout: 60_000 });
  } else {
    await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
  }
}

export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

/** 桌面:落在首页(没有选中任何会话),首页输入框发出的第一条消息就是一条新会话。
 *  夹具工作区在本套件所在的工作树里,侧栏不会把它列成工作区(侧栏显示「没有找到工作区」),所以不走侧栏的工作区行。
 *  已经在某条会话里时,点「新建会话」回首页。 */
export async function newSessionDesktop(page) {
  await dismissOverlays(page);
  const home = page.getByTestId('home-input');
  if (!(await home.isVisible({ timeout: 8_000 }).catch(() => false))) {
    const btn = page.locator('[data-cgui=new-session-btn]').first();
    if (await btn.count()) await btn.click({ force: true }).catch(() => {});
  }
  const box = composerBox(page).last();
  await expect(box, '首页应有可输入的输入框').toBeVisible({ timeout: 15_000 });
  return box;
}

/** 手机宽度:点「新建会话」→ 返回输入框。 */
export async function newSessionMobile(page) {
  await page.getByRole('button', { name: '新建会话' }).first().click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const box = composerBox(page).last();
  await expect(box, '新建会话后应出现输入框').toBeVisible({ timeout: 15_000 });
  return box;
}

/** 发一条消息;返回「回合结束」的等待函数用的停止键定位器。 */
export const stopBtn = (page) => page.locator('[data-cgui="stop-btn"]');

export async function sendText(page, text) {
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

/** 「回合结束后」= 停止键已经消失。假命令行每回合先停 0.7 秒,所以先等停止键出现,再等它消失(免得把「还没开始」当成「已结束」)。 */
export async function waitTurnEnded(page) {
  await expect(stopBtn(page), '发出消息后应先看到停止键(回合已开始)').toBeVisible({ timeout: 20_000 });
  await expect(stopBtn(page), '回合应当结束(停止键消失)').toHaveCount(0, { timeout: 60_000 });
}

/** 唯一标签:每个用例每次运行的消息都不同,侧栏搜索只会命中自己这一条会话。 */
export function uniqueTag(prefix) { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

/** 侧栏搜索 → 点结果行 → 会话打开(重新点开一条已存在的会话)。 */
export async function reopenSessionByTag(page, tag) {
  await dismissOverlays(page);
  const search = page.getByRole('textbox', { name: /搜索工作区/ }).first();
  await search.fill(tag);
  const result = page.getByRole('button', { name: new RegExp(tag) }).first();
  await expect(result, `侧栏搜不到会话 ${tag}`).toBeVisible({ timeout: 25_000 });
  await result.click({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await dismissOverlays(page);
  await expect(page.locator('[data-turn-uuid]').first(), '会话重新打开后应出现消息行').toBeVisible({ timeout: 30_000 });
}

export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

// ───────────────────────── 页面观测 ─────────────────────────
// probeInPage 在页面里跑(用 toString 传进去),所以不能引用本文件里的任何变量。
// spec = { anchor: '报错原文的开头', items: [{ key, kind: 'button'|'text', re: '正则源码' }] }
// 返回 { anchors: 页面上以 anchor 开头的文字节点个数(只在消息区里数), items: { key: { any: 页面上可见的个数, below: 其中位于报错原文下方的个数 } } }
// 「位于报错原文下方」= 文档顺序在最后一个报错文字节点之后,且顶边不高于该文字节点的底边(容差 2px)。
// 按钮 = button / [role=button] / a,且自身文字不超过 80 个字(排除把整段消息包进去的可点击大容器)。
export function probeInPage(spec) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const skipTag = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT']);
  const textNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || skipTag.has(p.tagName) || p.isContentEditable) continue;
    if (!norm(n.data)) continue;
    textNodes.push(n);
  }
  const area = document.querySelector('[data-chat-scroll]') || document.querySelector('[data-cgui="message-list"]') || document.body;
  const anchorNodes = spec.anchor ? textNodes.filter((n) => norm(n.data).startsWith(spec.anchor) && isVisible(n.parentElement)) : [];
  const anchorsInArea = anchorNodes.filter((n) => area.contains(n));
  const last = anchorNodes.length ? anchorNodes[anchorNodes.length - 1] : null;
  let lastBottom = null;
  if (last) { const rg = document.createRange(); rg.selectNodeContents(last); lastBottom = rg.getBoundingClientRect().bottom; }
  const below = (el) => {
    if (!last) return false;
    if (!(last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    return el.getBoundingClientRect().top >= lastBottom - 2;
  };
  const items = {};
  for (const it of spec.items) {
    const re = new RegExp(it.re, 'u');
    let els = [];
    if (it.kind === 'button') {
      els = [...document.querySelectorAll('button, [role="button"], a')].filter((e) => {
        const t = norm(e.textContent);
        return t.length <= 80 && re.test(t) && isVisible(e);
      });
    } else {
      els = textNodes.filter((n) => re.test(norm(n.data)) && isVisible(n.parentElement)).map((n) => n.parentElement);
    }
    items[it.key] = { any: els.length, below: els.filter(below).length };
  }
  return { anchors: anchorsInArea.length, anchorsAnywhere: anchorNodes.length, items };
}

export async function probe(page, spec) {
  return await page.evaluate(({ src, s }) => new Function(`return (${src})`)()(s), { src: probeInPage.toString(), s: spec });
}

/** 在页面里每 stepMs 毫秒探一次,共 count 次(默认 31 次 ≈ 回合结束起连续 3 秒);返回全部探测结果。 */
export async function sampleProbe(page, spec, { count = 31, stepMs = 100 } = {}) {
  return await page.evaluate(async ({ src, s, n, step }) => {
    const fn = new Function(`return (${src})`)();
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push({ at: Math.round(performance.now()), r: fn(s) });
      if (i < n - 1) await new Promise((res) => setTimeout(res, step));
    }
    return out;
  }, { src: probeInPage.toString(), s: spec, n: count, step: stepMs });
}

/** 「持续可见」:每一次探测里,报错原文在,且 required 里的每一项都有至少一个位于报错下方。返回失败的次数与第一处原因。 */
export function persistenceFailures(samples, requiredKeys) {
  const bad = [];
  samples.forEach((s, i) => {
    const missing = [];
    if (s.r.anchorsAnywhere < 1) missing.push('报错原文');
    for (const k of requiredKeys) if (!(s.r.items[k] && s.r.items[k].below >= 1)) missing.push(k);
    if (missing.length) bad.push({ i, at: s.at, missing });
  });
  return { total: samples.length, bad };
}
