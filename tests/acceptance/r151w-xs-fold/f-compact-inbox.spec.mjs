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

// ---------------- F5–F8 ----------------

// F5 滚到底(回归保护:封顶之后最后一张卡仍够得着、【忽略】仍可点)
test('F5 滚到底:N=12 把卡片区滚到底后最后一张卡完整可见、【忽略】可点;点击后该卡消失、12 → 11、接口状态 dismissed', async ({ page }) => {
  const pair = seedPair('f5');
  await seedN(pair, 12);
  await openWithCards(page, pair, 12);
  await settle(page);
  const sc0 = await scrollerFacts(page, { toBottom: true });
  expect(sc0.found, '前置:N=12 时卡片区内部应有可滚动容器').toBe(true);
  await settle(page);
  const sc = await scrollerFacts(page);
  expect.soft(sc.scrollTop + sc.clientHeight, `前置:容器应已滚到底(scrollTop ${f0(sc.scrollTop)} + clientHeight ${sc.clientHeight} ≥ scrollHeight ${sc.scrollHeight} - 3)`).toBeGreaterThanOrEqual(sc.scrollHeight - 3);

  const lastCard = inbox(page).locator('[data-testid="xs-card"]').last();
  const lastId = await lastCard.getAttribute('data-message-id');
  const dismiss = lastCard.getByTestId('xs-card-dismiss');
  const cb = await styleOf(lastCard);
  const db = await styleOf(dismiss);
  const view = `容器可视区 top=${f0(sc.top)} bottom=${f0(sc.bottom)}`;
  expect.soft(inside(cb, sc), `最后一张卡应完整落在卡片区可视范围内(卡 top=${f0(cb.top)} bottom=${f0(cb.bottom)};${view})`).toBe(true);
  expect.soft(inside(db, sc), `最后一张卡的【忽略】应完整落在卡片区可视范围内(按钮 top=${f0(db.top)} bottom=${f0(db.bottom)};${view})`).toBe(true);
  expect.soft(await dismiss.isEnabled(), '最后一张卡的【忽略】应可用').toBe(true);

  await dismiss.click();
  await expect(cardOf(page, lastId), '点【忽略】后最后一张卡应消失').toHaveCount(0, { timeout: 15_000 });
  await expect(inbox(page).locator('[data-testid="xs-card"]'), '卡数应 12 → 11').toHaveCount(11, { timeout: 15_000 });
  const m = await waitStatus(pair.B.sid, lastId, 'dismissed', 15_000);
  expect(m && m.status, '接口里该消息状态应为 dismissed').toBe('dismissed');
  const rest = (await msgsOf(pair.B.sid)).filter((x) => x.id !== lastId);
  expect.soft(rest.length, '其余消息仍是 11 条').toBe(11);
  expect.soft(rest.filter((x) => x.status === 'pending').length, '反向:其余 11 条仍是 pending,没被一并忽略').toBe(11);
});

// F6 展开不挪按钮(回归保护)
test('F6 展开不挪按钮:N=1 点标题行展开后正文在标题行下方、【处理】位置变化 ≤ 2px;再收起卡高回到展开前 ±2px、正文隐藏', async ({ page }) => {
  const pair = seedPair('f6');
  const [id] = await seedN(pair, 1);
  await openWithCards(page, pair, 1);
  const card = cardOf(page, id);
  const toggle = card.getByTestId('xs-card-toggle');
  const proc = card.getByTestId('xs-card-process');
  await expect(toggle, '前置:折叠态').toHaveAttribute('aria-expanded', 'false');
  await settle(page);
  const card0 = await styleOf(card);
  const proc0 = await styleOf(proc);
  const head0 = await styleOf(toggle);

  await toggle.click();
  await expect(toggle, '前置:点标题行后确实展开').toHaveAttribute('aria-expanded', 'true');
  await waitBodyShown(card, 'xs-card-body', '展开后的正文');
  await settle(page);
  const head1 = await styleOf(toggle);
  const body1 = await styleOf(card.getByTestId('xs-card-body'));
  const proc1 = await styleOf(proc);
  expect.soft(body1.top, `展开后正文应在标题行下方:正文 top ≥ 标题行 bottom - 2(实测 正文 top=${f0(body1.top)} / 标题行 bottom=${f0(head1.bottom)})`).toBeGreaterThanOrEqual(head1.bottom - 2);
  expect.soft(Math.abs(proc1.left - proc0.left), `展开前后【处理】left 变化应 ≤ 2px(实测 ${f0(proc0.left)} → ${f0(proc1.left)})`).toBeLessThanOrEqual(2);
  // 诊断(不是断言):同时给出"相对标题行"的位移 —— b-inbox 的 B2 用的是这个口径;收件箱在输入框上方底部锚定,展开会整块上移
  const rel0 = proc0.top - head0.top;
  const rel1 = proc1.top - head1.top;
  expect.soft(Math.abs(proc1.top - proc0.top), `展开前后【处理】top 变化应 ≤ 2px(实测 ${f0(proc0.top)} → ${f0(proc1.top)};诊断:标题行 top ${f0(head0.top)} → ${f0(head1.top)},【处理】相对标题行 ${f0(rel0)} → ${f0(rel1)})`).toBeLessThanOrEqual(2);

  await toggle.click();
  await expect(toggle, '前置:再点标题行后收起').toHaveAttribute('aria-expanded', 'false');
  await waitBodyHidden(card, 'xs-card-body', '收起后的正文');
  await settle(page);
  const card2 = await styleOf(card);
  expect.soft(Math.abs(card2.height - card0.height), `收起后卡高应回到展开前 ±2px(实测 ${f0(card0.height)} → ${f0(card2.height)})`).toBeLessThanOrEqual(2);
});

/** 不真点,只做可点性检查(可见 / 稳定 / 可用 / 没被别的元素盖住);可点返回 null,否则返回原因首行。 */
async function clickError(loc) {
  try { await loc.click({ trial: true, timeout: 4_000 }); return null; } catch (e) { return String((e && e.message) || e).split('\n')[0]; }
}

// F7 窄屏
test('F7 窄屏 375×812:N=3 无横向滚动,每张卡 right ≤ 376 且 ≤ 110px,【处理】【忽略】落在卡内且可点,收件箱 ≤ 20vh+16px', async ({ page }) => {
  const pair = seedPair('f7');
  const ids = await seedN(pair, 3);
  await openWithCards(page, pair, 3); // 先桌面宽度打开(375px 下侧栏收起,不能用侧栏搜索),再缩窄屏,做法同 e-layout 的 E4
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(800);
  await expect(inbox(page).locator('[data-testid="xs-card"]'), '前置:窄屏下仍是 3 张卡').toHaveCount(3, { timeout: 15_000 });
  await settle(page);
  const o = await overflowX(page);
  expect(o.innerWidth, '前置:视口宽应为 375').toBe(375);
  const vh = await pageHeight(page);
  expect.soft(o.scrollWidth, `页面不应出现横向滚动(document.scrollWidth ${o.scrollWidth} / innerWidth ${o.innerWidth})`).toBeLessThanOrEqual(o.innerWidth + 1);
  const ib = await styleOf(inbox(page));
  expect.soft(ib.height, `窄屏 N=3 收件箱区域高度应 ≤ 视口高 20% + 16px(${f0(vh * 0.2 + 16)}px)(实测 ${f0(ib.height)}px / 视口 ${vh}px)`).toBeLessThanOrEqual(vh * 0.2 + 16);
  for (let i = 0; i < ids.length; i += 1) {
    const card = cardOf(page, ids[i]);
    await card.scrollIntoViewIfNeeded(); // 区域封顶后后面的卡要滚进来才点得到
    const proc = card.getByTestId('xs-card-process');
    const dis = card.getByTestId('xs-card-dismiss');
    const cb = await styleOf(card);
    const pb = await styleOf(proc);
    const db = await styleOf(dis);
    const n = `第 ${i + 1} 张卡`;
    expect.soft(cb.right, `${n} right 应 ≤ 376(实测 ${f0(cb.right)})`).toBeLessThanOrEqual(376);
    expect.soft(cb.height, `${n}高度应 ≤ 110px(允许回落成两行)(实测 ${f0(cb.height)}px)`).toBeLessThanOrEqual(110);
    expect.soft(inside(pb, cb), `${n}的【处理】应完整落在卡内(按钮 l=${f0(pb.left)} r=${f0(pb.right)} t=${f0(pb.top)} b=${f0(pb.bottom)};卡 l=${f0(cb.left)} r=${f0(cb.right)} t=${f0(cb.top)} b=${f0(cb.bottom)})`).toBe(true);
    expect.soft(inside(db, cb), `${n}的【忽略】应完整落在卡内(按钮 l=${f0(db.left)} r=${f0(db.right)} t=${f0(db.top)} b=${f0(db.bottom)};卡 l=${f0(cb.left)} r=${f0(cb.right)} t=${f0(cb.top)} b=${f0(cb.bottom)})`).toBe(true);
    expect.soft(await clickError(proc), `${n}的【处理】应可点(可见/可用/没被遮挡)`).toBeNull();
    expect.soft(await clickError(dis), `${n}的【忽略】应可点(可见/可用/没被遮挡)`).toBeNull();
  }
});

const BTN = { 'xs-card-process': '【处理】', 'xs-card-release': '【撤回】', 'xs-card-dismiss': '【忽略】' };

/** 各状态一行:卡高 ≤ 56;原因文字可见且单行(≤ 28px);给定的每个按钮都与来源标题同一行(垂直中心差 ≤ 8px)。 */
async function expectOneLine(card, state, buttonIds) {
  const cb = await styleOf(card);
  const from = await styleOf(card.getByTestId('xs-card-from'));
  expect.soft(cb.height, `${state}:卡高度应 ≤ 56px(实测 ${f0(cb.height)}px)`).toBeLessThanOrEqual(56);
  const reasonLoc = card.getByTestId('xs-card-reason');
  await expect.soft(reasonLoc, `${state}:原因文字应可见`).toBeVisible();
  if (await reasonLoc.count()) {
    const rb = await styleOf(reasonLoc);
    expect.soft(rb.height, `${state}:原因文字应单行,高度 ≤ 28px(实测 ${f0(rb.height)}px)`).toBeLessThanOrEqual(28);
  }
  for (const id of buttonIds) {
    const loc = card.getByTestId(id);
    const n = await loc.count();
    expect.soft(n, `${state}:应有${BTN[id]}`).toBe(1);
    if (n !== 1) continue;
    const dy = Math.abs(midY(await styleOf(loc)) - midY(from));
    expect.soft(dy, `${state}:${BTN[id]}与来源标题应在同一行,垂直中心差 ≤ 8px(实测 ${f0(dy)}px)`).toBeLessThanOrEqual(8);
  }
}

// F8 各状态一行
test('F8 各状态一行(pending / claimed):卡 ≤ 56px,原因文字可见且单行,按钮与来源标题同一行;claimed 有【撤回】', async ({ page }) => {
  const pair = seedPair('f8');
  const mp = await sendInbox(pair.A, pair.B, `${pair.m} F8 pending 一条\n第二行`);
  const mc = await sendInbox(pair.A, pair.B, `${pair.m} F8 claimed 一条\n第二行`);
  await openWithCards(page, pair, 2);
  await api.claimOk(mc.id);
  await expect(cardOf(page, mc.id), '前置:第二条已进入 claimed').toHaveAttribute('data-status', 'claimed', { timeout: 10_000 });
  await expect(cardOf(page, mp.id), '前置:第一条仍是 pending').toHaveAttribute('data-status', 'pending');
  await settle(page);
  await expectOneLine(cardOf(page, mp.id), 'pending', ['xs-card-process', 'xs-card-dismiss']);
  await expectOneLine(cardOf(page, mc.id), 'claimed', ['xs-card-process', 'xs-card-release', 'xs-card-dismiss']);
});

// F8 的 queued 部分:只有目标会话正在运行时由 AI 通道投递才会产生 queued,需要真 CLI(造法照 B3q)
test('F8q 各状态一行(queued):卡 ≤ 56px,原因文字(排队说明)可见且单行,【处理】【忽略】与来源标题同一行', async ({ page }) => {
  test.skip(!realCliPath(), '本机没有真 claude CLI:queued 只由 AI 的 send_message 在目标正在运行时产生');
  const pair = seedPair('f8q');
  await profileTurn(shared, pair.B, 'bypassPermissions');
  await inboundOk(shared, pair.B.sid, 'auto');
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const go = `f8q-go-${uniq('')}`;
  writeScript(`f8q-hold-${pair.m}`, [{ waitFile: go }, { waitFile: go }, { say: `${pair.m} 忙完了` }]);
  const busyRes = await shared.post('/api/chat', { sessionId: pair.B.sid, cwd: pair.B.cwd, prompt: `${pair.m} 忙 R151S:f8q-hold-${pair.m}`, permissionMode: 'bypassPermissions' });
  expect(busyRes.status, '前置:目标开始一个会忙住的回合').toBe(200);
  expect(await waitFor(() => turnRecords().some((t) => t.sid === pair.B.sid && t.text.includes(`f8q-hold-${pair.m}`)), 15_000), '前置:目标会话正在跑').toBeTruthy();
  try {
    const r = await aiCalls(shared, { cwd: makeWorkspace(`real-f8q-${uniq('')}`), steps: [{ name: SM, input: { to: [pair.B.sid], message: `${pair.m} queued 一条` } }] });
    expect(r.results.length, '前置:真 CLI 拿到一次工具结果').toBe(1);
    expect(r.results[0].json && r.results[0].json.results && r.results[0].json.results[0] && r.results[0].json.results[0].delivery, '前置:目标正忙 → queued').toBe('queued');
    const q = await waitFor(async () => (await msgsOf(pair.B.sid)).find((x) => x.from && x.from.kind === 'session' && String(x.body || '').includes('queued 一条')), 20_000);
    expect(q, '前置:queued 消息已投递').toBeTruthy();
    const card = cardOf(page, q.id);
    await expect(card, '前置:卡片已出现且状态为 queued').toHaveAttribute('data-status', 'queued', { timeout: 15_000 });
    await settle(page);
    await expectOneLine(card, 'queued', ['xs-card-process', 'xs-card-dismiss']);
  } finally {
    touchCtl(go);
  }
});
