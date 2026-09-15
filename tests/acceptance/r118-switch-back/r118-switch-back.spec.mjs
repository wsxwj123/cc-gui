// r118 界面验收:回合进行中从会话 A 切到 B、再切回 A。
// 依据只有 .devflow/BRIEF-r118.md(R1–R5)与 .devflow/INTERFACE-r118.md(§A 文案 / §B 判定口径);
// 没看实现代码。只由 run.sh 调起:tests/acceptance/r118-switch-back/run.sh
//
// 竞态类用例(B1/R1、R3、停止按钮、R2、R4)各跑 3 轮,每轮换一条全新夹具会话,切走停留时长
// 逐轮变长(0.4s / 2s / 6s);每轮失败都被收集,最后一次性报出"3 轮里红几轮"。
// 每条夹具会话只在一个用例的一轮里用一次:回合跑完后应用会改会话标题,行文字会变,用完就不找它了。
import { test, expect } from '@playwright/test';
import { B, NAV, batch, extraBatch, live } from './helpers/fixtures.mjs';
import {
  assistantBlockCount, boot, clearSlowStart, composer, messageVisible, openSessionBySearch, readState,
  releaseAllRuns, releaseChunk2, releaseTurnEnd, sampleWindow, scanForText, sendPrompt, sessionRow,
  setSlowStart, switchTo, userBubbleCount, waitTurnRunning,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
const DWELL_MS = [400, 2_000, 6_000];       // 在 B 停留多久,逐轮变长
const ROUNDS = 3;
const WINDOW_MS = 6_000;                    // 切回后的观察窗(INTERFACE §B1 要求 ≥6 秒)
// 每个用例自己的一组会话(3 条 = 3 轮);B4/B3/B5 各用一条。
const GROUP = { B1: batch(0), MSG: batch(1), STOP: batch(2), B2: batch(3), R4: batch(4), TWO: batch(5), SLOW: batch(6), SLOW2: batch(7) };
// r118b 追加用例的会话池(单独一段,不动上面已有的分配)
const GROUP_X = { G1: extraBatch(0), G2: extraBatch(1), G3: extraBatch(2) };
// 追加用例的消息原文:比会话标题的截断长度(40 字)长,这样侧栏标题里不会出现完整原文,
// "别的会话页面上有没有这段话"就能用整页文字检索来判。
const longPrompt = (tag, i) => `R118 ${tag} 第${i + 1}轮:这条消息只属于这条会话,不该出现在别的会话的页面上。`;
// 夹具会话 B 正文里那句既有的助手回复(阳性对照用它确认"确实在看 B 的内容")。
const B_OWN_REPLY = '这是这条会话里已有的旧回复';
// 用户机器上挂了很多 MCP,会话进程要十几秒才吐第一条事件(界面一直"连接中…")。桩是秒开的,这里用
// slow-ms 控制文件把那段"请求已发出、界面上什么都还没吐"的窗口造出来。
const SLOW_MS = 20_000;

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
  clearSlowStart(CTL);
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

test('R3-慢启动 [R3/R1/R2] 进程还没吐第一条事件的窗口里切走再切回(3 轮)', async ({ page }) => {
  const results = await eachRound(page, GROUP.SLOW, 'SLOW', async (i, { sid, mark }, prompt) => {
    setSlowStart(CTL, SLOW_MS);
    await switchTo(page, mark);
    await sendPrompt(page, prompt);
    await page.waitForTimeout(1_000);
    expect(await messageVisible(page, prompt), '切走之前,刚发出的消息应先在界面上').toBe(true);

    await leaveToB(page);                       // 这一步发生在桩还没有任何输出的窗口里
    await page.waitForTimeout(3_000);
    await switchTo(page, mark);

    const deadline = Date.now() + WINDOW_MS;
    const samples = [];
    do {
      samples.push({ ...(await readState(page)), msg: await messageVisible(page, prompt) });
      if (Date.now() < deadline) await page.waitForTimeout(500);
    } while (Date.now() < deadline);

    clearSlowStart(CTL);                        // 桩现在开始吐字
    await expect(page.getByText(live.chunk1(sid, prompt), { exact: false }).first(),
      '桩吐出第一条事件后,这一轮的内容应照常显示').toBeVisible({ timeout: 30_000 });
    releaseChunk2(CTL, sid);
    await expect(page.getByText(live.chunk2(sid), { exact: false }).first(),
      '后续内容应照常继续追加').toBeVisible({ timeout: 20_000 });

    const missing = samples.filter((s) => !s.msg).length;
    const takeover = samples.filter((s) => s.takeover).length;
    const noStop = samples.filter((s) => !s.stops || !s.stopEnabled).length;
    const failed = [];
    if (missing) failed.push(`R3=✗(${missing}/${samples.length} 次采样里看不到刚发出的那条消息)`);
    if (takeover) failed.push(`R1=✗(${takeover}/${samples.length} 次采样出现"已在另一处查看")`);
    if (noStop) failed.push(`R1=✗(${noStop}/${samples.length} 次采样停止按钮不可用)`);
    if (failed.length) throw new Error(`${failed.join(' ')};其余检查通过`);
  });
  expectNoRed(results, 'R3-慢启动(进程静默窗口里切走再切回)');
});

test('B5-慢启动 [R3/B5] 静默窗口里切走、不回切,等它跑完再切回:历史完整', async ({ page }) => {
  const { sid, mark } = GROUP.SLOW2[0];
  const prompt = promptOf('B5SLOW', 0);
  setSlowStart(CTL, SLOW_MS);
  await switchTo(page, mark);
  await sendPrompt(page, prompt);
  await page.waitForTimeout(1_000);
  expect(await messageVisible(page, prompt), '切走之前,刚发出的消息应先在界面上').toBe(true);

  await leaveToB(page);                          // 切走就不回来了,这一轮在别处跑完
  await page.waitForTimeout(22_000);
  clearSlowStart(CTL);
  releaseChunk2(CTL, sid);
  releaseTurnEnd(CTL, sid);
  await expect.poll(() => page.getByText('运行中').count(), {
    message: '这一轮应在后台跑完(侧栏"运行中"标记消失)', timeout: 60_000, intervals: [1_000],
  }).toBe(0);

  await openSessionBySearch(page, prompt);       // 按消息内容找回这条会话(回合跑完后标题会变)
  const samples = await sampleWindow(page, { ms: 3_000, every: 1_000 });
  expect(samples.filter((s) => s.takeover).length, '切回后不该出现"已在另一处查看"').toBe(0);
  expect(await messageVisible(page, prompt), '切回来后用户那条消息应在历史里').toBe(true);
  expect(await messageVisible(page, live.final(sid)), '切回来后助手这条回复应在历史里').toBe(true);
});

// ===================== r118b 追加:跑完整轮之后的"计数"与"串会话" =====================
// 已有用例只覆盖到"切回来那一刻"(消息还在、停止按钮还在);下面三条问的是**整轮跑完之后**:
// 这条消息被画了几遍、别的会话页面上会不会瞄到它。

/**
 * 静默窗口的固定起手:慢启动 → 在 A 发一条消息 → 确认它先出现在界面上。
 * 返回后停在这句消息刚发出、会话进程还没吐任何事件的时刻。
 */
async function sendInSilentWindow(page, mark, prompt) {
  setSlowStart(CTL, SLOW_MS);
  await switchTo(page, mark);
  await sendPrompt(page, prompt);
  await page.waitForTimeout(1_000);
  const shown = await userBubbleCount(page, prompt);
  expect(shown, '切走之前,刚发出的消息应先在界面上(恰好一条)').toBe(1);
}

/** 放行整轮:等第一块 → 放行第二块 → 等第二块 → 收尾 → 等收尾。 */
async function runTurnToEnd(page, sid, prompt) {
  clearSlowStart(CTL);                 // 桩现在开始吐字
  await expect(page.locator('.markdown-content').filter({ hasText: live.chunk1(sid, prompt) }).first(),
    '桩吐出第一条事件后,这一轮的内容应照常显示').toBeVisible({ timeout: 40_000 });
  releaseChunk2(CTL, sid);
  await expect(page.locator('.markdown-content').filter({ hasText: live.chunk2(sid) }).first(),
    '后续内容应照常继续追加').toBeVisible({ timeout: 20_000 });
  releaseTurnEnd(CTL, sid);
  await expect(page.locator('.markdown-content').filter({ hasText: live.final(sid) }).first(),
    '这一轮应正常收尾').toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(1_500);    // 让收尾渲染落定
}

test('G1 静默窗口里切走再切回,整轮跑完后:这条消息恰好画一遍、助手三段各一遍(3 轮)', async ({ page }) => {
  const results = await eachRound(page, GROUP_X.G1, 'G1', async (i, { sid, mark }, _default) => {
    const prompt = longPrompt('G1', i);
    await sendInSilentWindow(page, mark, prompt);
    await leaveToB(page);
    await page.waitForTimeout(DWELL_MS[i]);
    await switchTo(page, mark);
    await runTurnToEnd(page, sid, prompt);

    // 同一句话只能画一遍:过一会儿再数第二次,防止"延迟又冒出来一块"
    for (const [n, extraWait] of [[1, 0], [2, 1_500]]) {
      if (extraWait) await page.waitForTimeout(extraWait);
      const n1 = await userBubbleCount(page, prompt);
      expect(n1, `整轮跑完后第 ${n} 次计数:这条用户消息被画了 ${n1} 遍(应当恰好 1 遍,0 遍 = 消息没了,2 遍 = 重复了)`).toBe(1);
      const total = await userBubbleCount(page, null);
      expect(total, `整轮跑完后第 ${n} 次计数:会话里共有 ${total} 条用户消息(应当是历史里那 1 条 + 本轮这 1 条)`).toBe(2);
      for (const [label, t] of [['第一块', live.chunk1(sid, prompt)], ['第二块', live.chunk2(sid)], ['收尾', live.final(sid)]]) {
        const c = await assistantBlockCount(page, t);
        expect(c, `整轮跑完后第 ${n} 次计数:助手${label}被画了 ${c} 遍(应当恰好 1 遍)`).toBe(1);
      }
    }
  });
  expectNoRed(results, 'G1(同一句话只画一遍)');
});

test('G2 静默窗口里切到另一个会话:那个会话页面上不该出现这条消息(3 轮)', async ({ page }) => {
  const results = await eachRound(page, GROUP_X.G2, 'G2', async (i, { sid, mark }, _default) => {
    const prompt = longPrompt('G2', i);
    await sendInSilentWindow(page, mark, prompt);

    await leaveToB(page);                       // 静默窗口里切到 B,并且停在 B
    // 阳性对照:先确认这一步确实在看 B 的页面内容(否则"看不到 A 的消息"可能只是因为页面是空的)
    await expect.poll(async () => (await scanForText(page, B_OWN_REPLY)).body, {
      message: 'B 的页面上应能看到它自己的旧回复(阳性对照:确认扫描确实在看 B 的内容)',
      timeout: 10_000, intervals: [500],
    }).toBe(true);

    const hits = [];
    for (let n = 0; n < 6; n += 1) {            // B 页面上反复看 3 秒
      const s = await scanForText(page, prompt);
      if (s.body || s.bubbles || s.leaves) hits.push({ 第几次采样: n + 1, ...s });
      await page.waitForTimeout(500);
    }
    expect(hits.length, `切到另一个会话后,6 次采样里有 ${hits.length} 次在它的页面上看到了 A 那条消息:${JSON.stringify(hits)}`).toBe(0);

    await switchTo(page, mark);                 // 再切回 A
    const back = await userBubbleCount(page, prompt);
    expect(back, `切回 A 后这条消息应还在且恰好一条(实际 ${back})`).toBe(1);

    await runTurnToEnd(page, sid, prompt);      // 把这一轮跑完,别把桩晾在那儿
    const after = await userBubbleCount(page, prompt);
    expect(after, `整轮跑完后,这条消息仍应恰好一条(实际 ${after})`).toBe(1);
  });
  expectNoRed(results, 'G2(消息不串会话)');
});

test('G3 静默窗口里切走再切回后点停止:不出现重复、不出现来源不明的第二条(3 轮)', async ({ page }) => {
  const results = await eachRound(page, GROUP_X.G3, 'G3', async (i, { sid, mark }, _default) => {
    const prompt = longPrompt('G3', i);
    await sendInSilentWindow(page, mark, prompt);
    await leaveToB(page);
    await page.waitForTimeout(DWELL_MS[i]);
    await switchTo(page, mark);

    const stop = page.getByRole('button', { name: /^停止/ });
    await expect(stop.first(), '切回后停止按钮应可用').toBeEnabled({ timeout: 15_000 });
    await stop.first().click();
    await page.waitForTimeout(2_000);

    // 停止之后放行桩:会话进程并不知道自己被停了,它可能继续往外吐 —— 界面不许因此多画一条用户消息
    clearSlowStart(CTL);
    releaseAllRuns(CTL);
    await page.waitForTimeout(10_000);

    const n1 = await userBubbleCount(page, prompt);
    expect(n1, `点停止并等这一轮收尾后,这条用户消息被画了 ${n1} 遍(应当恰好 1 遍)`).toBe(1);
    const total = await userBubbleCount(page, null);
    expect(total, `点停止并等这一轮收尾后,会话里共有 ${total} 条用户消息(应当是历史 1 条 + 本轮 1 条,没有来源不明的第二条)`).toBe(2);
  });
  expectNoRed(results, 'G3(静默窗口内点停止后不重复)');
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
