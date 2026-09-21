// 条带折叠 + 渐进挂载验收套件的运行时守卫与观测面。
//
// 铁规（与同批其它验收套件同口径）：
//   · 只连 127.0.0.1 上的**本套件自己的**隔离实例；用户正在用的 6677 / 6689 一律拒。
//   · 观测只用公开文案 / role / title / `data-*` 锚点。本套件依赖的锚点全部来自
//     .devflow/INTERFACE-20260912-stripfold.md §D（`data-strip-root` / `data-strip-state` /
//     `data-strip="head"` / `data-strip-item` / `data-strip-steps` / `data-strip-rounds` / `data-turn-placeholder`），
//     以及仓内既有锚点（`[data-turn-uuid]`、消息滚动容器）。
//   · 找不到东西时报"环境不成立"（EnvironmentBlocked），别报成产品缺陷。
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

export function suitePath(...parts) { return path.join(suiteDir, ...parts); }

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
    throw new EnvironmentBlocked('ports 6677 and 6689 are the user instances; use run-isolated.sh');
  }
  if (port < 6700) throw new EnvironmentBlocked(`port ${port} is outside the reserved test range (6700+)`);
  return { baseURL: url.toString().replace(/\/$/, ''), port };
}

export function fixtureManifest() {
  const file = suitePath('fixture-manifest.local.json');
  if (!fs.existsSync(file)) {
    throw new EnvironmentBlocked(`missing ${file}; run \`node helpers/fixtures.mjs\` (run-isolated.sh does it for you)`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ───────────────────────── 导航（像真实用户那样点）─────────────────────────
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

/**
 * 每次导航前预置"使用指引已看过"（一层与被测行为无关的整屏遮罩）。
 * 〈2026-09-21 r122〉同时预置「过程块自动折叠」开关为**开启**（localStorage `cgui-auto-fold-process`='1'，
 * INTERFACE-r122 A1 的公开契约）：r122 把默认改成"不自动折叠"，本套件验证的是折叠逻辑本身，
 * 所以在开关开启的前提下继续跑，用例与断言一字不动。
 */
export async function primeOverlays(page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cgui-tour-seen', '1');
      localStorage.setItem('cgui-auto-fold-process', '1');
    } catch { /* 忽略 */ }
  });
}

export async function openApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await dismissOverlays(page);
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 30_000 });
}

/** 侧栏搜索 marker → 点结果行 → 夹具会话打开（同批套件验证过的走法）。 */
export async function openSessionByMarker(page, marker) {
  await dismissOverlays(page);
  const search = page.getByRole('textbox', { name: /搜索项目/ }).first();
  await search.fill(marker);
  const result = page.getByRole('button', { name: new RegExp(marker) }).first();
  await expect(result, `侧栏搜不到夹具会话 ${marker} —— 夹具没落进这个实例的数据根`).toBeVisible({ timeout: 25_000 });
  await result.click({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await dismissOverlays(page);
  // 会话打开的判据：消息流里出现了轮行。
  await expect(page.locator('[data-turn-uuid]').first()).toBeVisible({ timeout: 30_000 });
}

export function composerBox(page) {
  return page.getByPlaceholder(/输入消息|开始一个新会话|发消息|问点什么/).or(page.locator('textarea'));
}

/** 侧栏点夹具项目 → 新建会话 → 返回输入框（真回合用例走这条路，cwd 才固定）。 */
export async function newSessionInFixtureProject(page, projectHint = /fixture-workspace/) {
  await dismissOverlays(page);
  const proj = page.getByText(projectHint).first();
  await expect(proj, '侧栏没有夹具项目 —— HOME 或夹具落点不对').toBeVisible({ timeout: 25_000 });
  await proj.click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  const plus = page.getByRole('button', { name: /^\+$|新建|新会话/ }).first();
  if (await plus.count()) {
    await plus.click({ timeout: 5_000 }).catch(() => null);
    await page.waitForTimeout(400);
  }
  const box = composerBox(page).last();
  await expect(box).toBeVisible({ timeout: 15_000 });
  return box;
}

export const stopButton = (page) => page.getByRole('button', { name: /停止|中断/ });

// ───────────────────────── 观测面：条带（INTERFACE §D）─────────────────────
export const turnRows = (page) => page.locator('[data-turn-uuid][data-turn-role="turn"]');
export const allRows = (page) => page.locator('[data-turn-uuid]');

/**
 * 一轮的"当前显示状态"快照（全部是公开锚点，不碰内部变量）。
 * 入参既可以是那一轮的行，也可以是条带根自身（流式气泡没有 data-turn-uuid，用根更省事）。
 */
export async function stripSnapshot(scope) {
  const isRoot = (await scope.getAttribute('data-strip-root').catch(() => null)) !== null;
  const root = isRoot ? scope : scope.locator('[data-strip-root]');
  if (!(await root.count())) return { present: false };
  const head = root.locator('[data-strip="head"]');
  const items = root.locator('[data-strip-item]');
  return {
    present: true,
    state: await root.first().getAttribute('data-strip-state'),
    rounds: await root.first().getAttribute('data-strip-rounds'),
    steps: await root.first().getAttribute('data-strip-steps'),
    headCount: await head.count(),
    headText: (await head.count()) ? (await head.first().textContent() || '').trim() : null,
    headAria: (await head.count()) ? await head.first().getAttribute('aria-expanded') : null,
    headTitle: (await head.count()) ? await head.first().getAttribute('title') : null,
    headHeight: (await head.count()) ? (await head.first().boundingBox())?.height ?? 0 : 0,
    kinds: await items.evaluateAll((els) => els.map((el) => el.getAttribute('data-strip-item'))),
    hiddenKinds: await items.evaluateAll((els) => els.filter((el) => el.hasAttribute('hidden'))
      .map((el) => el.getAttribute('data-strip-item'))),
    itemHeights: await items.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height))),
    itemTextLens: await items.evaluateAll((els) => els.map((el) => (el.textContent || '').trim().length)),
    /** 头行在条带根里的子元素序号：判"头行恒为第一个子元素"（J5）。 */
    headIndex: await root.first().evaluate((el) => {
      const h = el.querySelector('[data-strip="head"]');
      return h ? [...el.children].indexOf(h) : -1;
    }),
  };
}

/** 第 n 个 turn 行（1 基）。用具例只读，不做归因。 */
export const turnRowAt = (page, n) => turnRows(page).nth(n - 1);

/** 某轮里出现某段文字的那一行（真回合用例靠它跨"流式气泡→持久化轮"认同一轮）。 */
export const rowContaining = (page, text) => turnRows(page).filter({ hasText: text }).first();

// ───────────────────────── 观测面：滚动 / 挂载（INTERFACE §H）────────────────
/** 消息滚动容器：优先用产品既有锚点，取真正能滚的那个。 */
export async function scrollBox(page) {
  const candidates = ['[data-chat-scroll]', '[data-cgui="message-list"]'];
  let firstFound = null;
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (!(await loc.count())) continue;
    if (!firstFound) firstFound = loc;
    const scrollable = await loc.evaluate((el) => el.scrollHeight > el.clientHeight + 4).catch(() => false);
    if (scrollable) return loc;
  }
  if (firstFound) return firstFound;
  throw new EnvironmentBlocked('找不到消息滚动容器（[data-chat-scroll] / [data-cgui="message-list"] 都不在）');
}

export async function scrollMetrics(page) {
  const box = await scrollBox(page);
  return await box.evaluate((el) => ({
    scrollTop: Math.round(el.scrollTop),
    scrollHeight: Math.round(el.scrollHeight),
    clientHeight: Math.round(el.clientHeight),
    mountedRows: el.querySelectorAll('[data-turn-uuid]').length,
    placeholders: el.querySelectorAll('[data-turn-placeholder]').length,
  }));
}

/** 滚到某个位置（绝对），并等一帧让布局落定。 */
export async function scrollTo(page, top) {
  const box = await scrollBox(page);
  await box.evaluate((el, t) => { el.scrollTop = t; }, top);
  await page.waitForTimeout(120);
}

export async function scrollToTop(page) {
  await scrollTo(page, 0);
}

export async function scrollToBottom(page) {
  const box = await scrollBox(page);
  await box.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);
}

/** 轮询式等待（不许写"等 3 秒"）：条件成立即返回，超时抛人话。 */
export async function waitFor(page, label, fn, { timeout = 20_000, interval = 200 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn().catch((e) => ({ error: String(e && e.message) }));
    if (last && last.ok) return last.value;
    await page.waitForTimeout(interval);
  }
  throw new Error(`等不到「${label}」：${JSON.stringify(last)}`);
}

/** 挂载行数（已挂载的 [data-turn-uuid]），用于渐进挂载的判据。 */
export async function mountedRowCount(page) {
  return await allRows(page).count();
}

/** 像用户那样滚（滚轮事件，不是直接写 scrollTop —— 否则触发不到产品的"用户滚走了"判据）。 */
export async function userScroll(page, deltaY, { steps = 12 } = {}) {
  const box = await scrollBox(page);
  const b = await box.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(250);
}

/** 视口最上方那一行（含它的 uuid 与相对滚动容器的偏移）——补齐不跳视口的判据用它。 */
export async function topVisibleRow(page) {
  const box = await scrollBox(page);
  return await box.evaluate((el) => {
    const boxTop = el.getBoundingClientRect().top;
    const rows = [...el.querySelectorAll('[data-turn-uuid]')];
    const hit = rows.find((r) => r.getBoundingClientRect().bottom > boxTop + 1);
    if (!hit) return null;
    return {
      uuid: hit.getAttribute('data-turn-uuid'),
      offsetFromBoxTop: Math.round(hit.getBoundingClientRect().top - boxTop),
    };
  });
}

// ───────────────────────── 搜索（Cmd+F · 窗内检索）────────────────────────
// 锚点：`[data-cgui="chat-search"]` 浮层 + 其中的 `input[placeholder="窗内检索…"]`
// + 命中计数（形如 `1/6`）+ 上一个/下一个/关闭三个按钮（title 里带快捷键）。
export const searchUi = (page) => page.locator('[data-cgui="chat-search"]');

export async function openSearch(page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  const box = searchUi(page).getByPlaceholder(/窗内检索/).first();
  await expect(box, 'Cmd+F 之后没出现窗内检索输入框').toBeVisible({ timeout: 10_000 });
  return box;
}

export async function runSearch(page, text) {
  const box = await openSearch(page);
  await box.fill(text);
  await page.waitForTimeout(350);
  return box;
}

export async function closeSearch(page) {
  await page.keyboard.press('Escape');
  await expect(searchUi(page)).toHaveCount(0, { timeout: 5_000 });
}

/** 命中计数（`当前/总数`）。浮层在但没显示计数时，返回 `{current:0,total:0}`（= 没命中）。 */
export async function searchHits(page) {
  const ui = searchUi(page);
  if (!(await ui.count())) return null;
  const text = await ui.first().innerText().catch(() => '');
  const m = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) return { current: Number(m[1]), total: Number(m[2]) };
  const typed = await ui.first().getByPlaceholder(/窗内检索/).first().inputValue().catch(() => '');
  return typed ? { current: 0, total: 0 } : null;
}

// ───────────────────────── 其它既有控件（回归护栏用）────────────────────────
/** 右侧回合导航条（role=slider，既有公开锚点）。 */
export const scrubber = (page) => page.locator('[data-cgui="turn-scrubber"]').first();

/** 点导航条上第 n 档（n 从 1 起；按刻度几何比例点，与产品自身的布局算法同源）。 */
export async function clickScrubberTick(page, n, total) {
  const bar = scrubber(page);
  const box = await bar.boundingBox();
  const y = total <= 1 ? box.height / 2 : Math.round((box.height - 4) * ((n - 1) / (total - 1))) + 2;
  await bar.click({ position: { x: Math.round(box.width / 2), y } });
}

/** 触发两次与本功能无关的重渲染（开/关设置面板）。 */
export async function disturbRerender(page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+0' : 'Control+0');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

/** 一轮的条带根（用"这一轮里那段唯一的文字"定位；流式期与收官后都适用）。 */
export const stripRootOf = (page, text) => page.locator('[data-strip-root]').filter({ hasText: text }).first();

// ───────────────────────── 真回合（假 CLI）的现场控制 ────────────────────────
// 场景写在 CTL/scenario.json，假 CLI 每轮开始时读一次（见 helpers/fake-claude.mjs）。
export function ctlFile(name) { return path.join(fixtureManifest().fakeCtl, name); }

export function writeScenario(scenario) {
  fs.writeFileSync(ctlFile('scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`);
}

/** 放行"停在 result 之前"的回合（scenario.holdBeforeResult）。 */
export function releaseRound() {
  fs.writeFileSync(ctlFile('release'), String(Date.now()));
}

/** 清掉上一轮留下的场景与放行文件（不清的话下一轮的 hold 会立刻被放行）。 */
export function resetCtl() {
  for (const name of ['scenario.json', 'release']) {
    try { fs.unlinkSync(ctlFile(name)); } catch { /* 本来就没有 */ }
  }
}

export async function sendMessage(box, text) {
  await box.fill(text);
  await box.press('Enter');
}

/** 等回合结束（"停止"键消失即回合收尾，与既有套件同一判据）。 */
export async function waitRoundIdle(page, timeout = 60_000) {
  await expect.poll(async () => await stopButton(page).count(), { timeout, message: '回合没有结束（"停止"键一直在）' }).toBe(0);
}

/** 轮询某个条带根的 `data-strip-state`，直到等于期望值（超时抛人话）。 */
export async function waitStripState(page, root, want, timeout = 30_000) {
  await expect.poll(async () => await root.getAttribute('data-strip-state').catch(() => null), {
    timeout, message: `条带状态没变成 ${want}`,
  }).toBe(want);
}
