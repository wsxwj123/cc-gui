// SF-1xx：条带折叠的**静态形态**（历史轮）——结构、默认态、文案、折叠范围、边界。
//
// 观测面全部是 .devflow/INTERFACE-20260912-stripfold.md §D 的公开锚点：
//   [data-strip-root][data-strip-state|rounds|steps] / [data-strip="head"][aria-expanded][title]
//   / [data-strip-item="<kind>"][hidden]
import { test, expect } from '@playwright/test';
import { MARKER_A, MARKER_C, A, C } from './helpers/fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, turnRows, stripSnapshot, stripRootOf, disturbRerender,
} from './helpers/runtime.mjs';

test.beforeEach(async ({ page }) => { await primeOverlays(page); });

const HEAD_TITLE = '展开/收起这一轮的过程';

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
  const groupLabels = await page.getByText('思考 · 2 次工具调用', { exact: true }).count();
  expect(groupLabels, '主夹具每轮 2 个过程段折行（既有 WorkGroup 行为）').toBe(A.rounds * 2);
});

test('SF-101 收官态结构：每轮 1 条条带、默认收起、头行是按钮', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const rows = turnRows(page);
  await expect(rows).toHaveCount(A.rounds);

  for (let i = 0; i < A.rounds; i += 1) {
    const snap = await stripSnapshot(rows.nth(i));
    expect(snap.present, `第 ${i + 1} 轮应当有条带根 [data-strip-root]`).toBe(true);
    expect(snap.state, `第 ${i + 1} 轮正常完成 → 默认收起`).toBe('closed');
    expect(snap.headCount, `第 ${i + 1} 轮恰好一条摘要行（多一条就是把每段都画了）`).toBe(1);
    expect(snap.headAria, `收起态 aria-expanded 必须是 false`).toBe('false');
    expect(snap.headTitle).toBe(HEAD_TITLE);
  }
});

test('SF-102 摘要行文案逐字：N 轮 M 步 + 尾句', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const rows = turnRows(page);
  await expect(rows).toHaveCount(A.rounds);

  for (let i = 0; i < A.rounds; i += 1) {
    const snap = await stripSnapshot(rows.nth(i));
    expect(snap.headText, `第 ${i + 1} 轮摘要行必须逐字相等（夹具 A：9 轮 7 步 末句）`).toBe(A.headText);
    expect(snap.steps, 'data-strip-steps 是该轮被折块数').toBe(String(A.steps));
    expect(snap.rounds, 'data-strip-rounds 是 usageCalls 条数').toBe(String(A.callsPerRound));
  }
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

test('SF-104 收起态：可折段留在 DOM（不卸载）但真的不占位', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const rows = turnRows(page);
  await expect(rows).toHaveCount(A.rounds);

  for (let i = 0; i < A.rounds; i += 1) {
    const snap = await stripSnapshot(rows.nth(i));
    // 段序：group, text, group, text（一个不重排、一个不少）
    expect(snap.kinds, `第 ${i + 1} 轮的段序`).toEqual(A.segments);
    expect(snap.hiddenKinds, '收起态只有 group 段带 hidden').toEqual(['group', 'group']);
    const groupHeights = await rows.nth(i).locator('[data-strip-item="group"]')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(groupHeights, '可折段收起后高度必须为 0（真隐藏）').toEqual([0, 0]);
    expect(snap.itemTextLens.slice(0, 1)[0], '可折段的文字必须还在 DOM 里（hidden 不是卸载）').toBeGreaterThan(0);
  }
});

test('SF-105 展开/收起往返，且手动态不被无关重渲染打回', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const row = turnRows(page).first();
  await expect(row).toHaveCount(1);

  const closedSnap = await stripSnapshot(row);
  await row.locator('[data-strip="head"]').click();
  let snap = await stripSnapshot(row);
  expect(snap.state, '点摘要行之后应当展开').toBe('open');
  expect(snap.kinds.length, '展开后段一个不少（收起只是 hidden，不是卸载）').toBe(closedSnap.kinds.length);
  expect(snap.headAria).toBe('true');
  expect(snap.hiddenKinds, '展开态可折段不带 hidden').toEqual([]);
  const groupHeights = await row.locator('[data-strip-item="group"]')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(groupHeights.every((h) => h > 0), '展开后可折段应当真的占位').toBe(true);

  await disturbRerender(page);
  await disturbRerender(page);
  snap = await stripSnapshot(row);
  expect(snap.state, '两次无关重渲染之后，用户的展开态必须还在（坑 1 的等价验收）').toBe('open');

  await row.locator('[data-strip="head"]').click();
  snap = await stripSnapshot(row);
  expect(snap.state, '再点一次回到收起').toBe('closed');
  expect(snap.hiddenKinds).toEqual(['group', 'group']);
});

test('SF-106 展开记忆 = 不记忆：刷新重开同一会话后全部回到收起', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  await turnRows(page).first().locator('[data-strip="head"]').click();
  expect((await stripSnapshot(turnRows(page).first())).state).toBe('open');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openSessionByMarker(page, MARKER_A); // 产品刻意不自动打开上次会话，按真实路径重开
  const rows = turnRows(page);
  await expect(rows).toHaveCount(A.rounds);
  for (let i = 0; i < A.rounds; i += 1) {
    expect((await stripSnapshot(rows.nth(i))).state, `重开后第 ${i + 1} 轮应当是收起的（口径 6）`).toBe('closed');
  }
});

test('SF-107 折叠范围只含 group 段：Workflow / Task 卡在收起态仍可见（R114 行为防线）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_C);
  const wfRow = turnRows(page).filter({ hasText: C.workflowLabel }).first();
  const taskRow = turnRows(page).filter({ hasText: C.taskLabel }).first();
  await expect(wfRow).toHaveCount(1);
  await expect(taskRow).toHaveCount(1);

  for (const [label, row, kind] of [['Workflow', wfRow, 'workflow'], ['Task', taskRow, 'task']]) {
    const snap = await stripSnapshot(row);
    expect(snap.present, `${label} 那一轮应当有条带根`).toBe(true);
    expect(snap.kinds, `${label} 段的 kind 应当是 ${kind}`).toContain(kind);
    expect(snap.hiddenKinds, `${label} 段任何状态下都不得被折起来`).not.toContain(kind);
    const box = await row.locator(`[data-strip-item="${kind}"]`).first().boundingBox();
    expect(box && box.height > 0, `收起态下 ${label} 卡必须仍然占位可见（height > 0）`).toBe(true);
    const textLen = await row.locator(`[data-strip-item="${kind}"]`).first().evaluate((el) => (el.textContent || '').trim().length);
    expect(textLen, `${label} 卡里的文字必须还在`).toBeGreaterThan(0);
  }
});

/** §C.1 的 F1/F2 形态（本夹具每轮都有 usageCalls → 「N 轮 M 步」；尾段没有时不带第三段）。 */
const summaryHead = (rounds, steps, tail) => `思考与工具调用 · ${rounds} 轮 ${steps} 步${tail ? ` · ${tail}` : ''}`;

/**
 * SF-108 摘要尾句的清洗与取值。
 *
 * 〈2026-09-13 口径变更，用户拍板〉两处旧的锁定口径作废，换成 INTERFACE-20260912-stripfold §C.2 的现口径：
 *   ①「摘要尾句里的 markdown 记号原样保留」→ 改为**只剥配对的行内标记**（`**x**` / `` `x` `` / `~~x~~` / `*x*`
 *      等），零散与未闭合的一个不碰。理由：摘要行是纯文本，截断到 40 码点后未闭合的记号渲染也去不掉。
 *   ②「最后一块不是正文时取最后一条正文」（位置判据）→ 废除，改为**恒取最后一条思考；取不到就省略尾段**。
 *      理由：正文段在任何折叠态都可见，拿它当尾句 = 摘要行与下面那行正文逐字重复（用户截图实报）。
 * 这不是放宽：两处都改成**逐字全等**断言（原来只判子串），并补了零散/未闭合/末块是工具三组覆盖。
 */
test('SF-108 摘要尾句的清洗与取值（emoji 截断 / 空白折叠 / 只剥配对记号 / 恒取思考）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_C);
  const rows = turnRows(page);

  // ① 41 个 emoji：截断到 40 个码点 + 一个 `…`，不得劈开代理对
  const emojiRow = rows.filter({ hasText: '图看完了。' }).first();
  const emojiHead = (await stripSnapshot(emojiRow)).headText;
  expect(emojiHead, 'emoji 尾段应当是 40 个码点 + 省略号').toContain(C.emojiTail);
  const emojiTail = emojiHead.slice(emojiHead.lastIndexOf(' · ') + 3);
  expect([...emojiTail].length, '尾段按 Unicode 码点算应当是 41 个字符（40 + …）').toBe(41);

  // ② 换行 + 缩进 → 空白折叠成单个空格
  const messyRow = rows.filter({ hasText: '好了，见上。' }).first();
  expect((await stripSnapshot(messyRow)).headText, '空白必须折叠成单个空格').toContain(C.messyTailClean);

  // ③ 配对的行内记号被剥：`**粗**` / `` `码` `` / `~~删~~` / `*强*` 四种都要剥干净
  const mdRow = rows.filter({ hasText: '改完了，见上。' }).first();
  expect((await stripSnapshot(mdRow)).headText, '配对的行内记号必须被剥掉（粗体/行内码/删除线/斜体四种）')
    .toBe(summaryHead(2, 1, C.mdTailClean));

  // ④ 零散记号一个不许误伤：`foo_bar_baz`（下划线在标识符里）、`2*3*4`、`x**2 + y**2`（乘号算式）
  const scatteredRow = rows.filter({ hasText: '算式那一轮看完了。' }).first();
  expect((await stripSnapshot(scatteredRow)).headText, '零散记号必须原样留着（扫字符类会把真内容一起扫掉）')
    .toBe(summaryHead(2, 1, C.scatteredTail));

  // ④b `_*_` 夹在标识符里（`ANTHROPIC_DEFAULT_*_MODEL`）同样不许动
  const identRow = rows.filter({ hasText: '环境变量那一轮看完了。' }).first();
  expect((await stripSnapshot(identRow)).headText, '标识符里的 _*_ 不许当强调对剥掉')
    .toBe(summaryHead(2, 1, C.identTail));

  // ④c 未闭合的记号按字面量保留（CommonMark 语义如此；这里不做二次清理）
  const unclosedRow = rows.filter({ hasText: '未闭合那一轮看完了。' }).first();
  expect((await stripSnapshot(unclosedRow)).headText, '未闭合的记号必须原样保留')
    .toBe(summaryHead(2, 1, C.unclosedTail));

  // ⑤ 恒取最后一条思考（位置判据废除）：最后一块是**工具**时，尾段照样取那条思考
  const toolLastRow = rows.filter({ hasText: C.toolLastDoneText }).first();
  expect((await stripSnapshot(toolLastRow)).headText, '最后一块既不是正文也不是思考时，尾段仍取最后一条思考')
    .toBe(summaryHead(3, 2, C.toolLastThink));

  // ⑥ 取不到思考 → 省略尾段（**不回落取正文**：旧口径的"取最后一条正文"已废除）。
  //    这一轮 = [正文, 工具]：正文段照常可见，但摘要行不得把那句正文当尾句（那是逐字重复的来源）。
  const noThinkRow = rows.filter({ hasText: C.onlyTextTail }).first();
  expect((await stripSnapshot(noThinkRow)).headText, '没有思考时省略尾段，不许回落取正文')
    .toBe(summaryHead(2, 1, null));
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

test('SF-111 摘要行恒 1 行、不横向溢出（极窄 900 / 极宽 1600 两档）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const head = turnRows(page).first().locator('[data-strip="head"]');
  await expect(head).toHaveCount(1);

  const measure = async () => await head.evaluate((el) => ({
    h: Math.round(el.getBoundingClientRect().height),
    overflow: el.scrollWidth - el.clientWidth,
  }));
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(400);
  const narrow = await measure();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(400);
  const wide = await measure();
  console.log('[SF-111] 摘要行高度 窄档', narrow, '宽档', wide);
  expect(Math.abs(narrow.h - wide.h), '两档宽度下摘要行高度必须一样（恒 1 行）').toBeLessThanOrEqual(2);
  expect(narrow.overflow, '摘要行不得横向溢出').toBeLessThanOrEqual(1);
  expect(wide.overflow, '摘要行不得横向溢出（宽档）').toBeLessThanOrEqual(1);
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
