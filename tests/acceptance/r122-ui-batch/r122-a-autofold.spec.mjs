// r122 · A 组:过程块自动折叠开关(INTERFACE A1–A10 / BRIEF R1)。
// 判据只用 INTERFACE 公布的锚点:localStorage 键 cgui-auto-fold-process、#set-auto-fold、
// [data-strip-root][data-strip-state]、[data-strip="head"][aria-expanded]、[data-strip-item="group"][hidden]。
// 「修前」= 功能尚未开发的当前代码:今天回合结束一律收起、设置里没有这个开关。
import { test, expect } from '@playwright/test';
import { FOLD, PLAIN, POOL } from './helpers/fixtures.mjs';
import {
  FOLD_KEY, FOLD_BLOCK_ID, EXISTING_SWITCH_BLOCK_ID, boot, reloadApp, openSessionBySearch, readFoldKey,
  turnRows, stripRootOf, stripSnapshot, allStripStates,
  openSettings, closeSettings, settingsSearch, settingBlock, settingsSearchHits,
  foldBlock, foldSwitch, foldSwitchChecked, toggleFoldSwitch, blockSwitchChecked, toggleBlockSwitch, enableChatMode,
  writeScenario, releaseRound, resetCtl, ctlPhase, sendPrompt, stopButton, waitRoundIdle,
} from './helpers/ui.mjs';

test.beforeEach(() => { resetCtl(); });
test.afterEach(() => { releaseRound(); });   // 兜底:用例中途失败也放行桩,别让它挂着

/** 打开 FOLD 夹具并确认 3 轮都在。 */
async function openFold(page) {
  await openSessionBySearch(page, FOLD.mark);
  await expect(turnRows(page), 'FOLD 夹具应当有 3 个助手轮').toHaveCount(FOLD.rounds, { timeout: 20_000 });
}
const snapOfRow = (page, i) => stripSnapshot(turnRows(page).nth(i).locator('[data-strip-root]'));

// ───────────────────────── A4 默认(没有键 / '0')= 不自动折叠 ─────────────────────────

/** A4 的整套判据(A4 两条用例与下面的自证用例共用同一份,保证自证的就是它)。 */
async function expectAllRoundsOpen(page, why) {
  for (let i = 0; i < FOLD.rounds; i += 1) {
    const snap = await snapOfRow(page, i);
    expect(snap.present, `第 ${i + 1} 轮应当有条带根 [data-strip-root]`).toBe(true);
    expect(snap.state, `第 ${i + 1} 轮:${why}`).toBe('open');
    expect(snap.groupCount, `自证:第 ${i + 1} 轮确实有 2 段可折的过程(否则"不带 hidden"是空话)`).toBe(2);
    expect(snap.groupHidden, `第 ${i + 1} 轮的过程段不得带 hidden`).toEqual([false, false]);
    expect(snap.groupHeights.every((h) => h > 0), `第 ${i + 1} 轮的过程段应当真的占位可见:${snap.groupHeights}`).toBe(true);
    expect(snap.kinds, `第 ${i + 1} 轮:每段过程仍在原位,夹在各段正文之间`).toEqual(FOLD.segments);
    expect(snap.headAria, `第 ${i + 1} 轮摘要行 aria-expanded`).toBe('true');
  }
}

for (const [label, fold] of [['没有这个键', null], ["键值为 '0'", '0']]) {
  test(`A4 默认不折叠(${label}):已结束的含过程回合 state=open,过程段不带 hidden 且留在原位`, async ({ page }) => {
    await boot(page, { fold });
    await openFold(page);
    expect(await readFoldKey(page), '自证:预置的存储状态确实到了页面里').toBe(fold);
    await expectAllRoundsOpen(page, '开关关闭(默认)时已结束的回合应保持展开');
  });
}

test('自证·A4 判据不是空转:把三轮逐个手动展开后,A4 的同一套断言能通过', async ({ page }) => {
  await boot(page, { fold: '1' });
  await openFold(page);
  for (let i = 0; i < FOLD.rounds; i += 1) {
    const head = turnRows(page).nth(i).locator('[data-strip="head"]');
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  }
  await expectAllRoundsOpen(page, '手动展开之后应当是 open');
});

// ───────────────────────── A5 开启('1')= 与今天一致 ─────────────────────────

test("A5 开启('1'):已结束的含过程回合 state=closed,过程段带 hidden(与今天一致)", async ({ page }) => {
  await boot(page, { fold: '1' });
  await openFold(page);
  expect(await readFoldKey(page), '自证:预置的存储状态确实到了页面里').toBe('1');
  for (let i = 0; i < FOLD.rounds; i += 1) {
    const snap = await snapOfRow(page, i);
    expect(snap.state, `第 ${i + 1} 轮:开关开启时回合结束应收成一行摘要`).toBe('closed');
    expect(snap.groupCount, `自证:第 ${i + 1} 轮确实有 2 段可折的过程`).toBe(2);
    expect(snap.groupHidden, `第 ${i + 1} 轮的过程段应带 hidden`).toEqual([true, true]);
    expect(snap.textHidden, `第 ${i + 1} 轮的正文段任何时候都不得带 hidden`).toEqual([false, false]);
    expect(snap.headCount, `第 ${i + 1} 轮恰好一条摘要行`).toBe(1);
    expect(snap.headAria).toBe('false');
  }
});

// ───────────────────────── A3 无过程的回合:两种设置下都是 none ─────────────────────────

for (const [label, fold] of [['开关关闭(默认)', null], ['开关开启', '1']]) {
  test(`A3 纯正文回合不受开关影响(${label}):state=none、没有摘要行`, async ({ page }) => {
    await boot(page, { fold });
    await openSessionBySearch(page, PLAIN.mark);
    await expect(turnRows(page)).toHaveCount(PLAIN.rounds, { timeout: 20_000 });
    for (let i = 0; i < PLAIN.rounds; i += 1) {
      const snap = await snapOfRow(page, i);
      expect(snap.present, `第 ${i + 1} 轮应当有条带根`).toBe(true);
      expect(snap.state, `第 ${i + 1} 轮没有可折叠的过程 → none`).toBe('none');
      expect(snap.headCount, '没有可折叠的过程 → 不渲染摘要行').toBe(0);
    }
  });
}

// ───────────────────────── A6 手动覆盖:只影响被点的那一轮 ─────────────────────────

test('A6 手动覆盖·开关关闭:点第 2 轮摘要行 → 只有第 2 轮收起,第 1、3 轮仍展开', async ({ page }) => {
  await boot(page, { fold: null });
  await openFold(page);
  expect(await allStripStates(page), '前提:默认三轮都展开').toEqual(['open', 'open', 'open']);
  await turnRows(page).nth(1).locator('[data-strip="head"]').click();
  expect(await allStripStates(page), '只翻转被点的那一轮').toEqual(['open', 'closed', 'open']);
  expect((await snapOfRow(page, 1)).headAria, '被点那一轮的 aria-expanded 同步').toBe('false');
});

test('A6 手动覆盖·开关开启:点第 2 轮摘要行 → 只有第 2 轮展开,第 1、3 轮仍收起', async ({ page }) => {
  await boot(page, { fold: '1' });
  await openFold(page);
  expect(await allStripStates(page), '前提:开启时三轮都收起').toEqual(['closed', 'closed', 'closed']);
  await turnRows(page).nth(1).locator('[data-strip="head"]').click();
  expect(await allStripStates(page), '只翻转被点的那一轮').toEqual(['closed', 'open', 'closed']);
  const snap = await snapOfRow(page, 1);
  expect(snap.headAria, '被点那一轮的 aria-expanded 同步').toBe('true');
  expect(snap.groupHidden, '被点那一轮的过程段不再带 hidden').toEqual([false, false]);
});

test('A6 手动覆盖·开关关闭:同一轮点两次 → 收起再展开,回到原状', async ({ page }) => {
  await boot(page, { fold: null });
  await openFold(page);
  const head = turnRows(page).nth(0).locator('[data-strip="head"]');
  expect((await snapOfRow(page, 0)).state, '前提:默认展开').toBe('open');
  await head.click();
  expect((await snapOfRow(page, 0)).state, '点一次 → 收起').toBe('closed');
  await head.click();
  expect((await snapOfRow(page, 0)).state, '再点一次 → 展开').toBe('open');
});

// ───────────────────────── A2 设置入口 ─────────────────────────

test('A2 设置入口:打开设置面板不点任何页签,就能看到带 #set-auto-fold 的「过程块自动折叠」区块', async ({ page }) => {
  await boot(page, { fold: null });
  await openSettings(page);
  await expect(foldBlock(page), '区块根节点应带 id="set-auto-fold",且就在设置面板默认打开的那一页').toBeVisible({ timeout: 10_000 });
  await expect(foldBlock(page), '区块标题文字应含「过程块自动折叠」').toContainText('过程块自动折叠');
});

test('A2 开关控件·默认:#set-auto-fold 里有 role=switch 或 checkbox,且显示为"关"', async ({ page }) => {
  await boot(page, { fold: null });
  await openSettings(page);
  await expect(foldSwitch(page), '#set-auto-fold 里应有开关控件').toHaveCount(1, { timeout: 10_000 });
  expect(await foldSwitchChecked(page), '没有存储键 = 默认关闭 → 控件应反映为未选中').toBe(false);
});

test("A2 开关控件·已开启:存储键为 '1' 时控件显示为\"开\"", async ({ page }) => {
  await boot(page, { fold: '1' });
  await openSettings(page);
  await expect(foldSwitch(page), '#set-auto-fold 里应有开关控件').toHaveCount(1, { timeout: 10_000 });
  expect(await foldSwitchChecked(page), "存储键 '1' = 开启 → 控件应反映为选中").toBe(true);
});

test('A2 设置搜索:输入"折叠" → 结果列表里出现这一条', async ({ page }) => {
  await boot(page, { fold: null });
  await openSettings(page);
  await settingsSearch(page).fill('折叠');
  await expect(settingsSearchHits(page, '折叠', FOLD_BLOCK_ID), '搜索"折叠"应当在结果列表里找到「过程块自动折叠」这一条')
    .toHaveCount(1, { timeout: 8_000 });
});

test('A2 设置搜索:点"折叠"的搜索结果 → 「过程块自动折叠」区块出现在视口里(与既有条目同款行为)', async ({ page }) => {
  await boot(page, { fold: null });
  await openSettings(page);
  await settingsSearch(page).fill('折叠');
  const hit = settingsSearchHits(page, '折叠', FOLD_BLOCK_ID).first();
  await expect(hit, '前提:搜索"折叠"有结果').toBeVisible({ timeout: 8_000 });
  await hit.click();
  await expect(foldBlock(page), '点结果后应把 #set-auto-fold 带进视口').toBeInViewport({ timeout: 8_000 });
});

test('自证·设置搜索的找法有效:对既有条目"生成式"用同一套找法,能找到结果、点了能把区块带进视口', async ({ page }) => {
  await boot(page, { fold: null });
  await openSettings(page);
  await settingsSearch(page).fill('生成式');
  const hit = settingsSearchHits(page, '生成式', EXISTING_SWITCH_BLOCK_ID);
  await expect(hit, '既有条目应当能被同一套找法找到(找不到 = 找法坏了,A2 搜索那两条的红就不可信)').toHaveCount(1, { timeout: 8_000 });
  await hit.first().click();
  await expect(settingBlock(page, EXISTING_SWITCH_BLOCK_ID)).toBeInViewport({ timeout: 8_000 });
});

test('自证·开关读写手法有效:对既有开关区块用同一套手法,能读出状态、拨得动、再拨回来', async ({ page }) => {
  await boot(page, { fold: null });
  await openSettings(page);
  const before = await blockSwitchChecked(page, EXISTING_SWITCH_BLOCK_ID);
  expect(typeof before, '既有开关应当读得出布尔状态(读不出 = 手法坏了,A1/A2/A7/A8 的红就不可信)').toBe('boolean');
  await toggleBlockSwitch(page, EXISTING_SWITCH_BLOCK_ID);
  expect(await blockSwitchChecked(page, EXISTING_SWITCH_BLOCK_ID), '拨一下应当翻转').toBe(!before);
  await toggleBlockSwitch(page, EXISTING_SWITCH_BLOCK_ID);   // 还原,不给别的用例留状态
  expect(await blockSwitchChecked(page, EXISTING_SWITCH_BLOCK_ID), '再拨一下应当还原').toBe(before);
});

// ───────────────────────── A1 存储约定(界面写出去的值)─────────────────────────

test("A1 存储约定:在设置里打开开关 → localStorage['cgui-auto-fold-process'] 变成 '1'", async ({ page }) => {
  await boot(page);   // 不碰这个键:全新浏览器上下文里本来就没有
  expect(await readFoldKey(page), '前提:全新环境里没有这个键').toBe(null);
  await openSettings(page);
  await toggleFoldSwitch(page);
  expect(await readFoldKey(page), `打开开关后键 ${FOLD_KEY} 应为 '1'`).toBe('1');
  expect(await foldSwitchChecked(page), '控件同步显示为"开"').toBe(true);
});

test("A1 存储约定:开着的开关再关掉 → 键变成 '0' 或被删除(两者都表示关闭)", async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await toggleFoldSwitch(page);
  expect(await readFoldKey(page), "前提:先打开,键为 '1'").toBe('1');
  await toggleFoldSwitch(page);
  expect([null, '0'], `关掉后键应为 '0' 或不存在,实际 ${JSON.stringify(await readFoldKey(page))}`).toContain(await readFoldKey(page));
  expect(await foldSwitchChecked(page), '控件同步显示为"关"').toBe(false);
});

// ───────────────────────── A7 切换即时生效(重新打开会话观察)─────────────────────────

test('A7 关→开:在设置里打开开关,重新打开会话 → 回合按新设置收起', async ({ page }) => {
  await boot(page);
  await openFold(page);
  expect(await allStripStates(page), '前提:默认三轮展开').toEqual(['open', 'open', 'open']);
  await openSettings(page);
  await toggleFoldSwitch(page);
  await closeSettings(page);
  await openSessionBySearch(page, PLAIN.mark);   // 先切走
  await openFold(page);                          // 再重新打开
  expect(await allStripStates(page), '打开开关后重新打开会话,三轮都应收起').toEqual(['closed', 'closed', 'closed']);
});

test('A7 开→关:在设置里关掉开关,重新打开会话 → 回合按新设置展开', async ({ page }) => {
  await boot(page);
  await page.evaluate((k) => localStorage.setItem(k, '1'), FOLD_KEY);   // 按 A1 的公开契约预置"已开启",再刷新让它生效
  await reloadApp(page);
  await openFold(page);
  expect(await allStripStates(page), '前提:开启时三轮收起').toEqual(['closed', 'closed', 'closed']);
  await openSettings(page);
  expect(await foldSwitchChecked(page), '前提:控件显示为"开"').toBe(true);
  await toggleFoldSwitch(page);
  await closeSettings(page);
  await openSessionBySearch(page, PLAIN.mark);
  await openFold(page);
  expect(await allStripStates(page), '关掉开关后重新打开会话,三轮都应展开').toEqual(['open', 'open', 'open']);
});

// ───────────────────────── A8 记住选择(刷新页面)─────────────────────────

test('A8 记住选择·开关状态:打开开关 → 刷新页面 → 设置里仍显示为"开"', async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await toggleFoldSwitch(page);
  expect(await foldSwitchChecked(page), '前提:拨动后为"开"').toBe(true);
  await reloadApp(page);
  await openSettings(page);
  expect(await foldSwitchChecked(page), '刷新后开关仍应为"开"').toBe(true);
});

test('A8 记住选择·行为:打开开关 → 刷新页面 → 打开会话,回合是收起的', async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await toggleFoldSwitch(page);
  expect(await foldSwitchChecked(page), '前提:拨动后为"开"').toBe(true);
  await reloadApp(page);
  await openFold(page);
  expect(await allStripStates(page), '刷新后行为仍按"开启"').toEqual(['closed', 'closed', 'closed']);
});

test('A8 记住选择·关闭也记住:开着 → 关掉 → 刷新页面 → 仍是"关"且回合展开', async ({ page }) => {
  await boot(page);
  await page.evaluate((k) => localStorage.setItem(k, '1'), FOLD_KEY);
  await reloadApp(page);
  await openSettings(page);
  expect(await foldSwitchChecked(page), '前提:预置后为"开"').toBe(true);
  await toggleFoldSwitch(page);
  await reloadApp(page);
  await openSettings(page);
  expect(await foldSwitchChecked(page), '刷新后开关仍应为"关"').toBe(false);
  await closeSettings(page);
  await openFold(page);
  expect(await allStripStates(page), '刷新后行为仍按"关闭"').toEqual(['open', 'open', 'open']);
});

// ───────────────────────── A9 正在生成的回合 / 正常结束之后 ─────────────────────────

const liveScenario = (tag, extra = {}) => ({
  events: [
    { kind: 'thinking', text: `${tag} 先看一眼现场。` },
    { kind: 'tool', name: 'Bash', input: { command: 'ls -la /tmp/r122-fixture', description: '看现场' }, result: 'ok' },
    { kind: 'text', text: `${tag}-TEXT 这一轮的正文。` },
  ],
  holdBeforeResult: true,
  ...extra,
});

/** 发一条消息,等桩把事件吐完并停在 result 之前(= 稳定的"正在生成")。返回这一轮的条带根。 */
async function startHeldRound(page, session, tag, extra) {
  writeScenario(liveScenario(tag, extra));
  await openSessionBySearch(page, session.mark);
  await sendPrompt(page, `${tag} 跑一轮`);
  const root = stripRootOf(page, `${tag}-TEXT`);
  await expect(root, '正在生成的回合应当已经画出条带').toHaveCount(1, { timeout: 40_000 });
  await expect.poll(() => ctlPhase(session.sid), { timeout: 30_000, message: '桩应当已吐完事件并停在 result 之前' }).toBe('events-done');
  await expect(stopButton(page).first(), '自证:此刻回合仍在进行("停止"键在)').toBeVisible();
  return root;
}

/** 回合正常结束并已换成落盘的那一轮(摘要行补上「N 轮」即为已换)。 */
async function finishRound(page, root) {
  releaseRound();
  await waitRoundIdle(page);
  await expect.poll(async () => (await root.locator('[data-strip="head"]').first().textContent().catch(() => '')) || '', {
    timeout: 40_000, message: '回合结束后摘要行应补上「N 轮」(= 已换成落盘的那一轮)',
  }).toMatch(/\d+\s*轮/);
}

test('A9 正在生成·开关开启:回合进行中 state=open', async ({ page }) => {
  await boot(page, { fold: '1' });
  const root = await startHeldRound(page, POOL[0], 'R122A9ONLIVE');
  expect(await root.getAttribute('data-strip-state'), '正在生成的回合始终展开').toBe('open');
});

test('A9 正在生成·开关关闭:回合进行中 state=open', async ({ page }) => {
  await boot(page, { fold: null });
  const root = await startHeldRound(page, POOL[1], 'R122A9OFFLIVE');
  expect(await root.getAttribute('data-strip-state'), '正在生成的回合始终展开').toBe('open');
});

test('A9 正常结束·开关开启:回合结束后变 closed(与今天一致)', async ({ page }) => {
  await boot(page, { fold: '1' });
  const root = await startHeldRound(page, POOL[2], 'R122A9ONDONE');
  await finishRound(page, root);
  await expect.poll(() => root.getAttribute('data-strip-state'), { timeout: 20_000, message: '开启时回合正常结束应收成一行' }).toBe('closed');
});

test('A9 正常结束·开关关闭:回合结束后保持 open(过几秒也不自己折上)', async ({ page }) => {
  await boot(page, { fold: null });
  const root = await startHeldRound(page, POOL[3], 'R122A9OFFDONE');
  await finishRound(page, root);
  expect(await root.getAttribute('data-strip-state'), '关闭(默认)时回合正常结束应保持展开').toBe('open');
  await page.waitForTimeout(4_000);
  expect(await root.getAttribute('data-strip-state'), '过 4 秒仍应展开(不许延迟自动折上)').toBe('open');
  expect((await stripSnapshot(root)).groupHidden.some(Boolean), '过程段不得带 hidden').toBe(false);
});

test('A9/R1-3 报错收尾·开关开启:这一轮保持展开(与今天一致)', async ({ page }) => {
  await boot(page, { fold: '1' });
  const root = await startHeldRound(page, POOL[4], 'R122A9ONERR', { end: 'error', errorText: 'R122A9ONERR 这一轮故意报错' });
  releaseRound();
  await waitRoundIdle(page);
  await page.waitForTimeout(3_000);
  expect(await root.getAttribute('data-strip-state'), '报错收尾的回合不得被收起').not.toBe('closed');
});

test('A9/R1-3 用户中断·开关开启:这一轮保持展开(与今天一致)', async ({ page }) => {
  await boot(page, { fold: '1' });
  const root = await startHeldRound(page, POOL[5], 'R122A9ONSTOP');
  await stopButton(page).first().click();
  await waitRoundIdle(page);
  await page.waitForTimeout(3_000);
  expect(await root.getAttribute('data-strip-state'), '用户中断的回合应保持展开').toBe('open');
});

// ───────────────────────── A10 聊天模式:不受开关影响 ─────────────────────────

for (const [label, fold] of [['开关关闭(默认)', null], ['开关开启', '1']]) {
  test(`A10 聊天模式(${label}):所有回合 state=off`, async ({ page }) => {
    await boot(page, { fold });
    await openFold(page);
    const before = await allStripStates(page);
    expect(before.length, '前提:三轮都有条带根').toBe(FOLD.rounds);
    expect(before.includes('off'), `前提:进聊天模式之前不是 off(证明下面的 off 是聊天模式带来的),实际 ${JSON.stringify(before)}`).toBe(false);
    await enableChatMode(page);
    await expect.poll(() => allStripStates(page), { timeout: 10_000, message: '聊天模式下所有回合都应是 off' }).toEqual(['off', 'off', 'off']);
  });
}
