// r157-live-line 判官保留项:F1 收起整条过程条后状态行仍可见 / F2 计划被拒不算出错 / F3 提问组同样默认收起。
// 只用接口文件列出的锚点([data-work-group*]、[data-live-*]、[data-strip="head"] 及其 data-strip-live / aria-expanded、
// [data-entry-state]);不读源码、不读 React state。夹具会话:F1→b16、F2→b17、F3→b18。
import { test, expect } from '@playwright/test';
import { openAllGates, startRound } from './helpers/live.mjs';
import { bash, gr, expectLiveGroup, waitLine } from './helpers/wg.mjs';

test.afterEach(async () => { try { openAllGates(); } catch { /* 忽略 */ } });

const NONE = '页面上没有任何 [data-work-group]';

/** 页面上所有 [data-live-line] 的事实:总数、第一个是否肉眼可见(有面积、祖先无 hidden / display:none / visibility:hidden)、状态词。 */
async function lineFacts(page) {
  return await page.evaluate(() => {
    const ls = [...document.querySelectorAll('[data-live-line]')];
    const l = ls[0];
    if (!l) return { count: 0, visible: false, text: null };
    let visible = true;
    for (let p = l; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (p.hasAttribute('hidden') || cs.display === 'none' || cs.visibility === 'hidden') { visible = false; break; }
    }
    const r = l.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) visible = false;
    const t = l.querySelector('[data-live-text]');
    return { count: ls.length, visible, text: t ? t.textContent.replace(/\s+/g, ' ').trim() : null };
  });
}

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

const liveStripHead = (page) => page.locator('[data-strip="head"][data-strip-live="true"]').last();

test('F1 运行中收起整条过程条(总摘要行)后,状态行仍恰为 1 且看得见,状态词不变', async ({ page }) => {
  const DESC = 'F1 一直没返回的命令';
  await startRound(page, { key: 'b16', scenario: { events: [{ kind: 'text', text: 'R157-F1-TEXT 先有一条正文。' }, bash(DESC, { pending: 'd1' })] } });
  await waitLine(page, 'tool', DESC);
  await expectLiveGroup(page, { phase: 'tool', text: DESC }); // 前置自证:最后一个工作组承载着状态行
  await liveStripHead(page).click({ timeout: 8_000 });
  await expect(liveStripHead(page), '前置自证:本回合总摘要行应已收起').toHaveAttribute('aria-expanded', 'false', { timeout: 8_000 });
  await page.waitForTimeout(300);
  const f = await lineFacts(page);
  expect([f.count, f.visible, f.text], '收起整条过程条后:状态行应恰为 1、肉眼可见、状态词仍是工具的 description').toEqual([1, true, DESC]);
  await liveStripHead(page).click({ timeout: 8_000 });
  await expect(liveStripHead(page), '再点一次应展开').toHaveAttribute('aria-expanded', 'true', { timeout: 8_000 });
  const g = await lineFacts(page);
  expect([g.count, g.visible], '重新展开后状态行仍恰为 1、可见').toEqual([1, true]);
});

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

test('F4 收起整条过程条后承载状态行的组只剩头行(条目不可见);点这个头行会把过程条重新展开、该组展开', async ({ page }) => {
  const DESC = 'F4 一直没返回的命令';
  await startRound(page, { key: 'b16', scenario: { events: [{ kind: 'text', text: 'R157-F4-TEXT 先有一条正文。' }, bash(DESC, { pending: 'd1' })] } });
  await waitLine(page, 'tool', DESC);
  await expectLiveGroup(page, { phase: 'tool', text: DESC }); // 前置自证:最后一个工作组承载着状态行
  const groupHead = () => page.locator('[data-work-group-head]').filter({ hasText: DESC }).last();
  await groupHead().click({ timeout: 8_000 }); // 用户先把这一组点开
  await expect.poll(async () => (await gr(page)).entriesShown, { timeout: 8_000, message: '前置自证:点开后组内条目应可见' }).toBeGreaterThan(0);
  await liveStripHead(page).click({ timeout: 8_000 }); // 再收起整条过程条
  await expect(liveStripHead(page), '前置自证:本回合总摘要行应已收起').toHaveAttribute('aria-expanded', 'false', { timeout: 8_000 });
  await expect.poll(async () => (await gr(page)).entriesShown, { timeout: 8_000, message: '收起整条过程条后,承载状态行的组只剩头行,组内条目(运行中的小圆环等)不应可见' }).toBe(0);
  expect((await lineFacts(page)).visible, '收起时承载状态行的头行仍应可见').toBe(true);
  await groupHead().click({ timeout: 8_000 }); // 点这个头行
  await expect(liveStripHead(page), '点承载状态行的组头行后过程条应重新展开').toHaveAttribute('aria-expanded', 'true', { timeout: 8_000 });
  await expect.poll(async () => { const g = await gr(page); return [g.state, g.entriesShown > 0].join('|'); }, { timeout: 8_000, message: '点头行后该组应展开且条目可见' }).toBe('open|true');
});
