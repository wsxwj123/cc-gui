// ui-live-line-v2：底部状态行按「最后一块」显示、工具阶段显示工具标题、折叠行文案。
//
// 判据来自任务单第 5 节 U1–U5（对外行为，只看页面上用户看得见的东西）：
//   U1 工具调用中 = 该工具调用的标题（不带动词前缀）；取不到标题才回落动词短语。
//   U2 思考中 =「思考 · <一行预览>」；取不到预览只写「思考」。
//   U3 正文流式 =「正在输出」；多轮回合里前面出现过正文、最后一块是思考 / 工具时不得显示「正在输出」。
//   U4 不变项：用时在文字前、空动词不留多余空格或分隔点。
//   U5 折叠行：含工具 =「<最后工具标题> · N 次工具调用」；只有思考 =「思考 · <预览>」。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import { touchCtl, primeOverlays, openApp, openSessionByMarker } from './helpers/runtime.mjs';
import {
  openAllGates, startRound, endRound, liveSnap, expectOneLine, expectPhase, noObject,
} from './helpers/live.mjs';

test.afterEach(async () => {
  try { openAllGates(); } catch { /* 忽略 */ }
});

/** [data-live-text] 的原始 textContent（不 trim：空动词时不能留下前后空格）。 */
const rawLiveText = (page) => page.locator('[data-live-line] [data-live-text]').first().textContent();

test('U1 工具调用中显示该工具调用的标题，不带动词前缀；没有标题的工具回落动词短语', async ({ page }) => {
  const BASH_DESC = '补两条回归测试并在未修代码上跑';
  await startRound(page, {
    key: 'u1',
    scenario: { events: [
      { kind: 'thinking', text: 'U1 想一下。' },
      { kind: 'tool', name: 'Bash', input: { command: 'ls', description: BASH_DESC }, pending: 'd1' },
      { kind: 'wait', file: 'g1' },
      { kind: 'tool', name: 'Task', input: { subagent_type: 'general-purpose', description: '查一下资料', prompt: 'p' }, pending: 'd2' },
      { kind: 'wait', file: 'g2' },
      { kind: 'tool', name: 'TodoWrite', input: { todos: [] }, pending: 'd3' },
    ] },
  });
  await expectOneLine(page);
  await expectPhase(page, 'tool');
  await expect.poll(async () => (await rawLiveText(page)) ?? '', { timeout: 20_000, message: 'Bash 阶段：底部行文字应恰为工具标题' }).toBe(BASH_DESC);
  let s = await liveSnap(page);
  expect(s.text, 'Bash：文字不得带「运行」前缀').not.toContain('运行');
  expect(noObject(s), 'Bash：标题应在 object 里，不应被拆成 verb + object').toBe(false);
  expect(s.verb, 'Bash：verb 应为空（不额外渲染动词）').toBeNull();
  expect(s.sep, '空动词但有标题时，用时与文字之间的分隔点仍在').toBe('·');

  touchCtl('g1');
  await expect.poll(async () => (await rawLiveText(page)) ?? '', { timeout: 20_000, message: 'Task 阶段：底部行文字应恰为子代理标题' }).toBe('查一下资料');
  s = await liveSnap(page);
  expect(s.text, 'Task：文字不得带「委派子代理」').not.toContain('委派子代理');

  touchCtl('g2');
  await expect.poll(async () => (await rawLiveText(page)) ?? '', { timeout: 20_000, message: 'TodoWrite 没有标题可取，应回落动词短语' }).toBe('更新任务清单');
  s = await liveSnap(page);
  expect(s.verb, '回落的动词短语写在 verb 里').toBe('更新任务清单');
  expect(noObject(s), '回落时没有 object').toBe(true);
});

test('U2 思考中显示「思考 · 一行预览」；取不到预览只写「思考」', async ({ page }) => {
  await startRound(page, {
    key: 'u2',
    scenario: { events: [
      { kind: 'thinking', text: '先确认一下入口在哪。' },
      { kind: 'wait', file: 'g1' },
      { kind: 'thinking', text: '入口找到了，下一步跑测试。' },
    ] },
  });
  await expectOneLine(page);
  await expectPhase(page, 'thinking');
  await expect.poll(async () => (await rawLiveText(page)) ?? '', { timeout: 20_000, message: '思考中：文字应为「思考 · 最新一句思考」' }).toBe('思考 · 先确认一下入口在哪。');
  let s = await liveSnap(page);
  expect(s.verb, '思考阶段 verb 应为「思考」').toBe('思考');
  expect(s.object, '预览放在 object 里').toBe('先确认一下入口在哪。');
  expect(s.text, '不再出现「正在思考」').not.toContain('正在思考');

  touchCtl('g1');
  await expect.poll(async () => (await rawLiveText(page)) ?? '', { timeout: 20_000, message: '新一块思考到达后，预览应换成最新一句' }).toBe('思考 · 入口找到了，下一步跑测试。');
  await endRound(page);

  // 取不到预览（最后一块是思考，但清洗后为空）→ 只写「思考」
  await startRound(page, {
    key: 'u2',
    scenario: { events: [{ kind: 'thinking', text: '   ' }] },
    text: '请开始无预览的一轮',
  });
  await expectOneLine(page);
  await expect.poll(async () => (await rawLiveText(page)) ?? '', { timeout: 20_000, message: '取不到预览时应只写「思考」' }).toBe('思考');
  s = await liveSnap(page);
  expect(s.verb, '无预览时 verb 仍是「思考」').toBe('思考');
  expect(noObject(s), '无预览时没有 object').toBe(true);
});

test('U3 多轮回合：前面出现过正文、最后一块是思考 / 工具时不得显示「正在输出」', async ({ page }) => {
  const TOOL_DESC = '最后一块是工具调用';
  await startRound(page, {
    key: 'u3',
    scenario: { events: [
      { kind: 'text', text: 'U3 前面先输出一段正文。' },
      { kind: 'wait', file: 'g1' },
      { kind: 'thinking', text: '现在改主意开始思考。' },
      { kind: 'wait', file: 'g2' },
      { kind: 'tool', name: 'Bash', input: { command: 'ls', description: TOOL_DESC }, pending: 'd1' },
    ] },
  });
  await expectOneLine(page);
  await expectPhase(page, 'text');
  expect(await rawLiveText(page), '正文流式时显示「正在输出」').toBe('正在输出');

  touchCtl('g1');
  await expectPhase(page, 'thinking');
  await expect.poll(async () => (await rawLiveText(page)) ?? '', { timeout: 20_000, message: '最后一块是思考时应显示「思考 · 预览」，不得沿用整轮的「正在输出」' }).toBe('思考 · 现在改主意开始思考。');
  expect((await rawLiveText(page)) ?? '', '最后一块是思考时不得显示「正在输出」').not.toContain('正在输出');

  touchCtl('g2');
  await expectPhase(page, 'tool');
  await expect.poll(async () => (await rawLiveText(page)) ?? '', { timeout: 20_000, message: '最后一块是工具时应显示工具标题' }).toBe(TOOL_DESC);
  expect((await rawLiveText(page)) ?? '', '最后一块是工具时不得显示「正在输出」').not.toContain('正在输出');
});

test('U4 空动词不留多余空格；用时仍在文字前，分隔点只有一个', async ({ page }) => {
  await startRound(page, {
    key: 'u4',
    scenario: { events: [{ kind: 'tool', name: 'Read', input: { file_path: '/p/q/brief.md' }, pending: 'd1' }] },
  });
  await expectOneLine(page);
  await expectPhase(page, 'tool');
  const raw = (await rawLiveText(page)) ?? '';
  expect(raw, '工具标题不应有前导 / 尾随空格').toBe('读取 brief.md');
  const s = await liveSnap(page);
  expect(s.order, '状态行顺序仍是 指示器 → 用时 → 分隔符 → 状态词').toEqual(['data-live-indicator', 'data-live-elapsed', 'data-live-sep', 'data-live-text']);
  expect((raw.match(/·/g) || []).length, '文字里不应再出现分隔点').toBe(0);
  expect(s.sep, '分隔点仍是用时与文字之间的那一个').toBe('·');
});

test('U5 折叠行：含工具 =「<最后工具标题> · N 次工具调用」；只有思考 =「思考 · 预览」', async ({ page }) => {
  // 历史回合（夹具：思考 + Bash(description) + 正文）→ 含工具的组
  await primeOverlays(page);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.u5.marker);
  const histLabel = 'u5 历史回合工具 · 1 次工具调用';
  await expect(page.getByText(histLabel, { exact: true }), '历史回合的折叠行应是「最后工具标题 · N 次工具调用」').toHaveCount(1, { timeout: 20_000 });
  expect(await page.getByText('思考 · 1 次工具调用', { exact: true }).count(), '不再出现「思考 · N 次工具调用」').toBe(0);

  // 直播回合：一组只有思考（后面直接是正文）→「思考 · 最新一句思考」
  await startRound(page, {
    key: 'u5',
    scenario: { events: [
      { kind: 'thinking', text: 'U5 第一句思考。' },
      { kind: 'thinking', text: 'U5 最新一句思考。' },
      { kind: 'text', text: 'U5 直播回合正文。' },
    ] },
    text: '请开始 U5 的一轮',
  });
  await expect(page.getByText('U5 直播回合正文。').first(), '前置自证：直播回合的正文应画出来').toBeVisible({ timeout: 30_000 });
  await endRound(page);
  await expect(page.getByText('思考 · U5 最新一句思考。', { exact: true }), '只有思考的折叠行应是「思考 · 预览」').toHaveCount(1, { timeout: 20_000 });
});
