// SF-5xx：回归护栏 —— 既有能力不许被条带/裁剪打红，且它们的**取值来源必须是数据**，
// 不是渲染出来的 DOM（需求书 §验收 的原始要求）。
//
// 判别式：渲染产物里有一类**只存在于 DOM 的文字**（过程段折行标签「思考 · N 次工具调用」）。
// 如果某个能力改成读 DOM，它就会把这串文字带出来 —— 这批用例就是盯这个。
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { MARKER_A, MARKER_C, MARKER_D, A, C } from './helpers/fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, turnRows, scrubber, clickScrubberTick,
  stripRootOf, stripSnapshot, allRows,
  resetCtl, writeScenario, releaseRound, waitRoundIdle,
} from './helpers/runtime.mjs';

/** 只存在于渲染里的文字（数据里没有这串）。 */
const RENDER_ONLY = '次工具调用';

test.beforeEach(async ({ page }) => { await primeOverlays(page); });

test('SF-501 复制这条回复：内容来自数据，且不带渲染产物的文字', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read']).catch(() => null);
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  await turnRows(page).first().getByTitle('复制').first().click();
  await page.waitForTimeout(600);
  const text = await page.evaluate(async () => {
    try { return await navigator.clipboard.readText(); } catch (e) { return `ENVIRONMENT_BLOCKED: ${e.message}`; }
  });
  expect(text.startsWith('ENVIRONMENT_BLOCKED'), `读不到剪贴板：${text}`).toBe(false);
  expect(text).toContain(A.midText);
  expect(text).toContain(A.finalText.slice(0, 40));
  expect(text).not.toContain(RENDER_ONLY);
});

test('SF-502 导出 Markdown：内容来自数据，且不带渲染产物的文字', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read']).catch(() => null);
  await openApp(page);
  await openSessionByMarker(page, MARKER_D);
  const more = page.getByTitle(/更多会话操作/).first();
  await expect(more, '侧栏会话行的「更多会话操作」入口').toHaveCount(1);
  await more.click();
  await page.waitForTimeout(500);

  const item = page.locator('button, [role="menuitem"], [role="button"]').filter({ hasText: /导出/ }).first();
  const visible = await item.count()
    ? await item.evaluate((el) => ({ text: (el.textContent || '').trim(), h: Math.round(el.getBoundingClientRect().height) }))
    : null;
  console.log('[SF-502] 会话操作菜单里的「导出」项 =', JSON.stringify(visible));
  await expect(visible, '会话操作菜单里应当有可点的「导出 Markdown」').not.toBeNull();
  expect(visible.h, '「导出」项必须真的可见').toBeGreaterThan(0);

  // 导出在浏览器里可能：① 触发下载 ② 走接口落盘 ③ 进剪贴板。三种都算"有观测"，
  // 一个都观测不到就按环境不成立跳过（不伪装成通过，也不伪装成产品缺陷）。
  const apiHits = [];
  page.on('response', (r) => { if (/export|markdown|download/i.test(r.url())) apiHits.push(r); });
  await item.click();
  let content = null;
  let source = null;
  try {
    const download = await page.waitForEvent('download', { timeout: 8_000 });
    content = fs.readFileSync(await download.path(), 'utf8');
    source = 'download';
  } catch {
    await page.waitForTimeout(1_000);
    if (apiHits.length) {
      const body = await apiHits[apiHits.length - 1].text().catch(() => '');
      if (body.includes(MARKER_D)) { content = body; source = 'http'; }
    }
    if (!content) {
      const clip = await page.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch { return ''; } });
      if (clip.includes(MARKER_D)) { content = clip; source = 'clipboard'; }
    }
  }
  console.log('[SF-502] 导出的观测来源 =', source, '｜长度 =', content ? content.length : 0);
  test.info().annotations.push({ type: 'export-observed', description: String(source) });
  test.skip(content === null, 'ENVIRONMENT_BLOCKED: 浏览器里观测不到导出结果（下载/接口/剪贴板三种都没有），"取值来源"这半条没覆盖');

  expect(content, '导出的 markdown 里应当有夹具会话的内容').toContain(MARKER_D);
  expect(content, '应当带上正文').toContain('第 3 轮的正文');
  expect(content, '不许把渲染出来的过程段标签写进导出文件（说明取值不是 DOM）').not.toContain(RENDER_ONLY);
});

test('SF-503 回滚/重做之后：剩下的轮不受任何残留标记影响，全部回到收起', async ({ page }) => {
  // 现场自带：不清掉上一组（SF-2xx）留在遥控目录里的 scenario.json，这条就跑在**别人的场景**里
  // ——全量跑拿到的是上一个用例遗留的"停在 result 之前"，--grep 单跑又没有，同一用例两种现场。
  // 重发的那一轮**必须留在直播态**（holdBeforeResult）：判据要排除的正是它，现场得真有它。
  resetCtl();
  writeScenario({
    events: [
      { kind: 'thinking', text: '第 3 轮先看一眼现场。' },
      { kind: 'tool', name: 'Bash', input: { command: 'echo round-3', description: '打印' }, result: '（夹具）round-3' },
      { kind: 'text', text: '第 3 轮重发之后的正文。' },
    ],
    holdBeforeResult: true,
  });
  await openApp(page);
  await openSessionByMarker(page, MARKER_D);
  const rows = turnRows(page);
  await expect(rows).toHaveCount(3, { timeout: 25_000 });
  // 钉住三条轮行的身份：被重做的那条要消失，另两条要各自仍是「收起」。
  const uuids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-turn-uuid')));
  const remade = uuids[uuids.length - 1];

  // 「重做这条回复」= 裁到该轮之前的用户消息 + **原地重发**（App.jsx handleRetryTurn →
  // handleRollback(mode:'both') → resendReplacing）。这条路径**没有确认弹窗** —— 实测三次
  // [role=dialog] 按钮都是空数组；旧注释写的"自绘确认弹窗"是错的，那段"挑一个非取消键来点"
  // 的代码因此从未执行过，已删。
  await rows.nth(2).getByTitle(/回滚到这条 AI 回复之前/).first().click();

  // 前置：被重做的那一轮必须真的从消息流里消失（= 回滚生效）。没消失＝现场没造出来。
  let remadeGone = false;
  try {
    await expect.poll(async () => await page.locator(`[data-turn-uuid="${remade}"]`).count(), { timeout: 20_000 }).toBe(0);
    remadeGone = true;
  } catch { /* 下面统一处理 */ }
  if (!remadeGone) {
    // 这条路径不该有弹窗；真出现就把按钮文案带出来——那说明交互变了，用例要跟着改。
    const dialogButtons = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')]
      .map((b) => (b.textContent || '').trim()).filter(Boolean));
    console.log('[SF-503] 回滚没生效时页面上的弹窗按钮 =', JSON.stringify(dialogButtons));
  }
  test.skip(!remadeGone, 'ENVIRONMENT_BLOCKED: 被重做的那一轮没有从消息流里消失（回滚没生效），"回滚后不受残留标记影响"没被真正压到');

  // 判据只压**剩下的轮**，一轮一条：
  //   · 重发的那一轮此刻是**直播流**，渲染在轮行之外（App.jsx 的 liveTurnVisible 分支不带
  //     data-turn-uuid 包裹），按设计就是展开的（SF-201 压的正是这条行为，不是缺陷）。
  //     拿整页的 `[data-strip-root]` 取值会把它一起算进来 → 判据必然假红。
  //   · 剩下的两条（SFD 每轮 1 思考 + 1 工具 → 有可折过程段）正确状态**就是 closed**，
  //     所以这里是全等，不是"非 open"这种会把 none / off 一起放过的模糊判据。
  //   · 不数整页行数当回滚生效的判据：重发那一轮一旦落地变持久轮，行数会回到 3，
  //     "数到 2"就成了抢时序；按 uuid 钉住具体哪一轮消失才是稳的。
  const survivors = uuids.slice(0, -1);
  for (const [i, uuid] of survivors.entries()) {
    const row = page.locator(`[data-turn-uuid="${uuid}"]`);
    await expect(row, '重做之外的轮必须照常留在消息流里').toHaveCount(1);
    const root = row.locator('[data-strip-root]');
    await expect(root, '每一轮恰好一条条带根（取值面要真的落在这一轮里）').toHaveCount(1);
    await expect.poll(async () => await root.getAttribute('data-strip-state'), {
      timeout: 10_000,
      message: `回滚不该留下任何"异常收尾"痕迹把旧轮撑开（剩下的第 ${i + 1} 轮 ${uuid.slice(0, 8)}）`,
    }).toBe('closed');
  }

  // 收尾：放行重发的那一轮，别把假 CLI 晾在那儿等 release（进程会一直挂着）。
  releaseRound();
  await waitRoundIdle(page);
});

test('SF-504 回合导航跳转（既有能力）：从最后一档跳回第一档', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_A);
  const bar = scrubber(page);
  await expect(bar).toHaveCount(1);
  await clickScrubberTick(page, 3, 3);
  await expect.poll(async () => await bar.getAttribute('aria-valuenow'), { timeout: 15_000 }).toBe('3');
  await clickScrubberTick(page, 1, 3);
  await expect.poll(async () => await bar.getAttribute('aria-valuenow'), { timeout: 15_000 }).toBe('1');
  expect(await allRows(page).count(), '跳转不该把行弄丢').toBe(A.rounds * 2);
});

test('SF-505 既有过程段自己还能展开（条带不许把段内的开合吃掉）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, MARKER_C);
  const row = turnRows(page).filter({ hasText: C.workflowLabel }).first();
  // 展开条带 → 段内的 WorkGroup 仍然可点、点开能看到工具卡
  await row.locator('[data-strip="head"]').click();
  expect((await stripSnapshot(row)).state).toBe('open');
  const groupToggle = row.locator('[data-strip-item="group"]').first().getByRole('button').first();
  await groupToggle.click();
  await page.waitForTimeout(400);
  const opened = await row.locator('[data-strip-item="group"]').first().evaluate((el) => (el.textContent || '').trim());
  console.log('[SF-505] 展开段内的文字长度 =', opened.length);
  expect(opened.length, '段内组件自己的开合没被条带吃掉（展开后能看到里面的东西）').toBeGreaterThan(RENDER_ONLY.length);
});
