// 二期行为清单 8、19、20、21、22(界面,共享实例 + dev server,浏览器 webkit)。发送方 = 真 CLI 会话(模型请求只到本地假接口)。
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { seedSession, uniq, makeWorkspace, realCliPath } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, shared, waitFor, inputRecords, spawnRecords, turnRecords, writeScript, touchCtl } from '../r151b-xsession-p1/helpers/api.mjs';
import { boot, openSessionBySearch, openSessionSettings, recordRequests } from '../r151b-xsession-p1/helpers/ui.mjs';
import {
  SM, NOTE, SEND_NOTICE, QUEUED_REASON, BANNER_TEXT, INBOUND_CONFIRM, aiCalls, resultJson, blast, inboundOk, entry, msgs, waitMsg, profileTurn, wsT,
  openMoreMenu, chooseInbound,
} from './helpers/p2.mjs';

test.describe.configure({ timeout: 360_000 });
test.beforeEach(() => { test.skip(!realCliPath(), '本机没有真 claude CLI'); });
const api = xs();
const fromSession = (x) => x.from && x.from.kind === 'session';
const card = (page, id) => page.locator(`[data-testid="xs-card"][data-message-id="${id}"]`);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** 让 sid 忙起来(假 CLI 回合等 go 文件);返回 { go, pid }。 */
async function busy(s, run) {
  const go = `busy-go-${run}`;
  writeScript(`busy${run}`, [{ waitFile: go }, { say: `R151C 忙完了 ${run}` }]);
  const r = await shared.post('/api/chat', { sessionId: s.sid, cwd: s.cwd, prompt: `R151C R151S:busy${run}`, permissionMode: 'bypassPermissions' });
  expect(r.status, '前置:目标开始一个会忙一阵的回合').toBe(200);
  expect(await waitFor(() => turnRecords().some((t) => t.sid === s.sid && t.text.includes(`busy${run}`)), 15_000), '前置:目标正在跑').toBeTruthy();
  return { go, pid: r.body.pid };
}
async function autoTarget(name, run) {
  const B = seedSession(`${name}-${run}`, { title: `R151C ${name} ${run}` });
  await profileTurn(shared, B, 'bypassPermissions');
  await inboundOk(shared, B.sid, 'auto');
  return B;
}

test('P08 AI 调 send_message 发给"等你确认"的会话 → delivery:"card";目标出现卡片,来源"来自 <发送方标题> · <目录名>";目标不起进程', async ({ page }) => {
  await api.on();
  const run = uniq('');
  const B = seedSession(`p08-b-${run}`, { title: `R151C p08 目标 ${run}` });
  const cwd = makeWorkspace(`real-p08-${run}`);
  const r = await aiCalls(shared, { cwd, steps: [{ name: SM, input: { to: [B.title], message: `R151C p08 正文 ${run}` } }] });
  const j = resultJson(r, 0, 1);
  expect(j, '返回').toEqual({ results: [{ to: B.title, ok: true, id: (await entry(shared, B.sid)).shortId, name: B.title, delivery: 'card', note: NOTE.card }], notice: SEND_NOTICE });
  const m = await waitMsg(shared, B.sid, fromSession);
  expect(m, '消息对象').toMatchObject({ status: 'pending', heldReason: 'target-card', via: null, hop: 1, from: { kind: 'session', sessionId: r.sid } });
  expect(spawnRecords().filter((x) => x.cwd === B.cwd).length, '目标不起进程').toBe(0);
  await boot(page);
  await openSessionBySearch(page, B.title, B.reply);
  await expect(card(page, m.id).getByTestId('xs-card-from')).toHaveText(`来自 ${m.from.title} · ${path.basename(cwd)}`, { timeout: 15_000 });
});

test('P19 未暂停时设置块显示"过去 10 分钟自动处理 n / 20";触顶暂停后顶部出现 xs-paused-banner(文案逐字 + 【恢复自动处理】),设置块显示"自动处理已暂停"与 xsession-auto-resume;点恢复后提示条消失', async ({ page }) => {
  await api.on();
  let cfg = (await api.config()).body;
  if (cfg.autoPaused) expect((await api.setConfig({ autoPaused: false })).status, '前置:先恢复').toBe(200);
  cfg = (await api.config()).body;
  const used = cfg.autoBudget ? cfg.autoBudget.used : 0;
  await boot(page);
  await openSessionSettings(page);
  const section = page.getByTestId('xsession-settings-section');
  await section.scrollIntoViewIfNeeded().catch(() => {});
  await expect(section.getByTestId('xsession-auto-budget'), '未暂停时的计数').toHaveText(`过去 10 分钟自动处理 ${used} / 20`, { timeout: 10_000 });
  expect(await page.getByTestId('xs-paused-banner').count(), '未暂停时没有提示条').toBe(0);

  const run = uniq('');
  const T = [];
  for (let i = 0; i < 20 - used + 1; i += 1) T.push(await autoTarget(`p19-t${i}`, run));
  await blast(shared, { cwd: makeWorkspace(`real-p19-${run}`) }, T.map((t) => t.sid), `R151C p19 ${run}`);
  await expect.poll(async () => (await api.config()).body.autoPaused, { timeout: 20_000, message: '前置:已触顶暂停' }).toBe(true);
  const banner = page.getByTestId('xs-paused-banner');
  await expect(banner, '暂停后出现提示条').toBeVisible({ timeout: 15_000 });
  expect(norm(await banner.innerText())).toContain(BANNER_TEXT);
  await expect(banner.getByRole('button', { name: '恢复自动处理' })).toBeVisible();
  await expect(section.getByTestId('xsession-auto-budget')).toHaveText('自动处理已暂停', { timeout: 10_000 });
  await expect(section.getByTestId('xsession-auto-resume')).toHaveText('恢复自动处理');
  await banner.getByRole('button', { name: '恢复自动处理' }).click();
  await expect(banner, '恢复后提示条消失').toHaveCount(0, { timeout: 10_000 });
  expect((await api.config()).body.autoPaused).toBe(false);
  await expect(section.getByTestId('xsession-auto-budget')).toHaveText('过去 10 分钟自动处理 0 / 20', { timeout: 10_000 });
});

test('P20 "更多"菜单 xs-inbound-select 选"自动处理" → 先出 xs-inbound-confirm(文案逐字),取消保持原值、确认才生效;不追溯已有卡片;改回"等你确认"后排队中的消息转卡片 target-card', async ({ page }) => {
  await api.on();
  const run = uniq('');
  const B = seedSession(`p20-b-${run}`, { title: `R151C p20 ${run}` });
  await profileTurn(shared, B, 'bypassPermissions');
  const [m0] = await api.send(null, [B.sid], `R151C p20 已有卡片 ${run}`);
  const puts = recordRequests(page, `/api/xsession/sessions/${B.sid}/inbound`);
  await boot(page);
  await openSessionBySearch(page, B.title, B.reply);
  expect(await openMoreMenu(page), '"更多"菜单里有 xs-inbound-select').toBe(true);
  await chooseInbound(page, '自动处理');
  const confirm = page.getByTestId('xs-inbound-confirm');
  await expect(confirm, '先出确认框').toBeVisible({ timeout: 10_000 });
  expect(norm(await confirm.innerText()), '确认框文案逐字').toContain(INBOUND_CONFIRM);
  const cancel = confirm.getByRole('button', { name: '取消', exact: true });
  if (await cancel.count()) await cancel.click(); else await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(puts.filter((x) => x.method === 'PUT'), '取消不发请求').toEqual([]);
  expect((await entry(shared, B.sid)).inbound, '取消保持原值').toBe('card');

  if (!(await page.getByTestId('xs-inbound-select').first().isVisible().catch(() => false))) await openMoreMenu(page);
  await chooseInbound(page, '自动处理');
  await page.getByTestId('xs-inbound-confirm-ok').click();
  await expect.poll(async () => (await entry(shared, B.sid)).inbound, { timeout: 10_000, message: '确认后生效' }).toBe('auto');
  expect(puts.filter((x) => x.method === 'PUT').map((x) => x.body), '发了一次 {mode:"auto"}').toEqual([{ mode: 'auto' }]);
  const t0 = turnRecords().filter((t) => t.sid === B.sid).length;
  await page.waitForTimeout(3_000);
  expect((await msgs(shared, B.sid)).find((x) => x.id === m0.id), '改成自动处理不追溯已有卡片').toMatchObject({ status: 'pending', heldReason: 'target-card' });
  expect(turnRecords().filter((t) => t.sid === B.sid).length, '没有为已有卡片开始回合').toBe(t0);

  const { go } = await busy(B, run);
  const r = await aiCalls(shared, { cwd: makeWorkspace(`real-p20-${run}`), steps: [{ name: SM, input: { to: [B.sid], message: `R151C p20 排队 ${run}` } }] });
  expect(resultJson(r, 0, 1)?.results?.[0]?.delivery, '前置:目标正忙 → queued').toBe('queued');
  const q = await waitMsg(shared, B.sid, (x) => fromSession(x) && x.status === 'queued');
  if (!(await page.getByTestId('xs-inbound-select').first().isVisible().catch(() => false))) await openMoreMenu(page);
  await chooseInbound(page, '等你确认');
  await expect.poll(async () => (await entry(shared, B.sid)).inbound, { timeout: 10_000 }).toBe('card');
  expect(await waitMsg(shared, B.sid, (x) => x.id === q.id && x.status === 'pending'), '排队中的消息转卡片 target-card').toMatchObject({ heldReason: 'target-card' });
  touchCtl(go);
});

test('P21 被自动处理的消息在目标会话显示为 peer-message 气泡(data-via="auto",徽标"自动处理"),没有"你"的气泡;刷新后历史里同一条显示为 data-via="gui"', async ({ page }) => {
  await api.on();
  const run = uniq('');
  const B = await autoTarget('p21-b', run);
  await boot(page);
  await openSessionBySearch(page, B.title, B.reply);
  const body = `R151C p21 正文 ${run}`;
  const r = await aiCalls(shared, { cwd: makeWorkspace(`real-p21-${run}`), steps: [{ name: SM, input: { to: [B.sid], message: body } }] });
  expect(resultJson(r, 0, 1)?.results?.[0]?.delivery, '前置:自动处理').toBe('auto');
  const m = await waitMsg(shared, B.sid, fromSession);
  const live = page.locator('[data-testid="peer-message"][data-via="auto"]').filter({ hasText: body });
  await expect(live, '直播气泡 data-via="auto"').toHaveCount(1, { timeout: 20_000 });
  await expect(live.getByTestId('peer-message-auto')).toHaveText('自动处理');
  await expect(live.getByTestId('peer-message-from')).toHaveText(`来自 ${m.from.title}`);
  const stray = await page.evaluate((needle) => {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.data.includes(needle) && !n.data.includes('cross-session-message')) continue;
      if (!n.parentElement.closest('[data-testid="peer-message"],[data-testid="xs-card"]')) out.push(n.data.slice(0, 80));
    }
    return out;
  }, body);
  expect(stray, '正文 / 信封不出现在"你"的气泡里').toEqual([]);
  expect(await waitMsg(shared, B.sid, (x) => x.id === m.id && x.status === 'done'), '前置:处理完').toBeTruthy();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await openSessionBySearch(page, B.title, B.reply);
  await expect(page.locator('[data-testid="peer-message"][data-via="gui"]').filter({ hasText: body }), '刷新后历史里是 data-via="gui"').toHaveCount(1, { timeout: 20_000 });
  expect(await page.locator('[data-testid="peer-message"][data-via="auto"]').filter({ hasText: body }).count()).toBe(0);
});

test('P22 点【处理】一条 queued 的消息 → 取消自动处理改由人处理(via:"card");点【忽略】一条 queued 的消息 → dismissed', async ({ page }) => {
  await api.on();
  const run = uniq('');
  const B = await autoTarget('p22-b', run);
  const { go } = await busy(B, run);
  const ws = await wsT();
  try {
    const r = await aiCalls(shared, { cwd: makeWorkspace(`real-p22-${run}`), steps: [
      { name: SM, input: { to: [B.sid], message: `R151C p22 处理这条 ${run}` } },
      { name: SM, input: { to: [B.sid], message: `R151C p22 忽略这条 ${run}` } },
    ] });
    expect(r.results.map((x) => x.json?.results?.[0]?.delivery), '前置:两条都 queued').toEqual(['queued', 'queued']);
    const all = (await msgs(shared, B.sid)).filter(fromSession);
    const m1 = all.find((x) => x.body.includes('处理这条')); const m2 = all.find((x) => x.body.includes('忽略这条'));
    const chats = recordRequests(page, '/api/chat');
    await boot(page);
    await openSessionBySearch(page, B.title, B.reply);
    await expect(card(page, m1.id)).toHaveAttribute('data-status', 'queued', { timeout: 15_000 });
    await expect(card(page, m1.id).getByTestId('xs-card-reason')).toHaveText(QUEUED_REASON);
    await card(page, m2.id).getByTestId('xs-card-dismiss').click();
    await expect(card(page, m2.id), '忽略后卡片消失').toHaveCount(0, { timeout: 10_000 });
    expect((await msgs(shared, B.sid)).find((x) => x.id === m2.id).status, '【忽略】→ dismissed').toBe('dismissed');
    await card(page, m1.id).getByTestId('xs-card-process').click();
    const i0 = inputRecords().filter((x) => x.cwd === B.cwd).length;
    touchCtl(go);
    const done = await waitMsg(shared, B.sid, (x) => x.id === m1.id && x.status === 'done', 30_000);
    expect(done, '【处理】→ 改由人处理,via:"card"').toMatchObject({ status: 'done', via: 'card' });
    expect(chats.filter((c) => c.method === 'POST' && c.body && c.body.xsMessageId === m1.id).length, '经卡片发出一次带凭据的 /api/chat').toBe(1);
    expect(ws.msgs.filter((e) => e.type === 'xs:turn' && [m1.id, m2.id].includes(e.messageId)), '没有为这两条开始自动处理').toEqual([]);
    await page.waitForTimeout(2_000);
    const envs = inputRecords().filter((x) => x.cwd === B.cwd).slice(i0).filter((x) => typeof x.content === 'string' && x.content.startsWith('<cross-session-message'));
    expect(envs.length, '只投递了【处理】的那一条').toBe(1);
    expect(envs[0].content).toContain('处理这条');
  } finally { ws.close(); }
});
