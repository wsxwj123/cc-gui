// B 组:收件箱(输入框上方)折叠行(B1–B9 + 多消息 42vh 内滚)。依据 INTERFACE 第 2 节。
// 夹具:POST /api/xsession/messages 造 pending;claim 造 claimed;目标会话忙时投递造 queued;
// 点【处理】+ 假 CLI 脚本停住造 processing。
import { test, expect } from '@playwright/test';
import {
  api, boot, openSessionBySearch, seedPair, sendInbox, cardOf, inbox, styleOf, waitStatus,
  writeScript, touchCtl, uniq, turnRecords, waitFor, recordRequests, sendPrompt, ALL,
  shared, realCliPath, profileTurn, inboundOk, aiCalls, makeWorkspace, SM, msgsOf,
} from './helpers/w.mjs';

test.describe.configure({ timeout: 180_000 });
test.beforeEach(async () => { await api.on(); });

const body10 = (m) => Array.from({ length: 10 }, (_, i) => `${m} 第${i + 1}行`).join('\n');

async function openB(page, pair) {
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
}

test('B1 折叠态动作始终可见可点:处理 / 忽略 / 原因 / 来源都在紧贴标题行的动作区', async ({ page }) => {
  const pair = seedPair('b1');
  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  await openB(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card, '前置:待处理卡片存在').toBeVisible({ timeout: 15_000 });

  await expect.soft(card.getByTestId('xs-card-process'), '不展开也能看到【处理】').toBeVisible();
  await expect.soft(card.getByTestId('xs-card-dismiss'), '不展开也能看到【忽略】').toBeVisible();
  await expect.soft(card.getByTestId('xs-card-process')).toHaveText('处理');
  await expect.soft(card.getByTestId('xs-card-dismiss')).toHaveText('忽略');
  await expect.soft(card.getByTestId('xs-card-reason'), '原因串').toHaveText('等待你确认后处理');
  await expect.soft(card.getByTestId('xs-card-from'), '来源串').toHaveText(`由你从 ${pair.A.title} 转发`);
  expect.soft(await card.getByTestId('xs-card-process').isEnabled(), '【处理】可点').toBe(true);
  expect.soft(await card.getByTestId('xs-card-dismiss').isEnabled(), '【忽略】可点').toBe(true);
});

test('B2 展开动作行不移动:展开前后【处理】的 y 变化 ≤2px,展开后仍可点', async ({ page }) => {
  const pair = seedPair('b2');
  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  await openB(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const proc = card.getByTestId('xs-card-process');
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  const y0 = (await styleOf(proc)).top;
  await toggle.click();
  await page.waitForTimeout(400);
  const y1 = (await styleOf(proc)).top;
  expect.soft(Math.abs(y1 - y0), `展开前后【处理】的 y 应基本不动(实测 ${y0.toFixed(1)} → ${y1.toFixed(1)})`).toBeLessThanOrEqual(2);
  expect.soft(await proc.isEnabled(), '展开后【处理】仍可点').toBe(true);
});

test('B3a 按钮可用性与改动前一致:pending / claimed 两种状态', async ({ page }) => {
  const pair = seedPair('b3a');
  await openB(page, pair);
  const m1 = await sendInbox(pair.A, pair.B, `${pair.m} pending 一条`);
  const m2 = await sendInbox(pair.A, pair.B, `${pair.m} claimed 一条`);
  await expect(cardOf(page, m1.id)).toHaveAttribute('data-status', 'pending', { timeout: 15_000 });
  await expect(cardOf(page, m2.id)).toHaveAttribute('data-status', 'pending', { timeout: 15_000 });
  await api.claimOk(m2.id);
  await expect(cardOf(page, m2.id)).toHaveAttribute('data-status', 'claimed', { timeout: 10_000 });

  // pending
  await expect.soft(cardOf(page, m1.id).getByTestId('xs-card-process'), 'pending:【处理】可点').toBeEnabled();
  await expect.soft(cardOf(page, m1.id).getByTestId('xs-card-dismiss'), 'pending:【忽略】可点').toBeEnabled();
  expect.soft(await cardOf(page, m1.id).getByTestId('xs-card-release').count(), 'pending:没有【撤回】').toBe(0);
  // claimed
  await expect.soft(cardOf(page, m2.id).getByTestId('xs-card-process'), 'claimed:【处理】不可点').toBeDisabled();
  await expect.soft(cardOf(page, m2.id).getByTestId('xs-card-release'), 'claimed:【撤回】可点').toBeEnabled();
  await expect.soft(cardOf(page, m2.id).getByTestId('xs-card-dismiss')).toBeEnabled();
  await expect.soft(cardOf(page, m2.id).getByTestId('xs-card-reason')).toHaveText('等待发送');
});

test('B3q 按钮可用性:queued(目标会话正在运行)时【处理】【忽略】可点、原因是一行排队说明', async ({ page }) => {
  test.skip(!realCliPath(), '本机没有真 claude CLI:queued 只由 AI 的 send_message 在目标正在运行时产生');
  const pair = seedPair('b3q');
  await profileTurn(shared, pair.B, 'bypassPermissions');
  await inboundOk(shared, pair.B.sid, 'auto');
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  const go = `b3q-go-${uniq('')}`;
  writeScript(`b3q-hold-${pair.m}`, [{ waitFile: go }, { waitFile: go }, { say: `${pair.m} 忙完了` }]);
  const busyRes = await shared.post('/api/chat', { sessionId: pair.B.sid, cwd: pair.B.cwd, prompt: `${pair.m} 忙 R151S:b3q-hold-${pair.m}`, permissionMode: 'bypassPermissions' });
  expect(busyRes.status, '前置:目标开始一个会忙住的回合').toBe(200);
  expect(await waitFor(() => turnRecords().some((t) => t.sid === pair.B.sid && t.text.includes(`b3q-hold-${pair.m}`)), 15_000), '前置:目标会话正在跑').toBeTruthy();
  try {
    const r = await aiCalls(shared, { cwd: makeWorkspace(`real-b3q-${uniq('')}`), steps: [{ name: SM, input: { to: [pair.B.sid], message: `${pair.m} queued 一条` } }] });
    expect(r.results.length, '前置:真 CLI 拿到一次工具结果').toBe(1);
    expect(r.results[0].json && r.results[0].json.results && r.results[0].json.results[0] && r.results[0].json.results[0].delivery, '前置:目标正忙 → queued').toBe('queued');
    const q = await waitFor(async () => (await msgsOf(pair.B.sid)).find((x) => x.from && x.from.kind === 'session' && String(x.body || '').includes('queued 一条')), 20_000);
    expect(q, '前置:queued 消息已投递').toBeTruthy();
    const card = cardOf(page, q.id);
    await expect(card).toHaveAttribute('data-status', 'queued', { timeout: 15_000 });
    await expect.soft(card.getByTestId('xs-card-reason')).toHaveText('目标会话正在运行，回合结束后自动处理');
    await expect.soft(card.getByTestId('xs-card-process'), 'queued:【处理】可点').toBeEnabled();
    await expect.soft(card.getByTestId('xs-card-dismiss'), 'queued:【忽略】可点').toBeEnabled();
  } finally {
    touchCtl(go);
  }
});

test('B3b 按钮可用性:processing 时【处理】【忽略】都不可点', async ({ page }) => {
  const pair = seedPair('b3b');
  const go = `b3b-go-${uniq('')}`;
  const script = `b3b-hold-${pair.m}`;
  writeScript(script, [{ waitFile: go }, { waitFile: go }, { say: `${pair.m} 处理完了` }]);
  const msg = await sendInbox(pair.A, pair.B, `${pair.m} 处理中 ${script}\n第二行`);
  await openB(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByTestId('xs-card-process').click();
  const proc = await waitStatus(pair.B.sid, msg.id, 'processing', 20_000);
  expect(proc, '前置:点【处理】后消息进入 processing').toBeTruthy();
  try {
    await expect(card).toHaveAttribute('data-status', 'processing', { timeout: 10_000 });
    await expect.soft(card.getByTestId('xs-card-process'), 'processing:【处理】不可点').toBeDisabled();
    await expect.soft(card.getByTestId('xs-card-dismiss'), 'processing:【忽略】不可点').toBeDisabled();
  } finally {
    touchCtl(go);
  }
  expect(await waitStatus(pair.B.sid, msg.id, 'done', 25_000), '收尾:这一轮跑完').toBeTruthy();
});

test('B4 折叠态点【处理】仍走原链路:一次带 xsMessageId 的 POST /api/chat、目标出现 data-via="card" 的接收行、没有「你」的气泡、卡片消失', async ({ page }) => {
  const pair = seedPair('b4');
  const msg = await sendInbox(pair.A, pair.B, `${pair.m} B4 正文\n第二行`);
  await openB(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const chats = recordRequests(page, '/api/chat');
  await card.getByTestId('xs-card-process').click();

  const bubble = page.locator('[data-testid="peer-message"][data-via="card"]').filter({ hasText: `${pair.m} B4 正文` });
  await expect(bubble, '处理后的接收行 data-via="card"').toHaveCount(1, { timeout: 20_000 });
  const sent = chats.filter((c) => c.method === 'POST' && c.body && c.body.xsMessageId === msg.id);
  expect.soft(sent.length, '经卡片发出一次带 xsMessageId 的 /api/chat').toBe(1);
  const stray = await page.evaluate((needle) => {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.data.includes(needle)) continue;
      if (!n.parentElement.closest('[data-testid="peer-message"],[data-testid="xs-card"]')) out.push(n.data.slice(0, 80));
    }
    return out;
  }, `${pair.m} B4 正文`);
  expect.soft(stray, '正文不出现在「你」的气泡里').toEqual([]);
  await expect(card, '卡片随后消失').toHaveCount(0, { timeout: 20_000 });
});

test('B5 「放任」档正文不折叠:全文展示、line-clamp 为 none、没有展开控件', async ({ page }) => {
  const pair = seedPair('b5');
  await boot(page);
  await openSessionBySearch(page, pair.B.title, pair.B.reply);
  // 用界面上的权限档选择器把目标会话切到「放任」(用户可见入口,不写内部状态)
  const sel = page.getByTestId('permission-mode-selector');
  await expect(sel, '前置:会话头部有权限档选择器').toBeVisible({ timeout: 15_000 });
  await sel.click();
  const opt = page.locator('button,[role="option"],[role="menuitem"]').filter({ hasText: '跳过全部权限确认' }).first();
  await expect(opt, '前置:选择器里有「放任」档').toBeVisible({ timeout: 10_000 });
  await opt.click();
  await expect.poll(async () => sel.innerText(), { timeout: 10_000, message: '前置:已切到放任' }).toContain('放任');

  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const bodyEl = card.getByTestId('xs-card-body');
  const f = await styleOf(bodyEl);
  expect.soft(f.clamp, `放任档正文不应折叠(-webkit-line-clamp=${JSON.stringify(f.clamp)})`).toBe('none');
  expect.soft(await card.getByTestId('xs-card-expand').count(), '放任档没有展开控件').toBe(0);
  await expect.soft(bodyEl, '放任档正文整段可见').toContainText(`${pair.m} 第10行`);
});

test('B6 【忽略】后行消失,接口状态为 dismissed', async ({ page }) => {
  const pair = seedPair('b6');
  const msg = await sendInbox(pair.A, pair.B, `${pair.m} 忽略我`);
  await openB(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByTestId('xs-card-dismiss').click();
  await expect(card, '忽略后该行消失').toHaveCount(0, { timeout: 15_000 });
  const list = await api.list(pair.B.sid, ALL);
  const m = (list.body.messages || []).find((x) => x.id === msg.id);
  expect(m && m.status, '接口状态 dismissed').toBe('dismissed');
});

test('B7 总开关关闭不渲染收件箱,输入框照旧', async ({ page }) => {
  const pair = seedPair('b7');
  await sendInbox(pair.A, pair.B, `${pair.m} 开关关着也投递`);
  await api.off();
  await openB(page, pair);
  await expect.poll(async () => inbox(page).count(), { timeout: 10_000, message: '总开关关闭时不渲染 xs-inbox' }).toBe(0);
  await expect.soft(page.getByPlaceholder(/输入消息|开始一个新会话/).last(), '输入框与改动前一致').toBeVisible();
  await api.on();
});

test('B8 无消息 / 无会话不渲染收件箱,没有空白占位', async ({ page }) => {
  const pair = seedPair('b8');
  await openB(page, pair);
  await expect.poll(async () => inbox(page).count(), { timeout: 10_000, message: '目标会话没有消息时不渲染 xs-inbox' }).toBe(0);
  await expect.soft(cardOf(page, 'x')).toHaveCount(0);
});

test('B9 多条消息按到达顺序堆叠:3 行、顺序 = 接口返回顺序、互不嵌套', async ({ page }) => {
  const pair = seedPair('b9');
  const sent = [];
  for (let i = 0; i < 3; i += 1) {
    const [m] = await api.send(pair.A.sid, [pair.B.sid], `${pair.m} 第${i + 1}条`);
    sent.push(m);
  }
  const expected = sent.map((m) => m.id);
  await openB(page, pair);
  await expect(inbox(page).locator('[data-testid="xs-card"]')).toHaveCount(3, { timeout: 15_000 });
  const ids = await inbox(page).locator('[data-testid="xs-card"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-message-id')));
  expect(ids, '卡片顺序 = 接口返回顺序').toEqual(expected);
  const nested = await inbox(page).evaluate((el) => el.querySelectorAll('[data-testid="xs-card"] [data-testid="xs-card"]').length);
  expect(nested, '卡片不互相嵌套').toBe(0);
});

test('B10 多消息时收件箱在 42vh 内滚动,不把窗口顶爆', async ({ page }) => {
  const pair = seedPair('b10');
  for (let i = 0; i < 12; i += 1) await api.send(pair.A.sid, [pair.B.sid], `${pair.m} 第${i + 1}条\n第二行\n第三行\n第四行`);
  await openB(page, pair);
  await expect(inbox(page).locator('[data-testid="xs-card"]')).toHaveCount(12, { timeout: 20_000 });
  const f = await inbox(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cands = [el, ...el.querySelectorAll('*'), el.parentElement, el.parentElement && el.parentElement.parentElement].filter(Boolean);
    let scroller = null;
    for (const n of cands) {
      const s = getComputedStyle(n);
      if (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 2) {
        scroller = { tag: n.tagName, h: Math.round(n.getBoundingClientRect().height), scrollHeight: n.scrollHeight, clientHeight: n.clientHeight, overflowY: s.overflowY };
        break;
      }
    }
    return { height: r.height, vh: window.innerHeight, scroller };
  });
  expect.soft(f.height, `收件箱区域高度应 ≤ 42vh(实测 ${f.height.toFixed(0)}px / 视口 ${f.vh}px)`).toBeLessThanOrEqual(f.vh * 0.42 + 40);
  expect.soft(f.scroller, '内容溢出时应收件箱内部滚动(附近应有 overflow auto/scroll 且 scrollHeight > clientHeight 的容器)').not.toBeNull();
  if (f.scroller) expect.soft(f.scroller.h, `滚动容器高度应 ≤ 42vh(实测 ${f.scroller.h}px / 视口 ${f.vh}px)`).toBeLessThanOrEqual(f.vh * 0.42 + 40);
});
