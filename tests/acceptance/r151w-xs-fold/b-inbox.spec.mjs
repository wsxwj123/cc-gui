// B 组:收件箱(输入框上方)折叠行(B1–B9 + 多消息 20vh 内滚)。依据 INTERFACE 第 2 节。
// r152d:B10 的封顶口径由 42vh 改为 20vh(卡片区压缩;新口径的其余用例见 f-compact-inbox.spec.mjs)。
// r151y:B5 改写 —— 「放任」档也折叠(用户 2026-10-29 修订,覆盖旧审计 S6 的全文展示约定)。
// 夹具:POST /api/xsession/messages 造 pending;claim 造 claimed;目标会话忙时投递造 queued;
// 点【处理】+ 假 CLI 脚本停住造 processing。
import { test, expect } from '@playwright/test';
import {
  api, boot, openSessionBySearch, seedPair, sendInbox, cardOf, inbox, styleOf, waitStatus,
  writeScript, touchCtl, uniq, turnRecords, waitFor, recordRequests, sendPrompt, ALL,
  shared, realCliPath, profileTurn, inboundOk, aiCalls, makeWorkspace, SM, msgsOf, bodyFacts,
  textJustifyFacts, justifyVerdict, expectFolded, waitBodyShown, waitBodyHidden, expectExpandEntry, EXPAND, COLLAPSE,
} from './helpers/w.mjs';

test.describe.configure({ timeout: 180_000 });
test.beforeEach(async () => { await api.on(); });

const body10 = (m) => Array.from({ length: 10 }, (_, i) => `${m} 第${i + 1}行`).join('\n');

// B5 专用长正文:每段都够长,展开后在窄块里必然折行 —— 只有折行才有「非末行」,
// 两端对齐的「非末行铺满块宽」才判得出来(全是一行一段的短夹具只有末行,判据会空转)。
const B5_SENT = '这一行故意写得长一些，好让展开后的正文在窄块里折成好几行，非末行才检查得到两端对齐；';
const bodyB5 = (m) => Array.from({ length: 6 }, (_, i) => `${m} 第${i + 1}段 ${B5_SENT.repeat(2)}`).join('\n');

// 不用 Playwright isVisible(它只看元素自身有没有盒子,不管是否被滚动容器裁掉):
// 把按钮 rect 与「最近的滚动祖先 ∩ 视口」求交,要求按钮整体落在收件箱可视区内。
// 这是判官补强的 B2 断言:收件箱展开后正文变长、容器上限只有 20vh(r152d 起;此前 42vh),【处理】不能被推/裁到看不见。
async function visibleInScroller(loc) {
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let scroller = el.parentElement;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const sr = (scroller || document.documentElement).getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const box = {
      top: Math.max(sr.top, 0),
      bottom: Math.min(sr.bottom, vh),
      left: Math.max(sr.left, 0),
      right: Math.min(sr.right, vw),
    };
    const overlapW = Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left));
    const overlapH = Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top));
    const area = Math.max(1, r.width * r.height);
    return {
      ratio: (overlapW * overlapH) / area,
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
      box: { tag: scroller ? scroller.tagName : 'viewport', testid: scroller ? scroller.getAttribute('data-testid') : null, ...Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v)])) },
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      inViewport: r.top >= -1 && r.bottom <= vh + 1 && r.left >= -1 && r.right <= vw + 1,
    };
  });
}

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

test('B2 展开动作行不移动:动作行相对标题行的位置不变(≤2px),展开后仍可点', async ({ page }) => {
  const pair = seedPair('b2');
  const msg = await sendInbox(pair.A, pair.B, body10(pair.m));
  await openB(page, pair);
  const card = cardOf(page, msg.id);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const proc = card.getByTestId('xs-card-process');
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:标题行展开控件存在').toBeVisible({ timeout: 5_000 });
  // 收件箱在输入框上方、输入区底部锚定:展开正文必然把整块收件箱往上推(视口绝对 y 会变),
  // 契约要的是「按钮不被正文推走」——DOM 顺序固定「标题行 → 动作行 → 正文」,
  // 所以量动作行相对标题行(展开控件)的 rect 差值,展开前后应不变。
  const rel0 = (await styleOf(proc)).top - (await styleOf(toggle)).top;
  await toggle.click();
  await expect(toggle, '前置:点标题行后确实展开').toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(200);
  const rel1 = (await styleOf(proc)).top - (await styleOf(toggle)).top;
  expect.soft(Math.abs(rel1 - rel0), `展开前后【处理】相对标题行的位移应 ≤2px(实测 ${rel0.toFixed(1)} → ${rel1.toFixed(1)})`).toBeLessThanOrEqual(2);
  expect.soft(await proc.isVisible(), '展开后【处理】仍可见').toBe(true);
  expect.soft(await proc.isEnabled(), '展开后【处理】仍可点').toBe(true);

  // 判官补强:上面的「相对标题行不动」近乎恒真(DOM 顺序固定)。再量一次真实可视性——
  // 【处理】的 rect 必须整体落在最近滚动容器(收件箱 20vh 内滚)与视口的交集里。
  const vis = await visibleInScroller(proc);
  expect.soft(vis.ratio, `展开后【处理】应完整落在收件箱滚动容器可视区内(实测覆盖 ${(vis.ratio * 100).toFixed(1)}%,按钮 rect=${JSON.stringify(vis.rect)},可视区=${JSON.stringify(vis.box)},scrollTop=${vis.scrollTop})`).toBeGreaterThanOrEqual(0.98);
  expect.soft(vis.inViewport, `展开后【处理】应在视口内(按钮 rect=${JSON.stringify(vis.rect)})`).toBe(true);

  // 再收起:动作行相对标题行仍不动,且按钮仍可点
  await toggle.click();
  await expect(toggle, '再点标题行收起').toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(200);
  const rel2 = (await styleOf(proc)).top - (await styleOf(toggle)).top;
  expect.soft(Math.abs(rel2 - rel0), `收起前后【处理】相对标题行的位移应 ≤2px(实测 ${rel0.toFixed(1)} → ${rel2.toFixed(1)})`).toBeLessThanOrEqual(2);
  expect.soft(await proc.isEnabled(), '收起后【处理】仍可点').toBe(true);
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

// r151y(用户 2026-10-29 修订):旧审计 S6「放任档(bypassPermissions)全文展示、不折叠」作废。
// 「放任」只决定点【处理】后工具要不要经确认,不改变呈现 —— 放任档与其它档一样折叠:
// 折叠态只有标题行 + 状态 +「展开全文」,正文不显示;展开才看到完整正文(窄块、块居中、两端对齐);再收起消失;
// 【处理】/【忽略】留在折叠态、仍可见可点。旧的放任档行为(整段铺开、没有展开入口、标题行退化成 div)
// 在本用例里逐条写成反例断言 —— 放任档若哪天被回退成「全文展示」,这里立刻红。
// r151z:B5 的展开版式断言从旧口径 textCenterFacts(每行文字各自居中)迁移到新口径
// textJustifyFacts + justifyVerdict(窄块 ≤92% 行宽、块左右留白差 ≤2px、块内 justify、非末行铺满块宽),
// 与 A11 用同一套判据、同一份阈值;放任档语义不变,只换展开态的版式判据。
test('B5 「放任」档也折叠:折叠态无正文、有「展开全文」、标题行是 BUTTON;展开看全文且窄块两端对齐;收起消失;处理/忽略折叠态可点', async ({ page }) => {
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

  // 长正文(6 段、段段折行):放任档下也必须是折叠态,正文一个字都不显示
  const msg = await sendInbox(pair.A, pair.B, bodyB5(pair.m));
  const card = cardOf(page, msg.id);
  await expect(card, '前置:放任档下待处理卡片存在').toBeVisible({ timeout: 15_000 });

  // ① 折叠态:正文不显示(统一口径:不在 DOM 或可见高度 0),有「展开全文」,标题行是 BUTTON
  const folded = await expectFolded(card, 'xs-card-body', '放任档折叠态正文');
  expect.soft(folded.text.includes(`${pair.m} 第1段`),
    '反例:放任档折叠态不应把正文原文留在可见正文节点里(旧行为:整段铺开)').toBe(false);
  const expand = await expectExpandEntry(card, 'xs-card-expand', '放任档正文');
  const toggle = card.getByTestId('xs-card-toggle');
  await expect(toggle, '前置:折叠态标题行控件存在').toBeVisible({ timeout: 5_000 });
  expect.soft(await toggle.evaluate((el) => el.tagName),
    '反例:放任档标题行也应是可点的 BUTTON(旧行为:不折叠 → 退化成不可点的 div)').toBe('BUTTON');
  await expect.soft(toggle, '折叠态 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');

  // ② 动作留在折叠态:【处理】/【忽略】都可见可点
  const proc = card.getByTestId('xs-card-process');
  const dismiss = card.getByTestId('xs-card-dismiss');
  await expect.soft(proc, '折叠态【处理】可见').toBeVisible();
  await expect.soft(dismiss, '折叠态【忽略】可见').toBeVisible();
  expect.soft(await proc.isEnabled(), '折叠态【处理】可点').toBe(true);
  expect.soft(await dismiss.isEnabled(), '折叠态【忽略】可点').toBe(true);

  // ③ 展开:正文完整(含第 1 段与第 6 段)、不裁切、版式是窄块两端对齐
  await toggle.click();
  const bodyEl = await waitBodyShown(card, 'xs-card-body', '放任档展开后的正文');
  for (const seg of [1, 2, 5, 6]) {
    await expect.soft(bodyEl, `展开后正文完整(含第 ${seg} 段)`).toContainText(`${pair.m} 第${seg}段`);
  }
  const opened = await bodyFacts(card, 'xs-card-body');
  expect.soft(opened.scrollHeight, `展开后正文不应被裁(scrollHeight ${opened.scrollHeight} / clientHeight ${opened.clientHeight})`).toBeLessThanOrEqual(opened.clientHeight + 2);
  await expect.soft(toggle, '展开后 aria-expanded=true').toHaveAttribute('aria-expanded', 'true');
  await expect.soft(expand, `展开后提示变成「${COLLAPSE}」`).toHaveText(COLLAPSE);
  // 版式判据(与 A11 同一套):窄块、块居中、块内 justify、非末行铺满。逐条 check 的失败信息自带实测值。
  const f = await textJustifyFacts(card, 'xs-card-body');
  const v = justifyVerdict(f);
  for (const c of v.checks) expect.soft(c.ok, `展开后版式 [${c.id}] ${c.detail}`).toBe(true);
  // 展开态动作仍可点(动作行在正文之前,不被正文推走)
  await expect.soft(proc, '展开态【处理】仍可见').toBeVisible();
  expect.soft(await proc.isEnabled(), '展开态【处理】仍可点').toBe(true);

  // ④ 再收起:正文消失,回到「展开全文」,动作还在
  await toggle.click();
  await waitBodyHidden(card, 'xs-card-body', '收起后的放任档正文');
  await expect.soft(toggle, '收起后 aria-expanded=false').toHaveAttribute('aria-expanded', 'false');
  await expect.soft(expand, `收起后提示回到「${EXPAND}」`).toHaveText(EXPAND);
  await expect.soft(proc, '收起后【处理】仍可见').toBeVisible();
  expect.soft(await dismiss.isEnabled(), '收起后【忽略】仍可点').toBe(true);
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

test('B10 多消息时收件箱在 20vh 内滚动,不把窗口顶爆', async ({ page }) => {
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
  expect.soft(f.height, `收件箱区域高度应 ≤ 20vh + 16px(实测 ${f.height.toFixed(0)}px / 视口 ${f.vh}px)`).toBeLessThanOrEqual(f.vh * 0.20 + 16);
  expect.soft(f.scroller, '内容溢出时应收件箱内部滚动(附近应有 overflow auto/scroll 且 scrollHeight > clientHeight 的容器)').not.toBeNull();
  if (f.scroller) expect.soft(f.scroller.h, `滚动容器高度应 ≤ 20vh + 4px(实测 ${f.scroller.h}px / 视口 ${f.vh}px)`).toBeLessThanOrEqual(f.vh * 0.20 + 4);
});
