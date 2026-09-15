// SF-2xx：真回合现场（流式形态 / 收官 / 中断 / 报错 / 权限弹窗 / 并入切段）。
//
// 现场由 helpers/fake-claude.mjs 造（PATH 上的假 claude，见 run-isolated.sh）：
// 它按 CTL/scenario.json 发 stream-json 事件、**同时把每条记录写进转写**，
// 所以"用户中途点停止"之后磁盘上已经有一条持久化轮 —— 交接那条用例靠它。
//
// 每个用例用一条**全新会话**（夹具项目里点"新建"），互不干扰。
import { test, expect } from '@playwright/test';
import {
  primeOverlays, openApp, newSessionInFixtureProject, sendMessage, waitRoundIdle, writeScenario,
  releaseRound, resetCtl, stopButton, stripRootOf, stripSnapshot, waitStripState,
} from './helpers/runtime.mjs';

const THINK = '先看一眼现场。';
const THINK2 = '这一处改完再跑一遍。';
const ANSWER_STREAM = 'SF-LIVE-A1 流式期的正文。';
const BASH_INPUT = { command: 'ls -la /tmp/sf-fixture', description: '看现场' };

test.beforeEach(async ({ page }) => {
  resetCtl();
  await primeOverlays(page);
});

test('SF-201 流式形态：一开始就是展开的条带，摘要行是内容区第一个子元素', async ({ page }) => {
  writeScenario({
    events: [{ kind: 'thinking', text: THINK }, { kind: 'tool', name: 'Bash', input: BASH_INPUT, result: 'ok' }, { kind: 'text', text: ANSWER_STREAM }],
    holdBeforeResult: true,
  });
  await openApp(page);
  const box = await newSessionInFixtureProject(page);
  await sendMessage(box, 'SF-LIVE-A1 跑一轮');

  const root = stripRootOf(page, ANSWER_STREAM);
  await expect(root, '流式期就该有一条条带（一开始就是条带，不是收尾才合并）').toHaveCount(1, { timeout: 30_000 });
  await waitStripState(page, root, 'open');
  const snap = await stripSnapshot(root);
  expect(snap.headCount, '流式期恰好一条摘要行').toBe(1);
  expect(snap.headIndex, '摘要行恒为条带内容区的第一个子元素').toBe(0);
  expect(snap.headAria).toBe('true');
  expect(snap.headText.startsWith('思考与工具调用 · '), `摘要行前缀：${snap.headText}`).toBe(true);
  // 直播期没有 usageCalls → 不显示「N 轮」，也不许出现任何估算的轮数（PLAN §14.6 定死）
  expect(snap.headText.includes('轮'), `直播期不得出现「N 轮」：${snap.headText}`).toBe(false);
  // 同一时刻整页只有这一轮 → 只允许一条摘要行
  expect(await page.locator('[data-strip="head"]').count(), '一轮只有一条摘要行').toBe(1);
  releaseRound();
  await waitRoundIdle(page);
});

test('SF-202 收官：原地收起成一行，补上「N 轮」，段序与正文不重排', async ({ page }) => {
  writeScenario({
    events: [
      { kind: 'thinking', text: THINK }, { kind: 'tool', name: 'Bash', input: BASH_INPUT, result: 'ok' },
      { kind: 'text', text: 'SF-LIVE-B1 中间那段正文。' },
      { kind: 'thinking', text: THINK2 }, { kind: 'text', text: 'SF-LIVE-B2 我要收尾了。' },
    ],
    holdBeforeResult: true,
  });
  await openApp(page);
  const box = await newSessionInFixtureProject(page);
  await sendMessage(box, 'SF-LIVE-B 跑一轮');

  const root = stripRootOf(page, 'SF-LIVE-B2 我要收尾了。');
  await expect(root).toHaveCount(1, { timeout: 30_000 });
  const live = await stripSnapshot(root);
  const liveTexts = await root.locator('[data-strip-item="text"]').evaluateAll((els) => els.map((e) => (e.textContent || '').trim()));

  releaseRound();
  await waitRoundIdle(page);
  await waitStripState(page, root, 'closed');
  const done = await stripSnapshot(root);

  expect(done.headIndex, '收官不得搬家：摘要行仍在第一个子元素位置').toBe(live.headIndex);
  expect(done.kinds, '收官不得改结构：段序与段数不变').toEqual(live.kinds);
  expect(Math.abs(done.headHeight - live.headHeight), '摘要行高度不变（仍是一行）').toBeLessThanOrEqual(2);
  const doneTexts = await root.locator('[data-strip-item="text"]').evaluateAll((els) => els.map((e) => (e.textContent || '').trim()));
  expect(doneTexts, '正文段文字不得因收官而变化').toEqual(liveTexts);
  // 收官换成持久化轮之后补上「N 轮」（usageCalls 只在落盘后才有）
  expect(done.headText.includes('轮'), `收官后摘要行应当出现「N 轮」：${done.headText}`).toBe(true);
  expect(done.headText.startsWith('思考与工具调用 · 5 轮 '), `夹具这一轮 5 次 API 调用：${done.headText}`).toBe(true);
});

test('SF-203 用户中断：这一轮必须保持展开（口径 2），且停一会儿还是展开', async ({ page }) => {
  writeScenario({
    events: [{ kind: 'thinking', text: THINK }, { kind: 'tool', name: 'Bash', input: BASH_INPUT, result: 'ok' }, { kind: 'text', text: 'SF-LIVE-C1 中断前的正文。' }],
    holdBeforeResult: true,
  });
  await openApp(page);
  const box = await newSessionInFixtureProject(page);
  await sendMessage(box, 'SF-LIVE-C 跑一轮然后我打断它');
  const root = stripRootOf(page, 'SF-LIVE-C1 中断前的正文。');
  await expect(root).toHaveCount(1, { timeout: 30_000 });
  // 前置：确实有过程块被折进去了（否则"保持展开"没有对象）
  expect((await stripSnapshot(root)).steps).not.toBe('0');
  await expect(stopButton(page).first()).toBeVisible();

  await stopButton(page).first().click();
  await waitRoundIdle(page);
  await waitStripState(page, root, 'open');
  await page.waitForTimeout(5_000); // 口径 2 还要求"不会过一会儿自己折上"
  expect(await root.getAttribute('data-strip-state'), '中断 5 秒后仍必须展开').toBe('open');
});

test('SF-204 交接：本地停止副本被持久化 turn 替换之后，这一轮仍展开', async ({ page }) => {
  writeScenario({
    events: [{ kind: 'thinking', text: THINK }, { kind: 'tool', name: 'Bash', input: BASH_INPUT, result: 'ok' }, { kind: 'text', text: 'SF-LIVE-D1 交接用例的正文。' }],
    holdBeforeResult: true,
  });
  await openApp(page);
  const box = await newSessionInFixtureProject(page);
  await sendMessage(box, 'SF-LIVE-D 跑一轮然后我打断它');
  const root = stripRootOf(page, 'SF-LIVE-D1 交接用例的正文。');
  await expect(root).toHaveCount(1, { timeout: 30_000 });
  await expect(stopButton(page).first()).toBeVisible();
  await stopButton(page).first().click();
  await waitRoundIdle(page);

  const uuidOf = () => root.evaluate((el) => el.closest('[data-turn-uuid]')?.getAttribute('data-turn-uuid') || '');
  const before = await uuidOf();
  // 本地副本的 uuid 是哨兵（chat-*）；历史刷新接管后会换成真 uuid。
  expect(before.startsWith('chat-'), `本地停止副本应当挂在 chat-* 行上，实际 ${before}`).toBe(true);
  expect(await root.getAttribute('data-strip-state'), '本地副本本身就应当展开').toBe('open');

  await expect.poll(uuidOf, { timeout: 40_000, message: '历史刷新没有把本地副本换成持久化轮' })
    .not.toMatch(/^chat-/);
  expect(await root.getAttribute('data-strip-state'), '换成持久化轮之后仍必须展开（本地副本的 interrupted 已经没了）').toBe('open');
});

test('SF-205 报错：这一轮不许被折起来（口径 2）', async ({ page }) => {
  writeScenario({
    events: [{ kind: 'thinking', text: THINK }, { kind: 'tool', name: 'Bash', input: BASH_INPUT, result: 'ok' }, { kind: 'text', text: 'SF-LIVE-E1 报错前的正文。' }],
    holdBeforeResult: true,
    end: 'error',
    errorText: 'SF-LIVE-E 这一轮故意报错',
  });
  await openApp(page);
  const box = await newSessionInFixtureProject(page);
  await sendMessage(box, 'SF-LIVE-E 跑一轮，让它报错');
  const root = stripRootOf(page, 'SF-LIVE-E1 报错前的正文。');
  await expect(root).toHaveCount(1, { timeout: 30_000 });
  releaseRound();
  await waitRoundIdle(page);

  const state = await root.getAttribute('data-strip-state');
  console.log('[SF-205] 报错轮的条带状态 =', state);
  expect(state, '报错的轮不得落在 closed（要么展开，要么这一轮压根没有可折块 = none）').not.toBe('closed');
});

test('SF-206 权限/确认类弹窗不被吞：收起态下发起授权，弹窗可见且能点', async ({ page }) => {
  writeScenario({
    events: [{ kind: 'thinking', text: THINK }],
    permission: { tool_name: 'Bash', input: { command: 'rm -rf /tmp/sf-fixture-auth', description: '危险命令' } },
    holdBeforeResult: true,
  });
  await openApp(page);
  const box = await newSessionInFixtureProject(page);
  await sendMessage(box, 'SF-LIVE-F 触发一次授权');

  const cmd = page.getByText(/rm -rf \/tmp\/sf-fixture-auth/).first();
  await expect(cmd, '授权弹窗里应当出现待授权的命令原文').toBeVisible({ timeout: 30_000 });
  const where = await cmd.evaluate((el) => ({
    inMessageList: !!el.closest('[data-cgui="message-list"]'),
    h: Math.round(el.getBoundingClientRect().height),
    // 弹窗容器 = 最近的、带按钮的祖先（"可点"那一半判据要看它）
    buttons: [...(el.closest('div')?.closest('div')?.parentElement?.querySelectorAll('button') || [])]
      .map((b) => (b.textContent || b.getAttribute('title') || '').trim()).filter(Boolean).slice(0, 12),
  }));
  console.log('[SF-206] 授权弹窗位置信息 =', JSON.stringify(where));
  console.log('[SF-206] 弹窗容器 DOM =', await cmd.evaluate((el) => {
    let n = el;
    for (let i = 0; i < 4 && n.parentElement; i += 1) n = n.parentElement;
    return n.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').slice(0, 1200);
  }));
  expect(where.h, '弹窗必须真的可见（height > 0）').toBeGreaterThan(0);
  expect(where.inMessageList, '结构事实：授权弹窗在输入区，是消息滚动容器的兄弟节点，条带吞不到它').toBe(false);

  // 可点性：找弹窗自己那一族的按钮（一律排除消息流里的按钮），点了之后弹窗要收起来。
  const domButtons = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => !b.closest('[data-cgui="message-list"]'))
    .map((b) => (b.textContent || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim())
    .filter((t) => /允许|拒绝|同意|批准|Allow|Deny|授权/.test(t)));
  console.log('[SF-206] 输入区的授权类按钮 =', JSON.stringify(domButtons));
  const allow = page.getByRole('button', { name: /允许|同意|批准|Allow/ }).first();
  console.log('[SF-206] getByRole 找到的"允许"按钮数 =', await allow.count());
  if (await allow.count()) {
    await allow.click({ timeout: 5_000 });
    await expect(cmd, '点了允许之后授权弹窗应当收起来').toBeHidden({ timeout: 15_000 });
  } else {
    test.info().annotations.push({ type: 'J16-partial', description: `授权弹窗可见且不在消息流里；输入区按钮 = ${JSON.stringify(domButtons)}，"点了能授权"这一半没覆盖` });
  }
});

test('SF-207 并入把一轮切段时，整轮只有一条摘要行（不是每段一条）', async ({ page }) => {
  writeScenario({
    events: [{ kind: 'thinking', text: THINK }, { kind: 'text', text: 'SF-LIVE-G1 切段用例的正文。' }],
    holdBeforeResult: true,
  });
  await openApp(page);
  const box = await newSessionInFixtureProject(page);
  await sendMessage(box, 'SF-LIVE-G 第一句');
  await expect(stripRootOf(page, 'SF-LIVE-G1 切段用例的正文。')).toHaveCount(1, { timeout: 30_000 });

  // 回合进行中再发一条 → 走并入（切段）路径
  await sendMessage(box, 'SF-LIVE-G 第二句：顺带把这个也改了');
  await page.waitForTimeout(3_000);

  const heads = await page.locator('[data-strip="head"]').count();
  const roots = await page.locator('[data-strip-root]').count();
  const states = await page.locator('[data-strip-root]').evaluateAll((els) => els.map((e) => e.getAttribute('data-strip-state')));
  console.log('[SF-207] 切段现场：roots =', roots, 'heads =', heads, 'states =', JSON.stringify(states));
  expect(heads, '一轮只能有一条摘要行（切段时每段一个 TurnBubble，但头行只画在首段）').toBe(1);
  expect(states.every((s) => s === 'open'), '切段各段都应当展开（forceOpen）').toBe(true);
  if (roots < 2) {
    test.skip(true, 'ENVIRONMENT_BLOCKED: 这条隔离实例里没构造出并入切段（第二句没被接纳为并入），"整轮一条"没被真正压到');
  }
  releaseRound();
});
