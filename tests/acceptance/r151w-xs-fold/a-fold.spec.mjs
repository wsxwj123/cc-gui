// A 组:折叠行通用行为(A1–A7)。依据 .devflow/r151w-INTERFACE.md 第 1 节,只从用户可观察的 DOM/几何/文案断言。
// 夹具:收件箱待处理消息走既有 POST /api/xsession/messages;缺正文的接收/发送行用会话记录 jsonl 预置。
import { test, expect } from '@playwright/test';
import {
  api, boot, openSessionBySearch, seedPair, sendInbox, cardOf, styleOf, uniq,
  seedPeerHistory, seedSendHistory, setPanes, fillPane,
} from './helpers/w.mjs';

test.describe.configure({ timeout: 180_000 });
test.beforeEach(async () => { await api.on(); });

const body10 = (m) => Array.from({ length: 10 }, (_, i) => `${m} 第${i + 1}行 —— 这是一段用来占满折叠预览的正文内容`).join('\n');
// 无换行的长单段正文:按容器宽度会自动折成 >2 行,但 split('\n') 只有 1 行。
// 判官缺口:既有夹具都是显式 10 行,长单段会绕过「超过两行才折叠」的判定 → 不折叠、也没有 toggle。
const longPara = (m, tail = '', repeats = 7) => {
  const seg = `${m} 这是一段没有换行的长正文，用于验证按容器宽度自动折行后仍然只显示两行预览。`;
  return Array.from({ length: repeats }, () => seg).join('') + (tail ? ` ${tail}` : '');
};

async function openTarget(page, pair) {
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
}

test('A1 折叠行不是大卡片:默认高度 ≤180、无卡片阴影、行内有标题行展开控件', async ({ page }) => {
  const pair = seedPair('a1');
  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card, '前置:目标会话有 1 张待处理卡片').toBeVisible({ timeout: 15_000 });

  const facts = await styleOf(card);
  expect.soft(facts.height, `折叠行默认高度(实测 ${Math.round(facts.height)}px,应 ≤180;当前像大卡片)`).toBeLessThanOrEqual(180);
  expect.soft(facts.boxShadow, '折叠行不应有卡片阴影(box-shadow 计算值应为 none)').toBe('none');
  const toggle = card.getByTestId('xs-card-toggle');
  expect.soft(await toggle.count(), '收件箱行内应有标题行展开控件 [data-testid="xs-card-toggle"]').toBeGreaterThan(0);
  const hasNoticeRoot = await card.evaluate((el) => el.getAttribute('data-cgui') === 'xs-notice' || Boolean(el.closest('[data-cgui="xs-notice"]')));
  expect.soft(hasNoticeRoot, '收件箱行应属于通用折叠行根 [data-cgui="xs-notice"]').toBe(true);
});

test('A2 折叠态保留两行正文预览,第一行文字在 DOM 中且可见', async ({ page }) => {
  const pair = seedPair('a2');
  const body = body10(pair.m) + '\n尾部不该在预览里';
  const msg = await sendInbox(pair.A, pair.B, body);
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const bodyEl = card.getByTestId('xs-card-body');
  await expect(bodyEl, '收件箱正文节点应存在').toBeVisible();
  const f = await styleOf(bodyEl);
  const twoLine = f.clamp === '2' || f.height <= 4 * f.lineHeight;
  expect.soft(twoLine, `折叠预览应只有两行(实测 -webkit-line-clamp=${JSON.stringify(f.clamp)}, 正文高 ${Math.round(f.height)}px / 行高 ${Math.round(f.lineHeight)}px)`).toBe(true);
  const firstLine = `${pair.m} 第1行`;
  await expect.soft(bodyEl, '正文第一行应在 DOM 里').toContainText(firstLine);
  expect.soft(await bodyEl.evaluate((el, t) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.includes(t)) return true;
    return false;
  }, firstLine), '正文第一行文字应真的渲染在 DOM 里(不是只存在于属性)').toBe(true);
});

test('A3 点标题行展开 / 收起:正文显著变大、line-clamp 由 2 变 none、aria-expanded 跟着变', async ({ page }) => {
  const pair = seedPair('a3');
  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '点标题行展开的前提:标题行本身是展开控件').toBeVisible({ timeout: 5_000 });
  const bodyEl = card.getByTestId('xs-card-body');
  const h0 = (await styleOf(bodyEl)).height;
  expect.soft(await toggle.getAttribute('aria-expanded'), '折叠态 aria-expanded 应为 false').toBe('false');

  await toggle.click();
  await expect.poll(async () => (await styleOf(bodyEl)).height, { timeout: 5_000, message: '展开后正文应变高' }).toBeGreaterThan(h0 + 30);
  const opened = await styleOf(bodyEl);
  expect.soft(opened.clamp, '展开后 -webkit-line-clamp 应为 none').toBe('none');
  await expect.soft(toggle, '展开后 aria-expanded=true').toHaveAttribute('aria-expanded', 'true');

  await toggle.click();
  await expect.poll(async () => (await styleOf(bodyEl)).clamp, { timeout: 5_000, message: '再点应收起到两行' }).not.toBe('none');
  await expect.soft(toggle, '收起后 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');
});

test('A4 展开后能看到正文末尾(折叠只影响视觉,不删内容)', async ({ page }) => {
  const pair = seedPair('a4');
  const tail = `TAIL-${pair.m.slice(-8)}`;
  const body = [...Array.from({ length: 9 }, (_, i) => `${pair.m} 第${i + 1}行`), tail].join('\n');
  const msg = await sendInbox(pair.A, pair.B, body);
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  await toggle.click();
  const bodyEl = card.getByTestId('xs-card-body');
  const f = await styleOf(bodyEl);
  expect.soft(f.scrollHeight, `展开后正文不应被裁掉(scrollHeight ${f.scrollHeight} / clientHeight ${f.clientHeight})`).toBeLessThanOrEqual(f.clientHeight + 2);
  await expect.soft(bodyEl, '展开后页面上能读到正文末尾标记').toContainText(tail);
});

test('A5 短正文(1 行)没有展开控件,标题行不是按钮、不带 aria-expanded', async ({ page }) => {
  const pair = seedPair('a5');
  const msg = await sendInbox(pair.A, pair.B, `${pair.m} 只有一行`);
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  expect.soft(await card.getByTestId('xs-card-expand').count(), '短正文不应出现「展开全文」死按钮').toBe(0);
  const toggle = card.getByTestId('xs-card-toggle');
  const n = await toggle.count();
  if (n > 0) {
    const f = await styleOf(toggle.first());
    expect.soft(f.tag, '短正文的标题行不应是按钮').not.toBe('BUTTON');
    expect.soft(f.ariaExpanded, '短正文的标题行不应带 aria-expanded').toBeNull();
    expect.soft(f.role, '短正文的标题行不应有 role=button').not.toBe('button');
  } else {
    // 没有 toggle 时,退一步检查行内没有可展开的按钮
    expect.soft(await card.evaluate((el) => [...el.querySelectorAll('button,[role="button"]')].filter((b) => /展开全文/.test(b.innerText || '')).length), '短正文不应有展开控件').toBe(0);
  }
});

test('A6 正文缺失:接收行显示「（内容未能解析）」、发送行显示「（正文未记录）」，都不可展开', async ({ page }) => {
  // 接收:历史里的 peer 行 origin 没有 name / body(照 x23 的 p2 写法)
  const pair = seedPair('a6');
  const recv = seedPeerHistory('a6r', [{ from: 'uds:/tmp/r151w-a6.sock' }]);
  // 发送:历史里 tool_use 的 input 没有正文、tool_result 也没有 message 字段
  const send = seedSendHistory('a6s', {
    toolId: `toolu_${uniq('a6t').toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    input: { to: [pair.B.sid] },
    resultText: JSON.stringify({ results: [{ to: pair.B.sid, ok: true, id: pair.B.sid.slice(0, 8), name: pair.B.title }] }),
  });

  await boot(page);
  await openSessionBySearch(page, recv.title, `${recv.title} 回复`);
  const recvRow = page.getByTestId('peer-message').first();
  await expect(recvRow, '接收行应存在').toBeVisible({ timeout: 15_000 });
  await expect.soft(recvRow.getByTestId('peer-message-body'), '接收行正文缺失应显示占位').toHaveText('（内容未能解析）');
  expect.soft(await recvRow.getByTestId('peer-message-expand').count(), '正文缺失的接收行不应有展开提示').toBe(0);

  await openSessionBySearch(page, send.title, `${send.title} 回复`);
  const sendRow = page.getByTestId('xs-send-notice').first();
  await expect(sendRow, '发送行应存在').toBeVisible({ timeout: 15_000 });
  await expect.soft(sendRow.getByTestId('xs-send-body'), '发送行正文缺失应显示占位').toHaveText('（正文未记录）');
  expect.soft(await sendRow.getByTestId('xs-send-expand').count(), '正文缺失的发送行不应有展开提示').toBe(0);
});

test('A7 展开态不持久化:展开后切到另一个会话再切回,回到收起', async ({ page }) => {
  const pair = seedPair('a7');
  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  await toggle.click();
  await expect.soft(toggle, '前置:已展开').toHaveAttribute('aria-expanded', 'true');

  await openSessionBySearch(page, pair.A.title, pair.A.reply);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const again = cardOf(page, msg.id);
  await expect(again).toBeVisible({ timeout: 15_000 });
  await expect.soft(again.getByTestId('xs-card-toggle'), '切回后应回到收起(两行)').toHaveAttribute('aria-expanded', 'false');
});


test('A8 正文按纯文本渲染,不解析 markdown(收件箱与接收行都保持原文)', async ({ page }) => {
  const pair = seedPair('a8');
  const md = `${pair.m} **加粗** 与 # 一级标题 与 [链接](https://example.com/a8) 与 \`代码\``;
  const recv = seedPeerHistory('a8r', [{ from: `gui:${pair.A.sid}`, name: `用户转发自 ${pair.A.title}`, body: md }]);
  const msg = await sendInbox(pair.A, pair.B, md);
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const bodyEl = card.getByTestId('xs-card-body');
  await expect.soft(bodyEl, '收件箱正文保留 markdown 原文').toContainText('**加粗**');
  const parsed = await bodyEl.evaluate((el) => ['strong', 'h1', 'a', 'code', 'em'].map((t) => el.querySelectorAll(t).length));
  expect.soft(parsed, `收件箱正文不应解析出 markdown 元素(实测 ${JSON.stringify(parsed)})`).toEqual([0, 0, 0, 0, 0]);

  await openSessionBySearch(page, recv.title, `${recv.title} 回复`);
  const row = page.getByTestId('peer-message').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  const rb = page.locator('[data-testid="peer-message"]').filter({ hasText: pair.m }).first();
  await expect.soft(rb, '接收行正文保留 markdown 原文').toContainText('**加粗**');
  const rParsed = await rb.evaluate((el) => ['strong', 'h1', 'a', 'code', 'em'].map((t) => el.querySelectorAll(t).length));
  expect.soft(rParsed, `接收行正文不应解析出 markdown 元素(实测 ${JSON.stringify(rParsed)})`).toEqual([0, 0, 0, 0, 0]);
});

// 判官补充轮(2026-10-29):既有夹具全是显式换行的 10 行正文,「没有换行的长单段」会绕过折叠判定。
// 真实场景里跨会话消息经常就是一整段话(模型输出里没有 \n),按容器宽度折成 >2 行,用户看到的是整段铺开、没有 toggle。
// 契约依据:A1/A2/A3 对「正文超过两行」的要求不区分换行与否。
test('A9 无换行的长单段正文也折叠:两行预览、标题行是 BUTTON、可展开看全文、再收起', async ({ page }) => {
  const pair = seedPair('a9');
  const tail = `TAIL-${pair.m.slice(-8)}`;
  const body = longPara(pair.m, tail);
  expect.soft(body, '前置:正文是一整段、不含换行').not.toContain('\n');
  expect.soft(body.length, `前置:正文约 350–450 字(实测 ${body.length} 字),在 1280 宽下应折成 >2 行`).toBeGreaterThanOrEqual(300);

  const msg = await sendInbox(pair.A, pair.B, body);
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card, '前置:目标会话有 1 张待处理卡片').toBeVisible({ timeout: 15_000 });

  const bodyEl = card.getByTestId('xs-card-body');
  await expect(bodyEl, '收件箱正文节点应存在').toBeVisible();
  const folded = await styleOf(bodyEl);
  // 折叠态的两种等价判据(INTERFACE A2):line-clamp 计算值为 2,或高度 ≤ 2 行高度 + 容差。
  // 这里就是「只显示两行」的唯一断言,下面的像素高度独立上界已删除,理由见下。
  expect.soft(folded.clamp === '2' || folded.height <= 2 * folded.lineHeight + 2,
    `长单段折叠态应只显示两行(实测 -webkit-line-clamp=${JSON.stringify(folded.clamp)},正文高 ${Math.round(folded.height)}px / 行高 ${Math.round(folded.lineHeight)}px;`
    + '无换行的长单段被当成 1 行 → 不折叠,整段铺开)').toBe(true);
  // 注意:不要再加「folded.height ≤ 2 × lineHeight + 2」这种纯像素上界。getBoundingClientRect() 返回的是
  // 乘过 UI 缩放(--ui-zoom,默认 1.2)的视觉像素,而 getComputedStyle().lineHeight 是未缩放的计算值,
  // 两者口径不同 → 正确实现(两行 + 省略号 + toggle)恒被判红(实测 48.75 = 40.625 × 1.2 > 42.625)。
  // 「两行」由上面那条 clamp/高度二选一覆盖;收起态由本用例末尾的 again.clamp 断言覆盖。
  const cardFacts = await styleOf(card);
  expect.soft(cardFacts.height, `折叠行整体高度应有上界(≤180,实测 ${Math.round(cardFacts.height)}px)`).toBeLessThanOrEqual(180);

  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  expect.soft(await toggle.evaluate((el) => el.tagName), '长单段正文的标题行应是 BUTTON(能点开),不是不可点的 div').toBe('BUTTON');
  await expect.soft(toggle, '折叠态 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');

  // 展开:正文显著变高、clamp 放开、不裁切,末尾标记真的落在正文节点的可视矩形里
  await toggle.click();
  await expect.poll(async () => (await styleOf(bodyEl)).height, { timeout: 5_000, message: '长单段点标题行后正文应变高(当前实现不会展开)' }).toBeGreaterThan(folded.height + 30);
  const opened = await styleOf(bodyEl);
  expect.soft(opened.clamp, '展开后 -webkit-line-clamp 应为 none').toBe('none');
  expect.soft(opened.scrollHeight, `展开后正文不应被裁掉(scrollHeight ${opened.scrollHeight} / clientHeight ${opened.clientHeight})`).toBeLessThanOrEqual(opened.clientHeight + 2);
  await expect.soft(toggle, '展开后 aria-expanded=true').toHaveAttribute('aria-expanded', 'true');
  const tailRange = await bodyEl.evaluate((el, t) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(t);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i);
      range.setEnd(n, i + t.length);
      const tr = range.getBoundingClientRect();
      const br = el.getBoundingClientRect();
      return { top: tr.top, bottom: tr.bottom, within: tr.top >= br.top - 1 && tr.bottom <= br.bottom + 1 };
    }
    return null;
  }, tail);
  expect.soft(tailRange && tailRange.within, `展开后正文末尾应在正文节点的可视范围内(实测 ${JSON.stringify(tailRange)})`).toBe(true);

  // 再收起:回到两行预览
  await toggle.click();
  await expect(toggle, '再点标题行应收起').toHaveAttribute('aria-expanded', 'false');
  const again = await styleOf(bodyEl);
  expect.soft(again.clamp === '2' || again.height <= 2 * again.lineHeight + 2,
    `收起后应回到两行(实测 -webkit-line-clamp=${JSON.stringify(again.clamp)},正文高 ${Math.round(again.height)}px / 行高 ${Math.round(again.lineHeight)}px)`).toBe(true);
});

// ---------------- 判官新增缺口补充轮(2026-10-29) ----------------

/**
 * A10 夹具:约 120 字、无换行的收件箱正文。
 * 判官在隔离实例实测:110 字量级在 1280 单窗格两行正好放得下(clientHeight = scrollHeight = 41),
 * 同一挂载行开分屏后正文宽 493、scrollHeight = 82(四行),toggle 却仍是 DIV、后两行不可见也不可展开。
 * 本机复核(本用例实测):同一量级取 122 字,正文宽 864 → 493、内容 41 → 82,与判官数字一致。
 * 断言只写「两行放得下 / 放不下」,不写死任何像素宽度。
 */
const widthProbePara = (m, tail) => {
  const unit = '跨会话消息常常就是一整段没有换行的正文，窗口或分屏一变窄，原本两行放得下的内容就会折成三四行；';
  let s = `${m} `;
  while (s.length < 106) s += unit;
  return `${s.slice(0, 108)} ${tail}`;
};

/** 正文末尾标记是否真的落在正文节点的可视矩形里(「展开后能看到后半段」的可观察判据)。 */
const tailOnScreen = (loc, t) => loc.evaluate((el, s) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf(s);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(n, i);
    range.setEnd(n, i + s.length);
    const tr = range.getBoundingClientRect();
    const br = el.getBoundingClientRect();
    return { text: s, top: tr.top, bottom: tr.bottom, within: tr.top >= br.top - 1 && tr.bottom <= br.bottom + 1 };
  }
  return null;
}, t);

// 判官实测到的 P1:折叠判定只在挂载 / 展开 / 文本变化时量一次
// (XsNoticeRow 的 useLayoutEffect 依赖 [text, noFold, expanded],没有 ResizeObserver),
// 挂载后宽度变窄(开分屏 / 拖窗 / 收侧栏)不会重测 —— 原本两行放得下的正文被窄窗格折成三四行后
// 仍按「放得下」处理:两行被裁住,却连展开入口(标题行 BUTTON)都没有。
// 缩窄方式:面板坞 → 分屏=2。窗格 0 继续持有同一会话,不刷新、不重开会话;
// 「没有重挂载」用两重证据:缩窄前后是同一个 DOM 节点(节点上的临时标记还在)+ 同一 data-message-id 行还在。
test('A10 挂载后宽度变窄要重测折叠:1280 两行放得下 → 开分屏后同一行出现展开入口(可展开看末尾、可收起)', async ({ page }) => {
  const pair = seedPair('a10');
  const tail = `TAIL-${pair.m.slice(-8)}`;
  const body = widthProbePara(pair.m, tail);
  expect.soft(body, '前置:正文是一整段、不含换行').not.toContain('\n');
  expect.soft(body.length >= 100 && body.length <= 140,
    `前置:正文约 100–140 字(实测 ${body.length} 字;太长会让 1280 也放不下 → 调短正文,不要改断言意图;太短会让分屏也只放得下两行)`).toBe(true);

  const msg = await sendInbox(pair.A, pair.B, body);
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const card = cardOf(page, msg.id);
  await expect(card, '前置:目标会话有 1 张待处理卡片').toBeVisible({ timeout: 15_000 });

  const bodyEl = card.getByTestId('xs-card-body');
  await expect(bodyEl, '前置:收件箱正文节点存在').toBeVisible();
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行控件存在').toBeVisible({ timeout: 5_000 });

  // ① 1280 单窗格:两行放得下 → 折叠态没有展开入口(DIV、不带 aria-expanded)
  const wideBody = await styleOf(bodyEl);
  expect.soft(wideBody.scrollHeight,
    `前置:1280 单窗格两行就放得下(正文内容 ${wideBody.scrollHeight}px / 两行预览 ${wideBody.clientHeight}px,`
    + `正文宽 ${Math.round(wideBody.width)}px;放不下就调短正文,不要改断言意图)`).toBeLessThanOrEqual(wideBody.clientHeight + 1);
  const wideToggle = await styleOf(toggle);
  expect.soft(wideToggle.tag, `1280 两行放得下 → 标题行不应是 BUTTON(实测 ${wideToggle.tag})`).not.toBe('BUTTON');
  expect.soft(wideToggle.ariaExpanded, '1280 两行放得下 → 标题行不应带 aria-expanded').toBeNull();

  // ② 不重挂载地缩窄:先给当前 DOM 节点打标记(React 重挂一份就是新节点,标记会丢)
  await card.evaluate((el) => { el.__a10SameNode = (el.__a10SameNode || 0) + 1; });
  await setPanes(page, 2);
  await expect(page.locator('[data-testid="pane"]'), '前置:分屏后有两个窗格').toHaveCount(2, { timeout: 15_000 });
  const pane0 = page.locator('[data-testid="pane"]').nth(0);
  await expect(pane0.locator(`[data-testid="xs-card"][data-message-id="${msg.id}"]`), '缩窄后同一 data-message-id 的行仍在窗格 0').toBeVisible({ timeout: 10_000 });
  expect.soft(await card.evaluate((el) => el.__a10SameNode === 1),
    '缩窄过程没有重挂载(缩窄前后应是同一个 DOM 节点;换页面 / 换会话会新挂一份,标记就丢了)').toBe(true);
  // 窗格确实变窄了才谈得上「宽度变化」;等布局稳定
  await expect.poll(async () => (await styleOf(bodyEl)).width, { timeout: 10_000, message: '分屏后正文应变窄(窗格被压到约一半宽)' }).toBeLessThan(wideBody.width - 100);
  // 再等一帧:给「重测 → 提交重渲染」留时间(不是重试断言 —— 当前实现等多久标题行都还是 DIV)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const narrowBody = await styleOf(bodyEl);
  const narrowToggle = await styleOf(toggle);
  expect.soft(narrowBody.scrollHeight,
    `缩窄后正文内容应高于两行预览(= 被裁;内容 ${narrowBody.scrollHeight}px / 预览 ${narrowBody.clientHeight}px,`
    + `正文宽 ${Math.round(narrowBody.width)}px)`).toBeGreaterThan(narrowBody.clientHeight + 1);

  // ③ 红点断言:宽度变窄后应重测折叠 → 同一行变成能点的 BUTTON、aria-expanded=false
  expect.soft(narrowToggle.tag,
    `宽度变窄后同一行应重新判定折叠:标题行应是能点的 BUTTON,实测 ${narrowToggle.tag}`
    + `(正文宽 ${Math.round(wideBody.width)}px → ${Math.round(narrowBody.width)}px,内容 ${narrowBody.scrollHeight}px 塞进两行 ${narrowBody.clientHeight}px 的预览里,`
    + '后半段看不见、也没有展开入口 → 当前实现只在挂载/展开/文本变化时测量)').toBe('BUTTON');
  await expect.soft(toggle, '宽度变窄后折叠态 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');

  // ④ 点开能看到正文后半段(末尾标记落在正文节点可视矩形里),再收起回两行
  await toggle.click();
  await expect.poll(async () => (await styleOf(bodyEl)).height, { timeout: 5_000, message: '缩窄后点标题行应能展开(当前实现:标题行仍是 div,点了没反应)' }).toBeGreaterThan(narrowBody.height + 30);
  const opened = await styleOf(bodyEl);
  expect.soft(opened.clamp, '展开后 -webkit-line-clamp 应为 none').toBe('none');
  expect.soft(opened.scrollHeight, `展开后正文不应被裁(scrollHeight ${opened.scrollHeight} / clientHeight ${opened.clientHeight})`).toBeLessThanOrEqual(opened.clientHeight + 2);
  await expect.soft(toggle, '展开后 aria-expanded=true').toHaveAttribute('aria-expanded', 'true');
  const tailRange = await tailOnScreen(bodyEl, tail);
  expect.soft(tailRange && tailRange.within, `展开后正文末尾应在正文节点的可视范围内(实测 ${JSON.stringify(tailRange)})`).toBe(true);

  await toggle.click();
  await expect(toggle, '再点标题行应收起').toHaveAttribute('aria-expanded', 'false');
  const again = await styleOf(bodyEl);
  // 收起后回到两行:只看 line-clamp(高度是乘过 --ui-zoom 的视觉像素,不能和未缩放的行高直接比)
  expect.soft(again.clamp, `收起后应回到两行预览(实测 -webkit-line-clamp=${JSON.stringify(again.clamp)})`).toBe('2');
});

// 判官可选缺口 S3:分屏把同一会话挂两份时,同一条消息会有两份 DOM。
// 正文节点 id 若按「testid + 消息 id」生成,两处 id 相同、两份 aria-controls 会指向同一个节点(读屏关系错位)。
// 实现已改用 useId(每个实例唯一);这里从 DOM 观察:id 唯一 + 每份 aria-controls 指向自己那份正文。
test('S3 分屏同一会话同一条消息挂两份:正文 id 唯一,aria-controls 各指自己的正文', async ({ page }) => {
  const pair = seedPair('s3');
  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  await expect(cardOf(page, msg.id), '前置:目标会话有 1 张待处理卡片').toBeVisible({ timeout: 15_000 });
  await setPanes(page, 2);
  await fillPane(page, 2, pair.B.title); // 同一会话填进第二格 → 同一条消息两份 DOM
  await expect(page.locator('[data-testid="pane"]')).toHaveCount(2, { timeout: 15_000 });

  const copies = page.locator(`[data-testid="xs-card"][data-message-id="${msg.id}"]`);
  await expect(copies, '前置:同一会话同一条消息在两个窗格各挂一份').toHaveCount(2, { timeout: 15_000 });
  const info = await copies.evaluateAll((els) => els.map((el) => {
    const t = el.querySelector('[data-testid="xs-card-toggle"]');
    const b = el.querySelector('[data-testid="xs-card-body"]');
    const c = t ? t.getAttribute('aria-controls') : null;
    return {
      bodyId: b ? b.id : null,
      controls: c,
      controlsSelf: Boolean(b && c && c === b.id),
      // aria-controls 指向的节点必须真的存在,且是这一份里的正文
      controlsResolvesToOwnBody: Boolean(c && el.querySelector(`#${CSS.escape(c)}`) === b),
    };
  }));
  expect.soft(info.length, '同一消息应有两份 DOM').toBe(2);
  expect.soft(info[0].bodyId, '正文节点应有 id').toBeTruthy();
  expect.soft(info[0].bodyId === info[1].bodyId,
    `两份正文的 id 不应相同(实测 ${JSON.stringify(info.map((x) => x.bodyId))})`).toBe(false);
  for (const [i, one] of info.entries()) {
    expect.soft(one.controlsSelf,
      `第 ${i + 1} 份标题行的 aria-controls 应指向自己那份正文(controls=${one.controls}, 自己 bodyId=${one.bodyId})`).toBe(true);
    expect.soft(one.controlsResolvesToOwnBody,
      `第 ${i + 1} 份 aria-controls 指向的节点应存在且是本份正文(controls=${one.controls})`).toBe(true);
  }
});
