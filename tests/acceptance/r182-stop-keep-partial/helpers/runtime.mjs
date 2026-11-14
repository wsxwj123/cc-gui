// r182-stop-keep-partial 验收套件的运行时守卫、导航与页面观测。
// 铁规:只连 127.0.0.1 上本套件自己的隔离实例;只通过页面(文案 / role / data-* 锚点)观测,不读源码、不读应用内部状态。
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { manifestPath } from './fixtures.mjs';

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
  if ([6677, 6689, 6710, 8788, 8789, 8798, 8799].includes(port)) throw new EnvironmentBlocked(`port ${port} is reserved`);
  if (port !== 6922) throw new EnvironmentBlocked(`port ${port} is not this suite's page port (6922)`);
  return { baseURL: url.toString().replace(/\/$/, ''), port };
}

export function fixtureManifest() {
  const file = manifestPath();
  if (!fs.existsSync(file)) throw new EnvironmentBlocked(`missing ${file}; run-isolated.sh creates it`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 准备步骤:调应用的设置接口把静默超时设成 value('never' | '5m'),只对本套件自己的隔离实例;后端带 CGUI_STALL_MS=4000,'5m' 在这里即 4 秒(照 r178c)。 */
export async function setStallTimeout(value) {
  const { baseURL } = getRuntime();
  const res = await fetch(`${baseURL}/api/prefs/stall-timeout`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  const body = await res.text();
  if (!res.ok) throw new EnvironmentBlocked(`PUT /api/prefs/stall-timeout ${JSON.stringify({ value })} 返回 HTTP ${res.status}:${body.slice(0, 200)}`);
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

export async function openApp(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 忽略 */ } });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

export const stopBtn = (page) => page.locator('[data-cgui="stop-btn"]');
const projectRow = (page, ctx) => page.locator('[data-cgui="project-row"]').filter({ hasText: ctx.workspaceName });
const sessionRows = (page) => page.locator('[data-cgui="session-row"]');

/** 展开本用例工作区在侧栏里的分组(已展开就不动)。 */
export async function openWorkspaceGroup(page, ctx) {
  const pr = projectRow(page, ctx).first();
  await expect(pr, `侧栏里应有本用例的工作区 ${ctx.workspaceName}`).toBeVisible({ timeout: 30_000 });
  if ((await pr.getAttribute('aria-expanded')) !== 'true') await pr.click();
  await expect(sessionRows(page).first(), '展开工作区后应出现会话行').toBeVisible({ timeout: 15_000 });
}

/** 点侧栏会话行。who = 'jia' | 'yi'。甲的标题发过消息后可能被改写:找不到带甲标记的行时,退而取「不是乙」的第一行。 */
export async function clickSession(page, who, ctx, { timeout = 20_000 } = {}) {
  const rows = sessionRows(page);
  const deadline = Date.now() + timeout;
  let texts = [];
  for (;;) {
    texts = await rows.allInnerTexts();
    let idx = -1;
    if (who === 'yi') idx = texts.findIndex((t) => t.includes(ctx.yi.marker));
    else {
      idx = texts.findIndex((t) => t.includes(ctx.jia.marker));
      if (idx < 0) idx = texts.findIndex((t) => !t.includes(ctx.yi.marker));
    }
    if (idx >= 0) {
      await rows.nth(idx).click({ timeout: 5_000 });
      return;
    }
    if (Date.now() > deadline) throw new Error(`侧栏里 ${timeout}ms 内找不到「${who}」会话行;当前各行 = ${JSON.stringify(texts)}`);
    await page.waitForTimeout(150);
  }
}

/** 打开应用、展开本用例工作区、点开甲,并等到甲的历史回复显示出来。 */
export async function openJia(page, ctx) {
  await openApp(page);
  await openWorkspaceGroup(page, ctx);
  await clickSession(page, 'jia', ctx);
  await expect(page.locator('[data-cgui="message-list"]'), '甲的历史回复应显示').toContainText('R182 历史回复', { timeout: 20_000 });
}

export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

/** 在当前会话发一条消息;尽量等到页面真的向后端发出「发起对话」的请求(等不到也不报错,后面的读数会说明问题)。 */
export async function sendMessage(page, text) {
  const isChatStart = (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat';
  const posted = page.waitForRequest(isChatStart, { timeout: 15_000 }).catch(() => null);
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
  await posted;
}

// ───────────────────────── 页面观测(口径见接口文件) ─────────────────────────
const FRAG = /片段\d{4}/g;

/** 页面文字里,第 i 个提示词之后、后面第一个出现的提示词之前的那一段;提示词不在页面上返回 null。 */
function segmentOf(text, prompts, i) {
  const s = text.indexOf(prompts[i]);
  if (s < 0) return null;
  const start = s + prompts[i].length;
  let end = text.length;
  for (let j = i + 1; j < prompts.length; j += 1) {
    const e = text.indexOf(prompts[j], start);
    if (e >= 0) { end = e; break; }
  }
  return text.slice(start, end);
}

function statsOf(seg) {
  if (seg == null) return { present: false, n: 0, ids: {}, think: 0, seg: '' };
  const m = seg.match(FRAG) || [];
  const ids = {};
  for (const x of m) ids[x] = (ids[x] || 0) + 1;
  return { present: true, n: m.length, ids, think: seg.split('先想一想。').length - 1, seg };
}

/** 读一次页面。prompts = 本用例各轮提示词(按发送顺序)。返回消息区文字、停止键、「⏸」提示、整个消息区片段数,以及每一轮的 { n, ids, think, bubbles }。 */
export async function readView(page, prompts) {
  const raw = await page.evaluate((ps) => {
    const ml = document.querySelector('[data-cgui="message-list"]');
    const text = ml ? ml.innerText : '';
    const stop = Boolean(document.querySelector('[data-cgui="stop-btn"]'));
    const cards = ml ? Array.from(ml.querySelectorAll('[data-cgui="message-user"]')) : [];
    const turns = ml ? Array.from(ml.querySelectorAll('[data-turn-uuid]')) : [];
    const cardOf = ps.map((p) => cards.find((c) => c.innerText.includes(p)) || null);
    const bubbles = ps.map((p, i) => {
      const card = cardOf[i];
      if (!card) return 0;
      let next = null;
      for (let j = i + 1; j < ps.length; j += 1) { if (cardOf[j]) { next = cardOf[j]; break; } }
      const hits = turns.filter((n) => {
        if (!(card.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
        if (next && (n.contains(next) || !(next.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING))) return false;
        return /片段|先想一想/.test(n.innerText);
      });
      return hits.filter((n) => !hits.some((m) => m !== n && m.contains(n))).length;
    });
    return { text, stop, bubbles };
  }, prompts);
  const wholeFrag = (raw.text.match(FRAG) || []).length;
  return {
    t: Date.now(),
    text: raw.text,
    stop: raw.stop,
    notice: /^⏸/m.test(raw.text),
    total: wholeFrag,
    turns: prompts.map((_, i) => ({ ...statsOf(segmentOf(raw.text, prompts, i)), bubbles: raw.bubbles[i] })),
  };
}

/** 反复读页面直到 pred(view) 成立或超时。返回 { ok, v(最后一次读数) }。 */
export async function waitView(page, prompts, pred, timeoutMs, stepMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await readView(page, prompts);
    if (pred(v)) return { ok: true, v };
    if (Date.now() >= end) return { ok: false, v };
    await page.waitForTimeout(stepMs);
  }
}

/** 观察 ms 毫秒,每 250 毫秒读一次页面(读满)。每个读数带 dt(距起点毫秒);each(view) 可在每次读数后做点事。 */
export async function observe(page, prompts, ms, each) {
  const t0 = Date.now();
  const out = [];
  for (;;) {
    const v = await readView(page, prompts);
    v.dt = v.t - t0;
    out.push(v);
    if (each) await each(v);
    if (Date.now() - t0 >= ms) return out;
    await page.waitForTimeout(250);
  }
}

/** 把某一轮的片段数序列压成一行文字,放进断言信息。 */
export function series(samples, ti, pick = (s) => s.turns[ti].n) {
  return samples.map((s) => `${(s.dt / 1000).toFixed(1)}s:${pick(s)}`).join(' ');
}

export function uniqueTag(prefix = '') { return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

/** 合成核对:等同于页面与后端的实时连接断开又连上之后做的那一次历史核对。 */
export async function syntheticReconcile(page) {
  await page.evaluate(() => { window.dispatchEvent(new Event('cgui:ws-reconnected')); });
}
