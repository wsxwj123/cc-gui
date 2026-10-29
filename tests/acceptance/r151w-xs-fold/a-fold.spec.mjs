// A 组:折叠行通用行为(A1–A10)。依据 .devflow/r151w-INTERFACE.md 第 1 节 + 第 9 节用户修订(2026-10-29 21:20)。
// 新形态:折叠态只有「标题行 + 状态 + 展开全文」,正文不显示(不渲染或可见高度 0);有正文(哪怕 1 行)就有展开入口;
// 展开才显示完整正文,再点收起回标题行。旧条款里所有「两行预览 / line-clamp=2 / 高度 ≤ 2 行」断言全部作废。
// 统一口径见 helpers/w.mjs 的 expectFolded / waitBodyShown / waitBodyHidden —— 全套件只用这一条。
// 夹具:收件箱待处理消息走既有 POST /api/xsession/messages;缺正文的接收/发送行用会话记录 jsonl 预置。
import { test, expect } from '@playwright/test';
import {
  api, boot, openSessionBySearch, seedPair, sendInbox, cardOf, styleOf, uniq,
  seedPeerHistory, seedSendHistory, setPanes, fillPane,
  EXPAND, COLLAPSE, bodyFacts, textCenterFacts, expectFolded, waitBodyShown, waitBodyHidden, expectExpandEntry,
} from './helpers/w.mjs';

test.describe.configure({ timeout: 240_000 });
test.beforeEach(async () => { await api.on(); });

const body10 = (m) => Array.from({ length: 10 }, (_, i) => `${m} 第${i + 1}行 —— 这是一段够长的正文,用来证明折叠态一个字都不显示`).join('\n');
// 无换行的长单段正文:按容器宽度会自动折成 >2 行,但 split('\n') 只有 1 行。
// 新形态下折叠态不显示正文,这条夹具用来证明「长单段也一样被折叠住、也有展开入口」。
const longPara = (m, tail = '', repeats = 7) => {
  const seg = `${m} 这是一段没有换行的长正文，用于验证按容器宽度自动折行后折叠态仍然不显示任何正文预览。`;
  return Array.from({ length: repeats }, () => seg).join('') + (tail ? ` ${tail}` : '');
};

async function openTarget(page, pair) {
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
}

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

test('A2 折叠态只有标题行 + 状态 + 「展开全文」:正文不显示;展开后完整、再收起消失', async ({ page }) => {
  const pair = seedPair('a2');
  const tail = `TAIL-${pair.m.slice(-8)}`;
  const body = body10(pair.m) + `\n${tail}`;
  const msg = await sendInbox(pair.A, pair.B, body);
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card, '前置:目标会话有 1 张待处理卡片').toBeVisible({ timeout: 15_000 });

  // ① 折叠态:正文不显示(统一口径:不在 DOM 或可见高度 0);原文第一行与末尾都不能出现在页面上
  const folded = await expectFolded(card, 'xs-card-body', '收件箱行正文');
  expect.soft(folded.text.includes(`${pair.m} 第1行`),
    '折叠态不应把正文原文(哪怕第一行)留在可见正文节点里').toBe(false);

  // ② 有正文就有展开入口,提示文案「展开全文」
  const expand = await expectExpandEntry(card, 'xs-card-expand', '收件箱正文');
  const toggle = card.getByTestId('xs-card-toggle');
  await expect.soft(toggle, '折叠态 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');

  // ③ 展开:正文出现且完整(首行 + 末尾都在、没被裁)
  await toggle.click();
  const bodyEl = await waitBodyShown(card, 'xs-card-body', '展开后的收件箱正文');
  await expect.soft(bodyEl, '展开后正文完整(含末尾标记)').toContainText(tail);
  await expect.soft(bodyEl, '展开后正文完整(含第一行)').toContainText(`${pair.m} 第1行`);
  const opened = await bodyFacts(card, 'xs-card-body');
  expect.soft(opened.scrollHeight, `展开后正文不应被裁掉(scrollHeight ${opened.scrollHeight} / clientHeight ${opened.clientHeight})`).toBeLessThanOrEqual(opened.clientHeight + 2);
  await expect.soft(toggle, '展开后 aria-expanded=true').toHaveAttribute('aria-expanded', 'true');
  await expect.soft(expand, `展开后提示变成「${COLLAPSE}」`).toHaveText(COLLAPSE);

  // ④ 再收起:正文消失(不再有两行预览),aria 回到 false
  await toggle.click();
  await waitBodyHidden(card, 'xs-card-body', '收起后的收件箱正文');
  await expect.soft(toggle, '收起后 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');
  await expect.soft(expand, `收起后提示回到「${EXPAND}」`).toHaveText(EXPAND);
});

test('A3 点标题行展开 / 收起:aria-expanded 跟着变,正文只在展开时出现', async ({ page }) => {
  const pair = seedPair('a3');
  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '点标题行展开的前提:标题行本身是展开控件').toBeVisible({ timeout: 5_000 });
  await expect.soft(toggle, '折叠态 aria-expanded 应为 false').toHaveAttribute('aria-expanded', 'false');
  await expectFolded(card, 'xs-card-body', '收件箱行正文');

  // 点标题行(不是点「展开全文」三个字)→ 正文出现
  await toggle.click();
  await waitBodyShown(card, 'xs-card-body', '展开后的收件箱正文');
  const opened = await bodyFacts(card, 'xs-card-body');
  expect.soft(opened.height, `展开后正文应有可见高度(实测 ${Math.round(opened.height)}px)`).toBeGreaterThan(20);
  await expect.soft(toggle, '展开后 aria-expanded=true').toHaveAttribute('aria-expanded', 'true');

  // 再点一次 → 正文消失,回到标题行
  await toggle.click();
  await waitBodyHidden(card, 'xs-card-body', '收起后的收件箱正文');
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
  await expectFolded(card, 'xs-card-body', '收件箱行正文');
  await toggle.click();
  const bodyEl = await waitBodyShown(card, 'xs-card-body', '展开后的收件箱正文');
  const f = await bodyFacts(card, 'xs-card-body');
  expect.soft(f.scrollHeight, `展开后正文不应被裁掉(scrollHeight ${f.scrollHeight} / clientHeight ${f.clientHeight})`).toBeLessThanOrEqual(f.clientHeight + 2);
  await expect.soft(bodyEl, '展开后页面上能读到正文末尾标记').toContainText(tail);
});

// 用户 2026-10-29 21:20 修订:有正文就有展开,哪怕只有 1 行 —— 旧 A5(「短正文没有展开控件」)整条反了。
test('A5 1 行正文也有展开入口(旧 A5 反了):折叠态不显示正文,展开后看到那一行', async ({ page }) => {
  const pair = seedPair('a5');
  const line = `${pair.m} 只有一行`;
  const msg = await sendInbox(pair.A, pair.B, line);
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });

  await expectFolded(card, 'xs-card-body', '1 行正文的收件箱行正文');
  const expand = await expectExpandEntry(card, 'xs-card-expand', '1 行正文');
  const toggle = card.getByTestId('xs-card-toggle');
  expect.soft(await toggle.evaluate((el) => el.tagName), '1 行正文的标题行也应是可点的 BUTTON(不是不可点的 div)').toBe('BUTTON');
  await expect.soft(toggle, '1 行正文折叠态 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  const bodyEl = await waitBodyShown(card, 'xs-card-body', '展开后的 1 行正文');
  await expect.soft(bodyEl, '展开后能看到那一行原文').toContainText(line);
  await expect.soft(expand, `展开后提示变成「${COLLAPSE}」`).toHaveText(COLLAPSE);
  await toggle.click();
  await waitBodyHidden(card, 'xs-card-body', '收起后的 1 行正文');
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
  // 占位用于说明「内容缺失」,第 9 节只要求「不显示正文预览」,没有取消占位;
  // 不钉死在正文节点上(body 节点在折叠态可能不渲染),只要求行内能读到占位文案。
  await expect.soft(recvRow, '接收行正文缺失应显示占位「（内容未能解析）」').toContainText('（内容未能解析）');
  expect.soft(await recvRow.getByTestId('peer-message-expand').count(), '正文缺失的接收行不应有展开提示').toBe(0);

  await openSessionBySearch(page, send.title, `${send.title} 回复`);
  const sendRow = page.getByTestId('xs-send-notice').first();
  await expect(sendRow, '发送行应存在').toBeVisible({ timeout: 15_000 });
  await expect.soft(sendRow, '发送行正文缺失应显示占位「（正文未记录）」').toContainText('（正文未记录）');
  expect.soft(await sendRow.getByTestId('xs-send-expand').count(), '正文缺失的发送行不应有展开提示').toBe(0);
});

test('A7 展开态不持久化:展开后切到另一个会话再切回,回到收起(正文隐藏)', async ({ page }) => {
  const pair = seedPair('a7');
  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  await toggle.click();
  await expect.soft(toggle, '前置:已展开').toHaveAttribute('aria-expanded', 'true');
  await waitBodyShown(card, 'xs-card-body', '前置:展开后的收件箱正文');

  await openSessionBySearch(page, pair.A.title, pair.A.reply);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const again = cardOf(page, msg.id);
  await expect(again).toBeVisible({ timeout: 15_000 });
  await expect.soft(again.getByTestId('xs-card-toggle'), '切回后应回到收起(aria-expanded=false)').toHaveAttribute('aria-expanded', 'false');
  await expectFolded(again, 'xs-card-body', '切回后的收件箱正文');
});


test('A8 正文按纯文本渲染,不解析 markdown(收件箱与接收行都保持原文,展开后可见)', async ({ page }) => {
  const pair = seedPair('a8');
  const md = `${pair.m} **加粗** 与 # 一级标题 与 [链接](https://example.com/a8) 与 \`代码\``;
  const recv = seedPeerHistory('a8r', [{ from: `gui:${pair.A.sid}`, name: `用户转发自 ${pair.A.title}`, body: md }]);
  const msg = await sendInbox(pair.A, pair.B, md);
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  // 折叠态不显示正文 → 先展开再看原文
  await expectFolded(card, 'xs-card-body', '收件箱行正文');
  await card.getByTestId('xs-card-toggle').click();
  const bodyEl = await waitBodyShown(card, 'xs-card-body', '展开后的收件箱正文');
  await expect.soft(bodyEl, '收件箱正文保留 markdown 原文').toContainText('**加粗**');
  const parsed = await bodyEl.evaluate((el) => ['strong', 'h1', 'a', 'code', 'em'].map((t) => el.querySelectorAll(t).length));
  expect.soft(parsed, `收件箱正文不应解析出 markdown 元素(实测 ${JSON.stringify(parsed)})`).toEqual([0, 0, 0, 0, 0]);

  await openSessionBySearch(page, recv.title, `${recv.title} 回复`);
  const row = page.getByTestId('peer-message').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  const rb = page.locator('[data-testid="peer-message"]').filter({ hasText: pair.m }).first();
  await expectFolded(rb, 'peer-message-body', '接收行正文');
  await rb.getByTestId('peer-message-toggle').click();
  const rBody = await waitBodyShown(rb, 'peer-message-body', '展开后的接收行正文');
  await expect.soft(rBody, '接收行正文保留 markdown 原文').toContainText('**加粗**');
  const rParsed = await rBody.evaluate((el) => ['strong', 'h1', 'a', 'code', 'em'].map((t) => el.querySelectorAll(t).length));
  expect.soft(rParsed, `接收行正文不应解析出 markdown 元素(实测 ${JSON.stringify(rParsed)})`).toEqual([0, 0, 0, 0, 0]);
});

// 用户 2026-10-29 21:20 修订前的判官补充轮:「没有换行的长单段」会绕过按换行数判定的折叠。
// 新形态下这条依然有意义:长单段折叠态也必须没有正文预览,且必须给展开入口。
test('A9 无换行的长单段正文:折叠态无正文预览、标题行是 BUTTON、展开可看全文、再收起消失', async ({ page }) => {
  const pair = seedPair('a9');
  const tail = `TAIL-${pair.m.slice(-8)}`;
  const body = longPara(pair.m, tail);
  expect.soft(body, '前置:正文是一整段、不含换行').not.toContain('\n');
  expect.soft(body.length, `前置:正文约 350–450 字(实测 ${body.length} 字),在 1280 宽下应折成 >2 行`).toBeGreaterThanOrEqual(300);

  const msg = await sendInbox(pair.A, pair.B, body);
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card, '前置:目标会话有 1 张待处理卡片').toBeVisible({ timeout: 15_000 });

  // ① 折叠态:没有正文预览(统一口径),只有标题行 + 状态 + 展开全文
  const folded = await expectFolded(card, 'xs-card-body', '长单段收件箱正文');
  expect.soft(folded.shown, `长单段折叠态不应显示正文(实测 ${Math.round(folded.height)}px/行高未知;旧实现整段铺开)`).toBe(false);
  const expand = await expectExpandEntry(card, 'xs-card-expand', '长单段正文');
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  expect.soft(await toggle.evaluate((el) => el.tagName), '长单段正文的标题行应是 BUTTON(能点开),不是不可点的 div').toBe('BUTTON');
  await expect.soft(toggle, '折叠态 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');
  const cardFacts = await styleOf(card);
  expect.soft(cardFacts.height, `折叠行整体高度应有上界(≤180,实测 ${Math.round(cardFacts.height)}px)`).toBeLessThanOrEqual(180);

  // ② 展开:正文出现、不裁切,末尾标记真的落在正文节点的可视矩形里
  await toggle.click();
  const bodyEl = await waitBodyShown(card, 'xs-card-body', '展开后的长单段正文');
  const opened = await bodyFacts(card, 'xs-card-body');
  expect.soft(opened.scrollHeight, `展开后正文不应被裁掉(scrollHeight ${opened.scrollHeight} / clientHeight ${opened.clientHeight})`).toBeLessThanOrEqual(opened.clientHeight + 2);
  await expect.soft(toggle, '展开后 aria-expanded=true').toHaveAttribute('aria-expanded', 'true');
  await expect.soft(expand, `展开后提示变成「${COLLAPSE}」`).toHaveText(COLLAPSE);
  const tailRange = await tailOnScreen(bodyEl, tail);
  expect.soft(tailRange && tailRange.within, `展开后正文末尾应在正文节点的可视范围内(实测 ${JSON.stringify(tailRange)})`).toBe(true);

  // ③ 再收起:正文消失,回到标题行
  await toggle.click();
  await waitBodyHidden(card, 'xs-card-body', '收起后的长单段正文');
  await expect(toggle, '再点标题行应收起').toHaveAttribute('aria-expanded', 'false');
});

// ---------------- 判官新增缺口补充轮(2026-10-29) ----------------

/**
 * 约 120 字、无换行的收件箱正文(旧 A10 的宽度探针)。新形态下不再需要「宽度变窄后重测折叠」:
 * 折叠态永远不显示正文,所以不存在「被裁住却没有入口」;本用例改成证明
 * **宽度变化不改变折叠形态**——宽/窄两种布局下同一行都是「无正文预览 + 有展开入口」,展开都能看到末尾。
 */
const widthProbePara = (m, tail) => {
  const unit = '跨会话消息常常就是一整段没有换行的正文，窗口或分屏一变窄，原本两行放得下的内容就会折成三四行；';
  let s = `${m} `;
  while (s.length < 106) s += unit;
  return `${s.slice(0, 108)} ${tail}`;
};

test('A10 宽度变化不改变折叠形态:开分屏后同一行仍无正文预览、仍有展开入口,展开可看末尾', async ({ page }) => {
  const pair = seedPair('a10');
  const tail = `TAIL-${pair.m.slice(-8)}`;
  const body = widthProbePara(pair.m, tail);
  expect.soft(body, '前置:正文是一整段、不含换行').not.toContain('\n');
  expect.soft(body.length >= 100 && body.length <= 140,
    `前置:正文约 100–140 字(实测 ${body.length} 字;这是旧 A10 的宽度探针,用来证明窄窗格下形态不变)`).toBe(true);

  const msg = await sendInbox(pair.A, pair.B, body);
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const card = cardOf(page, msg.id);
  await expect(card, '前置:目标会话有 1 张待处理卡片').toBeVisible({ timeout: 15_000 });

  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行控件存在').toBeVisible({ timeout: 5_000 });

  // ① 1280 单窗格:折叠态无正文预览、有展开入口
  const wideRow = await styleOf(card);
  await expectFolded(card, 'xs-card-body', '宽窗格折叠态正文');
  await expectExpandEntry(card, 'xs-card-expand', '宽窗格正文');
  await expect.soft(toggle, '宽窗格折叠态 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');

  // ② 不重挂载地缩窄:先给当前 DOM 节点打标记(React 重挂一份就是新节点,标记会丢)
  await card.evaluate((el) => { el.__a10SameNode = (el.__a10SameNode || 0) + 1; });
  await setPanes(page, 2);
  await expect(page.locator('[data-testid="pane"]'), '前置:分屏后有两个窗格').toHaveCount(2, { timeout: 15_000 });
  const pane0 = page.locator('[data-testid="pane"]').nth(0);
  await expect(pane0.locator(`[data-testid="xs-card"][data-message-id="${msg.id}"]`), '缩窄后同一 data-message-id 的行仍在窗格 0').toBeVisible({ timeout: 10_000 });
  expect.soft(await card.evaluate((el) => el.__a10SameNode === 1),
    '缩窄过程没有重挂载(缩窄前后应是同一个 DOM 节点;换页面 / 换会话会新挂一份,标记就丢了)').toBe(true);
  await expect.poll(async () => (await styleOf(card)).width, { timeout: 10_000, message: '分屏后该行应变窄(窗格被压到约一半宽)' }).toBeLessThan(wideRow.width - 100);
  // 再等一帧:给布局稳定留时间
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // ③ 红点断言:变窄后形态不变 —— 仍然没有正文预览,仍然有展开入口(旧实现此时会把两行挤成四行)
  const narrowRow = await styleOf(card);
  const narrowBody = await bodyFacts(card, 'xs-card-body');
  expect.soft(narrowBody.shown,
    `窄窗格折叠态仍不应显示正文(实测 ${Math.round(narrowBody.height)}px;行宽 ${Math.round(wideRow.width)}px → ${Math.round(narrowRow.width)}px)`).toBe(false);
  await expectExpandEntry(card, 'xs-card-expand', '窄窗格正文');
  await expect.soft(toggle, '窄窗格折叠态 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');

  // ④ 窄窗格点开:仍然能展开看到正文末尾,再收起回标题行
  await toggle.click();
  const bodyEl = await waitBodyShown(card, 'xs-card-body', '窄窗格展开后的正文');
  const opened = await bodyFacts(card, 'xs-card-body');
  expect.soft(opened.scrollHeight, `展开后正文不应被裁(scrollHeight ${opened.scrollHeight} / clientHeight ${opened.clientHeight})`).toBeLessThanOrEqual(opened.clientHeight + 2);
  await expect.soft(toggle, '展开后 aria-expanded=true').toHaveAttribute('aria-expanded', 'true');
  const tailRange = await tailOnScreen(bodyEl, tail);
  expect.soft(tailRange && tailRange.within, `展开后正文末尾应在正文节点的可视范围内(实测 ${JSON.stringify(tailRange)})`).toBe(true);

  await toggle.click();
  await waitBodyHidden(card, 'xs-card-body', '收起后的正文');
  await expect(toggle, '再点标题行应收起').toHaveAttribute('aria-expanded', 'false');
});

// ---------------- 用户 2026-10-29 补充要求:折叠行展开后的正文也要水平居中 ----------------
// 判据(实现无关,见 helpers/w.mjs 的 textCenterFacts):展开后每一行没占满正文宽度的文本,
// 在正文内容框里的左右留白应基本相等(容差 2px);左对齐时短行左侧留白恒 ≈0,一眼分开。
// 夹具刻意用三种不同长度的短行:只把容器整体居中、文字仍左对齐的实现,短行会贴着内容框左边,同样过不了。
test('A11 展开后正文水平居中:每行左右留白相等(不是靠左),且正文完整、可再收起', async ({ page }) => {
  const pair = seedPair('a11');
  const lines = [
    `${pair.m} 第一行`,
    `${pair.m} 第二行还有更多一些文字内容`,
    `${pair.m} 第三行中等长度`,
  ];
  const msg = await sendInbox(pair.A, pair.B, lines.join('\n'));
  await openTarget(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card, '前置:目标会话有 1 张待处理卡片').toBeVisible({ timeout: 15_000 });

  // 折叠态不显示正文(统一口径不变)
  await expectFolded(card, 'xs-card-body', '居中用例的收件箱正文');
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  await toggle.click();
  const bodyEl = await waitBodyShown(card, 'xs-card-body', '展开后的收件箱正文');

  // ① 展开后正文完整(三行都在,不删内容)
  for (const line of lines) {
    await expect.soft(bodyEl, `展开后正文完整(含「${line}」)`).toContainText(line);
  }

  // ② 红点断言:展开后的正文水平居中
  const c = await textCenterFacts(card, 'xs-card-body');
  expect.soft(c.inDom, '展开后应能读到正文节点(居中判据依赖它)').toBe(true);
  expect.soft(c.narrowLines,
    `前置:应至少有一行没占满正文宽度(实测各行 [宽,左留白,右留白] = ${JSON.stringify(c.lines)})`).toBeGreaterThan(0);
  expect.soft(c.centered,
    `展开后正文应水平居中:每行左右留白应基本相等(实测 textAlign=${c.textAlign},内容宽 ${Math.round(c.contentWidth)}px, `
    + `各行 [宽,左留白,右留白] = ${JSON.stringify(c.lines)};左对齐时短行左侧留白为 0、右侧留白几十像素)`).toBe(true);

  // ③ 保留「可再收起」:再点标题行,正文消失、aria 回到 false
  await toggle.click();
  await waitBodyHidden(card, 'xs-card-body', '收起后的居中用例正文');
  await expect.soft(toggle, '收起后 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');
});

// 判官可选缺口 S3:分屏把同一会话挂两份时,同一条消息会有两份 DOM。
// 正文节点 id 若按「testid + 消息 id」生成,两处 id 相同、两份 aria-controls 会指向同一个节点(读屏关系错位)。
// 新形态下折叠态不渲染正文 → 先各自展开,再比较两份正文的 id 与 aria-controls(实现已改用 useId)。
test('S3 分屏同一会话同一条消息挂两份:展开后正文 id 唯一,aria-controls 各指自己的正文', async ({ page }) => {
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
  // 折叠态两份都不显示正文;各自展开后才能观察正文节点 id 与 aria-controls 的对应关系
  await expectFolded(copies.nth(0), 'xs-card-body', '第 1 份折叠态正文');
  await expectFolded(copies.nth(1), 'xs-card-body', '第 2 份折叠态正文');
  const info = await (async () => {
    // 逐份点开(两份是独立实例,展开状态互不影响)
    for (const i of [0, 1]) {
      if (!(await bodyFacts(copies.nth(i), 'xs-card-body')).shown) {
        await copies.nth(i).getByTestId('xs-card-toggle').click();
      }
      await waitBodyShown(copies.nth(i), 'xs-card-body', `第 ${i + 1} 份展开后的正文`);
    }
    return copies.evaluateAll((els) => els.map((el) => {
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
  })();
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
