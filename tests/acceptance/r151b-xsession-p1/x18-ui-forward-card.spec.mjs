// 行为清单 18、19:转发对话框、卡片区(界面,共享实例 + dev server,浏览器 webkit)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { seedSession, uniq } from './helpers/fixtures.mjs';
import { xs, waitFor, writeScript, touchCtl, turnRecords } from './helpers/api.mjs';
import { boot, openSessionBySearch, recordRequests, sendPrompt } from './helpers/ui.mjs';

test.describe.configure({ timeout: 240_000 });
const api = xs();
const card = (page, id) => page.locator(`[data-testid="xs-card"][data-message-id="${id}"]`);
const target = (page, sid) => page.locator(`[data-testid="xs-forward-target"][data-session-id="${sid}"]`);
const bodyValue = (loc) => loc.evaluate((e) => ('value' in e ? e.value : e.innerText));
const rgb = (s) => (String(s).match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);

test('X18 转发对话框:预填选中文字 / 整条回复;超 32768 字节标红且禁用发送;最多 8 个目标;列表不含当前会话;成功逐个回执;失败显示 error、标出目标、一条不发、不关', async ({ page }) => {
  await api.on();
  const mark = uniq('R151BX18');
  const A = seedSession(`x18-a-${mark}`, { title: `${mark} 来源`, reply: `${mark} 第一句。第二句。` });
  const tm = uniq('R151BX18T');
  const T = Array.from({ length: 9 }, (_, i) => seedSession(`x18-t${i}-${tm}`, { title: `${tm} 目标${i}` }));
  const D = seedSession(`x18-d-${tm}`, { title: `${tm} 将被删除` });
  const posts = recordRequests(page, '/api/xsession/messages');
  await boot(page);
  await openSessionBySearch(page, mark, A.reply);
  const dialog = page.getByTestId('xs-forward-dialog');
  const openDialog = async () => {
    await page.getByText(A.reply).first().hover();
    await page.getByTestId('xs-forward-btn').first().click();
    await expect(dialog, '对话框应打开').toBeVisible({ timeout: 10_000 });
  };

  await test.step('有选中文字 → 预填选中部分', async () => {
    await page.evaluate((needle) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.data.indexOf(needle);
        if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return; }
      }
    }, '第二句。');
    await openDialog();
    expect(await bodyValue(page.getByTestId('xs-forward-body'))).toBe('第二句。');
    expect(await dialog.innerText(), '没有"立即处理"选项').not.toContain('立即处理');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });

  await test.step('没有选中 → 预填整条回复;列表不含当前会话', async () => {
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await openDialog();
    expect(await bodyValue(page.getByTestId('xs-forward-body'))).toBe(A.reply);
    await page.getByTestId('xs-forward-search').fill(mark);
    await page.waitForTimeout(800);
    expect(await target(page, A.sid).count(), '目标列表不含当前会话').toBe(0);
  });

  await test.step('字节数:超过 32768 标红、发送禁用', async () => {
    const bodyBox = page.getByTestId('xs-forward-body');
    const size = page.getByTestId('xs-forward-size');
    await bodyBox.fill('a'.repeat(100));
    const okColor = rgb(await size.evaluate((e) => getComputedStyle(e).color));
    await bodyBox.fill('a'.repeat(32769));
    await expect(size).toContainText('32769');
    const [r, g, b] = rgb(await size.evaluate((e) => getComputedStyle(e).color));
    expect(r > g + 40 && r > b + 40 && `${[r, g, b]}` !== `${okColor}`, `超限时字节数应标红(超限 ${[r, g, b]},未超限 ${okColor})`).toBe(true);
    await expect(page.getByTestId('xs-forward-send')).toBeDisabled();
    await bodyBox.fill('R151B x18 正文');
  });

  await test.step('最多 8 个目标;发送后每个目标一行回执', async () => {
    await page.getByTestId('xs-forward-search').fill(tm);
    for (const t of T.slice(0, 8)) await target(page, t.sid).click();
    await target(page, T[8].sid).click();
    await expect(dialog, '第 9 个不会选中并提示').toContainText('最多 8 个目标');
    const n0 = posts.length;
    await page.getByTestId('xs-forward-send').click();
    const result = page.getByTestId('xs-forward-result');
    await expect(async () => {
      const txt = await result.innerText();
      expect(txt.split('已送达，等待对方会话里确认处理').length - 1).toBe(8);
    }).toPass({ timeout: 15_000 });
    const sent = posts.slice(n0).filter((p) => p.method === 'POST');
    expect(sent.length, '发了一次转发请求').toBe(1);
    expect([...sent[0].body.to].sort(), '只发给前 8 个').toEqual(T.slice(0, 8).map((t) => t.sid).sort());
    for (const t of T.slice(0, 8)) expect((await api.list(t.sid)).body.messages.map((m) => m.body)).toEqual(['R151B x18 正文']);
    expect((await api.list(T[8].sid)).body.messages, '第 9 个没收到').toEqual([]);
    await page.keyboard.press('Escape');
  });

  await test.step('接口失败:显示返回的 error、标出出错目标、一条都没发、对话框不关', async () => {
    await openDialog();
    await page.getByTestId('xs-forward-search').fill(tm);
    await target(page, T[8].sid).click();
    await target(page, D.sid).click();
    fs.rmSync(D.file);
    const respP = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/xsession/messages' && r.request().method() === 'POST');
    await page.getByTestId('xs-forward-send').click();
    const resp = await respP;
    const rb = await resp.json();
    expect(resp.status(), '前置:接口回 404').toBe(404);
    const result = page.getByTestId('xs-forward-result');
    await expect(result).toContainText(rb.error);
    const marked = (await result.innerText()).includes(D.title)
      || (await target(page, D.sid).getAttribute('aria-invalid')) === 'true' || (await target(page, D.sid).getAttribute('data-error')) !== null;
    expect(marked, '标出出错的目标').toBe(true);
    await expect(dialog, '对话框不关').toBeVisible();
    expect((await api.list(T[8].sid)).body.messages, '合法目标一条都没收到').toEqual([]);
  });
});

test('X19 卡片区:来源 / 折叠展开 / 原因文案;【处理】→ peer-message 气泡(data-via=card)且没有"你"的气泡;忙时进排队;409 时按最新状态刷新;【撤回】只在 claimed;【忽略】后消失', async ({ page }) => {
  await api.on();
  const mark = uniq('R151BX19');
  const A = seedSession(`x19-a-${mark}`, { title: `${mark} 来源会话` });
  const B = seedSession(`x19-b-${mark}`, { title: `${mark} 目标会话` });
  const lines = Array.from({ length: 10 }, (_, i) => `${mark} 第${i + 1}行`);
  const [m1] = await api.send(A.sid, [B.sid], lines.join('\n'));
  const [m2] = await api.send(A.sid, [B.sid], `${mark} 背后被忽略`);
  const [m3] = await api.send(A.sid, [B.sid], `${mark} 撤回与排队`);
  const [m4] = await api.send(A.sid, [B.sid], `${mark} 点忽略`);
  const drop = new Set();
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => server.send(msg));
    server.onMessage((msg) => {
      try { const o = JSON.parse(String(msg)); if (o && o.type === 'xs:message' && o.message && drop.has(o.message.id)) return; } catch { /* 非 JSON */ }
      ws.send(msg);
    });
  });
  const chats = recordRequests(page, '/api/chat');
  await boot(page);
  // 按目标会话的完整标题搜:只搜 mark 会连来源会话一起命中,结果第一条是来源会话
  await openSessionBySearch(page, B.title, B.reply);

  await test.step('卡片:来源、原因、折叠与展开、pending 时没有【撤回】', async () => {
    await expect(page.getByTestId('xs-inbox')).toBeVisible({ timeout: 15_000 });
    await expect(card(page, m1.id)).toHaveAttribute('data-status', 'pending');
    await expect(card(page, m1.id).getByTestId('xs-card-from')).toHaveText(`由你从 ${A.title} 转发`);
    await expect(card(page, m1.id).getByTestId('xs-card-reason')).toHaveText('等待你确认后处理');
    expect(await card(page, m1.id).getByTestId('xs-card-release').count(), 'pending 时没有【撤回】').toBe(0);
    const bodyEl = card(page, m1.id).getByTestId('xs-card-body');
    const h0 = await bodyEl.evaluate((e) => e.getBoundingClientRect().height);
    await card(page, m1.id).getByTestId('xs-card-expand').click();
    await expect(async () => expect(await bodyEl.evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThan(h0 + 10)).toPass({ timeout: 5_000 });
  });

  await test.step('【撤回】只在 claimed 时出现', async () => {
    await api.claimOk(m3.id);
    await expect(card(page, m3.id)).toHaveAttribute('data-status', 'claimed', { timeout: 10_000 });
    await expect(card(page, m3.id).getByTestId('xs-card-reason')).toHaveText('等待发送');
    await card(page, m3.id).getByTestId('xs-card-release').click();
    await expect(card(page, m3.id)).toHaveAttribute('data-status', 'pending', { timeout: 10_000 });
    expect(await card(page, m3.id).getByTestId('xs-card-release').count()).toBe(0);
    expect((await api.find(B.sid, m3.id)).status).toBe('pending');
  });

  await test.step('【忽略】后卡片消失', async () => {
    await card(page, m4.id).getByTestId('xs-card-dismiss').click();
    await expect(card(page, m4.id)).toHaveCount(0, { timeout: 10_000 });
    expect((await api.find(B.sid, m4.id)).status).toBe('dismissed');
  });

  await test.step('接口回 409 → 卡片按最新状态刷新', async () => {
    drop.add(m2.id);
    expect((await api.dismiss(m2.id)).status, '前置:背后忽略').toBe(200);
    await page.waitForTimeout(500);
    await card(page, m2.id).getByTestId('xs-card-process').click();
    await expect(card(page, m2.id), '已忽略的卡片刷新后消失').toHaveCount(0, { timeout: 10_000 });
  });

  await test.step('【处理】→ peer-message 气泡(data-via=card),没有"你"的气泡,处理完卡片消失', async () => {
    await card(page, m1.id).getByTestId('xs-card-process').click();
    const bubble = page.locator('[data-testid="peer-message"][data-via="card"]').filter({ hasText: lines[0] });
    await expect(bubble).toHaveCount(1, { timeout: 20_000 });
    const sent = chats.filter((c) => c.method === 'POST' && c.body && c.body.xsMessageId === m1.id);
    expect(sent.length, '发出一次带凭据的 /api/chat').toBe(1);
    expect(typeof sent[0].body.xsToken).toBe('string');
    const stray = await page.evaluate((needle) => {
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.data.includes(needle) && !n.data.includes('cross-session-message')) continue;
        if (!n.parentElement.closest('[data-testid="peer-message"],[data-testid="xs-card"]')) out.push(n.data.slice(0, 80));
      }
      return out;
    }, lines[0]);
    expect(stray, '正文 / 信封不应出现在别的气泡里').toEqual([]);
    await expect(card(page, m1.id)).toHaveCount(0, { timeout: 20_000 });
  });

  await test.step('会话正忙时点【处理】→ 进既有排队,回合结束后才处理', async () => {
    const go = `x19-go-${uniq('')}`;
    writeScript('x19busy', [{ waitFile: go }, { say: 'R151B x19 忙完了' }]);
    await sendPrompt(page, `${mark} 忙 R151S:x19busy`);
    expect(await waitFor(() => turnRecords().some((t) => t.sid === B.sid && t.text.includes('R151S:x19busy')), 15_000), '前置:忙的回合已开始').toBeTruthy();
    await card(page, m3.id).getByTestId('xs-card-process').click();
    await page.waitForTimeout(1_500);
    expect(turnRecords().some((t) => t.sid === B.sid && t.text.includes(`${mark} 撤回与排队`)), '忙的时候不处理').toBe(false);
    touchCtl(go);
    await expect(page.locator('[data-testid="peer-message"][data-via="card"]').filter({ hasText: `${mark} 撤回与排队` })).toHaveCount(1, { timeout: 20_000 });
    expect((await api.waitStatus(B.sid, m3.id, 'done')).status, '回合结束后处理完').toBe('done');
  });
});
