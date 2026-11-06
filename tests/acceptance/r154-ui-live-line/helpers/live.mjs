// r154-ui-live-line：底部状态行 / 指示器 / 流光 / 过程条条目 / 子代理卡的观测面与"造回合"小工具。
// 只用接口文件列出的锚点（[data-live-*]、.live-shine、[data-strip*]、[data-entry-*]、[data-agent-*]、[data-loading-*]）
// 加仓内既有锚点（[data-cgui="…"]、停止键的公开名字「停止生成」）；不读源码、不读 React state。
import { expect } from '@playwright/test';
import { SESSIONS } from './fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, sendInOpenSession, resetCtl, writeScenario, touchCtl, releaseRound,
} from './runtime.mjs';

export const LIVE = '[data-live-line]';
export const IND = '[data-live-line] [data-live-indicator]';
export const SUBVIEW = '[data-cgui="subagent-view"]';

/** 接口文件 §3 的英文词禁令（页面里任何地方都不得再出现）。 */
export const BANNED_WORDS = [
  'Frolicking', 'Pondering', 'Brewing', 'Cogitating', 'Mulling', 'Conjuring', 'Crafting', 'Weaving', 'Synthesizing',
  'Noodling', 'Spelunking', 'Marinating', 'Percolating', 'Ruminating', 'Connecting', 'Writing', 'Compacting',
];

// 主回合的停止键：既有锚点 data-cgui="stop-btn"（可见文字只有「停止」，title 才是「停止生成」；
// 按角色名 /停止/ 还会误中子代理卡上的「停止该子代理/teammate」，所以不用角色名）。
export const stopBtn = (page) => page.locator('[data-cgui="stop-btn"]');

/** 等回合结束：「停止生成」键消失（与既有套件同一判据）。 */
export async function waitIdle(page, timeout = 60_000) {
  await expect.poll(async () => await stopBtn(page).count(), { timeout, message: '回合没有结束（"停止生成"键一直在）' }).toBe(0);
}

/** 放开所有闸门（g* = 事件流等待点，d* = 工具结果）并放行回合，让停在半路的假命令行自己收尾。 */
export function openAllGates() {
  for (let i = 1; i <= 16; i += 1) { touchCtl(`g${i}`); touchCtl(`d${i}`); }
  releaseRound();
}

/**
 * 开一个生成中的回合：写场景 → 预置 localStorage → 打开应用 → 打开夹具会话 → 发消息。
 * 同一页第二次调用也行（会再导航一次；后注册的预置覆盖先注册的同名键）。返回发送消息的时刻（毫秒时间戳）。
 */
export async function startRound(page, { key, scenario, text = '请开始这一轮', presets = {} }) {
  resetCtl();
  writeScenario({ stepDelayMs: 120, holdBeforeResult: true, ...scenario });
  await primeOverlays(page, presets);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS[key].marker);
  const sentAt = Date.now();
  await sendInOpenSession(page, text);
  return sentAt;
}

export async function endRound(page) {
  openAllGates();
  await waitIdle(page);
}

// ───────────────────────── 底部状态行快照 ─────────────────────────
export async function liveSnap(page, scope = null) {
  return await page.evaluate((scopeSel) => {
    const root = scopeSel ? document.querySelector(scopeSel) : document;
    if (!root) return { count: 0, scopeMissing: true };
    const lines = [...root.querySelectorAll('[data-live-line]')];
    if (!lines.length) return { count: 0 };
    const l = lines[0];
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const attrs = ['data-live-indicator', 'data-live-elapsed', 'data-live-sep', 'data-live-text'];
    const parts = [...l.querySelectorAll(attrs.map((a) => `[${a}]`).join(','))];
    const text = l.querySelector('[data-live-text]');
    const verbEl = text ? text.querySelector('[data-live-verb]') : null;
    const objEl = text ? text.querySelector('[data-live-object]') : null;
    const elapsedEl = l.querySelector('[data-live-elapsed]');
    const sepEl = l.querySelector('[data-live-sep]');
    const ind = l.querySelector('[data-live-indicator]');
    return {
      count: lines.length,
      phase: l.getAttribute('data-live-phase'),
      role: l.getAttribute('role'),
      order: parts.map((el) => attrs.find((a) => el.hasAttribute(a))),
      elapsed: elapsedEl ? norm(elapsedEl.textContent) : null,
      sep: sepEl ? sepEl.textContent : null,
      text: text ? norm(text.textContent) : null,
      verb: verbEl ? norm(verbEl.textContent) : null,
      object: objEl ? norm(objEl.textContent) : null,
      indicator: ind ? { style: ind.getAttribute('data-style'), speed: ind.getAttribute('data-speed'), dots: ind.querySelectorAll('i').length } : null,
    };
  }, scope);
}

export async function expectOneLine(page, { scope = null, timeout = 15_000, message } = {}) {
  await expect.poll(async () => (await liveSnap(page, scope)).count, {
    timeout, message: message || '生成中：页面里应恰好有 1 个底部状态行 [data-live-line]',
  }).toBe(1);
}

export async function expectPhase(page, phase, { scope = null, timeout = 20_000 } = {}) {
  await expect.poll(async () => (await liveSnap(page, scope)).phase ?? null, {
    timeout, message: `底部状态行的 data-live-phase 应变成 ${phase}`,
  }).toBe(phase);
}

/** 没有 object 的状态词：[data-live-object] 不存在或为空。 */
export const noObject = (snap) => snap.object === null || snap.object === '';

/** 用时文字 `12s` / `1m 5s` → 秒数；格式不符返回 null。 */
export function parseElapsed(text) {
  const m = /^(?:(\d+)m )?(\d+)s$/.exec((text || '').trim());
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
}

/** 在页面里每 50 毫秒读一次用时文字，返回 ms 毫秒内每次变化的 {t, text}。 */
export async function watchElapsed(page, ms = 4500) {
  return await page.evaluate((dur) => new Promise((resolve) => {
    const read = () => { const e = document.querySelector('[data-live-line] [data-live-elapsed]'); return e ? e.textContent.trim() : null; };
    let last = read();
    const log = [{ t: performance.now(), text: last }];
    const iv = setInterval(() => { const cur = read(); if (cur !== last) { last = cur; log.push({ t: performance.now(), text: cur }); } }, 50);
    setTimeout(() => { clearInterval(iv); resolve(log); }, dur);
  }), ms);
}

/** 版式事实：状态行是否在消息列表里、其后是否还有本回合的正文 / 过程条 / 子代理卡。 */
export async function layoutFacts(page, marker) {
  return await page.evaluate((mk) => {
    const live = document.querySelector('[data-live-line]');
    if (!live) return { present: false };
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    const isAfter = (n) => !live.contains(n) && (live.compareDocumentPosition(n) & FOLLOWING) !== 0;
    const after = [];
    for (const sel of ['[data-strip-root]', '[data-strip="head"]', '[data-strip-item]', '[data-agent-icon]', '[data-agent-beam]']) {
      document.querySelectorAll(sel).forEach((el) => { if (isAfter(el)) after.push(sel); });
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      if (n.nodeValue && n.nodeValue.includes(mk) && isAfter(n)) after.push(`text:${mk}`);
      n = walker.nextNode();
    }
    return {
      present: true,
      inMessageList: !!live.closest('[data-cgui="message-list"], [data-chat-scroll]'),
      stripRoots: document.querySelectorAll('[data-strip-root]').length,
      after,
    };
  }, marker);
}

/** 页面（或某个范围）里出现的被禁英文词。 */
export async function bannedWordsOnPage(page, scope = null) {
  return await page.evaluate(({ words, scopeSel }) => {
    const root = scopeSel ? document.querySelector(scopeSel) : document.body;
    const t = (root && root.innerText) || '';
    return words.filter((w) => new RegExp(`\\b${w}\\b`).test(t));
  }, { words: BANNED_WORDS, scopeSel: scope });
}

// ───────────────────────── 指示器：颜色 / 动 / 转速 ─────────────────────────
export async function indicatorColor(page) {
  return await page.locator(IND).first().evaluate((el) => getComputedStyle(el).color);
}

/** 根元素上 --color-accent 的原文与"算成 rgb()"后的值（没有该变量时 rgb 为 null）。 */
export async function accentRgb(page) {
  return await page.evaluate(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
    if (!raw) return { raw, rgb: null };
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--color-accent)';
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return { raw, rgb };
  });
}

/** 改主题强调色：往根元素写 CSS 变量（与主题系统同一落点，只用公开面）。 */
export async function setAccent(page, color) {
  await page.evaluate((c) => document.documentElement.style.setProperty('--color-accent', c), color);
}

/** 指示器与它里面每个 <i> 点的 transform，每 step 毫秒采一次，共 ms 毫秒。 */
export async function dotsMotion(page, { ms = 700, step = 100 } = {}) {
  return await page.evaluate(async ({ dur, gap }) => {
    const ind = document.querySelector('[data-live-line] [data-live-indicator]');
    const dots = ind ? [...ind.querySelectorAll('i')] : [];
    const nodes = ind ? [ind, ...dots] : [];
    const read = () => nodes.map((n) => getComputedStyle(n).transform);
    const samples = [read()];
    const t0 = performance.now();
    while (performance.now() - t0 < dur) {
      await new Promise((r) => setTimeout(r, gap));
      samples.push(read());
    }
    return { dots: dots.length, samples };
  }, { dur: ms, gap: step });
}
export const distinct = (samples) => new Set(samples.map((s) => JSON.stringify(s))).size;

/** 逐帧累加每个点的位置变化（取点中心）；返回 ms 毫秒内的位移总量与帧数。 */
export async function measureDisplacement(page, ms = 1000) {
  return await page.evaluate((dur) => new Promise((resolve) => {
    const ind = document.querySelector('[data-live-line] [data-live-indicator]');
    const dots = ind ? [...ind.querySelectorAll('i')] : [];
    const center = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    let prev = dots.map(center);
    let total = 0;
    let frames = 0;
    const t0 = performance.now();
    const step = (t) => {
      const cur = dots.map(center);
      cur.forEach((c, i) => { total += Math.hypot(c[0] - prev[i][0], c[1] - prev[i][1]); });
      prev = cur;
      frames += 1;
      if (t - t0 < dur) requestAnimationFrame(step); else resolve({ total, frames, dots: dots.length });
    };
    requestAnimationFrame(step);
  }), ms);
}

// ───────────────────────── 流光 ─────────────────────────
export async function shineSnap(page) {
  return await page.evaluate(() => {
    const els = [...document.querySelectorAll('.live-shine')];
    const secs = (s) => { const first = String(s).split(',')[0].trim(); const v = parseFloat(first); return /ms$/.test(first) ? v / 1000 : v; };
    return {
      count: els.length,
      outside: els.filter((e) => !e.closest('[data-live-text]')).length,
      items: els.map((e) => {
        const cs = getComputedStyle(e);
        return {
          name: cs.animationName, duration: secs(cs.animationDuration), durationRaw: cs.animationDuration,
          color: cs.color, fill: cs.webkitTextFillColor, bgImage: cs.backgroundImage, clip: cs.backgroundClip || cs.webkitBackgroundClip || '',
        };
      }),
    };
  });
}

const alphaOf = (c) => {
  const m = /rgba?\(([^)]+)\)/.exec(c || '');
  if (!m) return null;
  const p = m[1].split(/[,\s/]+/).filter(Boolean);
  return p.length >= 4 ? parseFloat(p[3]) : 1;
};
/** 文字是否纯色：字形填充不透明、颜色不透明，且没有"渐变背景裁成文字"。 */
export function isSolidText(item) {
  if (alphaOf(item.fill) === 0 || alphaOf(item.color) === 0) return false;
  if (/text/.test(item.clip) && item.bgImage && item.bgImage !== 'none') return false;
  return true;
}

// ───────────────────────── 动画：某棵子树里"在循环的动画" ─────────────────────────
/**
 * 子树里正在循环（animation-iteration-count 含 infinite）的 CSS 动画元素 + 所有 SMIL 动画元素的描述列表。
 * 一次性的入场动画（淡入等）不算"运行中的动画元素"。visibleOnly：只数当前看得见的元素。
 */
export async function loopingAnimations(locator, { visibleOnly = false } = {}) {
  return await locator.evaluate((root, onlyVisible) => {
    const all = [root, ...root.querySelectorAll('*')];
    const vis = (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0);
    return all.filter((el) => {
      const cs = getComputedStyle(el);
      const css = cs.animationName !== 'none' && /infinite/.test(cs.animationIterationCount) && cs.animationPlayState !== 'paused';
      const smil = /^(animate|animatetransform|animatemotion|set)$/i.test(el.tagName);
      return (css || smil) && (!onlyVisible || vis(el));
    }).map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('class') ? `.${String(el.getAttribute('class')).split(/\s+/)[0]}` : ''}|${getComputedStyle(el).animationName}`);
  }, visibleOnly);
}

// ───────────────────────── 过程条 / 子代理卡 ─────────────────────────
/**
 * 保证直播过程条展开，并把默认收起的"思考 · N 次工具调用"组点开，直到 want 选择器有元素；返回是否出现。
 * scope（可选，一个 Locator，通常是本回合的 [data-strip-root]）：头行、条目、过程组都只在这棵子树里找；
 * 不传 = 整页（既有行为）。夹具里有历史回合时必须传，否则会把历史回合的过程组一起点开，条目数就对不上。
 */
export async function openStripEntries(page, want = '[data-entry-state]', timeout = 6_000, scope = null) {
  const within = (sel) => (scope ? scope.locator(sel) : page.locator(sel));
  const head = (scope ? within('[data-strip="head"]') : page.locator('[data-strip="head"][data-strip-live="true"]')).first();
  if ((await head.count()) && (await head.getAttribute('aria-expanded')) === 'false') await head.click();
  const has = async () => (await within(want).count()) > 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await has()) return true;
    await page.waitForTimeout(200);
  }
  const groups = within('[data-strip-item="group"] > div > button');
  const n = await groups.count();
  for (let i = 0; i < n; i += 1) await groups.nth(i).click().catch(() => {});
  await page.waitForTimeout(600);
  return await has();
}

/** 每个 [data-entry-state] 条目的状态，按 DOM 顺序。scope（可选 Locator）：只数这棵子树里的；不传 = 整页（既有行为）。 */
export async function entryStates(page, scope = null) {
  const entries = scope ? scope.locator('[data-entry-state]') : page.locator('[data-entry-state]');
  return await entries.evaluateAll((els) => els.map((e) => e.getAttribute('data-entry-state')));
}

/** 子代理卡（按卡片标题文字定位）里的九宫格 / 边框光事实。 */
export async function agentCardFacts(page, title) {
  // r157:子代理调用进了工作组(运行中默认收起),卡片在组内条目 [data-entry-state] 里;找不到就先把收起的组点开再找。
  const find = () => page.locator('[data-entry-state]').filter({ hasText: title }).first();
  let card = find();
  if (!(await card.count())) {
    const heads = page.locator('[data-work-group-state="closed"] [data-work-group-head]');
    for (let n = await heads.count(), i = 0; n > 0 && i < 10; n = await heads.count(), i += 1) {
      await heads.first().click().catch(() => {});
      await page.waitForTimeout(200);
    }
    card = find();
  }
  if (!(await card.count())) return { present: false };
  return await card.evaluate((el) => {
    const icons = [...el.querySelectorAll('[data-agent-icon="matrix"]')];
    const beams = [...el.querySelectorAll('[data-agent-beam]')];
    return {
      present: true,
      matrix: icons.length,
      matrixRects: icons.map((i) => i.querySelectorAll('rect').length),
      beams: beams.length,
      beamRects: beams.map((b) => b.querySelectorAll('rect').length),
      beamLayers: beams.map((b) => b.querySelectorAll('[data-beam-layer]').length),
      beamDisplay: beams.map((b) => getComputedStyle(b).display),
    };
  });
}

// ───────────────────────── 页内观察器：抓"只存在一瞬间"的阶段（如 stopping） ─────────────────────────
/**
 * 往页面里装一个 MutationObserver（观察 document.body；子树 / 子节点 / 属性 / 文字变动全开）。
 * 每次回调读一次 document.querySelector('[data-live-line]')，把 { phase, role, text, verb, object, hasObject }
 * 追加进 window.__r154Line；页面上没有该元素时不记。用来抓「停止中」这种只存在一两百毫秒、轮询抓不住的阶段：
 * 点停止 → 流被中断 → 回合收尾 → 状态行整行卸载，轮询（100–1000 毫秒间隔）很可能一次都撞不上。
 * 必须在点停止之前装；每次调用都会清空数组并换掉旧观察器。页面导航后是新文档，要重新装，别跨用例复用。
 */
export async function installLineObserver(page) {
  await page.evaluate(() => {
    if (window.__r154LineObs) window.__r154LineObs.disconnect();
    window.__r154Line = [];
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const obs = new MutationObserver(() => {
      const el = document.querySelector('[data-live-line]');
      if (!el) return;
      const text = el.querySelector('[data-live-text]');
      const verb = text ? text.querySelector('[data-live-verb]') : null;
      const obj = el.querySelector('[data-live-object]');
      window.__r154Line.push({
        phase: el.getAttribute('data-live-phase'),
        role: el.getAttribute('role'),
        text: text ? norm(text.textContent) : null,
        verb: verb ? norm(verb.textContent) : null,
        object: obj ? norm(obj.textContent) : null,
        hasObject: !!obj,
      });
    });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__r154LineObs = obs;
  });
}

/** 读观察器到目前为止记下的全部快照（按时间顺序）；没装过观察器返回空数组。 */
export async function lineLog(page) {
  return await page.evaluate(() => (Array.isArray(window.__r154Line) ? window.__r154Line.slice() : []));
}

/** 快照里 data-live-phase 的变化轨迹，如 `text×58 → stopping×2`（连续相同的合并计数）；失败消息里用。 */
export function phaseTrail(log) {
  const runs = [];
  for (const r of log) {
    const last = runs[runs.length - 1];
    if (last && last.phase === r.phase) last.n += 1; else runs.push({ phase: r.phase, n: 1 });
  }
  return runs.length ? runs.map((x) => `${x.phase}×${x.n}`).join(' → ') : '（观察器一条都没记到）';
}

/** 取出快照里 stopping 阶段的那些；一条都没有就直接断言失败（"没有观察到 stopping 阶段"）。 */
export function stoppingRecords(log) {
  const rows = log.filter((r) => r.phase === 'stopping');
  expect(rows.length, `没有观察到 stopping 阶段：点停止之后底部状态行的 data-live-phase 始终没变成 stopping（页内观察器记到的阶段轨迹：${phaseTrail(log)}）`).toBeGreaterThan(0);
  console.log(`[R154 观察器] 阶段轨迹：${phaseTrail(log)}（其中 stopping 快照 ${rows.length} 条）`); // 留一行痕迹，将来排查偶发时看得出抓到了几条
  return rows;
}
