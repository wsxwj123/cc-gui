// R13 session flow in the UI: pane/session identity is stable, switching only detaches the
// observation, and late events from a left-behind run never reach the session on screen.
import { test, expect } from '@playwright/test';
import {
  closePane,
  ensurePaneCount,
  fixtureSection,
  getRuntime,
  messagesWithMarker,
  modelChoiceControl,
  pollMessages,
  openSessionInPane,
  paneBody,
  paneIdentity,
  paneLocator,
  recordRequests,
  requireField,
  requireModel,
  sendPrompt,
  startCuttableProxy,
  startSustainedRun,
  uniqueId,
  waitForSessionIdle,
  waitForText,
} from './helpers/sb-runtime.mjs';

const A_MARKER_KEY = 'sessionASearchMarker';
const B_MARKER_KEY = 'sessionBSearchMarker';

function flowSections() {
  const flow = fixtureSection('sessionFlow');
  return {
    flow,
    sessionAId: requireField(flow, 'sessionASid'),
    sessionBId: requireField(flow, 'sessionBSid'),
  };
}

/**
 * SB-T33 用：页面上**每一处**出现 `marker` 的文本落点，以及它是否落在「非聚焦会话完成
 * 提醒」浮条内部。判据在真机上核过（0.2.378）：浮条整条是一个原生 `<button>`（点它跳转到
 * 该会话），挂在 `position:fixed` 的悬浮层上（页面顶部居中，约 10 秒自动消失），且既不在
 * 任何窗格（`[data-pane-id]`）也不在任何消息卡（`[data-message-id]` / `message-card`）内。
 * 产品没给这条浮条公布 `data-testid`，这里只能靠结构 + 计算样式识别（见 README「产品测试钩子」）。
 * 返回逐条落点（而不是一个总数），红的时能直接从失败信息里看出泄漏到了哪个元素。
 */
async function markerPlacements(page, marker) {
  return await page.evaluate((needle) => {
    const describe = (el) => {
      const testid = el.getAttribute('data-testid');
      const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
      return `${el.tagName.toLowerCase()}${testid ? `[data-testid=${testid}]` : ''}${classes ? `.${classes}` : ''}`;
    };
    const floatsAbovePage = (el) => {
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).position === 'fixed') return true;
      }
      return false;
    };
    const placements = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || !node.nodeValue || !node.nodeValue.includes(needle)) continue;
      const chain = [];
      for (let n = element; n && n !== document.body && chain.length < 6; n = n.parentElement) chain.push(describe(n));
      const jumpButton = element.closest('button');
      placements.push({
        path: chain.join(' < '),
        inCompletionNotice: !!jumpButton
          && floatsAbovePage(jumpButton)
          && !element.closest('[data-pane-id], [data-message-id], [data-testid=message-card]'),
      });
    }
    return placements;
  }, marker);
}

test('SB-T28 打开的会话窗格公布 data-pane-id/data-owner-key，流动容器公布 data-generation', async ({ page }) => {
  const { flow, sessionAId } = flowSections();

  await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });
  const identity = await paneIdentity(page);

  expect(identity.panes.length, 'the active session must live in an identified pane').toBeGreaterThanOrEqual(1);
  const pane = identity.panes.find(item => item.ownerKey === sessionAId);
  expect(pane, `no pane owns session ${sessionAId}; observed ${JSON.stringify(identity.panes)}`).toBeTruthy();
  expect(pane.paneId, 'paneId is a stable non-secret identity').toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
  expect(identity.flows.length, 'the flowing content container must publish data-generation').toBeGreaterThanOrEqual(1);
  expect(
    identity.flows.some(item => typeof item.generation === 'string' && item.generation.length > 0),
    `a generation value must be observable; observed ${JSON.stringify(identity.flows)}`,
  ).toBe(true);
});

test('SB-T29 两个窗格：owner 各不相同，正文只出现在匹配 owner 的窗格里', async ({ page }) => {
  const { flow, sessionAId, sessionBId } = flowSections();

  await ensurePaneCount(page, 2);
  await openSessionInPane(page, flow, { paneIndex: 0, markerKey: A_MARKER_KEY });
  await openSessionInPane(page, flow, { paneIndex: 1, markerKey: B_MARKER_KEY });

  const identity = await paneIdentity(page);
  const owners = identity.panes.map(item => item.ownerKey);
  expect(new Set(owners).size, `pane owners must be distinct; observed ${JSON.stringify(owners)}`).toBe(2);
  expect(owners.slice().sort(), 'both fixture sessions must own a pane').toEqual([sessionAId, sessionBId].sort());

  // 正文 = 消息区：窗格标题栏也渲染会话标题（夹具标题含标记），按整窗格计数会数到标题那一处。
  const panes = paneLocator(page);
  await expect(paneBody(panes.nth(0)).getByText(flow[A_MARKER_KEY])).toHaveCount(1);
  await expect(paneBody(panes.nth(0)).getByText(flow[B_MARKER_KEY])).toHaveCount(0);
  await expect(paneBody(panes.nth(1)).getByText(flow[B_MARKER_KEY])).toHaveCount(1);
  await expect(paneBody(panes.nth(1)).getByText(flow[A_MARKER_KEY])).toHaveCount(0);
});

test('SB-T30 切 A→B：窗格 owner 变为 B，A 的正文不再出现在当前窗格', async ({ page }) => {
  const { flow, sessionAId, sessionBId } = flowSections();

  await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });
  await openSessionInPane(page, flow, { markerKey: B_MARKER_KEY });

  const identity = await paneIdentity(page);
  expect(identity.panes[0].ownerKey, `after switching the pane must own B (${sessionBId})`).toBe(sessionBId);
  expect(identity.panes[0].ownerKey).not.toBe(sessionAId);
  const panes = paneLocator(page);
  await expect(paneBody(panes.first()).getByText(flow[B_MARKER_KEY])).toHaveCount(1);
  // A 的正文不得留在任何窗格里。为什么限定到窗格正文（而不是页级 `page.getByText(A标记)`）：
  // 夹具会话 A 的**标题**就取自消息文本、含这个标记，侧栏会话行这类"标题面"会照常渲染它
  // （实测 0.2.379：切到 B 后页级还能数到 1 处，落点是 `span < div.sidebar-item`，不在任何
  // 窗格内）—— 页级计数红的是观察面，不是"正文留在窗格里"这个合同。正文 = 消息区
  // （合同公布 `data-message-id`，见 paneBody 注释）；逐窗格断言，哪个窗格漏了直接点名，
  // 也没有放宽成"最多一处"这类恒真写法。
  const paneTotal = await panes.count();
  expect(paneTotal, 'the switching pane must still be observable').toBeGreaterThanOrEqual(1);
  for (let index = 0; index < paneTotal; index += 1) {
    await expect(
      paneBody(panes.nth(index)).getByText(flow[A_MARKER_KEY]),
      `A's body text must not stay in any pane body (pane #${index} owns another session now)`,
    ).toHaveCount(0);
  }
});

test('SB-T31 三个窗格关闭最左窗格：剩余窗格的 paneId/ownerKey 原样保留', async ({ page }) => {
  const { flow } = flowSections();
  const flow2 = fixtureSection('sessionFlowThird');
  const thirdMarkerKey = 'sessionCSearchMarker';

  await ensurePaneCount(page, 3);
  await openSessionInPane(page, flow, { paneIndex: 0, markerKey: A_MARKER_KEY });
  await openSessionInPane(page, flow, { paneIndex: 1, markerKey: B_MARKER_KEY });
  await openSessionInPane(page, flow2, { paneIndex: 2, markerKey: thirdMarkerKey });

  const before = (await paneIdentity(page)).panes;
  expect(before.length, `three panes expected before closing; observed ${JSON.stringify(before)}`).toBe(3);

  await closePane(page, paneLocator(page).first());

  const after = (await paneIdentity(page)).panes;
  expect(after.length, 'closing the left pane leaves two panes').toBe(2);
  expect(after.map(item => item.paneId), 'remaining pane identities must not shift or be re-assigned').toEqual(before.slice(1).map(item => item.paneId));
  expect(after.map(item => item.ownerKey)).toEqual(before.slice(1).map(item => item.ownerKey));
});

test('SB-T32 新草稿绑定真实 sid 后：paneId 与 generation 不变，本轮消息仍在同一窗格', async ({ page }) => {
  requireModel();
  const { flow } = flowSections();
  const marker = uniqueId('SB_T32');
  await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });

  const draftButton = page.getByRole('button', { name: '新建会话', exact: true }).first();
  await draftButton.click();
  const before = await paneIdentity(page);
  const draftPane = before.panes[0];
  expect(draftPane, 'a draft must live in an identified pane').toBeTruthy();
  expect(typeof draftPane.generation, 'the draft pane must already publish its generation').toBe('string');
  expect(draftPane.generation.length).toBeGreaterThan(0);

  await sendPrompt(page, paneLocator(page).first(), `Reply with exactly: ${marker}`);

  await expect
    .poll(async () => (await paneIdentity(page)).panes[0]?.ownerKey, {
      message: 'after the first send, the pane must be bound to the real sessionId',
      timeout: 20_000,
    })
    .not.toBe(draftPane.ownerKey);
  const after = (await paneIdentity(page)).panes[0];

  expect(after.paneId, 'binding the real sid must not move the turn to another pane').toBe(draftPane.paneId);
  expect(after.generation, 'the same turn keeps its generation across draft→sid binding').toBe(draftPane.generation);
  await expect(paneLocator(page).first().getByText(marker), 'the pending message stays in its own pane').toBeVisible();
});

test('SB-T33 A 运行中切到 B：B 的正文与消息数不被 A 的迟到事件改动', async ({ page }) => {
  requireModel();
  const { flow } = flowSections();
  const marker = uniqueId('SB_T33');

  await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });
  await sendPrompt(page, paneLocator(page).first(), `Reply with exactly: ${marker}`);
  await openSessionInPane(page, flow, { markerKey: B_MARKER_KEY });

  const messageCountBefore = await page.getByTestId('message-card').count();
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(1_000);
    await expect(
      paneBody(paneLocator(page).first()).getByText(marker),
      'A\'s late stream must not write into B',
    ).toHaveCount(0);
    // 页级覆盖：A 的标记只允许出现在「非聚焦会话完成提醒」浮条内部。那条浮条是本批之前
    // 就有的产品功能（全局后台完成提醒：含会话标题与摘要、约 10 秒自动消失、点击跳转），
    // 独立于会话内容 —— 本用例不要求产品取消它；但标记出现在页面上任何**别的**位置
    // （B 的窗格、任何消息卡、任何本地完成气泡）都是泄漏，逐条落点断言。
    for (const placement of await markerPlacements(page, marker)) {
      expect(
        placement.inCompletionNotice,
        `A's marker appeared outside the completion notice: ${placement.path}`,
      ).toBe(true);
    }
    expect(await page.getByTestId('message-card').count(), 'B must not gain messages from A\'s run').toBe(messageCountBefore);
  }
  expect(
    await paneLocator(page).first().getByRole('button', { name: /^停止/ }).count(),
    'B must not inherit A\'s stop target',
  ).toBe(0);
});

test('SB-T34 切走再切回 A：恢复 A 自己的后台运行，或明确提示暂无可恢复运行', async ({ page }) => {
  requireModel();
  const { flow, sessionAId } = flowSections();
  const marker = uniqueId('SB_T34');

  await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });
  await sendPrompt(page, paneLocator(page).first(), `Reply with exactly: ${marker}`);
  await openSessionInPane(page, flow, { markerKey: B_MARKER_KEY });
  await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });

  const identity = await paneIdentity(page);
  expect(identity.panes[0].ownerKey, 'coming back must land on A again').toBe(sessionAId);
  await expect(page.getByText(flow[B_MARKER_KEY]), 'no other session may be substituted for A').toHaveCount(0);
  const pane = paneLocator(page).first();
  const hasRecovery = await pane.getByRole('button', { name: /^停止/ }).count();
  if (hasRecovery === 0) {
    const noRun = await page.getByText(/暂无可恢复运行/).count();
    const finished = await pane.getByText(marker).count();
    expect(noRun + finished, 'either the run is recoverable, or the UI says clearly there is nothing to recover').toBeGreaterThan(0);
  }
});

test('SB-T35 关闭 A 窗格只分离观察：不发 stop，A 的对话继续并完成', async ({ page, request }) => {
  requireModel();
  const { baseURL } = getRuntime();
  const { flow, sessionAId } = flowSections();
  const marker = uniqueId('SB_T35');
  const stopRequests = recordRequests(page);

  await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });
  await sendPrompt(page, paneLocator(page).first(), `Reply with exactly: ${marker}`);
  await closePane(page, paneLocator(page).first());
  await page.waitForTimeout(3_000);

  expect(stopRequests, 'closing a pane only detaches the view; it must never stop the run').toEqual([]);

  // the detached turn keeps working: prompt + real reply both land in A's history
  const messages = await pollMessages(
    request, baseURL, sessionAId, flow.sessionAProjectHash,
    body => messagesWithMarker(body, marker).length >= 2,
  );
  expect(
    messagesWithMarker(messages.body, marker).length,
    'the run detached by the pane close must still finish and write its reply to history',
  ).toBeGreaterThanOrEqual(2);
});

test('SB-T36 A 迟到事件不改 B 正在编辑的输入与模型选择', async ({ page }) => {
  requireModel();
  const { flow } = flowSections();
  const marker = uniqueId('SB_T36');
  const draft = `SB_T36_DRAFT_${marker}`;

  await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });
  await sendPrompt(page, paneLocator(page).first(), `Reply with exactly: ${marker}`);
  await openSessionInPane(page, flow, { markerKey: B_MARKER_KEY });

  const composer = page.getByRole('textbox', { name: /打开命令/ }).first();
  await composer.fill(draft);
  // 模型控件按控件自身的标签定位，不按模型名匹配（第三方 provider 下页面上没有
  // claude-/gpt- 字样的按钮，按名字找会直接超时）；断言语义不变：B 的模型选择不得被改。
  const modelControl = modelChoiceControl(page);
  const modelBefore = (await modelControl.innerText()).trim();

  for (let i = 0; i < 10; i += 1) {
    await page.waitForTimeout(1_000);
    expect(await composer.inputValue(), 'a late event from A must not touch B\'s composer').toBe(draft);
  }
  const modelAfter = (await modelControl.innerText()).trim();
  expect(modelAfter, 'A\'s model events must not overwrite B\'s model choice').toBe(modelBefore);
});

test('SB-T37 另一处查看同一运行：旧页面收到 takeover 提示且不夺回', async ({ page, context, request }) => {
  requireModel();
  const { baseURL } = getRuntime();
  const { flow, sessionAId } = flowSections();
  const marker = uniqueId('SB_T37');

  // 前置①：这一会话自己的回合必须先跑完（上一用例的长回合可能还在跑；再发会被服务端并进
  // 那次运行）。判据是应用自己的运行状态面，见 helpers/sb-runtime.mjs waitForSessionIdle。
  await waitForSessionIdle(request, baseURL, sessionAId);
  await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });
  // 前置②：被"另一处查看"的必须是【还在跑】的那次运行。原用法用的琐碎提示词 1–2s 就结束，
  // 第二页附着上去时运行早没了 —— 那时既没有接管事件也没有断线，红的不是产品。改成撑得住
  // 的长回合，并用公开钩子 data-run-id 确认运行此刻仍在（见 helpers/sb-runtime.mjs 顶部说明）。
  await startSustainedRun(page, paneLocator(page).first(), marker);

  const second = await context.newPage();
  await openSessionInPane(second, flow, { markerKey: A_MARKER_KEY });

  await waitForText(page, /此运行已在另一处查看/);
  await expect(page.getByText(/此运行已在另一处查看/).first()).toBeVisible();
  await page.waitForTimeout(3_000);
  await expect(page.getByText(/此运行已在另一处查看/).first(), 'the detached page must not steal the run back').toBeVisible();
  await second.close();
});

test('SB-T38 SSE 断线重连：显示连接中断提示，恢复后不重复消息', async ({ browser, request }) => {
  requireModel();
  const { flow, sessionAId } = flowSections();
  const marker = uniqueId('SB_T38');
  const { baseURL } = getRuntime();

  // 前置：先等这一会话自己的回合跑完（长回合还没结束就再发，会被服务端并进那次运行，
  // 见 helpers/sb-runtime.mjs waitForSessionIdle）。
  await waitForSessionIdle(request, baseURL, sessionAId);

  // 断线刺激走本套件自己的直通代理（页面经它访问被测实例）：offline = 真实切掉现有连接并在
  // 窗口内拒绝新连接，就是"网断了 2 秒再回来"。不用 context.setOffline —— 实测它切不断已经
  // 建立的 streaming fetch（证据：helpers/sb-runtime.mjs startCuttableProxy 注释）。
  const link = await startCuttableProxy(baseURL);
  const context = await browser.newContext({ baseURL: link.url });
  const page = await context.newPage();
  try {
    await openSessionInPane(page, flow, { markerKey: A_MARKER_KEY });
    // 前置：断线窗口必须落在这轮运行还活着的时候，否则测的是"运行早结束了"而不是断线恢复。
    await startSustainedRun(page, paneLocator(page).first(), marker);
    const idsBefore = await page.getByTestId('message-card').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-message-id')));

    await link.offline();
    await page.waitForTimeout(2_000);
    const offlineNotice = await page.getByText(/连接中断|正在恢复/).count();
    await link.restore();
    await page.waitForTimeout(4_000);

    const idsAfter = await page.getByTestId('message-card').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-message-id')));
    expect(new Set(idsAfter).size, 'reconnect must not duplicate the same message identity').toBe(idsAfter.length);
    expect(idsAfter.length, 'reconnect must not drop already-loaded messages').toBeGreaterThanOrEqual(idsBefore.length);
    if (idsBefore.length > 0) {
      // 刚发出的那条消息先是乐观气泡（chat-user-<时间戳>），服务端落盘后由真实 uuid 就地替换：
      // 同一条消息、同一个位置，这是唯一允许的身份变化；其余消息必须原 id、原序、一个不丢。
      const isOptimisticBubbleId = id => /^chat-user-\d+$/.test(String(id));
      for (let i = 0; i < idsBefore.length; i += 1) {
        if (idsAfter[i] === idsBefore[i]) continue;
        expect(
          isOptimisticBubbleId(idsBefore[i]),
          `already-loaded message #${i} changed identity: ${idsBefore[i]} → ${idsAfter[i]}`,
        ).toBe(true);
      }
    }
    expect(offlineNotice, 'the UI must announce the interruption or the recovery while it happens').toBeGreaterThan(0);
  } finally {
    await context.close().catch(() => {});
    await link.close();
  }
});
