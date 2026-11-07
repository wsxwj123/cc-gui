// r157-live-line 判官保留项:F2 计划被拒不算出错 / F3 提问组同样默认收起。
// (原 F1「收起整条过程条后状态行仍可见」、F4「收起整条过程条后只剩头行」测的是「总栏」,功能已按用户要求去掉,r159 起退役。)
// 只用接口文件列出的锚点([data-work-group*]、[data-live-*]、[data-entry-state]);不读源码、不读 React state。夹具会话:F2→b17、F3→b18。
import { test, expect } from '@playwright/test';
import { openAllGates, startRound } from './helpers/live.mjs';
import { bash, gr, expectLiveGroup, waitLine } from './helpers/wg.mjs';

test.afterEach(async () => { try { openAllGates(); } catch { /* 忽略 */ } });

const NONE = '页面上没有任何 [data-work-group]';

/** 头行文字含 needle 的那个工作组:状态、头行出错标记个数、组内条目的 data-entry-state 列表。 */
async function groupByHead(page, needle) {
  return await page.evaluate((nd) => {
    const g = [...document.querySelectorAll('[data-work-group]')].reverse()
      .find((x) => { const h = x.querySelector('[data-work-group-head]'); return h && h.textContent.includes(nd); });
    if (!g) return null;
    const head = g.querySelector('[data-work-group-head]');
    return {
      state: g.getAttribute('data-work-group-state'),
      headError: head.querySelectorAll('[data-work-group-error]').length,
      entryStates: [...g.querySelectorAll('[data-entry-state]')].map((e) => e.getAttribute('data-entry-state')),
    };
  }, needle);
}

test('F2 计划被要求修改(ExitPlanMode 被拒)不算出错:该组头行没有出错标记,条目是 done;真正出错的 Bash 组仍有标记', async ({ page }) => {
  const PLAN = 'F2 提交计划';
  const BAD = 'F2 出错的命令';
  await startRound(page, { key: 'b17', scenario: { events: [
    { kind: 'tool', name: 'ExitPlanMode', input: { plan: '1. 先做甲\n2. 再做乙', description: PLAN },
      result: '用户要求修改计划:请补充测试步骤。请按反馈调整后再次调用 ExitPlanMode 重新提交。', isError: true },
    { kind: 'text', text: 'R157-F2-TEXT-1 正文一。' },
    bash(BAD, { result: '命令失败了', isError: true }),
    { kind: 'text', text: 'R157-F2-TEXT-2 正文二。' },
  ] } });
  await expect(page.getByText('R157-F2-TEXT-2').first(), '前置自证:第二段正文应已画出来').toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => { const b = await groupByHead(page, BAD); return b ? b.headError > 0 : '找不到头行含「F2 出错的命令」的工作组'; },
    { timeout: 10_000, message: '真正出错的 Bash 所在组的头行应有 [data-work-group-error](防止一律不显)' }).toBe(true);
  const p = await groupByHead(page, PLAN);
  expect(p, '应能找到头行含「F2 提交计划」的工作组').not.toBeNull();
  expect(p.headError, '计划被要求修改的 ExitPlanMode 所在组头行不应有 [data-work-group-error]').toBe(0);
  if (p.state !== 'open') await page.locator('[data-work-group-head]', { hasText: PLAN }).last().click({ timeout: 8_000 });
  await expect.poll(async () => (await groupByHead(page, PLAN))?.entryStates.join(',') ?? NONE,
    { timeout: 8_000, message: '点开后 ExitPlanMode 条目的 data-entry-state 应是 done(与头行口径一致)' }).toBe('done');
  expect((await groupByHead(page, PLAN)).headError, '展开后头行仍不应有出错标记').toBe(0);
});

test('F3 运行中最后一组里有还没回答的 AskUserQuestion:该组同样默认收起并承载状态行', async ({ page }) => {
  await startRound(page, { key: 'b18', scenario: { events: [
    { kind: 'thinking', text: 'F3 先想一想。' },
    { kind: 'tool', name: 'AskUserQuestion', pending: 'd1', input: { questions: [{
      question: 'F3 选哪个?', header: '选择', multiSelect: false,
      options: [{ label: '甲', description: '选甲' }, { label: '乙', description: '选乙' }],
    }] } },
  ] } });
  await waitLine(page, 'tool');
  await expectLiveGroup(page, { phase: 'tool' }); // 前置自证:最后一组承载着状态行
  await expect.poll(async () => { const g = await gr(page); return g.state === undefined ? NONE : [g.state, g.live, g.headLines].join('|'); },
    { timeout: 10_000, message: '含未回答提问的最后一组应 closed、live=true、头行里恰 1 个状态行' }).toBe('closed|true|1');
  await page.waitForTimeout(1000);
  expect((await gr(page)).state, '稳定 1 秒后仍应 closed').toBe('closed');
});
