// SF-1xx：条带折叠的**静态形态**（历史轮）——结构、默认态、文案、折叠范围、边界。
//
// 观测面全部是 .devflow/INTERFACE-20260912-stripfold.md §D 的公开锚点：
//   [data-strip-root][data-strip-state|rounds|steps]（r159：总栏 [data-strip="head"] 已去掉，data-strip-state 现在只有 open / none）
//   / [data-strip-item="<kind>"][hidden]
import { test, expect } from '@playwright/test';
import { MARKER_A, MARKER_C, A, C } from './helpers/fixtures.mjs';
import { primeOverlays, openApp, openSessionByMarker, turnRows, stripSnapshot } from './helpers/runtime.mjs';

test.beforeEach(async ({ page }) => { await primeOverlays(page); });


/**
 * SF-100 · 夹具自检（**不是被测功能的判据**）。
 *
 * 为什么留着：本套件其余用例全部读夹具会话。若夹具的记录形态没被产品认出来
 * （少喂一步、块形状不对），后面每一条都会红成"产品缺陷"——这条先把夹具自身的问题
 * 与产品的问题分开。它读的都是**既有**行为（过程段折行、正文渲染），所以修前就该是绿的。
 */
test('SF-100 夹具自检：主夹具能打开、3 轮都在、每轮两段过程 + 两段正文', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const rows = turnRows(page);
  await expect(rows, '主夹具应当有 3 个 turn 行').toHaveCount(A.rounds, { timeout: 20_000 });
  const body = page.locator('body');
  await expect(body).toContainText(A.midText);
  await expect(body).toContainText(A.finalText.slice(0, 40));
  // 每组折行 =「<本组最后一次工具调用的标题> · N 次工具调用」：group1 最后一个工具是 Read，
  // group2 最后一个是 Grep(pattern=ROOT=)。每组各 A.rounds 条。
  const g1 = await page.getByText('读取 release.local.sh · 2 次工具调用', { exact: true }).count();
  const g2 = await page.getByText('搜索 ROOT= · 2 次工具调用', { exact: true }).count();
  expect(g1, '主夹具每轮第 1 个过程段折行（最后工具 Read 的标题）').toBe(A.rounds);
  expect(g2, '主夹具每轮第 2 个过程段折行（最后工具 Grep 的标题）').toBe(A.rounds);
});

test('SF-103 正文全部可见（含中间插话），且文字用 textContent 核对', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const rows = turnRows(page);
  await expect(rows).toHaveCount(A.rounds);

  for (let i = 0; i < A.rounds; i += 1) {
    const items = rows.nth(i).locator('[data-strip-item]');
    const texts = await items.evaluateAll((els) => els.filter((e) => e.getAttribute('data-strip-item') === 'text')
      .map((e) => ({ hidden: e.hasAttribute('hidden'), h: Math.round(e.getBoundingClientRect().height), text: (e.textContent || '').trim() })));
    expect(texts.length, `第 ${i + 1} 轮应当有 2 个正文段`).toBe(2);
    for (const t of texts) {
      expect(t.hidden, '正文段任何状态下都不得带 hidden').toBe(false);
      expect(t.h, '正文段必须真的占位（height > 0）').toBeGreaterThan(0);
    }
    expect(texts[0].text).toContain(A.midText);
    expect(texts[1].text).toContain(A.finalText.slice(0, 30));
  }
});


test('SF-109 无可折块的轮：state=none、不渲染摘要行、正文照常', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_C);
  const textOnlyRow = turnRows(page).filter({ hasText: C.textOnlyText }).first();
  await expect(textOnlyRow).toHaveCount(1);
  const snap = await stripSnapshot(textOnlyRow);
  expect(snap.present, '只有正文的轮也应当有条带根（便于区分"没折"与"渲染坏了"）').toBe(true);
  expect(snap.state, '没有可折块 → state=none').toBe('none');
  expect(snap.headCount, '没有可折块 → 不渲染摘要行').toBe(0);
  expect(Number(snap.steps), '步数不得是 NaN').toBe(0);
  const box = await textOnlyRow.locator('[data-strip-item="text"]').first().boundingBox();
  expect(box && box.height > 0, '正文照常可见').toBe(true);

  // 同会话里，空思考块不计入步数：那一轮只有 1 个真工具 → 1 步。
  // ⚠️ 锚点必须是**助手正文**（`C.emptyThinkDoneText`），不能是那一轮的用户话术：
  // `turnRows` 只取 `[data-turn-role="turn"]` 的行，用户气泡是**另一行**，
  // 用它定位这一轮永远找不到（2026-09-13 修：原来写的 `C.emptyThinkTurnText` 就是栽在这）。
  const emptyThinkRow = turnRows(page).filter({ hasText: C.emptyThinkDoneText }).first();
  await expect(emptyThinkRow, '空思考那一轮应当能按助手正文定位到').toHaveCount(1);
  const emptySnap = await stripSnapshot(emptyThinkRow);
  expect(emptySnap.steps, '空 content 的思考块必须被跳过、不计入步数').toBe('1');
});

test('SF-110 老形态记录（老 CLI 的字符串 content）照常渲染，同会话的普通轮照常做条带', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_C);

  // ── 配对**正**断言：同会话里普通轮必须**有**条带根。先跑，不许被下面的跳过吃掉：
  //    没有它，任何负断言在"整条功能根本没做"时也会绿（这条纪律一字未动）。
  const normalRoots = await turnRows(page).filter({ hasText: C.workflowLabel }).first().locator('[data-strip-root]').count();
  expect(normalRoots, '同会话的普通轮必须有条带根').toBe(1);

  // ── 老形态记录那一轮：夹具里它的 `message.content` 是纯字符串（老 CLI 形态）。
  const legacyRow = turnRows(page).filter({ hasText: C.legacyText }).first();
  await expect(legacyRow, '老形态记录应当照常渲染（正文可见）').toHaveCount(1);

  // 实测（隔离实例 `/api/sessions/<C>/messages`）：这一轮在读取器里被规范化成
  // `blocks=[{type:'text',content:'这一条是老形态记录…'}]` → 走的是**普通轮**路径。
  // 因此能压的是"无可折块 → none、不渲染摘要行、正文照常"（I-109/I-201/I-205 那一组）。
  const snap = await stripSnapshot(legacyRow);
  expect(snap.present, '老形态记录经读取器规范化后走普通轮路径（读取器对有条目的轮恒给 blocks）').toBe(true);
  expect(snap.state, '这一轮没有可折块 → state=none').toBe('none');
  expect(snap.headCount, '无可折块 → 不渲染摘要行').toBe(0);
  expect(Number(snap.steps), '步数不得是 NaN，且这一轮是 0').toBe(0);
  const textBox = await legacyRow.locator('[data-strip-item="text"]').first().boundingBox();
  expect(textBox && textBox.height > 0, '老形态记录的正文照常可见').toBe(true);
  const textLen = await legacyRow.locator('[data-strip-item="text"]').first()
    .evaluate((el) => (el.textContent || '').trim().length);
  expect(textLen, '老形态记录的正文文字必须还在').toBeGreaterThan(0);

  // ── I-115 真正想要的那个现场（`turn.blocks` 为空 / 没有 blocks → TurnBubble 走 legacy 分支
  //    → 连 `data-strip-root` 都没有）**在本产品下造不出来**，证据两条（都是实测 + 读实现）：
  //      ① 读取器把字符串 content 规范化成正文块（session-reader.js `normalizeContent`）；
  //      ② 一个"什么都没有"的回合会被 `flushTurn()`（同文件）整轮丢掉，根本不出行。
  //    live 侧同理：不发 partial 的整条消息型 provider 的快照也会写进 `orderedBlocks`。
  //    所以这条按套件约定标 ENVIRONMENT_BLOCKED —— 不伪装成通过，也不改用更弱的断言冒名顶替。
  //    ⚠️ 上面的断言在跳过之前**已经跑过**：它们红的话这条会报 failed 而不是 skipped。
  test.skip(true, 'ENVIRONMENT_BLOCKED: 造不出「无 blocks 的旧 turn」—— 字符串 content 被读取器规范化成正文块，无内容的轮被 flushTurn 丢掉；I-115 的"连根都没有"这条路径在本产品下不可达');
});
