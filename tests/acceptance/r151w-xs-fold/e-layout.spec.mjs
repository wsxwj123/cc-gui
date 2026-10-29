// E 组:布局、键盘、读屏(E1–E6)。依据 INTERFACE 第 5 节。
// 窄屏 = 375×812;分屏 = 面板坞 → 分屏=2,第二格用侧栏搜索填会话;键盘 = 真 Tab / Enter / Space。
import { test, expect } from '@playwright/test';
import {
  api, boot, openSessionBySearch, seedPair, sendInbox, cardOf, inbox, styleOf, sendRows, peerRows,
  expandControls, tabUntil, tabBackFromComposer, activeElementFacts, overflowX, setPanes, fillPane, uniq, writeScript,
  touchCtl, waitStatus, recordRequests, sendPrompt, turnRecords, waitFor, seedSession,
} from './helpers/w.mjs';

test.describe.configure({ timeout: 240_000 });
test.beforeEach(async () => { await api.on(); });

const body8 = (m) => Array.from({ length: 8 }, (_, i) => `${m} 第${i + 1}行`).join('\n');
const body10 = (m) => Array.from({ length: 10 }, (_, i) => `${m} 第${i + 1}行`).join('\n');

test('E1 键盘可展开 / 收起:Tab 到标题行 → Enter 展开 → Space 收起,焦点不丢且有可见轮廓', async ({ page }) => {
  const pair = seedPair('e1');
  const msg = await sendInbox(pair.A, pair.B, body8(pair.m));
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  await expect(cardOf(page, msg.id), '前置:收件箱行存在').toBeVisible({ timeout: 15_000 });

  const hit = await tabBackFromComposer(page, "el.getAttribute('data-testid') === 'xs-card-toggle'", 60);
  expect(hit, 'Tab 应能到达标题行展开控件 [data-testid="xs-card-toggle"]').toBeTruthy();
  const focus = await activeElementFacts(page);
  expect.soft(focus.outlineStyle !== 'none' || focus.boxShadow !== 'none' || parseFloat(focus.outlineWidth) > 0, `焦点应有可见轮廓(${JSON.stringify(focus)})`).toBe(true);

  await page.keyboard.press('Enter');
  const toggle = cardOf(page, msg.id).getByTestId('xs-card-toggle');
  await expect.soft(toggle, 'Enter 展开').toHaveAttribute('aria-expanded', 'true');
  const afterEnter = await activeElementFacts(page);
  expect.soft(afterEnter.testid, '展开后焦点不丢').toBe('xs-card-toggle');

  await page.keyboard.press('Space');
  await expect.soft(toggle, 'Space 收起').toHaveAttribute('aria-expanded', 'false');
  const afterSpace = await activeElementFacts(page);
  expect.soft(afterSpace.testid, '收起后焦点不丢').toBe('xs-card-toggle');
});

test('E2 动作按钮可 Tab 到达:pending 的【处理】在 Tab 序里且可回车触发;processing 时按钮 disabled', async ({ page }) => {
  const pair = seedPair('e2');
  const script = `e2-hold-${uniq('')}`;
  const go = `e2-go-${uniq('')}`;
  writeScript(script, [{ waitFile: go }, { waitFile: go }, { say: `${pair.m} 处理完了` }]);
  const msg = await sendInbox(pair.A, pair.B, `${pair.m} 待处理 ${script}`);
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  try {
    const chats = recordRequests(page, '/api/chat');
    const hit = await tabBackFromComposer(page, "el.getAttribute('data-testid') === 'xs-card-process' && !el.disabled", 60);
    expect(hit, 'Tab 应能到达 pending 的【处理】且它是可用的').toBeTruthy();
    await page.keyboard.press('Enter');
    expect(await waitStatus(pair.B.sid, msg.id, 'processing', 20_000), '前置:回车触发的回合已进入 processing').toBeTruthy();
    await expect.poll(() => chats.filter((c) => c.method === 'POST' && c.body && c.body.xsMessageId === msg.id).length, { timeout: 15_000, message: '回车应触发一次带 xsMessageId 的 /api/chat' }).toBe(1);
    await expect(card).toHaveAttribute('data-status', 'processing', { timeout: 10_000 });
    await expect.soft(card.getByTestId('xs-card-process'), 'processing:【处理】disabled').toBeDisabled();
    await expect.soft(card.getByTestId('xs-card-dismiss'), 'processing:【忽略】disabled').toBeDisabled();
  } finally {
    touchCtl(go);
  }
});

test('E3 读屏:标题行角色是按钮、名字含标题文字、aria-expanded 与状态一致、同一行只有一个展开控件', async ({ page }) => {
  const pair = seedPair('e3');
  const msg = await sendInbox(pair.A, pair.B, body8(pair.m));
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  const role = await toggle.evaluate((el) => (el.tagName === 'BUTTON' ? 'button' : el.getAttribute('role')));
  expect.soft(role, '标题行角色是按钮').toBe('button');
  const name = (await toggle.evaluate((el) => el.getAttribute('aria-label') || el.innerText || '')).replace(/\s+/g, ' ').trim();
  expect.soft(name, `可访问名应含展开提示(实测「${name}」)`).toContain('展开全文');
  expect.soft(name.includes('由你从') || name.includes(pair.A.title), `可访问名应含标题文字(实测「${name}」)`).toBe(true);
  await expect.soft(toggle).toHaveAttribute('aria-expanded', 'false');
  const controls = await expandControls(card);
  expect.soft(controls.length, `同一行只应有一个展开/收起控件(实测 ${JSON.stringify(controls)}`).toBe(1);
});

test('E4 375px 窄屏不横向溢出,【处理】【忽略】仍可见可点', async ({ page }) => {
  const longSource = seedSession(`w-e4-a-${uniq('')}`, { title: `R151W E4 ${'很长的来源标题'.repeat(12)}` });
  const pair = seedPair('e4');
  // 来源标题很长:把 A 换成上面的长标题会话
  const msg = await sendInbox(longSource, pair.B, `${pair.m} 窄屏正文\n第二行\n第三行\n第四行\n第五行`);
  // 先在桌面宽度打开会话(375px 下侧栏会收起,不能用侧栏搜索导航),再缩到 375×812
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(800);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });

  const o = await overflowX(page);
  expect.soft(o.scrollWidth, `不应出现横向滚动(document.scrollWidth ${o.scrollWidth} / innerWidth ${o.innerWidth})`).toBeLessThanOrEqual(o.innerWidth + 1);
  const box = await styleOf(card);
  expect.soft(box.right, `卡片不应超出视口右缘(right ${box.right.toFixed(0)} / 375)`).toBeLessThanOrEqual(376);
  const proc = card.getByTestId('xs-card-process');
  const dis = card.getByTestId('xs-card-dismiss');
  await expect.soft(proc, '窄屏仍能看到【处理】').toBeVisible();
  await expect.soft(dis, '窄屏仍能看到【忽略】').toBeVisible();
  expect.soft(await proc.isEnabled(), '窄屏【处理】可点').toBe(true);
  const pb = await styleOf(proc);
  const db = await styleOf(dis);
  expect.soft(pb.right <= 376 && db.right <= 376, `按钮不应被挤出屏幕(处理 right ${pb.right.toFixed(0)}, 忽略 right ${db.right.toFixed(0)})`).toBe(true);
});

test('E5 分屏互不影响:左窗格展开,右窗格仍收起,两边高度/滚动互不改变', async ({ page }) => {
  const pair = seedPair('e5');
  // 卡片必须可折叠:正文 > 2 行时标题行才是带 aria-expanded 的 <button>(1 行正文按契约 A5 不可折叠,没有 toggle)。
  const body5 = (m) => Array.from({ length: 5 }, (_, i) => `${m} 第${i + 1}行`).join('\n');
  const ma = await sendInbox(pair.A, pair.B, body5(`${pair.m} 给 B 的卡片`));
  const mb = await sendInbox(pair.B, pair.A, body5(`${pair.m} 给 A 的卡片`));
  await boot(page);
  await openSessionBySearch(page, pair.A.title, pair.A.reply);
  await setPanes(page, 2);
  await fillPane(page, 2, pair.B.title);
  await expect(page.locator('[data-testid="pane"]')).toHaveCount(2, { timeout: 15_000 });

  const pane1 = page.locator('[data-testid="pane"]').nth(0);
  const pane2 = page.locator('[data-testid="pane"]').nth(1);
  const cardA = pane1.locator(`[data-testid="xs-card"][data-message-id="${mb.id}"]`);
  const cardB = pane2.locator(`[data-testid="xs-card"][data-message-id="${ma.id}"]`);
  await expect(cardA, '左窗格有 A 的收件箱行').toBeVisible({ timeout: 15_000 });
  await expect(cardB, '右窗格有 B 的收件箱行').toBeVisible({ timeout: 15_000 });

  const toggleA = cardA.getByTestId('xs-card-toggle');
  const toggleB = cardB.getByTestId('xs-card-toggle');
  await expect(toggleA, '前置:左窗格标题行可展开(折叠态)').toHaveAttribute('aria-expanded', 'false', { timeout: 5_000 });
  await expect(toggleB, '前置:右窗格标题行可展开(折叠态)').toHaveAttribute('aria-expanded', 'false');

  const rightFacts = () => pane2.evaluate((el) => ({ h: el.getBoundingClientRect().height, scrollTop: el.scrollTop }));
  const leftH0 = (await styleOf(cardA)).height;
  const rightH0 = (await styleOf(cardB)).height;
  const pane0 = await rightFacts();

  await toggleA.click();
  await expect(toggleA, '左窗格已展开').toHaveAttribute('aria-expanded', 'true');
  await expect.soft(toggleB, '右窗格仍收起').toHaveAttribute('aria-expanded', 'false');
  const leftH1 = (await styleOf(cardA)).height;
  const rightH1 = (await styleOf(cardB)).height;
  const pane1After = await rightFacts();
  expect.soft(leftH1, `左窗格该行应真的展开(高度 ${leftH0.toFixed(0)} → ${leftH1.toFixed(0)})`).toBeGreaterThan(leftH0 + 10);
  expect.soft(Math.abs(rightH1 - rightH0), `右窗格该行高度不应被左窗格影响(${rightH0.toFixed(0)} → ${rightH1.toFixed(0)})`).toBeLessThanOrEqual(2);
  expect.soft(Math.abs(pane1After.h - pane0.h), `右窗格高度不应变(${pane0.h.toFixed(0)} → ${pane1After.h.toFixed(0)})`).toBeLessThanOrEqual(2);
  expect.soft(pane1After.scrollTop, '右窗格滚动位置不应变').toBe(pane0.scrollTop);

  // 再收起:左窗格回到折叠高度,右窗格依旧不动
  await toggleA.click();
  await expect(toggleA, '左窗格已收起').toHaveAttribute('aria-expanded', 'false');
  const leftH2 = (await styleOf(cardA)).height;
  const rightH2 = (await styleOf(cardB)).height;
  expect.soft(Math.abs(leftH2 - leftH0), `左窗格收起后应回到折叠高度(${leftH0.toFixed(0)} → ${leftH2.toFixed(0)})`).toBeLessThanOrEqual(2);
  expect.soft(Math.abs(rightH2 - rightH0), `右窗格该行高度在左窗格收起后也不应变(${rightH0.toFixed(0)} → ${rightH2.toFixed(0)})`).toBeLessThanOrEqual(2);
});

test('E6 空态不渲染任何东西:xs-inbox / xs-send-notice / peer-message 都是 0', async ({ page }) => {
  const pair = seedPair('e6');
  await boot(page);
  await openSessionBySearch(page, pair.A.title, pair.A.reply);
  await page.waitForTimeout(800);
  expect.soft(await inbox(page).count(), '没有收件箱').toBe(0);
  expect.soft(await sendRows(page).count(), '没有发送行').toBe(0);
  expect.soft(await peerRows(page).count(), '没有接收行').toBe(0);
});
