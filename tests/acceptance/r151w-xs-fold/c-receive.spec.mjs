// C 组:对话流里的接收行(C1–C4)。依据 INTERFACE 第 3 节 + 第 9 节用户修订(2026-10-29 21:20)。
// 新形态:折叠态只有「标题行 + 状态 + 展开全文」,正文不显示;有正文(哪怕 1 行)就有展开入口;展开才显示完整正文。
// 旧条款里所有「两行预览 / line-clamp=2 / 高度 ≤ 2 行」断言全部作废,统一用 helpers 的 expectFolded 口径。
// 三种来源:历史(peer 行 jsonl)→ data-via="gui";点【处理】的直播 → "card";原生 result.origin → "native";
// 自动处理 → "auto"(需要真 CLI 作为发送方,本机没有真 CLI 时整条 skip,不假装通过)。
import { test, expect } from '@playwright/test';
import {
  api, shared, boot, openSessionBySearch, seedPair, sendInbox, cardOf, styleOf, peerRows,
  seedPeerHistory, liveTurn, writeScript, touchCtl, uniq, waitStatus, msgsOf, waitFor, waitTurnDone,
  makeWorkspace, realCliPath, aiCalls, inboundOk, profileTurn, SM,
  EXPAND, COLLAPSE, bodyFacts, expectFolded, expectExpandEntry, waitBodyShown, waitBodyHidden,
} from './helpers/w.mjs';

test.describe.configure({ timeout: 240_000 });
test.beforeEach(async () => { await api.on(); });

const body8 = (m) => Array.from({ length: 8 }, (_, i) => `${m} 第${i + 1}行`).join('\n');
const noticeRoot = (row) => row.evaluate((el) => ({
  cgui: el.getAttribute('data-cgui'),
  direction: el.getAttribute('data-direction'),
  via: el.getAttribute('data-via'),
}));

test('C1a 三种来源同款(历史 / 原生):data-cgui="xs-notice" 方向 in、有标题行展开控件、折叠态无正文预览;标题规则保持', async ({ page }) => {
  const pair = seedPair('c1a');
  const body = body8(pair.m);
  const hist = seedPeerHistory('c1a', [{ from: `gui:${pair.A.sid}`, name: `用户转发自 ${pair.A.title}`, body }]);
  await boot(page);
  await openSessionBySearch(page, hist.title, `${hist.title} 回复`);

  const hRow = page.locator('[data-testid="peer-message"]').filter({ hasText: body }).first();
  await expect(hRow, '历史里的接收行应显示').toBeVisible({ timeout: 15_000 });
  const h = await noticeRoot(hRow);
  expect.soft(h.cgui, '历史接收行应是通用折叠行根 [data-cgui="xs-notice"]').toBe('xs-notice');
  expect.soft(h.direction, '接收行方向 data-direction="in"').toBe('in');
  await expect.soft(hRow.getByTestId('peer-message-toggle'), '历史接收行有标题行展开控件').toBeVisible({ timeout: 4_000 });
  await expectFolded(hRow, 'peer-message-body', '历史接收行正文');
  await expectExpandEntry(hRow, 'peer-message-expand', '历史接收行正文');
  await expect.soft(hRow.getByTestId('peer-message-from')).toHaveText(`用户转发自 ${pair.A.title}`);
  expect.soft(await hRow.getByTestId('peer-message-auto').count(), '历史接收行没有自动处理徽标').toBe(0);

  // 原生 result.origin:同一个会话里再跑一轮
  await liveTurn(page, pair.m, 'native', [
    { say: `${pair.m} 原生回复` },
    { result: { origin: { kind: 'peer', from: 'uds:/tmp/r151w-native.sock', name: 'R151W 原生来源', body: `${pair.m} 原生正文` } } },
  ], `${pair.m} 原生回复`);
  const nRow = page.locator('[data-testid="peer-message"]').filter({ hasText: `${pair.m} 原生正文` }).first();
  await expect(nRow, '原生来源的接收行应显示').toBeVisible({ timeout: 15_000 });
  const n = await noticeRoot(nRow);
  expect.soft(n.cgui, '原生接收行应是通用折叠行根').toBe('xs-notice');
  expect.soft(n.direction, '原生接收行方向 in').toBe('in');
  expect.soft(n.via, '原生接收行 data-via="native"').toBe('native');
  await expect.soft(nRow.getByTestId('peer-message-toggle'), '原生接收行有标题行展开控件').toBeVisible({ timeout: 4_000 });
  await expectFolded(nRow, 'peer-message-body', '原生接收行正文');
  await expectExpandEntry(nRow, 'peer-message-expand', '原生接收行正文');
  await expect.soft(nRow.getByTestId('peer-message-from')).toHaveText(/^来自\s?R151W 原生来源$/);
});

test('C1b 直播来源(点【处理】)与历史/原生同款:data-via="card"、折叠态无正文预览、标题"来自 <名字>"', async ({ page }) => {
  const pair = seedPair('c1b');
  const msg = await sendInbox(pair.A, pair.B, `${pair.m} 卡片处理正文\n第二行\n第三行`);
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByTestId('xs-card-process').click();

  const row = page.locator('[data-testid="peer-message"][data-via="card"]').filter({ hasText: `${pair.m} 卡片处理正文` }).first();
  await expect(row, '处理后直播接收行应显示').toBeVisible({ timeout: 20_000 });
  const facts = await noticeRoot(row);
  expect.soft(facts.cgui, '直播接收行应是通用折叠行根').toBe('xs-notice');
  expect.soft(facts.direction, '直播接收行方向 in').toBe('in');
  await expect.soft(row.getByTestId('peer-message-toggle'), '直播接收行有标题行展开控件').toBeVisible({ timeout: 4_000 });
  await expectFolded(row, 'peer-message-body', '直播接收行正文');
  await expectExpandEntry(row, 'peer-message-expand', '直播接收行正文');
  await expect.soft(row.getByTestId('peer-message-from')).toHaveText(`来自 ${pair.A.title}`);
});

test('C1c 自动处理来源:data-via="auto" + 徽标「自动处理」,与其它来源同款', async ({ page }) => {
  test.skip(!realCliPath(), '本机没有真 claude CLI:自动处理必须由真 CLI 的 send_message 触发');
  const pair = seedPair('c1c');
  await profileTurn(shared, pair.B, 'bypassPermissions');
  await inboundOk(shared, pair.B.sid, 'auto');
  const hold = `c1c-hold-${uniq('')}`;
  const go = `c1c-go-${uniq('')}`;
  writeScript(hold, [{ waitFile: go }, { waitFile: go }, { say: `${pair.m} 处理完` }]);
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  let row;
  try {
    const r = await aiCalls(shared, { cwd: makeWorkspace(`real-c1c-${uniq('')}`), steps: [{ name: SM, input: { to: [pair.B.sid], message: `${pair.m} 自动正文 ${hold}` } }] });
    expect(r.results.length, '前置:真 CLI 拿到一次工具结果').toBe(1);
    row = page.locator('[data-testid="peer-message"][data-via="auto"]').filter({ hasText: `${pair.m} 自动正文` }).first();
    await expect(row, '自动处理开始的回合应显示 data-via="auto" 的接收行').toBeVisible({ timeout: 25_000 });
    const facts = await noticeRoot(row);
    expect.soft(facts.cgui, '自动接收行应是通用折叠行根').toBe('xs-notice');
    expect.soft(facts.direction, '自动接收行方向 in').toBe('in');
    await expect.soft(row.getByTestId('peer-message-auto'), '自动处理徽标').toHaveText('自动处理');
    await expect.soft(row.getByTestId('peer-message-toggle'), '自动接收行有标题行展开控件').toBeVisible({ timeout: 4_000 });
    await expectFolded(row, 'peer-message-body', '自动接收行正文');
    await expectExpandEntry(row, 'peer-message-expand', '自动接收行正文');
  } finally {
    touchCtl(go);
  }
  if (row) {
    const m = (await msgsOf(pair.B.sid)).find((x) => x.from && x.from.kind === 'session' && String(x.body || '').includes(`${pair.m} 自动正文`));
    if (m) expect(await waitStatus(pair.B.sid, m.id, 'done', 25_000), '收尾:自动处理回合跑完').toBeTruthy();
  }
});

test('C2 接收行折叠态无正文预览,点标题行展开全文 / 再收起正文消失', async ({ page }) => {
  const pair = seedPair('c2');
  const body = body8(pair.m);
  const hist = seedPeerHistory('c2', [{ from: `gui:${pair.A.sid}`, name: `用户转发自 ${pair.A.title}`, body }]);
  await boot(page);
  await openSessionBySearch(page, hist.title, `${hist.title} 回复`);
  const row = page.locator('[data-testid="peer-message"]').filter({ hasText: body }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  const toggle = row.getByTestId('peer-message-toggle');
  await expect(toggle, '前置:接收行标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  const folded = await expectFolded(row, 'peer-message-body', '接收行正文');
  expect.soft(folded.text.includes(`${pair.m} 第1行`), '折叠态不应把正文原文留在可见正文节点里').toBe(false);
  const expand = await expectExpandEntry(row, 'peer-message-expand', '接收行正文');
  await expect.soft(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  const bodyEl = await waitBodyShown(row, 'peer-message-body', '展开后的接收行正文');
  await expect.soft(bodyEl, '展开后能看到第 8 行(全文)').toContainText(`${pair.m} 第8行`);
  const opened = await bodyFacts(row, 'peer-message-body');
  expect.soft(opened.scrollHeight, `展开后正文不应被裁(scrollHeight ${opened.scrollHeight} / clientHeight ${opened.clientHeight})`).toBeLessThanOrEqual(opened.clientHeight + 2);
  await expect.soft(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect.soft(expand, `展开后提示变成「${COLLAPSE}」`).toHaveText(COLLAPSE);

  await toggle.click();
  await waitBodyHidden(row, 'peer-message-body', '收起后的接收行正文');
  await expect.soft(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.soft(expand, `收起后提示回到「${EXPAND}」`).toHaveText(EXPAND);
});

test('C3 总开关关闭时,历史里的接收行照常显示且仍可展开', async ({ page }) => {
  await api.off();
  const pair = seedPair('c3');
  const body = body8(pair.m);
  const hist = seedPeerHistory('c3', [{ from: `gui:${pair.A.sid}`, name: `用户转发自 ${pair.A.title}`, body }]);
  try {
    await boot(page);
    await openSessionBySearch(page, hist.title, `${hist.title} 回复`);
    const row = page.locator('[data-testid="peer-message"]').filter({ hasText: body }).first();
    await expect(row, '开关关着,历史接收行照常显示').toBeVisible({ timeout: 15_000 });
    const toggle = row.getByTestId('peer-message-toggle');
    await expect(toggle, '有正文就该有展开控件(总开关只管新消息渲染)').toBeVisible({ timeout: 5_000 });
    await expectFolded(row, 'peer-message-body', '接收行正文');
    await toggle.click();
    const bodyEl = await waitBodyShown(row, 'peer-message-body', '展开后的接收行正文');
    await expect.soft(bodyEl, '仍可展开看到全文').toContainText(`${pair.m} 第8行`);
  } finally {
    await api.on();
  }
});

test('C4 同一条不重复:回合中直播一条(data-via=card),刷新后历史里只剩一条(data-via=gui)', async ({ page }) => {
  const pair = seedPair('c4');
  const script = `c4-hold-${uniq('')}`;
  const go = `c4-go-${uniq('')}`;
  writeScript(script, [{ waitFile: go }, { waitFile: go }, { say: `${pair.m} 处理完了` }]);
  const body = `${pair.m} C4 正文\n第二行\n第三行`;
  const msg = await sendInbox(pair.A, pair.B, `${body} ${script}`);
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByTestId('xs-card-process').click();
  const live = page.locator('[data-testid="peer-message"][data-via="card"]').filter({ hasText: `${pair.m} C4 正文` });
  await expect(live, '回合进行中直播显示 1 条').toHaveCount(1, { timeout: 20_000 });
  expect(await waitStatus(pair.B.sid, msg.id, 'processing', 20_000), '前置:回合正在处理').toBeTruthy();
  touchCtl(go);
  expect(await waitStatus(pair.B.sid, msg.id, 'done', 30_000), '收尾:回合处理完').toBeTruthy();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const rows = page.locator('[data-testid="peer-message"]').filter({ hasText: `${pair.m} C4 正文` });
  await expect(rows, '刷新后同一条正文只显示 1 行').toHaveCount(1, { timeout: 20_000 });
  await expect.soft(rows.first(), '刷新后历史里的来源是 data-via="gui"').toHaveAttribute('data-via', 'gui');
});

// 判官补充轮(2026-10-29):接收行也必须覆盖「没有换行的长单段」。
// 新形态下这条仍然有意义:长单段折叠态也必须没有正文预览,且必须给展开入口,展开后能读到末尾。
test('C4b 无换行长单段的接收行:折叠态无正文预览、可展开看全文、再收起消失', async ({ page }) => {
  const pair = seedPair('c4b');
  const tail = `TAIL-${pair.m.slice(-8)}`;
  const seg = `${pair.m} 这是另一段没有换行的长正文，用于验证历史接收行折叠态仍然不显示任何正文预览。`;
  const body = Array.from({ length: 7 }, () => seg).join('') + ` ${tail}`;
  expect.soft(body, '前置:接收行正文是一整段、不含换行').not.toContain('\n');
  expect.soft(body.length, `前置:正文约 350–450 字(实测 ${body.length} 字),应折成 >2 行`).toBeGreaterThanOrEqual(300);

  const hist = seedPeerHistory('c4b', [{ from: `gui:${pair.A.sid}`, name: `用户转发自 ${pair.A.title}`, body }]);
  await boot(page);
  await openSessionBySearch(page, hist.title, `${hist.title} 回复`);
  const row = page.locator('[data-testid="peer-message"]').filter({ hasText: tail }).first();
  await expect(row, '历史接收行应显示').toBeVisible({ timeout: 15_000 });

  const folded = await expectFolded(row, 'peer-message-body', '长单段接收行正文');
  expect.soft(folded.shown, `长单段接收行折叠态不应显示正文(实测可见高 ${Math.round(folded.height)}px)`).toBe(false);
  const expand = await expectExpandEntry(row, 'peer-message-expand', '长单段接收行正文');

  const toggle = row.getByTestId('peer-message-toggle');
  await expect(toggle, '前置:接收行标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  expect.soft(await toggle.evaluate((el) => el.tagName), '长单段接收行的标题行应是 BUTTON(能点开),不是不可点的 div').toBe('BUTTON');
  await expect.soft(toggle, '折叠态 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  const bodyEl = await waitBodyShown(row, 'peer-message-body', '展开后的长单段接收行正文');
  const opened = await bodyFacts(row, 'peer-message-body');
  expect.soft(opened.scrollHeight, `展开后接收行正文不应被裁掉(scrollHeight ${opened.scrollHeight} / clientHeight ${opened.clientHeight})`).toBeLessThanOrEqual(opened.clientHeight + 2);
  await expect.soft(toggle, '展开后 aria-expanded=true').toHaveAttribute('aria-expanded', 'true');
  await expect.soft(expand, `展开后提示变成「${COLLAPSE}」`).toHaveText(COLLAPSE);
  await expect.soft(bodyEl, '展开后能读到正文末尾标记').toContainText(tail);

  await toggle.click();
  await waitBodyHidden(row, 'peer-message-body', '收起后的长单段接收行正文');
  await expect(toggle, '再点标题行应收起').toHaveAttribute('aria-expanded', 'false');
});
