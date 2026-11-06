// r157-live-line：生成中的「工作组」（最后一段思考 + 工具调用）默认收起成一行，实时状态行挂在这一行上。
// 判据全部来自 .devflow/r157-live-line-接口.md 的行为清单 B1–B15，只看页面上用户能看到的东西
// （接口文件列出的 data-* 锚点、公开文案）；不读源码、不读 React state。命名：Bn 对应行为清单第 n 条。
// 约定：「最后一个 [data-work-group]」= 本回合最新的那组（夹具里的历史回合在它前面）；断言一律先确认工作组存在再取字段，
// 所以改动前（页面上没有 [data-work-group]）会以断言失败的形式变红，而不是超时 / 抛错。
import { test, expect } from '@playwright/test';
import { touchCtl } from './helpers/runtime.mjs';
import { stopBtn, openAllGates, startRound, endRound, liveSnap, expectOneLine, expectPhase, parseElapsed, phaseTrail } from './helpers/live.mjs';
import {
  bash, wgSnap, lastGroup, gr, expectLiveGroup, waitLine, headElapsedTrail, lineAfterText, startRoundHook, turnOnChatMode, installWgObserver, wgLog,
} from './helpers/wg.mjs';

// 用例失败时直播回合会停在半路（假命令行在等放行文件）：把所有闸门都放了，让它自己收尾，别拖累下一条。
test.afterEach(async () => { try { openAllGates(); } catch { /* 忽略 */ } });

const TXT = (n) => `R157-B${n}-TEXT`;
const lastHead = (page) => page.locator('[data-work-group-head]').last();
const NONE = '页面上没有任何 [data-work-group]';
/** 最后一个工作组的「状态 | 头行 aria-expanded」应是 state | expanded。 */
const expectState = (page, state, expanded, message) => expect.poll(async () => {
  const g = await gr(page);
  return g.state === undefined ? NONE : `${g.state}|${g.expanded}`;
}, { timeout: 10_000, message }).toBe(`${state}|${expanded}`);

/** B1 的状态：先有一条正文，再来一个未返回结果的 Bash 工具调用（带 description）。 */
async function toolState(page, n, desc) {
  await startRound(page, { key: `b${n}`, scenario: { events: [{ kind: 'text', text: `${TXT(n)} 先有一条正文。` }, bash(desc, { pending: 'd1' })] } });
  await waitLine(page, 'tool', desc); // 前置自证：改动前底部状态行就是这样
}

test('B1 运行中最后一个工作组默认收起，组内没有可见的条目', async ({ page }) => {
  await toolState(page, 1, 'B1 一直没返回的命令');
  await expect.poll(async () => (await gr(page)).state ?? NONE, { timeout: 15_000, message: '最后一个 [data-work-group] 的 data-work-group-state 应为 closed' }).toBe('closed');
  expect((await gr(page)).entriesShown, '收起时组内不应有任何可见的 [data-entry-state]').toBe(0);
  await page.waitForTimeout(1500);
  expect((await gr(page)).state, '稳定 1.5 秒后仍应是 closed（不是先展开一下再收起）').toBe('closed');
});

test('B2 状态行挂在最后一个工作组的头行里：转圈、走字、状态词恰为工具的 description', async ({ page }) => {
  const DESC = 'B2 一直没返回的命令';
  await toolState(page, 2, DESC);
  await expectLiveGroup(page, { phase: 'tool', text: DESC });
  const g = await gr(page);
  expect([g.live, g.headLines, g.phase, g.lineText, g.ind], '组应 live=true，头行里恰有 1 个状态行：phase=tool、状态词恰为 description、带转圈').toEqual(['true', 1, 'tool', DESC, 1]);
  const secs = (await headElapsedTrail(page, 1700)).map(parseElapsed);
  expect(secs[0], `用时应是「12s」/「1m 5s」格式（观察到 ${JSON.stringify(secs)}）`).not.toBeNull();
  expect(Math.max(...secs.filter((x) => x !== null)), `用时应在 1.5 秒内走字（观察到 ${JSON.stringify(secs)}）`).toBeGreaterThan(secs[0]);
});

test('B3 页面上状态行总数恰为 1，并且就挂在工作组头行里（回合底部不再另起一条）', async ({ page }) => {
  await toolState(page, 3, 'B3 一直没返回的命令');
  await expectLiveGroup(page, { phase: 'tool' });
  const facts = async () => { const s = await wgSnap(page); return [s.lines, s.linesInHeads]; };
  expect(await facts(), '页面上 [data-live-line] 总数应恰为 1，且这 1 个在 [data-work-group-head] 里').toEqual([1, 1]);
  await page.waitForTimeout(1500);
  expect(await facts(), '稳定 1.5 秒后仍应恰为 1 个、仍在头行里').toEqual([1, 1]);
});

test('B4 最后一块是思考：最后一个工作组收起，头行状态行是「思考」', async ({ page }) => {
  await startRound(page, { key: 'b4', scenario: { events: [{ kind: 'thinking', text: 'B4 我在想一件事。' }] } });
  await waitLine(page, 'thinking'); // 前置自证：改动前底部状态行就是 thinking
  await expectLiveGroup(page, { phase: 'thinking', text: /^思考( · .*)?$/ });
  expect((await gr(page)).state, '最后一个工作组应收起').toBe('closed');
});

test('B5 点头行展开、再点收起：状态行一直在头行里，页面上始终恰为 1 个', async ({ page }) => {
  await toolState(page, 5, 'B5 一直没返回的命令');
  await expectLiveGroup(page, { phase: 'tool' }); // 没有工作组时在这里断言失败，不会去点不存在的元素
  await lastHead(page).click({ timeout: 8_000 });
  await expectState(page, 'open', 'true', '点头行后应展开：data-work-group-state=open、aria-expanded=true');
  await expect.poll(async () => (await gr(page)).entriesShown, { timeout: 6_000, message: '展开后组内应有可见的 [data-entry-state]' }).toBeGreaterThan(0);
  let s = await wgSnap(page);
  expect([lastGroup(s).headLines, s.lines], '展开后头行里的状态行仍在、页面上状态行仍恰为 1').toEqual([1, 1]);
  await lastHead(page).click({ timeout: 8_000 });
  await expectState(page, 'closed', 'false', '再点一次应回到 data-work-group-state=closed、aria-expanded=false');
  s = await wgSnap(page);
  expect([lastGroup(s).headLines, s.lines], '再收起后头行里的状态行仍在、页面上状态行仍恰为 1').toEqual([1, 1]);
});

test('B6 第一个工具返回、第二个工具发出：头行状态词换成第二个工具的 description，组仍收起', async ({ page }) => {
  await startRound(page, { key: 'b6', scenario: { events: [
    { kind: 'thinking', text: 'B6 先想一想。' }, bash('B6 工具甲', { pending: 'd1' }), { kind: 'wait', file: 'g1' }, bash('B6 工具乙', { pending: 'd2' }),
  ] } });
  await waitLine(page, 'tool', 'B6 工具甲'); // 前置自证：第二个工具还没发，状态词是第一个工具的 description
  await expectLiveGroup(page, { phase: 'tool', text: 'B6 工具甲' });
  touchCtl('d1'); // 第一个工具返回
  touchCtl('g1'); // 第二个工具发出（不给结果）
  await expectLiveGroup(page, { phase: 'tool', text: 'B6 工具乙' });
  expect((await gr(page)).state, '用户没点过：组仍是 closed').toBe('closed');
});

test('B7 正文开始流出：组变成静态摘要「<最新工具标题> · N 次工具调用」，底部状态行改显示「正在输出」', async ({ page }) => {
  await startRound(page, { key: 'b7', scenario: { events: [
    { kind: 'thinking', text: 'B7 先想一想。' }, bash('B7 工具甲'), bash('B7 工具乙'), { kind: 'wait', file: 'g1' }, { kind: 'text', text: `${TXT(7)} 正文流出来了。` },
  ] } });
  await expectOneLine(page);
  touchCtl('g1');
  await expect(page.getByText(TXT(7)).first(), '前置自证：正文应已画出来').toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => { const g = await gr(page); return g.state === undefined ? NONE : [g.live, g.headLines, g.headInd, g.headText].join(' | '); },
    { timeout: 15_000, message: '正文开始后：组应是静态摘要（live=false、头行没有状态行 / 转圈），头行文字恰为「B7 工具乙 · 2 次工具调用」' }).toBe('false | 0 | 0 | B7 工具乙 · 2 次工具调用');
  await expect.poll(async () => { const s = await liveSnap(page); return [s.count, s.phase, s.text].join('|'); }, { timeout: 10_000, message: '正文下面应出现底部状态行：页面上恰为 1 个、phase=text、文字「正在输出」' }).toBe('1|text|正在输出');
  expect(await lineAfterText(page, TXT(7)), '底部状态行应在正文下面').toBe(true);
  expect((await wgSnap(page)).linesInGroups, '底部状态行不应在任何工作组里').toBe(0);
});

test('B8 正文之后又来新工具调用：新组收起并承载状态行，上一个组变静态仍收起', async ({ page }) => {
  await startRound(page, { key: 'b8', scenario: { events: [
    bash('B8 工具甲'), { kind: 'text', text: `${TXT(8)} 第一段正文。` }, { kind: 'wait', file: 'g1' }, bash('B8 工具乙', { pending: 'd1' }),
  ] } });
  await expect(page.getByText(TXT(8)).first(), '前置自证：第一段正文应已画出来').toBeVisible({ timeout: 20_000 });
  touchCtl('g1');
  await waitLine(page, 'tool', 'B8 工具乙'); // 前置自证：新工具调用已到
  await expectLiveGroup(page, { phase: 'tool', text: 'B8 工具乙' });
  const s = await wgSnap(page); const cur = lastGroup(s); const prev = lastGroup(s, 2) || {};
  expect([cur.state, cur.live], '新的最后一个组：closed、承载状态行').toEqual(['closed', 'true']);
  expect([prev.state, prev.live, (prev.headText || '').includes('B8 工具甲')], '上一个组（头行含「B8 工具甲」）：仍 closed、不再承载状态行').toEqual(['closed', 'false', true]);
  expect([s.lines, s.linesInHeads, cur.headLines], '页面上状态行恰为 1，且在新组的头行里').toEqual([1, 1, 1]);
});

test('B9 子代理（Agent）折进最后一个工作组：不再是组外独立卡，点开能看到，正文后计入「N 次工具调用」', async ({ page }) => {
  const AG = 'B9 子代理任务';
  await startRound(page, { key: 'b9', scenario: { events: [
    bash('B9 普通命令'), { kind: 'tool', name: 'Agent', input: { subagent_type: 'general-purpose', description: AG, prompt: '做点事' }, pending: 'd1' },
    { kind: 'wait', file: 'g1' }, { kind: 'text', text: `${TXT(9)} 正文。` },
  ] } });
  await waitLine(page, 'tool', AG); // 前置自证：子代理没返回时状态词是它的 description
  await expectLiveGroup(page, { phase: 'tool', text: AG });
  const s = await wgSnap(page);
  expect([s.tasksOutside, s.tasksShown, lastGroup(s).state], '收起时：组外没有常显的子代理卡 [data-strip-item="task"]（数量 0），组是 closed').toEqual([0, 0, 'closed']);
  await lastHead(page).click({ timeout: 8_000 });
  await expect.poll(async () => (await gr(page)).bodyText ?? '', { timeout: 8_000, message: '点开后头行之外（组内）应能看到这张子代理卡（含它的描述文字）' }).toContain(AG);
  touchCtl('g1');
  await expect(page.getByText(TXT(9)).first(), '前置自证：正文应已画出来').toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await gr(page)).headText ?? NONE, { timeout: 15_000, message: '正文开始后头行应为「B9 子代理任务 · 2 次工具调用」（普通命令 + 子代理，子代理被计入 N）' }).toBe(`${AG} · 2 次工具调用`);
});

test('B10 Workflow 工作流仍是组外常显的独立卡，状态行不挂在任何工作组头行里', async ({ page }) => {
  await startRound(page, { key: 'b10', scenario: { events: [
    { kind: 'thinking', text: 'B10 先想一想。' }, bash('B10 普通命令'), { kind: 'tool', name: 'Workflow', input: { name: 'b10-flow', description: 'B10 工作流' }, pending: 'd1' },
  ] } });
  await expectOneLine(page);
  await expect.poll(async () => (await wgSnap(page)).workflowOutside, { timeout: 25_000, message: '前置自证：工作流卡片 [data-strip-item="workflow"] 应作为组外独立卡画出来且可见' }).toBe(1);
  await page.waitForTimeout(1500);
  const s = await wgSnap(page);
  expect([s.workflowOutside, s.liveGroups, s.linesInGroups, s.lines], '工作流卡仍在组外常显（1 张）；没有 data-work-group-live=true；状态行不在任何工作组里；页面上状态行恰为 1').toEqual([1, 0, 0, 1]);
});

test('B11 点「停止」：出现「停止中」状态行，页面上恰为 1 个，没有任何工作组承载状态行', async ({ page }) => {
  await toolState(page, 11, 'B11 一直没返回的命令');
  // 「停止中」只存在一瞬间（点停止 → 回合很快收尾 → 状态行整行卸载），轮询抓不住：点停止之前先装页内观察器，收尾后读它记下的快照。
  await installWgObserver(page);
  await stopBtn(page).click({ timeout: 8_000 });
  await endRound(page);
  const log = await wgLog(page);
  const rows = log.filter((r) => r.phase === 'stopping');
  expect(rows.length, `没有观察到 stopping 阶段（观察器记到的阶段轨迹：${phaseTrail(log)}）`).toBeGreaterThan(0);
  expect(rows.filter((r) => r.text !== '停止中').map((r) => r.text), 'stopping：状态词应恰为「停止中」（下列快照不是）').toEqual([]);
  expect(rows.filter((r) => r.lines !== 1).map((r) => r.lines), 'stopping：页面上状态行应恰为 1（下列快照的个数不是）').toEqual([]);
  expect(rows.filter((r) => r.wgLive !== 0 || r.inGroup).length, 'stopping：不应有 data-work-group-live=true，状态行也不应在任何工作组里（有这种快照）').toBe(0);
});

test('B12 压缩 / 连接中：状态行仍在回合底部，不在任何工作组头行里，页面上恰为 1 个', async ({ page }) => {
  const bottomOnly = async (phase) => {
    await expectPhase(page, phase);
    const s = await wgSnap(page);
    expect([s.lines, s.linesInGroups, s.liveGroups], `${phase}：状态行恰为 1、不在任何工作组里、没有 data-work-group-live=true`).toEqual([1, 0, 0]);
  };
  // 连接中：刚发消息，什么内容都还没有
  await startRound(page, { key: 'b12', scenario: { events: [{ kind: 'wait', file: 'g1' }, { kind: 'text', text: `${TXT(12)} 正文` }] } });
  await bottomOnly('connecting');
  await endRound(page);
  // 压缩：先有思考 + 一个已返回的工具（新版里会有工作组），再发 system/status:compacting
  await startRound(page, { key: 'b12', text: '请开始第二轮', scenario: { events: [
    { kind: 'thinking', text: 'B12 思考。' }, bash('B12 已返回的命令'), { kind: 'raw', payload: { type: 'system', subtype: 'status', status: 'compacting' } },
  ] } });
  await bottomOnly('compacting');
});

test('B13 出错标记：出错的组头行里有 [data-work-group-error]（收起 / 展开、承载状态行 / 静态都在），全部成功的组没有', async ({ page }) => {
  await startRound(page, { key: 'b13', scenario: { events: [
    bash('B13 出错的命令', { result: '命令失败了', isError: true }), { kind: 'text', text: `${TXT(13)}-1 正文一。` },
    bash('B13 成功的命令'), { kind: 'text', text: `${TXT(13)}-2 正文二。` },
    bash('B13 又出错的命令', { result: '又失败了', isError: true }), bash('B13 运行中的命令', { pending: 'd1' }),
  ] } });
  await waitLine(page, 'tool', 'B13 运行中的命令');
  await expectLiveGroup(page, { phase: 'tool', text: 'B13 运行中的命令' });
  // 最后三个组：甲（有出错，静态）、乙（全部成功，静态）、丙（有出错、还有一个在跑，承载状态行）
  const marks = async () => { const s = await wgSnap(page); return [3, 2, 1].map((n) => { const g = lastGroup(s, n); return g ? `${g.state}/${g.live}/${g.headError > 0 ? '有出错标记' : '无出错标记'}` : '无此组'; }); };
  await expect.poll(marks, { timeout: 10_000, message: '收起时：甲（静态、有出错）有标记，乙（全部成功）没有，丙（承载状态行、有出错）有标记' }).toEqual(['closed/false/有出错标记', 'closed/false/无出错标记', 'closed/true/有出错标记']);
  const heads = page.locator('[data-work-group-head]');
  const total = await heads.count();
  for (const n of [3, 2, 1]) await heads.nth(total - n).click({ timeout: 8_000 });
  await expect.poll(marks, { timeout: 10_000, message: '三个组都点开后：出错标记仍在甲和丙，乙仍没有' }).toEqual(['open/false/有出错标记', 'open/false/无出错标记', 'open/true/有出错标记']);
});

test('B14 用户点开过的组，正文开始后仍展开；没点过的仍收起', async ({ page }) => {
  const events = (n) => [{ kind: 'thinking', text: `B14 思考${n}。` }, bash(`B14 工具${n}`), { kind: 'wait', file: 'g1' }, { kind: 'text', text: `${TXT(14)}-${n} 正文。` }];
  for (const [n, clicked] of [[1, true], [2, false]]) {
    await startRound(page, { key: 'b14', scenario: { events: events(n) }, text: `请开始第 ${n} 轮` });
    await expectLiveGroup(page); // 工具都返回了、正文还没来：最后一个组承载状态行
    if (clicked) {
      await lastHead(page).click({ timeout: 8_000 });
      await expectState(page, 'open', 'true', `第 ${n} 轮前置：用户点开后应是 open`);
    }
    touchCtl('g1'); // 正文开始流出
    await expect(page.getByText(`${TXT(14)}-${n}`).first(), `第 ${n} 轮前置自证：正文应已画出来`).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => { const g = await gr(page); return g.state === undefined ? NONE : [g.live, g.state, g.expanded].join('|'); },
      { timeout: 10_000, message: `第 ${n} 轮（用户${clicked ? '点开过' : '没点过'}）：正文开始后组应是 live=false、${clicked ? '仍 open' : '仍 closed'}` }).toBe(clicked ? 'false|open|true' : 'false|closed|false');
    await endRound(page);
  }
});

test('B15 ①回合结束后所有工作组都收起且不再承载状态行；②聊天模式下没有工作组、状态行仍在回合底部', async ({ page }) => {
  await startRound(page, { key: 'b15', scenario: { events: [{ kind: 'thinking', text: 'B15 思考。' }, bash('B15 命令'), { kind: 'text', text: `${TXT(15)} 正文。` }] } });
  await expect(page.getByText(TXT(15)).first(), '①前置自证：正文应已画出来').toBeVisible({ timeout: 20_000 });
  await endRound(page);
  await expect.poll(async () => (await wgSnap(page)).lines, { timeout: 15_000, message: '①回合结束后：页面上不应有任何 [data-live-line]' }).toBe(0);
  // ① 的组断言用 soft：改动前它们会红，但要让 ② 照样跑完（② 改动前应是绿的）。
  const s = await wgSnap(page);
  expect.soft(s.groups.length, '①回合结束后页面上应有工作组（历史回合 + 本回合），不能一个都没有').toBeGreaterThan(0);
  expect.soft(s.groups.map((g) => `${g.state}|${g.live}`).filter((x) => x !== 'closed|false'), '①所有 [data-work-group] 都应是 closed 且 data-work-group-live=false（下列组不是）').toEqual([]);
  // ② 聊天模式：打开设置里的「聊天模式」后再造一个有工具调用的运行中回合
  await startRoundHook(page, {
    key: 'b15', text: '请开始第二轮',
    scenario: { events: [{ kind: 'thinking', text: 'B15 聊天模式思考。' }, bash('B15 聊天模式命令', { pending: 'd1' })] },
    beforeSend: async () => {
      await turnOnChatMode(page);
      expect(await page.locator('[data-strip-item]').count(), '②前置自证：聊天模式已打开（过程条条目全部折掉）').toBe(0);
    },
  });
  await waitLine(page, 'tool', 'B15 聊天模式命令'); // 前置自证：改动前聊天模式下底部状态行就是这样
  await page.waitForTimeout(1500);
  const c = await wgSnap(page);
  expect(c.groups.length, '②聊天模式下页面上不应有 [data-work-group]').toBe(0);
  expect([c.lines, c.linesInGroups], '②聊天模式下状态行仍在回合底部（不在任何工作组里），页面上恰为 1').toEqual([1, 0]);
  console.log('[B15] ②段（聊天模式）全部断言通过'); // 留痕：①在改动前会红，这行证明 ② 确实跑到了并通过
});
