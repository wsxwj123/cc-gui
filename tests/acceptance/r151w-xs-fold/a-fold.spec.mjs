// A 组:折叠行通用行为(A1–A7)。依据 .devflow/r151w-INTERFACE.md 第 1 节,只从用户可观察的 DOM/几何/文案断言。
// 夹具:收件箱待处理消息走既有 POST /api/xsession/messages;缺正文的接收/发送行用会话记录 jsonl 预置。
import { test, expect } from '@playwright/test';
import {
  api, boot, openSessionBySearch, seedPair, sendInbox, cardOf, styleOf, uniq,
  seedPeerHistory, seedSendHistory,
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
