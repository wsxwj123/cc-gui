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

// ───────────────────────── r188-rollback-flow 用例共用的页面操作与观测 ─────────────────────────
// (只通过页面:文案 / role / title / data-* 锚点)
// 口径照接口文件:观察窗口 = 从消息区第一次出现「重发轮。」起,每 250 毫秒读一次,直到新一轮结束(见过停止键之后停止键消失)后 6 秒。

export const RELAUNCH_SCENARIO = { chunkCount: 5, chunkIntervalMs: 1500, textPrefix: '重发轮。' };
export const countOf = (text, s) => text.split(s).length - 1;

/** 对某条用户消息卡打开「回滚 / 重新编辑」菜单并点指定菜单项(itemName 为菜单项可见文字的正则)。 */
export async function pickRollbackItem(page, prompt, itemName, what) {
  const card = page.locator('[data-cgui="message-user"]').filter({ hasText: prompt }).first();
  await expect(card, `${what}:这条用户消息卡应带 data-message-id(最多等 5 秒)`).toHaveAttribute('data-message-id', /.+/, { timeout: 5_000 });
  // 停止 / 回合刚结束后的头一两秒,消息列表会重排、用户消息卡可能被重新挂载,刚打开的菜单会跟着消失。
  // 所以「悬停 → 点菜单键 → 点菜单项」整组重来:每步短超时,点不到就从悬停重新开始;菜单项一点成功立刻返回(不会点两次)。
  const STEP_MS = 1_200;
  const TOTAL_MS = 8_000;
  const start = Date.now();
  let attempt = 0;
  let lastStep = '悬停用户消息卡';
  let lastErr = '';
  while (Date.now() - start < TOTAL_MS) {
    attempt += 1;
    try {
      lastStep = '悬停用户消息卡';
      await card.hover({ timeout: STEP_MS });
      lastStep = '点「回滚 / 重新编辑」';
      await card.getByTitle('回滚 / 重新编辑').click({ timeout: STEP_MS });
      lastStep = `点菜单项 ${itemName}`;
      await page.getByRole('button', { name: itemName }).click({ timeout: STEP_MS });
      return;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e).split('\n')[0];
      await page.waitForTimeout(150);
    }
  }
  throw new Error(`${what}:${TOTAL_MS} 毫秒内共尝试 ${attempt} 次仍没点到菜单项 ${itemName};最后一次(第 ${attempt} 次)卡在「${lastStep}」:${lastErr}`);
}

/** 「编辑后重发」:点菜单项,等原文回到输入框,不发送。 */
export async function editAndResendFill(page, prompt, what) {
  await pickRollbackItem(page, prompt, /编辑后重发/, what);
  await expect(composerBox(page).last(), `${what}:「编辑后重发」应把原文放回输入框`).toHaveValue(prompt, { timeout: 20_000 });
}

/**
 * 等「重发轮。」第一次出现(最多 appearTimeoutMs),再按观察窗口口径读到结束。
 * t0 = 触发回退的那次点击 / 发送的时刻。返回 { appearMs(从 t0 到第一次出现;没出现为 null), samples(窗口内读数,dt 为距第一次出现的毫秒), doneAt(新一轮结束时刻;没结束为 null) }。
 */
export async function observeRelaunch(page, prompts, t0, { appearTimeoutMs = 40_000, maxWindowMs = 60_000 } = {}) {
  const first = await waitView(page, prompts, (v) => v.text.includes('重发轮。'), appearTimeoutMs, 250);
  if (!first.ok) return { appearMs: null, samples: [first.v], doneAt: null };
  const base = first.v.t;
  const samples = [];
  let seenStop = false;
  let doneAt = null;
  let v = first.v;
  for (;;) {
    v.dt = v.t - base;
    samples.push(v);
    if (v.stop) seenStop = true;
    if (doneAt == null && seenStop && !v.stop) doneAt = v.t;
    if (doneAt != null && v.t - doneAt >= 6000) break;
    if (v.t - base > maxWindowMs) break;
    await page.waitForTimeout(250);
    v = await readView(page, prompts);
  }
  return { appearMs: base - t0, samples, doneAt };
}

/** 后台每 250 毫秒读一次页面,直到 stop();读数带 dt(距 t0 毫秒)。 */
export function startSampler(page, prompts, t0 = Date.now()) {
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const v = await readView(page, prompts);
        v.dt = v.t - t0;
        samples.push(v);
      } catch { /* 页面正在跳转 / 关闭:忽略这一次 */ }
      await page.waitForTimeout(250);
    }
  })();
  return { samples, stop: async () => { running = false; await loop; } };
}

/** 切走再切回:点乙,停 1.5 秒,点回甲,等 5 秒后读一次。 */
export async function switchAwayAndBack(page, ctx, prompts) {
  await clickSession(page, 'yi', ctx);
  await page.waitForTimeout(1500);
  await clickSession(page, 'jia', ctx);
  await page.waitForTimeout(5000);
  return readView(page, prompts);
}

/** 片段编号 → 出现次数。 */
export function fragIds(text) {
  const ids = {};
  for (const x of text.match(/片段\d{4}/g) || []) ids[x] = (ids[x] || 0) + 1;
  return ids;
}

/** 期末(或切回后)的共同断言:片段总数 5、5 个不同编号且各 1 次(withIds)、「重发轮。」恰好 1 次(withRelaunch)。 */
export function expectFiveFragments(view, what, { withIds = true, withRelaunch = true } = {}) {
  expect(view.total, `${what}:整个消息区片段总数应为 5`).toBe(5);
  if (withIds) {
    const ids = fragIds(view.text);
    expect(Object.keys(ids).length, `${what}:应有 5 个不同编号;实际 ${JSON.stringify(ids)}`).toBe(5);
    expect(Math.max(0, ...Object.values(ids)), `${what}:每个编号恰好 1 次;实际 ${JSON.stringify(ids)}`).toBe(1);
  }
  if (withRelaunch) expect(countOf(view.text, '重发轮。'), `${what}:「重发轮。」在消息区出现的次数`).toBe(1);
}
