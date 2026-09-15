// r118 界面验收:回合进行中从会话 A 切到 B、再切回 A。
// 依据只有 .devflow/BRIEF-r118.md(R1–R5)与 .devflow/INTERFACE-r118.md(§A 文案 / §B 判定口径);
// 没看实现代码。只由 run.sh 调起:tests/acceptance/r118-switch-back/run.sh
//
// 竞态类用例(B1/R1、R3、停止按钮、R2、R4)各跑 3 轮,每轮换一条全新夹具会话,切走停留时长
// 逐轮变长(0.4s / 2s / 6s);每轮失败都被收集,最后一次性报出"3 轮里红几轮"。
// 每条夹具会话只在一个用例的一轮里用一次:回合跑完后应用会改会话标题,行文字会变,用完就不找它了。
import { test, expect } from '@playwright/test';
import { B, NAV, batch, live } from './helpers/fixtures.mjs';
import {
  boot, composer, messageVisible, openSessionBySearch, releaseAllRuns, releaseChunk2, releaseTurnEnd,
  sampleWindow, sendPrompt, sessionRow, switchTo, waitTurnRunning,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
const DWELL_MS = [400, 2_000, 6_000];       // 在 B 停留多久,逐轮变长
const ROUNDS = 3;
const WINDOW_MS = 6_000;                    // 切回后的观察窗(INTERFACE §B1 要求 ≥6 秒)
// 每个用例自己的一组会话(3 条 = 3 轮);B4/B3/B5 各用一条。
const GROUP = { B1: batch(0), MSG: batch(1), STOP: batch(2), B2: batch(3), R4: batch(4), TWO: batch(5) };

const promptOf = (tag, i) => `R118 ${tag} 第${i + 1}轮`;

/** 逐轮跑,单轮失败不打断后面的轮次,最后一起报出来(看的是"几轮里红几轮")。 */
async function eachRound(page, group, tag, body) {
  const results = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const { sid, mark } = group[i];
    const prompt = promptOf(tag, i);
    try {
      await body(i, { sid, mark }, prompt);
      results.push(`第${i + 1}轮 PASS`);
    } catch (error) {
      results.push(`第${i + 1}轮 FAIL: ${String(error.message).split('\n')[0]}`);
    } finally {
      releaseChunk2(CTL, sid);              // 别把假 CLI 晾在停住的回合里
      releaseTurnEnd(CTL, sid);
      await page.waitForTimeout(1_000);
    }
  }
  return results;
}

function expectNoRed(results, label) {
  const bad = results.filter((r) => r.includes('FAIL'));
  expect(bad, `${label}:${results.length} 轮里红 ${bad.length} 轮 —— ${results.join(' | ')}`).toEqual([]);
  console.log(`[r118] ${label} 复现稳定性:${results.join(' | ')}`);
}

/** 开一条会话 → 发消息 → 等这一轮跑起来(有第一块文字 + 可用停止按钮)。 */
async function startTurn(page, mark, sid, prompt) {
  await switchTo(page, mark);
  await sendPrompt(page, prompt);
  await waitTurnRunning(page, sid, prompt);
}

/** 回合进行中切到别的会话 B;再 switchTo 切回来。 */
const leaveToB = (page) => switchTo(page, B.mark);

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);   // 打开一次,夹具项目与它的会话才进侧栏
  await expect(sessionRow(page, B.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  releaseAllRuns(CTL);   // 放行本用例里所有还停着的回合(含运行时新建的会话)
});

test('B1 [R1] 回合中切走再切回:不出现"已在另一处查看"(3 轮)', async ({ page }) => {
  const results = await eachRound(page, GROUP.B1, 'B1', async (i, { sid, mark }, prompt) => {
    await startTurn(page, mark, sid, prompt);
    await leaveToB(page);
    await page.waitForTimeout(DWELL_MS[i]);
    await switchTo(page, mark);
    const samples = await sampleWindow(page, { ms: WINDOW_MS, every: 500 });
    const bad = samples.filter((s) => s.takeover);
    expect(bad.length, `切回后 ${samples.length} 次采样里有 ${bad.length} 次出现"此运行已在另一处查看"`).toBe(0);
  });
  expectNoRed(results, 'B1(不出现被接管提示)');
});

test('B1-消息 [R3] 切回后,刚发出的那条消息仍在正文里(3 轮)', async ({ page }) => {
  const results = await eachRound(page, GROUP.MSG, 'R3', async (i, { sid, mark }, prompt) => {
    await startTurn(page, mark, sid, prompt);
    await leaveToB(page);
    await page.waitForTimeout(DWELL_MS[i]);
    await switchTo(page, mark);
    const deadline = Date.now() + WINDOW_MS;
    let round = 0;
    do {
      round += 1;
      expect(await messageVisible(page, prompt),
        `切回后第 ${round} 次采样:正文里找不到刚发出的消息「${prompt}」`).toBe(true);
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(1_000);
    } while (true);
  });
  expectNoRed(results, 'R3(刚发的消息仍可见)');
});

test('B1-停止 [R1] 切回后停止按钮仍可用(3 轮)', async ({ page }) => {
  const results = await eachRound(page, GROUP.STOP, 'R1STOP', async (i, { sid, mark }, prompt) => {
    await startTurn(page, mark, sid, prompt);
    await leaveToB(page);
    await page.waitForTimeout(DWELL_MS[i]);
    await switchTo(page, mark);
    const samples = await sampleWindow(page, { ms: WINDOW_MS, every: 500 });
    for (const [n, s] of samples.entries()) {
      expect(s.stops, `观察窗第 ${n + 1} 次采样:切回后界面应仍认为这一轮在跑(停止按钮消失)`).toBeGreaterThan(0);
      expect(s.stopEnabled, `观察窗第 ${n + 1} 次采样:停止按钮应可用`).toBe(true);
    }
  });
  expectNoRed(results, 'R1(停止按钮仍可用)');
});

test('B2 [R2] 切回后这一轮继续吐字,且不需要重新发送(3 轮)', async ({ page }) => {
  const chatPosts = [];
  page.on('request', (r) => {
    try { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/chat') chatPosts.push(Date.now()); } catch { /* 忽略 */ }
  });
  const results = await eachRound(page, GROUP.B2, 'B2', async (i, { sid, mark }, prompt) => {
    await startTurn(page, mark, sid, prompt);
    await leaveToB(page);
    await page.waitForTimeout(DWELL_MS[i]);
    await switchTo(page, mark);
    await page.waitForTimeout(1_000);
    const postsBefore = chatPosts.length;      // 切回之后用户没有再发任何消息
    releaseChunk2(CTL, sid);                   // 假 CLI 现在才吐第二块
    await expect(page.getByText(live.chunk2(sid), { exact: false }).first(),
      '切回后这一轮继续产出的内容应出现在正文里(不需要重发/刷新)').toBeVisible({ timeout: 20_000 });
    expect(chatPosts.length, '内容应自己续上,不该在切回后自动补发一条新消息').toBe(postsBefore);
  });
  expectNoRed(results, 'B2(切回后内容继续追加)');
});

test('R4 [R4] 切回并接上实时内容后,后台横幅不出现(3 轮)', async ({ page }) => {
  const results = await eachRound(page, GROUP.R4, 'R4', async (i, { sid, mark }, prompt) => {
    await startTurn(page, mark, sid, prompt);
    await leaveToB(page);
    await page.waitForTimeout(DWELL_MS[i]);
    await switchTo(page, mark);
    const samples = await sampleWindow(page, { ms: WINDOW_MS, every: 500 });
    const bad = samples.filter((s) => s.banner);
    expect(bad.length, `切回后 ${samples.length} 次采样里有 ${bad.length} 次出现"这个会话仍在后台工作中"横幅`).toBe(0);
  });
  expectNoRed(results, 'R4(接上实时内容后横幅不出现)');
});

test('B4 [反向守卫] 真接不上时(另一处接管了这一轮),后台横幅照常出现', async ({ page, context }) => {
  const { sid, mark } = GROUP.TWO[0];
  const prompt = promptOf('B4', 0);
  await startTurn(page, mark, sid, prompt);

  // 第二个观察者:同一窗口另开一页,打开同一条会话
  const second = await context.newPage();
  await boot(second);
  await openSessionBySearch(second, mark);
  await expect(sessionRow(second, B.mark), '第二页也应进到夹具项目').toBeVisible({ timeout: 20_000 });

  // 谁被顶掉:先出现"已在另一处查看"的那一页就是接不上的一方
  let loser = null;
  const deadline = Date.now() + 20_000;
  while (!loser && Date.now() < deadline) {
    if ((await sampleWindow(page, { ms: 500, every: 500 })).some((s) => s.takeover)) loser = page;
    else if ((await sampleWindow(second, { ms: 500, every: 500 })).some((s) => s.takeover)) loser = second;
  }
  expect(loser, '真有两个观察者时,被顶掉的一方应显示"此运行已在另一处查看"(否则就是被修成了"永不报接管")').not.toBeNull();

  const samples = await sampleWindow(loser, { ms: 8_000, every: 1_000 });
  const withBanner = samples.filter((s) => s.banner);
  expect(withBanner.length, `接不上的一页在 ${samples.length} 次采样里都没出现后台横幅(否则就是被修成了"横幅永不出现")`).toBeGreaterThan(0);
  await second.close();
});

test('B3 [反向守卫/R5] 真有两个观察者时,接管提示只出现在一方且不来回夺回', async ({ page, context }) => {
  const { sid, mark } = GROUP.TWO[1];
  const prompt = promptOf('B3', 0);
  await startTurn(page, mark, sid, prompt);

  const second = await context.newPage();
  await boot(second);
  await openSessionBySearch(second, mark);
  await expect(sessionRow(second, B.mark), '第二页也应进到夹具项目').toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(4_000);   // 让接管判定落定

  const aSide = (await sampleWindow(page, { ms: 6_000, every: 1_000 })).filter((s) => s.takeover).length;
  const bSide = (await sampleWindow(second, { ms: 6_000, every: 1_000 })).filter((s) => s.takeover).length;
  expect(Number(aSide > 0) + Number(bSide > 0),
    '真有两个观察者时,应恰好有一方看到"此运行已在另一处查看"(两方都没有 = 被修成了"永不报接管";'
    + `两侧都有 = 两边互相顶) —— 实测第一页 ${aSide}/7 次、第二页 ${bSide}/7 次`).toBe(1);
  expect(Math.min(aSide, bSide), '接管提示应稳定留在同一方,不能两边来回夺回').toBe(0);

  // 运行只被一方实时消费:放行第二块后,持有运行的那一页能看到它
  const holder = aSide > 0 ? second : page;
  releaseChunk2(CTL, sid);
  await expect(holder.getByText(live.chunk2(sid), { exact: false }).first(),
    '没被顶掉的那一页应继续收到这一轮的新内容').toBeVisible({ timeout: 20_000 });
  await second.close();
});

test('B1-新建会话 [R1/R3] 在刚新建的会话里发第一条,回合中切走再切回', async ({ page }) => {
  const prompt = 'R118 新建会话 第一条';
  await page.getByRole('button', { name: '新建会话' }).first().click();
  await page.waitForTimeout(1_000);
  await sendPrompt(page, prompt);
  await expect(page.getByText('R118-CHUNK1', { exact: false }).first(), '新会话这一轮应跑起来').toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^停止/ }), '回合进行中应有可用的停止按钮').toBeEnabled({ timeout: 10_000 });

  await leaveToB(page);
  await page.waitForTimeout(2_000);
  const row = page.locator('[role=button].sidebar-item').filter({ hasText: prompt }).first();
  await expect(row, '侧栏里应能看到刚新建的这条会话').toBeVisible({ timeout: 15_000 });
  await row.click();
  // 切回后必须重新接上这一轮(3 秒内停止按钮得回来),再要求它整段窗口里一直在
  await expect(page.getByRole('button', { name: /^停止/ }), '切回新建的会话后,界面应重新接上这一轮')
    .toBeEnabled({ timeout: 3_000 });
  await page.waitForTimeout(500);

  const samples = await sampleWindow(page, { ms: WINDOW_MS, every: 500 });
  const bad = samples.filter((s) => s.takeover || s.banner);
  expect(bad.length, `切回新建会话后 ${samples.length} 次采样里有 ${bad.length} 次出现接管提示或后台横幅`).toBe(0);
  expect(samples.every((s) => s.stops > 0), '切回后界面应仍认为这一轮在跑(停止按钮消失)').toBe(true);
  expect(await messageVisible(page, prompt), '切回后刚发出的第一条消息应还在正文里').toBe(true);
});

test('B5 [回归] 回合结束后切走再切回:历史完整,且不出现接管提示', async ({ page }) => {
  const { sid, mark } = GROUP.TWO[2];
  const prompt = promptOf('B5', 0);
  await startTurn(page, mark, sid, prompt);
  releaseChunk2(CTL, sid);
  releaseTurnEnd(CTL, sid);
  await expect(page.getByText(live.final(sid), { exact: false }).first(), '这一轮应正常收尾').toBeVisible({ timeout: 25_000 });

  await leaveToB(page);
  await page.waitForTimeout(1_500);
  await switchTo(page, mark);
  const samples = await sampleWindow(page, { ms: 4_000, every: 1_000 });
  const bad = samples.filter((s) => s.takeover);
  expect(bad.length, `回合结束后切走再切回,不该出现"已在另一处查看"(${bad.length}/${samples.length} 次)`).toBe(0);
  expect(await messageVisible(page, prompt), '切回来后用户那条消息应在历史里').toBe(true);
  expect(await messageVisible(page, live.final(sid)), '切回来后助手这条回复应在历史里').toBe(true);
});
