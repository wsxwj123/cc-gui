// F 组:收件箱卡片区压缩(r152d-xs-inbox-height)。依据接口文件第 2、4 节的新口径:
//   ① 每张卡折叠态压成一行(来源标题 / 时间 / 「展开全文」/ 原因 / 【处理】【撤回】【忽略】同一行,按钮直接可点);
//   ② 卡片区总高度上限从视口高的 42% 降到 20%,超出在区域内部滚动;窄屏放不下允许回落成两行,上限同样 20%。
// 只通过页面与 HTTP 接口观察:元素钩子 data-testid、消息区 [data-chat-scroll]、/api/xsession/messages。
// 尺寸口径:全部取 getBoundingClientRect() 的"视觉像素"(页面根元素带界面缩放,默认 1.2,尺寸已含缩放);
//   视口高取 window.innerHeight(同为视觉像素),所以 20vh 在 800 视口下 = 160。
// 基线(N=0)现量:同一视口下另起一对没有消息的会话,量消息区高度,不写死数字。每个 N 各用一对新会话、各开一次页面。
// 卡片有约 0.5s 淡入位移动画:量位置/高度前先等 ≥800ms,再轮询到连续两次读数相同。
// 造数照 b-inbox:pending 用 sendInbox;claimed 用 api.claimOk(B3a);queued 在目标会话运行时由真 CLI 投递(B3q)。
import { test, expect } from '@playwright/test';
import {
  api, boot, openSessionBySearch, seedPair, sendInbox, cardOf, inbox, styleOf, pageHeight, overflowX,
  waitBodyShown, waitBodyHidden, waitStatus, msgsOf, writeScript, touchCtl, uniq, turnRecords, waitFor,
  shared, realCliPath, profileTurn, inboundOk, aiCalls, makeWorkspace, SM,
} from './helpers/w.mjs';

test.describe.configure({ timeout: 240_000 });
test.beforeEach(async () => { await api.on(); });

// ---------------- 本文件专用的量尺工具(只读页面,不碰产品内部) ----------------
const bodyOf = (m, i) => `${m} 第${i + 1}条\n第二行\n第三行\n第四行`;
const midY = (b) => b.top + b.height / 2;
const f0 = (n) => Number(n).toFixed(1);
/** 内层盒是否完整落在外层盒里(容差 tol 像素)。 */
const inside = (a, b, tol = 1) => a.top >= b.top - tol && a.bottom <= b.bottom + tol && a.left >= b.left - tol && a.right <= b.right + tol;

/** 给目标会话投 n 条待处理消息(每条 4 行正文);返回消息 id(接口返回顺序)。 */
async function seedN(pair, n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push((await sendInbox(pair.A, pair.B, bodyOf(pair.m, i))).id);
  return ids;
}

/** 打开目标会话并等 n 张卡出现(先造数后开页面,不依赖推送延迟)。 */
async function openWithCards(page, pair, n) {
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  await expect(inbox(page).locator('[data-testid="xs-card"]'), `前置:收件箱应有 ${n} 张卡`).toHaveCount(n, { timeout: 20_000 });
}

/** 稳定判据用的快照:收件箱 + 全部卡 + 消息区的盒子(取整到 0.1px)。 */
const layoutSnap = (page) => page.evaluate(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.top, r.bottom, r.left, r.right].map((v) => Math.round(v * 10) / 10);
  };
  const ib = document.querySelector('[data-testid="xs-inbox"]');
  return {
    inbox: box(ib),
    cards: ib ? [...ib.querySelectorAll('[data-testid="xs-card"]')].map(box) : [],
    chat: box(document.querySelector('[data-chat-scroll]')),
  };
});

/** 淡入动画:先等 800ms,再轮询到连续两次快照相同(最多再等约 4 秒)。 */
async function settle(page) {
  await page.waitForTimeout(800);
  let prev = JSON.stringify(await layoutSnap(page));
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(150);
    const cur = JSON.stringify(await layoutSnap(page));
    if (cur === prev) return;
    prev = cur;
  }
}

/** 消息区([data-chat-scroll])的可视高度;读不到返回 -1。 */
const chatH = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-chat-scroll]');
  return el ? el.getBoundingClientRect().height : -1;
});

/** 基线(N=0):同一视口下另起一对没有消息的会话,量消息区高度。 */
async function baselineChatH(page, tag) {
  const base = seedPair(`${tag}base`);
  await boot(page);
  await openSessionBySearch(page, base.B.title, base.B.reply);
  await expect(inbox(page), '前置:基线会话没有消息,不渲染收件箱').toHaveCount(0);
  await settle(page);
  const h = await chatH(page);
  expect(h, '前置:基线下应能读到消息区 [data-chat-scroll] 的高度(> 200px)').toBeGreaterThan(200);
  return h;
}

/**
 * 卡片区内部滚动容器:找法照 b-inbox 的 B10(overflow-y 为 auto/scroll 且 scrollHeight > clientHeight);
 * toBottom=true 时顺手把它滚到底。返回容器盒子与滚动量;找不到返回 { found:false }。
 */
const scrollerFacts = (page, { toBottom = false } = {}) => inbox(page).evaluate((el, bottom) => {
  const cands = [el, ...el.querySelectorAll('*'), el.parentElement, el.parentElement && el.parentElement.parentElement].filter(Boolean);
  for (const n of cands) {
    const s = getComputedStyle(n);
    if (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 2) {
      if (bottom) n.scrollTop = n.scrollHeight;
      const r = n.getBoundingClientRect();
      return {
        found: true, tag: n.tagName, testid: n.getAttribute('data-testid'), overflowY: s.overflowY,
        top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height,
        scrollHeight: n.scrollHeight, clientHeight: n.clientHeight, scrollTop: n.scrollTop,
      };
    }
  }
  return { found: false };
}, toBottom);

// ---------------- F1–F4 ----------------

// F1 单条一行
test('F1 单条一行:N=1 折叠卡高度 ≤ 56px,且【处理】与来源标题垂直中心相差 ≤ 8px(同一行)', async ({ page }) => {
  const pair = seedPair('f1');
  const [id] = await seedN(pair, 1);
  await openWithCards(page, pair, 1);
  const card = cardOf(page, id);
  await expect(card.getByTestId('xs-card-toggle'), '前置:卡片是折叠态').toHaveAttribute('aria-expanded', 'false');
  await settle(page);
  const cb = await styleOf(card);
  const from = await styleOf(card.getByTestId('xs-card-from'));
  const proc = await styleOf(card.getByTestId('xs-card-process'));
  expect.soft(cb.height, `折叠态那张卡高度应 ≤ 56px(实测 ${f0(cb.height)}px;旧口径约 92px、两行)`).toBeLessThanOrEqual(56);
  const dy = Math.abs(midY(proc) - midY(from));
  expect.soft(dy, `【处理】与来源标题应在同一行:垂直中心差 ≤ 8px(实测 ${f0(dy)}px;处理中心 y=${f0(midY(proc))} / 来源中心 y=${f0(midY(from))})`).toBeLessThanOrEqual(8);
});

// F2 单条占高
test('F2 单条占高:N=1 时收件箱区域高度 ≤ 视口高 8%,消息区高度 ≥ 基线(N=0)的 85%', async ({ page }) => {
  const baseH = await baselineChatH(page, 'f2');
  const pair = seedPair('f2');
  await seedN(pair, 1);
  await openWithCards(page, pair, 1);
  await settle(page);
  const vh = await pageHeight(page);
  const ib = await styleOf(inbox(page));
  const h = await chatH(page);
  expect.soft(ib.height, `N=1 收件箱区域高度应 ≤ 视口高 8%(${f0(vh * 0.08)}px)(实测 ${f0(ib.height)}px / 视口 ${vh}px;旧口径约 101px)`).toBeLessThanOrEqual(vh * 0.08);
  expect.soft(h, `N=1 消息区高度应 ≥ 基线 ${f0(baseH)}px 的 85%(${f0(baseH * 0.85)}px)(实测 ${f0(h)}px = ${f0((h / baseH) * 100)}%;旧口径约 79%)`).toBeGreaterThanOrEqual(baseH * 0.85);
});

// F3 三条占高
test('F3 三条占高:N=3 时收件箱 ≤ 20vh+16px,消息区 ≥ 基线 62%,每张卡 ≤ 56px 且卡与卡不重叠', async ({ page }) => {
  const baseH = await baselineChatH(page, 'f3');
  const pair = seedPair('f3');
  const ids = await seedN(pair, 3);
  await openWithCards(page, pair, 3);
  await settle(page);
  const vh = await pageHeight(page);
  const ib = await styleOf(inbox(page));
  const h = await chatH(page);
  expect.soft(ib.height, `N=3 收件箱区域高度应 ≤ 视口高 20% + 16px(${f0(vh * 0.2 + 16)}px)(实测 ${f0(ib.height)}px / 视口 ${vh}px;旧口径约 294px)`).toBeLessThanOrEqual(vh * 0.2 + 16);
  expect.soft(h, `N=3 消息区高度应 ≥ 基线 ${f0(baseH)}px 的 62%(${f0(baseH * 0.62)}px)(实测 ${f0(h)}px = ${f0((h / baseH) * 100)}%;旧口径约 39%)`).toBeGreaterThanOrEqual(baseH * 0.62);
  const boxes = [];
  for (const id of ids) boxes.push(await styleOf(cardOf(page, id)));
  boxes.forEach((b, i) => expect.soft(b.height, `第 ${i + 1} 张卡高度应 ≤ 56px(实测 ${f0(b.height)}px)`).toBeLessThanOrEqual(56));
  for (let i = 1; i < boxes.length; i += 1) {
    expect.soft(boxes[i - 1].bottom, `第 ${i} 张与第 ${i + 1} 张卡不应重叠:上一张 bottom ≤ 下一张 top + 1(实测 ${f0(boxes[i - 1].bottom)} vs ${f0(boxes[i].top)})`).toBeLessThanOrEqual(boxes[i].top + 1);
  }
});

// F4 封顶 20%
test('F4 封顶 20%:N=12(每条 4 行)收件箱 ≤ 20vh+16px,内部滚动容器可视高 ≤ 20vh+4px 且内容可滚,消息区 ≥ 基线 58%', async ({ page }) => {
  const baseH = await baselineChatH(page, 'f4');
  const pair = seedPair('f4');
  await seedN(pair, 12);
  await openWithCards(page, pair, 12);
  await settle(page);
  const vh = await pageHeight(page);
  const ib = await styleOf(inbox(page));
  const h = await chatH(page);
  const sc = await scrollerFacts(page);
  expect.soft(ib.height, `N=12 收件箱区域高度应 ≤ 视口高 20% + 16px(${f0(vh * 0.2 + 16)}px)(实测 ${f0(ib.height)}px / 视口 ${vh}px;旧口径封顶约 346px)`).toBeLessThanOrEqual(vh * 0.2 + 16);
  expect.soft(sc.found, `N=12 内容溢出时卡片区内部应能滚动(应有 overflow-y 为 auto/scroll 且 scrollHeight > clientHeight 的容器;实测 ${JSON.stringify(sc)})`).toBe(true);
  if (sc.found) {
    expect.soft(sc.scrollHeight, `内部滚动容器内容应可滚(scrollHeight ${sc.scrollHeight} > clientHeight ${sc.clientHeight})`).toBeGreaterThan(sc.clientHeight);
    expect.soft(sc.height, `内部滚动容器可视高度应 ≤ 视口高 20% + 4px(${f0(vh * 0.2 + 4)}px)(实测 ${f0(sc.height)}px / 视口 ${vh}px)`).toBeLessThanOrEqual(vh * 0.2 + 4);
  }
  expect.soft(h, `N=12 消息区高度应 ≥ 基线 ${f0(baseH)}px 的 58%(${f0(baseH * 0.58)}px)(实测 ${f0(h)}px = ${f0((h / baseH) * 100)}%;旧口径约 28%)`).toBeGreaterThanOrEqual(baseH * 0.58);
});
