// r152c-head-desktop：折叠条改版后的外观（只看页面上用户看得见、量得到的东西）。
// 判据全部来自 .devflow/r152c-head-desktop-接口.md 的「行为清单」；用例名 Cn 对应清单第 n 条。
// 折叠条 = [data-strip="head"]；子元素从左到右：左图标 → [data-strip-title] → [用时 data-strip-elapsed，仅生成中] → [data-strip-caret]。
// 几何一律用 getBoundingClientRect()，容差写在各用例里（取自接口文件，不放宽）。
import { test, expect } from '@playwright/test';
import { SESSIONS, C_ROWS, LONG_THINK } from './helpers/fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, turnRows, stripRootOf, headOf,
  sendInOpenSession, waitRoundIdle, writeScenario, releaseRound, touchCtl, resetCtl, scrollBox,
} from './helpers/runtime.mjs';

test.beforeEach(async ({ page }) => {
  resetCtl();
  await primeOverlays(page);
});

// 用例失败时直播回合会停在半路（假命令行在等放行文件）：全部放行，让它自己收尾，别拖累下一条。
test.afterEach(async () => {
  for (const name of ['done-b', 'done-c', 'go-c', 'go-d', 'go-finish']) touchCtl(name);
  releaseRound();
});

const HOVER_TAIL = '展开/收起这一轮的过程';
const PREFIX = '思考与工具调用';
const squash = (s) => (s || '').replace(/\s+/g, '');
const cpHead = (s, n) => [...s].slice(0, n).join('');

/** 历史回合：打开会话 ch，按收官正文找到这一轮，返回 { row, root, head }。 */
async function openHistoryRound(page, round) {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.ch.marker);
  const row = turnRows(page).filter({ hasText: round.anchor }).first();
  await expect(row, `按收官正文「${round.anchor}」应能找到这一轮（夹具会话 ch）`).toHaveCount(1, { timeout: 20_000 });
  const root = row.locator('[data-strip-root]');
  const head = headOf(row);
  await expect(head, `这一轮应有折叠条（${round.key}）`).toHaveCount(1);
  return { row, root, head };
}

/** 直播回合：在会话 sessKey 里续写一轮并停住（假命令行卡在 result 之前）。返回 { root, head, LIVE }。 */
async function startLive(page, sessKey, tag, { title = `${tag} 直播工具标题` } = {}) {
  const LIVE = `R152C-${tag} 直播正文。`;
  writeScenario({
    events: [
      { kind: 'thinking', text: `${tag} 先想一想。` },
      { kind: 'tool', name: 'Bash', input: { command: 'ls', description: title }, result: 'ok' },
      { kind: 'text', text: LIVE },
    ],
    holdBeforeResult: true,
  });
  await openApp(page);
  await openSessionByMarker(page, SESSIONS[sessKey].marker);
  await sendInOpenSession(page, `${tag} 跑一轮`);
  const root = stripRootOf(page, LIVE);
  await expect(root, '正在生成的回合应画出折叠条').toHaveCount(1, { timeout: 40_000 });
  const head = headOf(root);
  await expect(head, '生成中折叠条带 data-strip-live="true"').toHaveAttribute('data-strip-live', 'true');
  return { root, head, LIVE };
}

/** 折叠条的结构与文字（一次 evaluate 读完，避免读到一半页面变了）。 */
const readStructure = (head) => head.evaluate((el) => {
  const kids = [...el.children];
  const tag = (n) => (n ? n.tagName.toLowerCase() : null);
  const mark = (n) => (n.hasAttribute('data-strip-dots') ? 'dots' : n.hasAttribute('data-strip-title') ? 'title'
    : n.hasAttribute('data-strip-elapsed') ? 'elapsed' : n.hasAttribute('data-strip-caret') ? 'caret' : tag(n));
  const titles = el.querySelectorAll('[data-strip-title]');
  const carets = el.querySelectorAll('[data-strip-caret]');
  const clone = el.cloneNode(true);
  const b = el.getBoundingClientRect();
  return {
    kids: kids.map(mark),
    titleCount: titles.length,
    title: titles.length ? (titles[0].textContent || '') : null,
    caretCount: carets.length,
    caretText: carets.length ? (carets[0].textContent || '') : null,
    caretIsLast: carets.length === 1 && kids[kids.length - 1] === carets[0],
    whole: (el.textContent || ''),
    wholeNoElapsed: (() => { clone.querySelectorAll('[data-strip-elapsed]').forEach((n) => n.remove()); return clone.textContent || ''; })(),
    headRight: b.right, headLeft: b.left, headHeight: b.height,
    caretRight: carets.length ? carets[0].getBoundingClientRect().right : null,
    caretLeft: carets.length ? carets[0].getBoundingClientRect().left : null,
    firstIsSvg: kids.length ? tag(kids[0]) === 'svg' : false,
  };
});

// ───────────────────────── C1–C3：折叠条的文字只剩标题 ─────────────────────────
test('C1 历史回合有通用工具：[data-strip-title] = 清洗后的 description，折叠条整体别无其它文字（无前缀、无计数）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.ch.marker);
  for (const round of [C_ROWS.c1a, C_ROWS.c1b, C_ROWS.c1c]) {
    const head = headOf(turnRows(page).filter({ hasText: round.anchor }).first());
    await expect(head, `${round.key}：这一轮应有折叠条`).toHaveCount(1, { timeout: 20_000 });
    const s = await readStructure(head);
    expect.soft(s.titleCount, `${round.key}：折叠条里 [data-strip-title] 应恰有 1 个，整句「${s.whole}」`).toBe(1);
    expect.soft(s.title, `${round.key}：[data-strip-title] 的文字应是清洗后的 description，整句「${s.whole}」`).toBe(round.expect);
    expect.soft(squash(s.whole), `${round.key}：折叠条整体文字（去空白）应只有这一句话，整句「${s.whole}」`).toBe(squash(round.expect));
    expect.soft(s.whole.includes(PREFIX), `${round.key}：不得再出现「${PREFIX}」前缀，整句「${s.whole}」`).toBe(false);
    expect.soft(/\d+\s*[轮步]/.test(s.whole), `${round.key}：不得再出现「N 轮 M 步」计数，整句「${s.whole}」`).toBe(false);
  }
});

test('C2 历史回合整轮只有思考：[data-strip-title] = 最后一条思考的前 40 个字 + …，折叠条整体同样只有这一句', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.ch.marker);
  const round = C_ROWS.c2;
  const head = headOf(turnRows(page).filter({ hasText: round.anchor }).first());
  await expect(head, '纯思考的一轮应有折叠条').toHaveCount(1, { timeout: 20_000 });
  expect(round.expect, '夹具自证：期望值 = 最后一条思考的前 40 个码点 + …').toBe(`${cpHead(LONG_THINK, 40)}…`);
  const s = await readStructure(head);
  expect.soft(s.titleCount, `折叠条里 [data-strip-title] 应恰有 1 个，整句「${s.whole}」`).toBe(1);
  expect.soft(s.title, `标题应是最后一条思考的预览（不是第一条思考），整句「${s.whole}」`).toBe(round.expect);
  expect.soft(squash(s.whole), `折叠条整体文字（去空白）应只有预览这一句，整句「${s.whole}」`).toBe(squash(round.expect));
  expect.soft(s.whole.includes(PREFIX), `不得再出现「${PREFIX}」前缀，整句「${s.whole}」`).toBe(false);
  expect.soft(/\d+\s*[轮步]/.test(s.whole), `不得再出现「N 轮 M 步」计数，整句「${s.whole}」`).toBe(false);
});

test('C3 历史回合整轮没有通用工具且唯一的思考块是纯空白：可见文字回落成计数文字（N 轮 1 步 / 1 步）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.ch.marker);
  const round = C_ROWS.c3;
  const row = turnRows(page).filter({ hasText: round.anchor }).first();
  const root = row.locator('[data-strip-root]');
  await expect(root, '纯空白思考的一轮应能按收官正文找到').toHaveCount(1, { timeout: 20_000 });
  const rounds = await root.getAttribute('data-strip-rounds');
  const steps = await root.getAttribute('data-strip-steps');
  const head = headOf(row);
  // 夹具自证：纯空白思考块要“计入步数”，折叠条才存在；若这里不成立，是夹具造不出该现场，不是产品缺陷。
  await expect(head, `夹具自证：纯空白思考块应计入步数并画出折叠条（data-strip-steps=${steps}）`).toHaveCount(1);
  expect(steps, '夹具自证：这一轮恰 1 步（那个纯空白思考块）').toBe('1');
  const want = rounds ? `${rounds} 轮 1 步` : '1 步';
  const s = await readStructure(head);
  expect.soft(s.titleCount, `折叠条里 [data-strip-title] 应恰有 1 个，整句「${s.whole}」`).toBe(1);
  expect.soft(s.title, `取不到标题时回落成计数文字「${want}」，整句「${s.whole}」`).toBe(want);
  expect.soft(squash(s.whole), `折叠条整体文字（去空白）应只有计数文字，整句「${s.whole}」`).toBe(squash(want));
  expect.soft(s.whole.includes(PREFIX), `不得出现「${PREFIX}」前缀，整句「${s.whole}」`).toBe(false);
});

// ───────────────────────── C4：悬停提示 ─────────────────────────
test('C4 悬停提示：历史回合带轮数、直播回合不带；展开 / 收起前后读到的 title 完全相同', async ({ page }) => {
  test.setTimeout(150_000);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.ch.marker);
  const row = turnRows(page).filter({ hasText: C_ROWS.c1a.anchor }).first();
  const root = row.locator('[data-strip-root]');
  await expect(root, '历史回合应有条带根').toHaveCount(1, { timeout: 20_000 });
  const head = headOf(row);
  const n = await root.getAttribute('data-strip-rounds');
  const m = await root.getAttribute('data-strip-steps');
  expect(n, '夹具自证：历史回合的条带根带轮数 data-strip-rounds（数字）').toMatch(/^\d+$/);
  expect(m, '夹具自证：条带根带步数 data-strip-steps（数字）').toMatch(/^\d+$/);
  const want = `${PREFIX} · ${n} 轮 ${m} 步 · ${HOVER_TAIL}`;
  const t0 = await head.getAttribute('title');
  await head.click();
  await expect(head, '点一下展开').toHaveAttribute('aria-expanded', 'true');
  const t1 = await head.getAttribute('title');
  await head.click();
  await expect(head, '再点一下收起').toHaveAttribute('aria-expanded', 'false');
  const t2 = await head.getAttribute('title');
  expect.soft(t0, '历史回合（收起态）title 逐字').toBe(want);
  expect.soft(t1, '历史回合（展开态）title 与收起态完全相同').toBe(want);
  expect.soft(t2, '历史回合（再收起）title 与最初完全相同').toBe(want);

  // 直播回合：data-strip-rounds 为空串 → 不带「N 轮 」
  const live = await startLive(page, 'cl4', 'C4');
  await expect.poll(async () => await live.root.getAttribute('data-strip-steps'), {
    timeout: 30_000, message: '夹具自证：直播回合应画出 2 步（思考 + Bash）',
  }).toBe('2');
  const liveRounds = await live.root.getAttribute('data-strip-rounds');
  expect.soft(liveRounds ?? '', '直播回合没有轮数：data-strip-rounds 应为空串').toBe('');
  expect.soft(await live.head.getAttribute('title'), '直播回合 title 逐字（不带「N 轮」）')
    .toBe(`${PREFIX} · 2 步 · ${HOVER_TAIL}`);
});

// ───────────────────────── C5 / C6：三角 ─────────────────────────
/** 三角位置的全部判据（历史回合与直播回合共用）。 */
function expectCaretAtRight(s, label) {
  expect.soft(s.caretCount, `${label}：折叠条里 [data-strip-caret] 应恰有 1 个，子元素 ${JSON.stringify(s.kids)}`).toBe(1);
  expect.soft(s.caretIsLast, `${label}：三角应是折叠条的最后一个子元素，子元素 ${JSON.stringify(s.kids)}`).toBe(true);
  expect.soft((s.caretText ?? 'x').trim(), `${label}：三角自己不含任何文字`).toBe('');
  expect.soft(s.kids[0], `${label}：折叠条的第一个子元素不能是三角（最左没有箭头），子元素 ${JSON.stringify(s.kids)}`).not.toBe('caret');
  expect.soft(s.kids.indexOf('title'), `${label}：标题紧跟在左图标后面（第 2 个子元素），子元素 ${JSON.stringify(s.kids)}`).toBe(1);
  expect.soft(s.kids.indexOf('title') < s.kids.indexOf('caret'), `${label}：标题在三角左边，子元素 ${JSON.stringify(s.kids)}`).toBe(true);
  expect.soft(s.headRight - (s.caretRight ?? -9999), `${label}：三角右缘距折叠条右缘应 ≤ 16px（折叠条右缘 ${s.headRight}，三角右缘 ${s.caretRight}）`)
    .toBeLessThanOrEqual(16);
}

test('C5 三角的位置：在折叠条最右（最后一个子元素、无文字），最左没有箭头，标题在三角左边；历史回合与直播回合都要满足', async ({ page }) => {
  test.setTimeout(150_000);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.ch.marker);
  const head = headOf(turnRows(page).filter({ hasText: C_ROWS.c1a.anchor }).first());
  await expect(head, '历史回合应有折叠条').toHaveCount(1, { timeout: 20_000 });
  expectCaretAtRight(await readStructure(head), '历史回合');

  const live = await startLive(page, 'cl5', 'C5');
  await expect(live.head.locator('[data-strip-caret]'), '直播回合的折叠条也应有三角').toHaveCount(1);
  expectCaretAtRight(await readStructure(live.head), '直播回合');
});

test('C6 三角随开合变化：收起 false / false → 点击展开 true / true → 再点收起 false / false；两态画面不同、右缘位置相同（差 ≤ 1px）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.ch.marker);
  const head = headOf(turnRows(page).filter({ hasText: C_ROWS.c1a.anchor }).first());
  await expect(head, '历史回合应有折叠条').toHaveCount(1, { timeout: 20_000 });
  const caret = head.locator('[data-strip-caret]');
  await expect(caret, '折叠条里应有 1 个三角').toHaveCount(1);
  const state = async () => ({ open: await caret.getAttribute('data-open'), aria: await head.getAttribute('aria-expanded') });
  const right = () => caret.evaluate((el) => el.getBoundingClientRect().right);
  const settle = () => page.waitForTimeout(500); // 等三角的过渡动画落定再截图

  expect.soft(await state(), '初始：历史回合默认收起').toEqual({ open: 'false', aria: 'false' });
  const rightClosed0 = await right();
  await head.click();
  await expect(head, '点击折叠条展开').toHaveAttribute('aria-expanded', 'true');
  await settle();
  expect.soft(await state(), '点击后：展开').toEqual({ open: 'true', aria: 'true' });
  const shotOpen = await caret.screenshot();
  const rightOpen = await right();
  await head.click();
  await expect(head, '再点一下收起').toHaveAttribute('aria-expanded', 'false');
  await settle();
  expect.soft(await state(), '再点后：收起').toEqual({ open: 'false', aria: 'false' });
  const shotClosed = await caret.screenshot();
  const rightClosed = await right();

  expect.soft(Buffer.compare(shotOpen, shotClosed) !== 0, '展开与收起两态下三角的画面应不同（两张截图的字节不得相等）').toBe(true);
  expect.soft(Math.abs(rightOpen - rightClosed), `展开 / 收起两态下三角右缘位置应相同（差 ≤ 1px；展开 ${rightOpen}，收起 ${rightClosed}）`).toBeLessThanOrEqual(1);
  expect.soft(Math.abs(rightClosed0 - rightClosed), `点击往返之后三角右缘回到原位（差 ≤ 1px；初始 ${rightClosed0}，现在 ${rightClosed}）`).toBeLessThanOrEqual(1);
});

// ───────────────────────── C7：没有左边线 ─────────────────────────
const borderLeftOf = (head) => head.evaluate((el) => getComputedStyle(el).borderLeftWidth);

test('C7 没有左边线：折叠条 border-left-width 为 0px（历史 / 直播 × 收起 / 展开 四种组合）', async ({ page }) => {
  test.setTimeout(150_000);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.ch.marker);
  const head = headOf(turnRows(page).filter({ hasText: C_ROWS.c1a.anchor }).first());
  await expect(head, '历史回合应有折叠条').toHaveCount(1, { timeout: 20_000 });
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  expect.soft(await borderLeftOf(head), '历史回合·收起：border-left-width').toBe('0px');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  expect.soft(await borderLeftOf(head), '历史回合·展开：border-left-width').toBe('0px');

  const live = await startLive(page, 'cl7', 'C7');
  const first = await live.head.getAttribute('aria-expanded');
  expect.soft(await borderLeftOf(live.head), `直播回合·${first === 'true' ? '展开' : '收起'}：border-left-width`).toBe('0px');
  await live.head.click();
  const flipped = first === 'true' ? 'false' : 'true';
  await expect(live.head, '点击折叠条切换开合').toHaveAttribute('aria-expanded', flipped);
  expect.soft(await borderLeftOf(live.head), `直播回合·${flipped === 'true' ? '展开' : '收起'}：border-left-width`).toBe('0px');
});

// ───────────────────────── C8 / C9：直播回合头行是静态的（r154 R3 换锚） ─────────────────────────
// r154 R3 起：直播回合的 2×2 点阵与用时都挪到了页面底部的状态行 [data-live-line]；头行恒为 静态扳手图标 → 标题 → 三角。
// 原 C8（点阵几何）、C9（点阵动画顺序与减弱动态）的对象已不存在，按同一意图换成“头行静态”的等价判据；
// 新行为的完整契约与底部状态行的断言在 tests/acceptance/r154-ui-live-line（L6 / L9）。
test('C8 直播回合最左是静态小图标 svg：没有点阵与用时（r154 R3 起挪到底部状态行），图标 ≤ 16px 且在标题左边', async ({ page }) => {
  const live = await startLive(page, 'cl8', 'C8');
  await expect(live.head.locator('[data-strip-dots]'), 'r154 起折叠条里不再有 [data-strip-dots]').toHaveCount(0);
  const s = await readStructure(live.head);
  expect.soft(s.firstIsSvg, `直播回合折叠条最左应是 svg 小图标（不是点阵），子元素 ${JSON.stringify(s.kids)}`).toBe(true);
  expect.soft(s.kids.includes('dots') || s.kids.includes('elapsed'), `直播回合折叠条里不再有点阵 / 用时，子元素 ${JSON.stringify(s.kids)}`).toBe(false);
  const icon = await live.head.evaluate((h) => {
    const i = h.children[0].getBoundingClientRect();
    const t = h.querySelector('[data-strip-title]').getBoundingClientRect();
    return { w: i.width, h: i.height, right: i.right, titleLeft: t.left };
  });
  expect.soft(icon.w <= 16 && icon.h <= 16, `左图标布局应 ≤ 16×16px，实际 ${icon.w}×${icon.h}`).toBe(true);
  expect.soft(icon.right, '左图标在标题左边（右缘 ≤ 标题左缘 + 1px）').toBeLessThanOrEqual(icon.titleLeft + 1);
});

test('C9 直播回合头行静态：折叠条里没有任何正在运行的动画；系统“减弱动态”下同样没有', async ({ page }) => {
  const live = await startLive(page, 'cl9', 'C9');
  // 折叠条（含子孙）上正在运行的动画个数：document.getAnimations() 里作用目标落在折叠条内的
  const running = (head) => head.evaluate((h) => document.getAnimations()
    .filter((a) => a.playState === 'running' && a.effect && a.effect.target && h.contains(a.effect.target)).length);
  expect.soft(await running(live.head), '直播回合折叠条（含子孙）里不应有运行中的动画').toBe(0);
  await page.waitForTimeout(1200);
  expect.soft(await running(live.head), '过 1 秒后折叠条里仍不应有运行中的动画').toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => running(live.head), { timeout: 10_000, message: '系统设为“减弱动态”后折叠条里仍不应有运行中的动画' }).toBe(0);
});

// ───────────────────────── C10：直播回合右侧布局 ─────────────────────────
/** 标题 / 用时 / 三角 / 折叠条各自的左右缘（读不到的元素给 null）。 */
const readEdges = (head) => head.evaluate((h) => {
  const e = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return { left: b.left, right: b.right }; };
  return { head: e(h), title: e(h.querySelector('[data-strip-title]')), elapsed: e(h.querySelector('[data-strip-elapsed]')), caret: e(h.querySelector('[data-strip-caret]')) };
});
const liveMarks = async (page) => ({
  dots: await page.locator('[data-strip-dots]').count(),
  elapsed: await page.locator('[data-strip-elapsed]').count(),
  live: await page.locator('[data-strip-live]').count(),
});

// r154 R3 换锚：原判据“标题 → 用时 → 三角”里的用时挪到了底部状态行，头行右侧只剩 标题 → 三角。
test('C10 直播回合右侧布局：标题 → 三角（左到右），头行没有用时（r154 R3 起挪到底部状态行）；回合结束后直播标记消失，左图标仍是 svg，三角位置不变', async ({ page }) => {
  const live = await startLive(page, 'cl10', 'C10');
  await expect(live.head.locator('[data-strip-elapsed]'), 'r154 起折叠条里不再有 [data-strip-elapsed]').toHaveCount(0);
  const g = await readEdges(live.head);
  expect(g.title, '折叠条里应有 [data-strip-title]').not.toBeNull();
  expect(g.caret, '折叠条里应有 [data-strip-caret]').not.toBeNull();
  expect.soft(g.elapsed, '直播回合折叠条里没有用时元素').toBeNull();
  const f = (n) => Number(n).toFixed(2);
  const dump = `折叠条 ${f(g.head.left)}–${f(g.head.right)}；标题 ${f(g.title.left)}–${f(g.title.right)}；三角 ${f(g.caret.left)}–${f(g.caret.right)}`;
  expect.soft(g.caret.left, `三角在标题右边（三角左缘 ≥ 标题右缘 − 1px）；${dump}`).toBeGreaterThanOrEqual(g.title.right - 1);
  expect.soft(g.caret.right, `三角右缘 ≤ 折叠条右缘（浮点噪声容 0.01px）；${dump}`).toBeLessThanOrEqual(g.head.right + 0.01);
  const gapBefore = g.head.right - g.caret.right;

  releaseRound();
  await waitRoundIdle(page);
  await expect.poll(async () => await liveMarks(page), { timeout: 15_000, message: '回合结束后：点阵、用时、直播标记全部消失' })
    .toEqual({ dots: 0, elapsed: 0, live: 0 });
  const doneHead = headOf(stripRootOf(page, live.LIVE));
  await expect(doneHead, '回合结束后折叠条仍在').toHaveCount(1);
  const s = await readStructure(doneHead);
  expect.soft(s.firstIsSvg, `回合结束后左图标应是 svg 小图标（不是点阵），子元素 ${JSON.stringify(s.kids)}`).toBe(true);
  expect.soft(s.caretIsLast, `回合结束后三角仍是最后一个子元素，子元素 ${JSON.stringify(s.kids)}`).toBe(true);
  expect.soft(s.kids.includes('elapsed') || s.kids.includes('dots'), `回合结束后折叠条里不再有用时 / 点阵，子元素 ${JSON.stringify(s.kids)}`).toBe(false);
  const gapAfter = s.headRight - (s.caretRight ?? -9999);
  expect.soft(Math.abs(gapAfter - gapBefore), `回合结束前后三角右缘位置不变（距折叠条右缘 ${f(gapBefore)} → ${f(gapAfter)}，差 ≤ 1px）`).toBeLessThanOrEqual(1);
});

// ───────────────────────── C11：超长标题 ─────────────────────────
test('C11 超长标题（900 / 1600 两档窗口）：标题自己被省略号截断，三角完整留在折叠条里，折叠条仍一行，页面无横向滚动', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.ch.marker);
  const longHead = headOf(turnRows(page).filter({ hasText: C_ROWS.c11long.anchor }).first());
  const shortHead = headOf(turnRows(page).filter({ hasText: C_ROWS.c11short.anchor }).first());
  await expect(longHead, '长标题那一轮应有折叠条').toHaveCount(1, { timeout: 20_000 });
  await expect(shortHead, '短标题那一轮应有折叠条').toHaveCount(1);
  const box = await scrollBox(page);
  // 先把两档宽度下的度量都读出来（并打印），再统一断言：一档读不到不影响另一档的数据可见。
  const seen = {};
  for (const width of [900, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(600);
    seen[width] = {
      ...(await longHead.evaluate((h) => {
        const t = h.querySelector('[data-strip-title]');
        const c = h.querySelector('[data-strip-caret]');
        const hb = h.getBoundingClientRect();
        const cb = c ? c.getBoundingClientRect() : null;
        return {
          headW: hb.width, headH: hb.height, headLeft: hb.left, headRight: hb.right,
          title: t ? { ellipsis: getComputedStyle(t).textOverflow, over: t.scrollWidth - t.clientWidth, clientW: t.clientWidth, ws: getComputedStyle(t).whiteSpace } : null,
          caret: cb ? { left: cb.left, right: cb.right } : null,
        };
      })),
      shortH: await shortHead.evaluate((h) => h.getBoundingClientRect().height),
      docOver: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      boxOver: await box.evaluate((el) => el.scrollWidth - el.clientWidth),
    };
    console.log(`[C11] ${width}px 度量`, JSON.stringify(seen[width]));
  }
  for (const width of [900, 1600]) {
    const m = seen[width];
    const at = `${width}px`;
    expect(m.title, `${at}：长标题的折叠条里应有 [data-strip-title]`).not.toBeNull();
    expect(m.caret, `${at}：长标题的折叠条里应有 [data-strip-caret]`).not.toBeNull();
    expect.soft(m.title.ellipsis, `${at}：[data-strip-title] 自己设了省略号（text-overflow: ellipsis）`).toBe('ellipsis');
    expect.soft(m.title.over, `${at}：[data-strip-title] 放不下，必须真被截断（scrollWidth − clientWidth > 0）`).toBeGreaterThan(0);
    expect.soft(m.caret.left, `${at}：三角左缘 ≥ 折叠条左缘（三角完整留在折叠条里）`).toBeGreaterThanOrEqual(m.headLeft);
    expect.soft(m.caret.right, `${at}：三角右缘 ≤ 折叠条右缘（三角完整留在折叠条里，浮点噪声容 0.01px）`).toBeLessThanOrEqual(m.headRight + 0.01);
    expect.soft(Math.abs(m.headH - m.shortH), `${at}：长标题折叠条仍是一行（高度与短标题折叠条相差 ≤ 2px：${m.headH} vs ${m.shortH}）`).toBeLessThanOrEqual(2);
    expect.soft(m.docOver, `${at}：页面无横向滚动`).toBeLessThanOrEqual(1);
    expect.soft(m.boxOver, `${at}：消息区无横向滚动`).toBeLessThanOrEqual(1);
  }
});
