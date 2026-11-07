// r159-orbit-random：观测面与"造回合"小工具。
// 只用接口文件列出的锚点（[data-live-*]、[data-strip="head"]、[data-work-group*]、[data-loading-*]、localStorage 键）
// 加仓内既有锚点（[data-cgui="…"]、停止键、设置搜索框的占位文字「搜索设置」）；不读源码、不读 React state、不 import 应用内部模块。
import { expect } from '@playwright/test';
import { SESSIONS } from './fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, sendInOpenSession, resetCtl, writeScenario, touchCtl, releaseRound, dismissOverlays,
} from './runtime.mjs';

/** 16 种旋转动画：id / 中文标签 / 圆点数（接口文件「16 种旋转动画」表，原样照抄）。 */
export const ORBITS = [
  { id: 'orbit3', label: '三体旋转', dots: 3 },
  { id: 'orbit4', label: '四体旋转', dots: 4 },
  { id: 'o3-v5', label: '三体·摆动偏转', dots: 3 },
  { id: 'o4-v5', label: '四体·摆动偏转', dots: 4 },
  { id: 'o3-v6', label: '三体·忽停忽翻', dots: 3 },
  { id: 'o4-v6', label: '四体·忽停忽翻', dots: 4 },
  { id: 'o3-tumble', label: '三体·三维翻滚', dots: 3 },
  { id: 'o4-tumble', label: '四体·三维翻滚', dots: 4 },
  { id: 'o3-breath', label: '三体·呼吸环绕', dots: 3 },
  { id: 'o4-breath', label: '四体·呼吸环绕', dots: 4 },
  { id: 'o3-fig8', label: '三体·八字轨道', dots: 3 },
  { id: 'o3-adj', label: '三体·邻位交换', dots: 3 },
  { id: 'o4-adj', label: '四体·邻位交换', dots: 4 },
  { id: 'o4-diag', label: '四体·对角换位', dots: 4 },
  { id: 'o4-counter', label: '四体·内外对转', dots: 4 },
  { id: 'o4-binary', label: '四体·双星互绕', dots: 4 },
];
export const ORBIT_IDS = ORBITS.map((o) => o.id);

/** 「圆点大小约定」：宽高读数全程 ∈ [1.45, 2.65]；12 秒窗口里最大 ≥ 2.2、最小 ≤ 1.95。 */
export const DOT_LO = 1.45;
export const DOT_HI = 2.65;
export const MAX_AT_LEAST = 2.2;
export const MIN_AT_MOST = 1.95;

export const IND = '[data-live-line] [data-live-indicator]';

export const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
export const uniq = (arr) => [...new Set(arr)];
export const lsGet = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

// ───────────────────────── 造回合 ─────────────────────────
// 主回合的停止键：既有锚点 data-cgui="stop-btn"。
export const stopBtn = (page) => page.locator('[data-cgui="stop-btn"]');

export async function waitIdle(page, timeout = 60_000) {
  await expect.poll(async () => await stopBtn(page).count(), { timeout, message: '回合没有结束（"停止生成"键一直在）' }).toBe(0);
}

/** 放开所有闸门（g* = 事件流等待点，d* = 工具结果）并放行回合，让停在半路的假命令行自己收尾。 */
export function openAllGates() {
  for (let i = 1; i <= 16; i += 1) { touchCtl(`g${i}`); touchCtl(`d${i}`); }
  releaseRound();
}

/** 一个带 description 的 Bash 工具事件（状态行的工具标题 = description）。 */
export const bash = (desc, extra = {}) => ({ kind: 'tool', name: 'Bash', input: { command: 'echo r159', description: desc }, ...extra });

/**
 * 阶段表 → 假命令行的事件流。phases[i] = { kind: 'think' } | { kind: 'tool', title }。
 * 第 0 段（必须是思考）发消息后自然出现；第 i 段（i ≥ 1）由闸门 g<i> 放出；工具段不给结果，结果由 d<i> 放出。
 */
export function phaseEvents(phases) {
  const events = [];
  phases.forEach((p, i) => {
    if (i > 0) events.push({ kind: 'wait', file: `g${i}` });
    if (p.kind === 'think') events.push({ kind: 'thinking', text: `R159 思考 ${i}。` });
    else events.push(bash(p.title, { pending: `d${i}` }));
  });
  return events;
}

/** 写场景 → （可选）减弱动画 → 预置 localStorage → 打开应用 → 打开夹具会话；还不发消息。 */
export async function prepareLive(page, { key, scenario, presets = {}, reducedMotion = false }) {
  resetCtl();
  writeScenario({ stepDelayMs: 120, holdBeforeResult: true, ...scenario });
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await primeOverlays(page, presets);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS[key].marker);
}

export async function sendRound(page, text = '请开始这一轮') {
  await sendInOpenSession(page, text);
}

/** 刷新页面并等应用重新挂好。 */
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

export async function expectPhase(page, phase, timeout = 30_000) {
  await expect.poll(
    async () => await page.evaluate(() => { const l = document.querySelector('[data-live-line]'); return l ? l.getAttribute('data-live-phase') : null; }),
    { timeout, message: `底部状态行 [data-live-line] 的 data-live-phase 应变成 ${phase}` },
  ).toBe(phase);
}

// ───────────────────────── 页内采样器（后台跑，不占测试线程） ─────────────────────────
/**
 * 往页面里装一个定时采样器（每 stepMs 毫秒一次），每次记：墙钟时间、状态行个数、phase、状态词、
 * 指示器的 data-style / data-loading-mode（没有该属性时为 null）/ data-speed、整页 [data-strip="head"] 个数、
 * 以及指示器根元素直接子元素 <i>（圆点）的 [宽, 高, 中心x, 中心y]。
 * 页面里的 Date.now() 与 Node 里的 Date.now() 是同一块系统时钟，所以可以拿测试里记的"放行时刻"去切时间窗。
 */
export async function startSampler(page, stepMs = 100) {
  await page.evaluate((step) => {
    if (window.__r159Iv) clearInterval(window.__r159Iv);
    window.__r159S = [];
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const read = () => {
      const lines = document.querySelectorAll('[data-live-line]');
      const line = lines[0] || null;
      const ind = line ? line.querySelector('[data-live-indicator]') : null;
      const textEl = line ? line.querySelector('[data-live-text]') : null;
      const ir = ind ? ind.getBoundingClientRect() : null;
      const dots = ind ? [...ind.children].filter((c) => c.tagName === 'I').map((d) => {
        const r = d.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // 读数 = [宽, 高, 中心x, 中心y, 相对指示器根元素中心的 dx, dy]；后两项不受页面滚动 / 版面挪动影响，只反映圆点在指示器里的位置。
        return [r.width, r.height, cx, cy, cx - (ir.left + ir.width / 2), cy - (ir.top + ir.height / 2)];
      }) : [];
      window.__r159S.push({
        wall: Date.now(),
        lines: lines.length,
        phase: line ? line.getAttribute('data-live-phase') : null,
        text: textEl ? clean(textEl.textContent) : null,
        hasInd: !!ind,
        style: ind ? ind.getAttribute('data-style') : null,
        mode: ind ? ind.getAttribute('data-loading-mode') : null,
        speed: ind ? ind.getAttribute('data-speed') : null,
        strips: document.querySelectorAll('[data-strip="head"]').length,
        dots,
      });
    };
    read();
    window.__r159Iv = setInterval(read, step);
  }, stepMs);
}

export async function stopSampler(page) {
  return await page.evaluate(() => {
    if (window.__r159Iv) clearInterval(window.__r159Iv);
    window.__r159Iv = null;
    return window.__r159S || [];
  });
}

/**
 * 按阶段表放行并采样。phases[i].ms = 该阶段持续多久。
 * 第 0 段在状态行出现 thinking 之后开始计时；进入第 i+1 段时：若第 i 段是工具，先放它的结果 d<i>，再放闸门 g<i+1>。
 * 返回 { samples, starts, ends }：starts[i] / ends[i] 是第 i 段的放行时刻 / 下一段的放行时刻（最后一段 = 采样结束时刻）。
 */
export async function playPhases(page, phases, { stepMs = 100 } = {}) {
  await startSampler(page, stepMs);
  await expectPhase(page, 'thinking');
  const starts = [Date.now()];
  for (let i = 0; i < phases.length; i += 1) {
    await page.waitForTimeout(phases[i].ms);
    if (i === phases.length - 1) break;
    if (phases[i].kind === 'tool') touchCtl(`d${i}`);
    touchCtl(`g${i + 1}`);
    starts.push(Date.now());
  }
  const ends = [...starts.slice(1), Date.now()];
  const samples = await stopSampler(page);
  return { samples, starts, ends };
}

// ───────────────────────── 主题弹层「界面」页 / 设置面板 ─────────────────────────
/** 主题弹层 →「界面」页（办法照 r154-ui-live-line 的 openInterfaceTab）。 */
export async function openInterfaceTab(page) {
  await page.locator('[data-cgui="theme-btn"]').click();
  await page.getByRole('tab', { name: '界面' }).click();
  await expect(page.getByText('加载动画').first(), '前置自证：「界面」页应有「加载动画」分组').toBeVisible({ timeout: 10_000 });
}

export const loadingGrid = (page) => page.locator('[role="radiogroup"][aria-label="加载动画样式"]');

/** 关主题弹层：先按 Escape，还开着就再点一次主题按钮。 */
export async function closeThemePopover(page) {
  const probe = page.locator('[data-loading-option]').first();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  if (await probe.isVisible().catch(() => false)) {
    await page.locator('[data-cgui="theme-btn"]').click();
    await page.waitForTimeout(400);
  }
  await expect(probe, '前置：主题弹层应已关闭（加载动画选项格不再可见）').toBeHidden({ timeout: 5_000 });
}

export const settingsSearch = (page) => page.getByPlaceholder(/搜索设置/).first();

/** 打开设置面板（Cmd/Ctrl+0 直达；不灵就点顶栏设置按钮），落在默认页，不点任何页签。 */
export async function openSettings(page) {
  const box = settingsSearch(page);
  const combo = process.platform === 'darwin' ? 'Meta+0' : 'Control+0';
  let attempt = 0;
  await expect(async () => {
    if (await box.isVisible().catch(() => false)) return;
    attempt += 1;
    if (attempt % 2 === 1) await page.keyboard.press(combo);
    else await page.locator('[data-cgui="settings-btn"]').first().click({ timeout: 3_000 }).catch(() => {});
    await expect(box).toBeVisible({ timeout: 4_000 });
  }, '设置面板应当打开（能看到「搜索设置」输入框）').toPass({ timeout: 40_000 });
}

/**
 * 在页内对设置网格里的每一格采样 durationMs 毫秒（每 stepMs 毫秒读一次）：
 * 每格的指示器根元素 = 格内第一个带 data-style 的元素；圆点 = 根元素的直接子元素 <i>；读它的 getBoundingClientRect 宽 / 高。
 * 16 格放在同一个 12 秒窗口里一起读（等价于逐格各读 12 秒，只是不串行排队）。
 */
export async function sampleGrid(page, ids, durationMs = 12_000, stepMs = 100) {
  return await page.evaluate(async ({ ids: list, durationMs: dur, stepMs: step, lo, hi }) => {
    const out = {};
    for (const id of list) out[id] = { found: false, root: false, styleAttr: null, dotCount: 0, n: 0, min: null, max: null, bad: 0 };
    const t0 = performance.now();
    for (;;) {
      for (const id of list) {
        const o = out[id];
        const cell = document.querySelector(`[data-loading-option="${id}"]`);
        if (!cell) continue;
        o.found = true;
        const root = cell.querySelector('[data-style]') || cell.querySelector('[data-live-indicator]');
        if (!root) continue;
        o.root = true;
        o.styleAttr = root.getAttribute('data-style');
        const dots = [...root.children].filter((c) => c.tagName === 'I');
        o.dotCount = dots.length;
        for (const d of dots) {
          const r = d.getBoundingClientRect();
          for (const v of [r.width, r.height]) {
            o.n += 1;
            o.min = o.min === null ? v : Math.min(o.min, v);
            o.max = o.max === null ? v : Math.max(o.max, v);
            if (v < lo || v > hi) o.bad += 1;
          }
        }
      }
      if (performance.now() - t0 >= dur) break;
      await new Promise((r) => setTimeout(r, step));
    }
    return out;
  }, { ids, durationMs, stepMs, lo: DOT_LO, hi: DOT_HI });
}
