// r147 键盘 / 输入法 / Esc 穿透验收(黑盒)。只由 run.sh 调起:tests/acceptance/r147-keys/run.sh [-g 'K1']
// 依据:.devflow/BRIEF-r147.md(K1–K5)与 .devflow/AUDIT-20261005-A2-keys.md。
// 套件结构照抄 r146-crosstalk(假 claude + 隔离实例 + dev server),helpers 是从 r146 复制来的副本
// (r146 原目录只读),r147 只在 helpers/ui.mjs 末尾追加了权限卡桩 / 回合存活判定 / WS 帧记录 / 输入法按键。
//
// 覆盖:K1(终端 Esc)、K3(焦点在否定按钮上按 Enter)、K4(弹窗 / 旁问窗 / 卡片输入框 Esc 穿透)界面层;
// K2 另挑两处高影响的调用点做界面层(旁问框、提问卡自定义回答)。K2 全部调用点与 K5 在
// tests/unit/check-r147-*.mjs 做逻辑 + 源码级断言。
//
// "回合被停"的可观测信号(探路实测):会话级 Esc 停止生效时,停止按钮在 1 秒内消失、这一轮的 CLI 进程被收掉。
import { test, expect } from '@playwright/test';
import { NAV, R147, live } from './helpers/fixtures.mjs';
import {
  boot, expectTurnKeepsRunning, imeKeydown, openRightPanel, openSessionBySearch, recordWsSent, releaseAllRuns,
  releaseChunk2, releaseTurnEnd, sendPrompt, sessionRow, stubPermissions, termSentEsc, waitTurnRunning,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);   // 打开一次,夹具项目与它的会话才进侧栏
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  releaseAllRuns(CTL);     // 别把任何一条会话的回合晾在停住状态
});

/** 打开会话 S,发一句话,等它停在第一块(= 有一条正在生成的回合)。 */
async function startLongTurn(page, S, prompt) {
  await openSessionBySearch(page, S.mark);
  await sendPrompt(page, prompt);
  await waitTurnRunning(page, S.sid, prompt);
}

/** 放行这一轮并等它正常收尾(证明前面那几下 Esc 没有把它停掉)。 */
async function finishTurn(page, S) {
  releaseChunk2(CTL, S.sid);
  releaseTurnEnd(CTL, S.sid);
  await expect(page.getByText(live.final(S.sid), { exact: false }).first(), '这一轮应正常跑完并显示定稿').toBeVisible({ timeout: 40_000 });
}

/** 右侧面板此刻是否开着某个面板(看面板头上的标题)。 */
const panelHeader = (page, label) => page.locator('[data-cgui-panel]').getByText(label, { exact: true }).first();

// ============================================================ K1 ============================================================
test('K1 内置终端里按 Esc:ESC 原样送到 shell;正在跑的回合不被停;面板内其它输入框的 Esc 仍不外泄', async ({ page }) => {
  const S = R147[0];
  const sent = recordWsSent(page);
  await startLongTurn(page, S, 'R147 K1 这一轮一直在跑,终端里按 Esc 不该停掉它。');

  await page.locator('[data-tour="panel-term"]').click();
  await expect(page.locator('.xterm').first(), '终端面板应打开').toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => document.activeElement?.className || ''), { message: '焦点应落在 xterm 的输入元素上', timeout: 10_000 })
    .toContain('xterm-helper-textarea');
  // 等 shell 连上(收到过任何输出,即会话凭据已就绪;否则输入先被缓冲,判据会晚到)
  await expect.poll(() => sent.some((p) => p.includes('"term-open"')), { message: '终端应已发出 term-open', timeout: 10_000 }).toBe(true);
  await page.waitForTimeout(1_500);
  expect(termSentEsc(sent), '前置:按 Esc 之前终端还没发过 ESC').toBe(false);

  await page.keyboard.press('Escape');
  await expect.poll(() => termSentEsc(sent), {
    message: '终端里按 Esc,xterm 应收到并把 ESC(\\u001b)发给 shell(vim / less / fzf 靠它);没发 = 这一击在面板的捕获监听里被截断了',
    timeout: 5_000,
  }).toBe(true);
  await expect(page.locator('.xterm').first(), '终端里按 Esc 不应关掉终端面板').toBeVisible();
  await expectTurnKeepsRunning(page, CTL, S.sid, '终端里按 Esc 之后');

  // 回归护栏(修前修后都应成立):面板内普通输入框里的 Esc 不外泄到会话级停止监听,面板也不关。
  await openRightPanel(page, 'CLAUDE.md 指令');
  const editor = page.locator('[data-cgui-panel] textarea').first();
  await expect(editor, 'CLAUDE.md 面板的编辑框应出现').toBeVisible({ timeout: 10_000 });
  await editor.click();
  await page.keyboard.press('Escape');
  await expectTurnKeepsRunning(page, CTL, S.sid, 'CLAUDE.md 编辑框里按 Esc 之后');
  await expect(panelHeader(page, 'CLAUDE.md 指令'), '面板内输入框的 Esc 不应关掉面板').toBeVisible();

  await finishTurn(page, S);
});

// ============================================================ K3 ============================================================
test('K3 工具权限卡:焦点在「拒绝」上按 Enter = 拒绝;选了「始终允许」时也不写规则;焦点不在控件上时 Enter 仍 = 允许', async ({ page }) => {
  const perms = await stubPermissions(page);
  await openSessionBySearch(page, R147[1].mark);
  const deny = page.getByRole('button', { name: '拒绝', exact: true });

  // ① 仅此次:Tab 到「拒绝」按 Enter
  await perms.push({ id: 'r147-k3-a', toolName: 'Bash', toolInput: { command: 'ls -la /tmp' } });
  await expect(deny, '工具权限卡应出现').toBeVisible({ timeout: 15_000 });
  await deny.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => perms.answersFor('r147-k3-a').length, { message: '卡片应收到一次应答', timeout: 10_000 }).toBeGreaterThan(0);
  expect(perms.answersFor('r147-k3-a')[0].decision, '焦点在「拒绝」上按 Enter,执行的必须是拒绝(修前执行的是允许)').toBe('deny');

  // ② 记住选了「始终允许」:焦点在「拒绝」上按 Enter 不得写入永久规则
  await perms.push({ id: 'r147-k3-b', toolName: 'Bash', toolInput: { command: 'git status' } });
  await expect(deny, '第二张工具权限卡应出现').toBeVisible({ timeout: 15_000 });
  await page.locator('select').filter({ has: page.locator('option[value="always"]') }).first().selectOption('always');
  await deny.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => perms.answersFor('r147-k3-b').length, { message: '第二张卡应收到一次应答', timeout: 10_000 }).toBeGreaterThan(0);
  const b = perms.answersFor('r147-k3-b')[0];
  expect(b.decision, '「始终允许」+ 焦点在「拒绝」上按 Enter:必须是拒绝').toBe('deny');
  expect(b.always, '拒绝时不得带上「写入永久规则」').toBeFalsy();

  // ③ 阳性对照:焦点不在任何控件上(body)时,Enter 仍是卡片的快捷键「允许」
  await perms.push({ id: 'r147-k3-c', toolName: 'Bash', toolInput: { command: 'pwd' } });
  await expect(deny, '第三张工具权限卡应出现').toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  await page.keyboard.press('Enter');
  await expect.poll(() => perms.answersFor('r147-k3-c').length, { message: '第三张卡应收到一次应答', timeout: 10_000 }).toBeGreaterThan(0);
  expect(perms.answersFor('r147-k3-c')[0].decision, '焦点不在控件上时 Enter = 允许(既有快捷键不变)').toBe('allow');
});

test('K3 MCP 表单卡与计划卡:焦点在「拒绝」/「取消」上按 Enter = 拒绝 / 取消计划(不是提交 / 按计划执行)', async ({ page }) => {
  const perms = await stubPermissions(page);
  await openSessionBySearch(page, R147[2].mark);

  // MCP 表单卡(elicitation):无必填项,窗口级 Enter 若接管就是"整表提交"
  await perms.push({
    id: 'r147-k3-elicit', kind: 'elicitation', serverName: 'r147-srv', displayName: 'R147 测试服务器',
    message: 'R147 请填写备注', requestedSchema: { type: 'object', properties: { note: { type: 'string', title: '备注' } } },
  });
  const elicitDeny = page.getByRole('button', { name: '拒绝', exact: true });
  await expect(page.getByText('R147 请填写备注').first(), 'MCP 表单卡应出现').toBeVisible({ timeout: 15_000 });
  await elicitDeny.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => perms.answersFor('r147-k3-elicit').length, { message: 'MCP 表单卡应收到一次应答', timeout: 10_000 }).toBeGreaterThan(0);
  const e = perms.answersFor('r147-k3-elicit')[0];
  expect(e.decision, '焦点在 MCP 表单卡「拒绝」上按 Enter:必须是拒绝(修前是整表提交)').toBe('deny');
  expect(e.content, '拒绝时不带表单内容').toBeUndefined();

  // 计划卡:焦点在「取消」上按 Enter,修前执行的是「按计划执行」
  await perms.push({ id: 'r147-k3-plan', toolName: 'ExitPlanMode', toolInput: { plan: '# R147 计划\n\n- 第一步:什么都不做' } });
  const card = page.locator('[data-cgui="permission-card"]');
  await expect(card, '计划卡应出现').toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => perms.answersFor('r147-k3-plan').length, { message: '计划卡应收到一次应答', timeout: 10_000 }).toBeGreaterThan(0);
  expect(perms.answersFor('r147-k3-plan')[0].decision, '焦点在计划卡「取消」上按 Enter:必须是取消(deny),不是按计划执行').toBe('deny');
});

// ============================================================ K4 ============================================================
test('K4 添加项目弹窗:输入框里按 Esc 只关弹窗,不停正在跑的回合', async ({ page }) => {
  const S = R147[4];
  // 本机访问时「添加项目」先走后端系统选择器(会在桌面上弹原生窗口)—— 让它失败,落到应用内的路径弹窗。
  await page.route('**/api/pick-directory', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"r147 测试:不弹系统选择器"}' }));
  await startLongTurn(page, S, 'R147 K4 添加项目弹窗:这一轮一直在跑。');

  await page.locator('[data-cgui="add-project-btn"]').click();
  const input = page.getByPlaceholder('~/Desktop/my-project');
  await expect(input, '添加项目弹窗应出现').toBeVisible({ timeout: 10_000 });
  await input.click();
  await input.fill('~/r147-half-typed');
  await page.keyboard.press('Escape');
  await expectTurnKeepsRunning(page, CTL, S.sid, '添加项目弹窗里按 Esc 之后');
  await expect(input, 'Esc 应关掉添加项目弹窗').toBeHidden({ timeout: 3_000 });
  await finishTurn(page, S);
});

test('K4 worktree 弹窗:分支名输入框里按 Esc 只关弹窗,不停正在跑的回合', async ({ page }) => {
  const S = R147[5];
  await startLongTurn(page, S, 'R147 K4 worktree 弹窗:这一轮一直在跑。');

  await page.locator('[data-cgui="sidebar"]').getByRole('button', { name: '项目操作' }).first().click();
  await page.locator('[data-cgui="new-worktree-btn"]').first().click();
  const input = page.getByPlaceholder('分支名 (如 feature-X)');
  await expect(input, 'worktree 弹窗应出现').toBeVisible({ timeout: 10_000 });
  await input.click();
  await input.fill('r147-half');
  await page.keyboard.press('Escape');
  await expectTurnKeepsRunning(page, CTL, S.sid, 'worktree 弹窗里按 Esc 之后');
  await expect(input, 'Esc 应关掉 worktree 弹窗').toBeHidden({ timeout: 3_000 });
  await finishTurn(page, S);
});

test('K4 旁问窗:旁问框里按 Esc 只收起旁问窗,不停主回合', async ({ page }) => {
  const S = R147[6];
  await startLongTurn(page, S, 'R147 K4 旁问窗:主回合一直在跑。');

  await page.locator('[data-cgui="aside-btn"]').first().click();
  const box = page.getByPlaceholder('继续旁问…（Enter 发送）');
  await expect(box, '旁问窗应展开').toBeVisible({ timeout: 10_000 });
  await box.click();
  await box.fill('R147 旁问半句');
  await page.keyboard.press('Escape');
  await expectTurnKeepsRunning(page, CTL, S.sid, '旁问框里按 Esc 之后');
  await expect(box, 'Esc 应收起旁问窗').toBeHidden({ timeout: 3_000 });
  await finishTurn(page, S);
});

test('K4 计划卡「需要修改」的意见框里按 Esc:不停回合、卡片还在,只收起意见框', async ({ page }) => {
  const S = R147[7];
  const perms = await stubPermissions(page);
  await startLongTurn(page, S, 'R147 K4 计划卡意见框:这一轮一直在跑,卡片挂在它上面。');

  await perms.push({ id: 'r147-k4-plan', sessionId: S.sid, toolName: 'ExitPlanMode', toolInput: { plan: '# R147 K4 计划\n\n- 一步' } });
  const planCard = page.locator('[data-cgui="permission-card"]');
  await expect(planCard, '计划卡应出现').toBeVisible({ timeout: 15_000 });
  await planCard.getByRole('button', { name: '需要修改', exact: true }).click();
  const refine = page.getByPlaceholder(/告诉 Claude 该如何修改这份计划/);
  await expect(refine).toBeVisible({ timeout: 5_000 });
  await refine.click();
  await refine.fill('R147 修改意见写到一半');
  await page.keyboard.press('Escape');
  await expectTurnKeepsRunning(page, CTL, S.sid, '计划修改意见框里按 Esc 之后');
  await expect(planCard, '意见框里按 Esc 不应把计划卡清掉').toBeVisible();
  expect(perms.answersFor('r147-k4-plan'), '意见框里按 Esc 不应替用户裁决计划卡').toEqual([]);
  // 取消本次输入 = 收起意见框(与意见框自己的「取消」按钮同义),回到卡片的三个按钮
  await expect(refine, '意见框里按 Esc 应收起意见框(取消本次输入)').toBeHidden({ timeout: 3_000 });
  await planCard.getByRole('button', { name: '取消', exact: true }).click();
  await expect.poll(() => perms.answersFor('r147-k4-plan').length, { timeout: 10_000 }).toBeGreaterThan(0);
  await finishTurn(page, S);
});

test('K4 提问卡「自定义回答」里按 Esc:不停回合、卡片还在,只退出输入框', async ({ page }) => {
  const S = R147[8];
  const perms = await stubPermissions(page);
  await startLongTurn(page, S, 'R147 K4 提问卡自定义回答:这一轮一直在跑,卡片挂在它上面。');

  await perms.push({ id: 'r147-k4-ask', sessionId: S.sid, toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'R147 选哪个?', header: 'R147', options: [{ label: '甲' }, { label: '乙' }] }] } });
  const custom = page.getByPlaceholder('或自定义回答,回车提交…');
  await expect(custom, '提问卡应出现').toBeVisible({ timeout: 15_000 });
  await custom.click();
  await custom.fill('R147 自定义回答写到一半');
  await page.keyboard.press('Escape');
  await expectTurnKeepsRunning(page, CTL, S.sid, '提问卡自定义回答里按 Esc 之后');
  await expect(custom, '自定义回答里按 Esc 不应把提问卡清掉').toBeVisible();
  expect(perms.answersFor('r147-k4-ask'), '自定义回答里按 Esc 不应替用户作答').toEqual([]);
  // 取消本次输入 = 退出输入框(焦点离开),已写的字留着
  await expect(custom, '自定义回答里按 Esc 应退出输入框').not.toBeFocused({ timeout: 3_000 });
  await expect(custom, '退出输入框不丢已写的字').toHaveValue('R147 自定义回答写到一半');
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await expect.poll(() => perms.answersFor('r147-k4-ask').length, { timeout: 10_000 }).toBeGreaterThan(0);
  await finishTurn(page, S);
});

test('K4 MCP 表单卡的文本字段里按 Esc:不停回合、卡片还在,只退出输入框', async ({ page }) => {
  const S = R147[9];
  const perms = await stubPermissions(page);
  await startLongTurn(page, S, 'R147 K4 MCP 表单卡字段:这一轮一直在跑,卡片挂在它上面。');

  await perms.push({ id: 'r147-k4-elicit', sessionId: S.sid, kind: 'elicitation', serverName: 'r147-srv', displayName: 'R147 测试服务器',
    message: 'R147 K4 请填写备注', requestedSchema: { type: 'object', properties: { note: { type: 'string', title: '备注' } } } });
  const msg = page.getByText('R147 K4 请填写备注').first();
  await expect(msg, 'MCP 表单卡应出现').toBeVisible({ timeout: 15_000 });
  const field = msg.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-panel ")][1]//input[@type="text"]').first();
  await field.click();
  await field.fill('R147 表单写到一半');
  await page.keyboard.press('Escape');
  await expectTurnKeepsRunning(page, CTL, S.sid, 'MCP 表单卡字段里按 Esc 之后');
  await expect(msg, '表单字段里按 Esc 不应把 MCP 表单卡清掉').toBeVisible();
  expect(perms.answersFor('r147-k4-elicit'), '表单字段里按 Esc 不应替用户提交或拒绝').toEqual([]);
  await expect(field, '表单字段里按 Esc 应退出输入框').not.toBeFocused({ timeout: 3_000 });
  await expect(field, '退出输入框不丢已写的字').toHaveValue('R147 表单写到一半');
  await finishTurn(page, S);
});

const MCP_LABEL = '工具（MCP 服务器 · 插件）';
/** 打开 MCP 面板并打开「添加 MCP 服务器」表单弹窗,返回表单标题定位器。 */
async function openMcpForm(page) {
  await openRightPanel(page, MCP_LABEL);
  await expect(panelHeader(page, MCP_LABEL), 'MCP 面板应打开').toBeVisible({ timeout: 10_000 });
  await page.locator('[data-cgui-panel]').getByRole('button', { name: '添加', exact: true }).first().click();
  const formTitle = page.getByText('添加 MCP 服务器', { exact: true });
  await expect(formTitle, 'MCP 表单弹窗应出现').toBeVisible({ timeout: 10_000 });
  return formTitle;
}

test('K4 MCP 表单弹窗:填了一半、焦点在空白处按 Esc —— 只关表单,右侧面板留着', async ({ page }) => {
  const formTitle = await openMcpForm(page);
  await page.getByPlaceholder('my-mcp-server').fill('r147-half');
  await formTitle.click();   // 点一下表单空白处:焦点离开输入框
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  expect(await panelHeader(page, MCP_LABEL).isVisible(), '表单弹窗里按 Esc 不应关掉整个右侧面板').toBe(true);
  await expect(formTitle, 'Esc 应关掉 MCP 表单弹窗').toBeHidden({ timeout: 3_000 });
});

test('K4 MCP 表单弹窗:焦点在输入框里按 Esc —— 关掉表单(修前完全无反应),右侧面板留着', async ({ page }) => {
  const formTitle = await openMcpForm(page);
  await page.getByPlaceholder('my-mcp-server').click();
  await page.keyboard.type('r147-x');
  await page.keyboard.press('Escape');
  await expect(formTitle, '焦点在表单输入框里按 Esc,应关掉表单弹窗').toBeHidden({ timeout: 3_000 });
  expect(await panelHeader(page, MCP_LABEL).isVisible(), '右侧面板应还开着').toBe(true);
});

test('K4 添加插件弹窗:Esc 只关弹窗,右侧面板留着', async ({ page }) => {
  const LABEL = MCP_LABEL;
  await openRightPanel(page, LABEL);
  await expect(panelHeader(page, LABEL), 'MCP 面板应打开').toBeVisible({ timeout: 10_000 });
  await page.locator('[data-cgui-panel]').getByRole('tab', { name: '插件', exact: true }).click();
  await page.locator('[data-cgui-panel]').getByRole('button', { name: '添加', exact: true }).first().click();
  const title = page.getByText('添加插件', { exact: true });
  await expect(title, '添加插件弹窗应出现').toBeVisible({ timeout: 10_000 });
  await title.click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  expect(await panelHeader(page, LABEL).isVisible(), '添加插件弹窗里按 Esc 不应关掉整个右侧面板').toBe(true);
  await expect(title, 'Esc 应关掉添加插件弹窗').toBeHidden({ timeout: 3_000 });
});

// ============================================================ K2(界面层抽样)============================================================
test('K2 旁问框:输入法上屏的 Enter(WebKit 形态 keyCode 229)不发送、不清空', async ({ page }) => {
  let btwPosts = 0;
  await page.route('**/api/chat/btw', (r) => { btwPosts += 1; return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"r147 测试桩"}' }); });
  await openSessionBySearch(page, R147[10].mark);
  await page.locator('[data-cgui="aside-btn"]').first().click();
  const box = page.getByPlaceholder('继续旁问…（Enter 发送）');
  await expect(box, '旁问窗应展开').toBeVisible({ timeout: 10_000 });
  await box.click();
  await box.fill('R147 拼音上屏中');
  await imeKeydown(box, 'Enter', { isComposing: true });    // 组字中的 Enter(Chromium / 多数情形)
  await imeKeydown(box, 'Enter', { isComposing: false });   // WebKit:上屏那一下 isComposing 已为 false,只剩 keyCode 229
  await page.waitForTimeout(500);
  await expect(box, '输入法上屏的 Enter 不应把半句话发出去(输入框应原样保留)').toHaveValue('R147 拼音上屏中');
  expect(btwPosts, '输入法上屏的 Enter 不应触发旁问请求').toBe(0);
  // 阳性对照:真正的 Enter 仍然发送
  await box.press('Enter');
  await expect.poll(() => btwPosts, { message: '普通 Enter 仍应发送旁问', timeout: 5_000 }).toBe(1);
});

test('K2 提问卡自定义回答:输入法上屏的 Enter 不把半截回答交给模型', async ({ page }) => {
  const perms = await stubPermissions(page);
  await openSessionBySearch(page, R147[11].mark);
  await perms.push({ id: 'r147-k2-ask', toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'R147 K2 选哪个?', header: 'R147', options: [{ label: '甲' }, { label: '乙' }] }] } });
  const custom = page.getByPlaceholder('或自定义回答,回车提交…');
  await expect(custom, '提问卡应出现').toBeVisible({ timeout: 15_000 });
  await custom.click();
  await custom.fill('R147 半截');
  await imeKeydown(custom, 'Enter', { isComposing: false });
  await page.waitForTimeout(800);
  expect(perms.answersFor('r147-k2-ask'), '输入法上屏的 Enter 不应提交自定义回答').toEqual([]);
  await expect(custom).toHaveValue('R147 半截');
  // 阳性对照:真正的 Enter 提交
  await custom.press('Enter');
  await expect.poll(() => perms.answersFor('r147-k2-ask').length, { message: '普通 Enter 仍应提交', timeout: 10_000 }).toBeGreaterThan(0);
});

// ============================================================ K5(界面层抽样)============================================================
test('K5 模型选择弹层:自定义模型输入框里组字时按 Esc(取消候选词)不关弹层;普通 Esc 照常关', async ({ page }) => {
  await openSessionBySearch(page, R147[12].mark);
  await page.locator('[data-cgui="model-selector"] > button').first().click();
  const input = page.getByPlaceholder('自定义模型 ID...');
  await expect(input, '模型选择弹层应展开').toBeVisible({ timeout: 10_000 });
  await input.click();
  await input.fill('claude-r147-组字');
  for (const isComposing of [true, false]) {   // false = WebKit:取消候选那一下 isComposing 已为 false,只剩 keyCode 229
    await imeKeydown(input, 'Escape', { isComposing });
    await page.waitForTimeout(400);
    await expect(input, `组字中按 Esc(isComposing=${isComposing}, keyCode=229)是取消候选词,不应关掉弹层`).toBeVisible({ timeout: 1_000 });
  }
  await expect(input, '弹层里已输入的内容应还在').toHaveValue('claude-r147-组字');
  // 阳性对照:普通 Esc 照常关弹层
  await page.keyboard.press('Escape');
  await expect(input, '普通 Esc 应关掉弹层').toBeHidden({ timeout: 3_000 });
});
