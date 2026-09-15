// R11 监控定位母会话 + R12 子代理历史/视图状态：身份来自 (parentSessionId, toolUseId)，
// 与 pane 位置、模型名无关；迟到的历史响应不得把运行中的源代理说成已完成。
import { test, expect } from '@playwright/test';
import {
  agentViewLocator,
  closePane,
  ensurePaneCount,
  expectJsonError,
  fixtureSection,
  getRuntime,
  openAgentViewFromMonitor,
  openFixtureSession,
  openMonitorPanel,
  openSessionInPane,
  paneIdentity,
  paneLocator,
  postAgentStop,
  readMessages,
  requireAgentRunLive,
  requireArrayField,
  requireField,
  requireModel,
  uniqueId,
} from './helpers/sb-runtime.mjs';

function agentFixture(keys) {
  const section = fixtureSection('agent');
  return Object.fromEntries(keys.map(key => [key, requireField(section, key)]));
}

function namedCase(sectionName, keys) {
  const section = fixtureSection(sectionName);
  return Object.fromEntries(keys.map(key => [key, requireField(section, key)]));
}

test('SB-T39 监控面板可打开：subagent 数据源与后台代理分区可见', async ({ page }) => {
  getRuntime();

  await openMonitorPanel(page);

  await expect(page.getByText(/subagent\s*监控/i).first()).toBeVisible();
  await expect(page.getByText(/数据源|后台代理|CLAUDE --BG/i).first()).toBeVisible();
});

test('SB-T40 当前母会话的"查看"：视图身份 = 母 sessionId + toolUseId', async ({ page }) => {
  requireModel();
  const agent = agentFixture(['sessionSearchMarker', 'projectName', 'parentSessionId', 'parentTitle', 'toolUseId']);

  await openFixtureSession(page, agent);
  await openAgentViewFromMonitor(page, agent.toolUseId);

  const observed = (await paneIdentity(page)).agentViews;
  const views = observed.filter(view => view.parentSessionId === agent.parentSessionId && view.toolUseId === agent.toolUseId);
  expect(views.length, `exactly one subagent view must carry the parent identity; observed ${JSON.stringify(observed)}`).toBe(1);
  await expect(page.getByText(agent.parentTitle).first(), 'the parent title must agree with the view identity').toBeVisible();
});

test('SB-T41 母会话已在另一窗格：复用该窗格，不新开第三个', async ({ page }) => {
  requireModel();
  const agent = agentFixture(['sessionSearchMarker', 'projectName', 'parentSessionId', 'toolUseId']);
  const flow = fixtureSection('sessionFlow');

  await ensurePaneCount(page, 2);
  await openSessionInPane(page, flow, { paneIndex: 0, markerKey: 'sessionASearchMarker' });
  await openSessionInPane(page, agent, { paneIndex: 1 });
  await openMonitorPanel(page);
  await openAgentViewFromMonitor(page, agent.toolUseId);

  expect(await paneLocator(page).count(), '查看 an already open parent must reuse its pane').toBe(2);
  const views = (await paneIdentity(page)).agentViews
    .filter(view => view.parentSessionId === agent.parentSessionId && view.toolUseId === agent.toolUseId);
  expect(views.length, 'the reused pane must show the requested subagent view').toBe(1);
});

test('SB-T42 跨项目母会话：查看落在正确项目/会话，不落在当前会话上', async ({ page }) => {
  requireModel();
  const cross = namedCase('agentCrossProject', ['sessionSearchMarker', 'projectName', 'parentSessionId', 'parentTitle', 'toolUseId']);
  const flow = fixtureSection('sessionFlow');

  await openSessionInPane(page, flow, { markerKey: 'sessionASearchMarker' });
  await openAgentViewFromMonitor(page, cross.toolUseId);

  const views = (await paneIdentity(page)).agentViews
    .filter(view => view.parentSessionId === cross.parentSessionId && view.toolUseId === cross.toolUseId);
  expect(views.length, 'the cross-project parent must be located by identity, not by position').toBe(1);
  await expect(page.getByText(cross.parentTitle).first()).toBeVisible();
});

test('SB-T43 后台未打开的母会话：查看打开正确母会话', async ({ page }) => {
  requireModel();
  const background = namedCase('agentBackground', ['sessionSearchMarker', 'projectName', 'parentSessionId', 'parentTitle', 'toolUseId']);
  const flow = fixtureSection('sessionFlow');

  await openSessionInPane(page, flow, { markerKey: 'sessionASearchMarker' });
  await openAgentViewFromMonitor(page, background.toolUseId);

  const views = (await paneIdentity(page)).agentViews
    .filter(view => view.parentSessionId === background.parentSessionId && view.toolUseId === background.toolUseId);
  expect(views.length, 'a parent that is not open must still be opened at the right identity').toBe(1);
  await expect(page.getByText(background.parentTitle).first()).toBeVisible();
});

test('SB-T44 母会话不存在：保留当前视图并显示"母会话不存在"，不在错误会话上显示"数据不可用"', async ({ page }) => {
  const orphan = namedCase('agentOrphan', ['monitorEntryMarker']);
  const flow = fixtureSection('sessionFlow');

  await openSessionInPane(page, flow, { markerKey: 'sessionASearchMarker' });
  await openMonitorPanel(page);
  await openAgentViewFromMonitor(page, orphan.monitorEntryMarker);

  await expect(page.getByText(/母会话不存在/).first()).toBeVisible();
  await expect(page.getByText(flow.sessionASearchMarker).first(), 'the current view must stay').toBeVisible();
  await expect(
    page.getByText(/数据不可用/),
    'the failure must not be shown as "data unavailable" inside a wrong parent session',
  ).toHaveCount(0);
});

test('SB-T45 缺母身份：显示"无法确定母会话"并保留当前视图', async ({ page }) => {
  const broken = namedCase('agentUnresolvedEntry', ['monitorEntryMarker']);
  const flow = fixtureSection('sessionFlow');

  await openSessionInPane(page, flow, { markerKey: 'sessionASearchMarker' });
  await openMonitorPanel(page);
  await openAgentViewFromMonitor(page, broken.monitorEntryMarker);

  await expect(page.getByText(/无法确定母会话/).first()).toBeVisible();
  await expect(page.getByText(flow.sessionASearchMarker).first(), 'the current view must stay').toBeVisible();
});

test('SB-T46 无权限查看母会话：显示"无权查看此会话"', async ({ page }) => {
  const noPermission = namedCase('agentNoPermission', ['monitorEntryMarker']);

  await openMonitorPanel(page);
  await openAgentViewFromMonitor(page, noPermission.monitorEntryMarker);

  await expect(page.getByText(/无权查看此会话/).first()).toBeVisible();
});

test('SB-T47 临时读取失败：显示"加载失败，可重试"', async ({ page }) => {
  const loadFailure = namedCase('agentLoadFailure', ['monitorEntryMarker']);

  await openMonitorPanel(page);
  await openAgentViewFromMonitor(page, loadFailure.monitorEntryMarker);

  await expect(page.getByText(/加载失败.*可重试|可重试/).first()).toBeVisible();
});

test('SB-T48 代理历史 HTTP：唯一根 schema，owner 带母身份，view.blocks 保持原序', async ({ request }) => {
  requireModel();
  const agent = agentFixture(['agentSessionId', 'parentSessionId', 'toolUseId', 'parentProjectHash']);
  const expectedTypes = requireArrayField(fixtureSection('agent'), 'expectedBlockTypes');
  const { baseURL } = getRuntime();

  const history = await readMessages(request, baseURL, agent.agentSessionId, agent.parentProjectHash);

  expect(history.status, `agent history body: ${JSON.stringify(history.body)?.slice(0, 200)}`).toBe(200);
  expect(Object.keys(history.body).sort(), 'agent history keeps the one documented root schema').toEqual(['messages', 'owner', 'usageTotals', 'view']);
  expect(history.body.owner.parentSessionId).toBe(agent.parentSessionId);
  expect(history.body.owner.toolUseId).toBe(agent.toolUseId);
  expect(history.body.view.kind, 'an agent history must be marked as the agent view kind').toBe('agent');
  expect(Array.isArray(history.body.view.blocks), 'ordered blocks live in view.blocks').toBe(true);
  expect(
    history.body.view.blocks.map(block => block.type),
    'blocks must keep the original prompt/thinking/tool/text order observed in the source run',
  ).toEqual(expectedTypes);
});

test('SB-T49 代理历史不存在：404', async ({ request }) => {
  const flow = fixtureSection('sessionFlow');
  const { baseURL } = getRuntime();

  const history = await readMessages(request, baseURL, `sb_missing_agent_${uniqueId('x')}`, flow.sessionAProjectHash);

  expectJsonError(history, { status: 404 });
});

test('SB-T50 代理历史归属冲突：409 AGENT_OWNER_UNRESOLVED', async ({ request }) => {
  requireModel();
  const agent = agentFixture(['agentSessionId', 'parentProjectHash']);
  const flow = fixtureSection('sessionFlow');
  if (flow.sessionAProjectHash === agent.parentProjectHash) {
    throw new Error('ENVIRONMENT_BLOCKED: fixtures must place the agent parent and sessionFlow in different projects');
  }
  const { baseURL } = getRuntime();

  const history = await readMessages(request, baseURL, agent.agentSessionId, flow.sessionAProjectHash);

  expectJsonError(history, { status: 409, code: 'AGENT_OWNER_UNRESOLVED' });
});

test('SB-T51 代理详情显示来源：仅历史时标注历史来源', async ({ page }) => {
  requireModel();
  const historyOnly = namedCase('agentHistoryOnly', ['sessionSearchMarker', 'projectName', 'parentSessionId', 'parentTitle', 'toolUseId']);

  await openFixtureSession(page, historyOnly);
  await openAgentViewFromMonitor(page, historyOnly.toolUseId);

  const view = agentViewLocator(page, historyOnly);
  await expect(view, 'the history-only view must still carry its identity').toBeVisible();
  await expect(view.getByText(/历史/).first(), 'the view must name its source (history)').toBeVisible();
});

test('SB-T52 源仍运行时的迟到历史：不改状态、不替换停止目标', async ({ page, request }) => {
  requireModel();
  const running = namedCase('agentRunning', ['sessionSearchMarker', 'projectName', 'parentSessionId', 'parentTitle', 'toolUseId']);
  const flow = fixtureSection('sessionFlow');
  const { baseURL } = getRuntime();
  const agentIdentity = {
    marker: running.sessionSearchMarker,
    parentSessionId: running.parentSessionId,
    toolUseId: running.toolUseId,
  };

  // 前置（公开面，跑前先证）：这条 Task 现在【真的还在跑】—— 读母会话自身的消息（应用公布的
  // 历史面，也是视图判「实时/历史」用的同一份证据）。窗口过了（agentRunning 硬寿命≈30–45 分钟）
  // 就 ENVIRONMENT_BLOCKED：那时"视图不是实时"是夹具过期，不是产品回归。
  await requireAgentRunLive(request, baseURL, agentIdentity);

  await openFixtureSession(page, running);
  await openAgentViewFromMonitor(page, running.toolUseId);
  const view = agentViewLocator(page, running);
  await expect(view, 'the running source must open in realtime mode').toBeVisible();
  await expect(view.getByText(/实时/).first()).toBeVisible();
  const stopBefore = await view.getByRole('button', { name: /停止/ }).count();
  // 源还在跑却没有任何停止入口，"停止目标没被替换"就成了 0=0 的恒真断言（合同：有运行证据才
  // 显示源代理的停止按钮，见 SB-T54 的反面）。所以这里先要求它存在，数量本身仍是原断言。
  expect(stopBefore, 'a still-running source must offer its stop affordance, otherwise the "stop target survived" check below is vacuous').toBeGreaterThan(0);

  await openSessionInPane(page, flow, { markerKey: 'sessionASearchMarker' });
  // 前置复核：后半段的观察窗口同样必须落在"源还在跑"上；中途到期就报环境，不让夹具过期
  // 污染"迟到的历史把实时说成历史"这个产品结论（复核与重开之间的数秒仍有理论竞态，
  // 见 .devflow/TEST-PLAN-second-batch.md 第四轮修订）。
  await requireAgentRunLive(request, baseURL, agentIdentity);
  await openFixtureSession(page, running);
  await openAgentViewFromMonitor(page, running.toolUseId);

  const reopened = agentViewLocator(page, running);
  await expect(reopened, 'the reopened view keeps the same identity').toBeVisible();
  await expect(reopened.getByText(/实时/).first(), 'a late history response must not turn a running source into a finished one').toBeVisible();
  expect(await reopened.getByRole('button', { name: /停止/ }).count(), 'the stop target must survive the history load').toBe(stopBefore);
});

test('SB-T53 fork 相同 toolUseId：各视图归属各自的母会话', async ({ page }) => {
  requireModel();
  const fork = namedCase('agentFork', ['parentASearchMarker', 'parentAId', 'parentBSearchMarker', 'parentBId', 'toolUseId']);

  const parentA = { ...fixtureSection('agentFork'), sessionSearchMarker: fork.parentASearchMarker };
  const parentB = { ...fixtureSection('agentFork'), sessionSearchMarker: fork.parentBSearchMarker };

  await openFixtureSession(page, parentA);
  await openAgentViewFromMonitor(page, fork.toolUseId);
  let views = (await paneIdentity(page)).agentViews;
  expect(views.filter(view => view.parentSessionId === fork.parentAId).length, 'fork view must belong to parent A').toBe(1);

  await openFixtureSession(page, parentB);
  await openAgentViewFromMonitor(page, fork.toolUseId);
  views = (await paneIdentity(page)).agentViews;
  expect(views.filter(view => view.parentSessionId === fork.parentBId).length, 'the same toolUseId under parent B is a different view').toBe(1);
  expect(views.filter(view => view.parentSessionId === fork.parentAId).length, 'parent A view must not survive the switch').toBe(0);
});

test('SB-T54 fork 视图没有运行证据：不显示源代理的停止按钮', async ({ page }) => {
  requireModel();
  const fork = namedCase('agentFork', ['parentASearchMarker', 'parentAId', 'parentBSearchMarker', 'parentBId', 'toolUseId', 'forkAgentSessionId']);

  await openFixtureSession(page, { ...fixtureSection('agentFork'), sessionSearchMarker: fork.parentBSearchMarker });
  await openAgentViewFromMonitor(page, fork.toolUseId);

  const view = agentViewLocator(page, { parentSessionId: fork.parentBId, toolUseId: fork.toolUseId });
  await expect(view).toBeVisible();
  expect(await view.getByRole('button', { name: /停止/ }).count(), 'a fork without run evidence must not offer the source stop action').toBe(0);
});

test('SB-T55 关闭其他 pane：代理视图归属不变', async ({ page }) => {
  requireModel();
  const agent = agentFixture(['sessionSearchMarker', 'projectName', 'parentSessionId', 'toolUseId']);
  const flow = fixtureSection('sessionFlow');

  await ensurePaneCount(page, 2);
  await openSessionInPane(page, flow, { paneIndex: 1, markerKey: 'sessionASearchMarker' });
  await openSessionInPane(page, agent, { paneIndex: 0 });
  await openAgentViewFromMonitor(page, agent.toolUseId);
  const viewsBefore = (await paneIdentity(page)).agentViews;

  await closePane(page, paneLocator(page).nth(1));

  const viewsAfter = (await paneIdentity(page)).agentViews;
  expect(viewsAfter.map(view => `${view.parentSessionId}|${view.toolUseId}`)).toEqual(viewsBefore.map(view => `${view.parentSessionId}|${view.toolUseId}`));
});

test('SB-T56 切到无关母会话：退出旧代理视图', async ({ page }) => {
  requireModel();
  const agent = agentFixture(['sessionSearchMarker', 'projectName', 'parentSessionId', 'toolUseId']);
  const flow = fixtureSection('sessionFlow');

  await openFixtureSession(page, agent);
  await openAgentViewFromMonitor(page, agent.toolUseId);
  expect((await paneIdentity(page)).agentViews.length, 'the agent view must be open before switching away').toBeGreaterThan(0);

  await openSessionInPane(page, flow, { markerKey: 'sessionASearchMarker' });

  expect(
    (await paneIdentity(page)).agentViews.filter(view => view.parentSessionId === agent.parentSessionId).length,
    'switching to an unrelated session must leave the old agent view',
  ).toBe(0);
});

test('SB-T57 重复打开同一代理：只保留一处视图', async ({ page }) => {
  requireModel();
  const agent = agentFixture(['sessionSearchMarker', 'projectName', 'parentSessionId', 'toolUseId']);

  await openFixtureSession(page, agent);
  await openAgentViewFromMonitor(page, agent.toolUseId);
  await openAgentViewFromMonitor(page, agent.toolUseId);

  const matching = (await paneIdentity(page)).agentViews
    .filter(view => view.parentSessionId === agent.parentSessionId && view.toolUseId === agent.toolUseId);
  expect(matching.length, 'opening the same agent twice must render one view').toBe(1);
  await expect(agentViewLocator(page, agent)).toBeVisible();
});

test('SB-T58 目标已改变时的迟到响应：不显示旧代理内容', async ({ page }) => {
  requireModel();
  const agent = agentFixture(['sessionSearchMarker', 'projectName', 'parentSessionId', 'parentTitle', 'toolUseId']);
  const flow = fixtureSection('sessionFlow');

  await openFixtureSession(page, agent);
  await openAgentViewFromMonitor(page, agent.toolUseId);
  await openSessionInPane(page, flow, { markerKey: 'sessionASearchMarker' });
  await page.waitForTimeout(5_000);

  expect(
    (await paneIdentity(page)).agentViews.filter(view => view.parentSessionId === agent.parentSessionId).length,
    'a response that belongs to the previous target must be dropped, not displayed',
  ).toBe(0);
  await expect(
    paneLocator(page).filter({ hasText: agent.parentTitle }),
    'no stale agent title may bleed into the pane that now shows another session',
  ).toHaveCount(0);
});

test('SB-T59 代理停止带错归属：409 AGENT_OWNER_MISMATCH', async ({ request }) => {
  requireModel();
  const stopTaskPathTemplate = requireField(fixtureSection('agent'), 'stopTaskPathTemplate');
  const running = namedCase('agentRunning', ['parentPid', 'parentSessionId', 'toolUseId']);
  const { baseURL } = getRuntime();

  const result = await postAgentStop(request, baseURL, stopTaskPathTemplate, running.parentPid, {
    parentSessionId: `sb_wrong_parent_${uniqueId('x')}`,
    parentPid: running.parentPid,
    toolUseId: running.toolUseId,
  });

  expectJsonError(result, { status: 409, code: 'AGENT_OWNER_MISMATCH' });
});

test('SB-T60 代理只有历史、没有运行实例：409 AGENT_NOT_RUNNING', async ({ request }) => {
  requireModel();
  const stopTaskPathTemplate = requireField(fixtureSection('agent'), 'stopTaskPathTemplate');
  const historyOnly = namedCase('agentHistoryOnly', ['parentPid', 'parentSessionId', 'toolUseId']);
  const { baseURL } = getRuntime();

  const result = await postAgentStop(request, baseURL, stopTaskPathTemplate, historyOnly.parentPid, {
    parentSessionId: historyOnly.parentSessionId,
    parentPid: historyOnly.parentPid,
    toolUseId: historyOnly.toolUseId,
  });

  expectJsonError(result, { status: 409, code: 'AGENT_NOT_RUNNING' });
});

test('SB-T61 代理运行已结束的重复停止：200 stopped:false 且回真实终态', async ({ request }) => {
  requireModel();
  const stopTaskPathTemplate = requireField(fixtureSection('agent'), 'stopTaskPathTemplate');
  const ended = namedCase('agentEnded', ['parentPid', 'parentSessionId', 'toolUseId']);
  const { baseURL } = getRuntime();
  const payload = {
    parentSessionId: ended.parentSessionId,
    parentPid: ended.parentPid,
    toolUseId: ended.toolUseId,
  };

  const first = await postAgentStop(request, baseURL, stopTaskPathTemplate, ended.parentPid, payload);
  expect(first.status, `agent stop body: ${JSON.stringify(first.body)?.slice(0, 200)}`).toBe(200);

  const second = await postAgentStop(request, baseURL, stopTaskPathTemplate, ended.parentPid, payload);

  expect(second.status, `repeat agent stop body: ${JSON.stringify(second.body)?.slice(0, 200)}`).toBe(200);
  expect(second.body?.ok).toBe(true);
  expect(second.body?.stopped, 'an already finished agent must not be reported as freshly stopped').toBe(false);
  expect(['completed', 'failed', 'stopped', 'killed']).toContain(second.body?.status);
  expect(second.body?.parentSessionId).toBe(ended.parentSessionId);
  expect(second.body?.toolUseId).toBe(ended.toolUseId);
});
