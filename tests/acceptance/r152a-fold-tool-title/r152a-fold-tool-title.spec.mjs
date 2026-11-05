// r152a-fold-tool-title：折叠条文字 = 最新工具调用的标题（r152c 起折叠条只剩标题，前缀与计数挪进悬停提示）；直播期点阵动画 + 用时。
// 判据全部来自 .devflow/r152a-fold-tool-title-接口.md 的「行为清单」与「错误契约」，只看页面上用户能看到的东西：
//   [data-strip="head"] 的文字 / aria-expanded / [data-strip-live] / [data-strip-dots] / [data-strip-elapsed] / [data-strip-item][hidden]。
// 命名：Bn 对应行为清单第 n 条；B11 对应错误契约。
import { test, expect } from '@playwright/test';
import { SESSIONS, TITLE_ROWS, TOOL_ROWS, ERROR_ROWS, MISC, HIST_ROWS, LONG_TITLE } from './helpers/fixtures.mjs';
import {
  primeOverlays, openApp, openSessionByMarker, newSessionInFixtureProject, turnRows, stripSnapshot, stripRootOf,
  headOf, headParts, expectTail, parseElapsed, cpHead, collectPageErrors, sendMessage, sendInOpenSession,
  waitRoundIdle, writeScenario, releaseRound, touchCtl, resetCtl, scrollBox,
} from './helpers/runtime.mjs';

test.beforeEach(async ({ page }) => {
  resetCtl();
  await primeOverlays(page);
});

// 用例失败时直播回合会停在半路（假命令行在等放行文件）：把所有放行文件都放了，让它自己收尾，别拖累下一条。
test.afterEach(async () => {
  for (const name of ['done-b', 'done-c', 'go-c', 'go-d', 'go-finish']) touchCtl(name);
  releaseRound();
});

/** 历史回合：按收官正文找到这一轮，读折叠条末尾，与期望逐字比较（软断言：一次跑完列出所有不符的行）。 */
async function expectHistoryTail(page, round, label) {
  const row = turnRows(page).filter({ hasText: round.anchor }).first();
  await expect(row, `${label}：按收官正文「${round.anchor}」应能找到这一轮`).toHaveCount(1);
  await expect(headOf(row), `${label}：这一轮应有折叠条`).toHaveCount(1);
  const parts = await headParts(headOf(row));
  expect.soft(parts.matched, `${label}：折叠条应只有标题（[data-strip-title] 恰 1 个，除标题与用时外无其它文字），实际「${parts.text}」`).toBe(true);
  expect.soft(parts.tail, `${label}：折叠条标题（整句「${parts.text}」）`).toBe(round.expect);
}

test('B1 历史回合：Bash 带 description → 末尾是 description（清洗：空白折叠 / 成对记号 / 60 字符截断），不是思考', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.t.marker);
  await expect(turnRows(page)).toHaveCount(TITLE_ROWS.length, { timeout: 20_000 });
  const labels = ['普通 description', '前后空白与换行', '成对反引号', '恰好 60 个字符不截', '61 个字符截成 60+…',
    '第 60 个字符是 emoji 不拆开', 'markdown 成对记号剥掉', '零散记号原样保留', '非 Bash 工具有 description 也以它为先'];
  for (const [i, round] of TITLE_ROWS.entries()) await expectHistoryTail(page, round, `B1-${i + 1} ${labels[i]}`);
});

test('B2 历史回合：Bash 无 description 或 description 全是空白 → 末尾是 command 第一个非空行；都没有 → Bash', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.m.marker);
  await expect(turnRows(page)).toHaveCount(9, { timeout: 20_000 });
  await expectHistoryTail(page, MISC.b2a, 'B2-1 没有 description、多行 command 只取第一行');
  await expectHistoryTail(page, MISC.b2b, 'B2-2 description 全是空白、command 前有空行 → 第一个非空行');
  await expectHistoryTail(page, MISC.b2c, 'B2-3 既没有 description 也没有 command → 工具原名 Bash');
});

test('B3 历史回合：逐种工具的标题（读 / 改 / 写 / 搜 / 抓取 / 其它工具 / 未知工具 / MCP 工具 / 缺字段）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.r.marker);
  await expect(turnRows(page)).toHaveCount(TOOL_ROWS.length, { timeout: 20_000 });
  for (const round of TOOL_ROWS) await expectHistoryTail(page, round, `B3 ${round.label}`);
});

test('B4 历史回合：思考、Bash、思考、Read、思考（最后一块是思考）→ 末尾是最后一个工具 Read 的标题', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.m.marker);
  const rows = turnRows(page);
  await expect(rows).toHaveCount(9, { timeout: 20_000 });
  const parts = await headParts(headOf(rows.last())); // M9 排在会话最后，且没有收官正文
  expect(parts.matched, `折叠条应只有标题（[data-strip-title] 恰 1 个，除标题与用时外无其它文字），实际「${parts.text}」`).toBe(true);
  expect(parts.tail, `最后一块是思考时标题也取最后一个工具（不是甲 / 不是任何思考）；整句「${parts.text}」`).toBe(MISC.b4lastThink.expect);
});

test('B5 历史回合：纯思考保持思考预览；子代理卡不参与（卡后有 Bash 取它，卡后没有取卡前的）', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.m.marker);
  await expect(turnRows(page)).toHaveCount(9, { timeout: 20_000 });
  await expectHistoryTail(page, MISC.b5thinkOnly, 'B5-1 整轮只有思考 → 仍是最后一条思考的前 40 个字 + …');
  await expectHistoryTail(page, MISC.b5cardThenBash, 'B5-2 Task 卡之后又有 Bash → 末尾是卡后的 Bash（不是卡的标题）');
  await expectHistoryTail(page, MISC.b5cardLast, 'B5-3 Agent 卡之后没有通用工具、只有思考 → 末尾是卡前的 Bash');
});

test('B6 历史回合：标题很长 → 折叠条仍一行、900 / 1600 两种宽度页面都不出横向滚动，文字被省略号截断', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.m.marker);
  await expect(turnRows(page)).toHaveCount(9, { timeout: 20_000 });
  const longHead = headOf(turnRows(page).filter({ hasText: MISC.b6long.anchor }).first());
  const shortHead = headOf(turnRows(page).filter({ hasText: MISC.b7toggle.anchor }).first());
  const parts = await headParts(longHead);
  expect.soft(parts.tail, `长标题应是前 60 个字符 + …（整句「${parts.text}」）`).toBe(MISC.b6long.expect);

  const measure = async () => ({
    long: await longHead.evaluate((el) => ({ h: Math.round(el.getBoundingClientRect().height), over: el.scrollWidth - el.clientWidth })),
    shortH: await shortHead.evaluate((el) => Math.round(el.getBoundingClientRect().height)),
    docOver: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    boxOver: await (await scrollBox(page)).evaluate((el) => el.scrollWidth - el.clientWidth),
    // 装着长标题文字的那个元素，连同它到折叠条之间的祖先里，设了省略号截断的（并带上“被截了多少 px”）
    ellipsis: await longHead.evaluate((el, prefix) => {
      const hit = [...el.querySelectorAll('*')].filter((n) => (n.textContent || '').includes(prefix));
      const chain = [];
      for (let n = hit.length ? hit[hit.length - 1] : null; n && n !== el.parentElement; n = n.parentElement) chain.push(n);
      return chain.filter((n) => getComputedStyle(n).textOverflow === 'ellipsis').map((n) => n.scrollWidth - n.clientWidth);
    }, cpHead(LONG_TITLE, 8)),
  });
  const seen = {};
  for (const width of [900, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(500);
    const m = await measure();
    seen[width] = m;
    expect(m.long.h - m.shortH, `${width}px：长标题的折叠条不得比短标题的更高（恒 1 行）`).toBeLessThanOrEqual(2);
    expect(m.long.over, `${width}px：折叠条自身不得横向溢出`).toBeLessThanOrEqual(1);
    expect(m.docOver, `${width}px：页面不得出现横向滚动`).toBeLessThanOrEqual(1);
    expect(m.boxOver, `${width}px：消息区不得出现横向滚动`).toBeLessThanOrEqual(1);
  }
  console.log('[B6] 折叠条度量（窄 900 / 宽 1600）', JSON.stringify(seen));
  expect(Math.abs(seen[900].long.h - seen[1600].long.h), '两档宽度下折叠条高度一样（恒 1 行）').toBeLessThanOrEqual(2);
  expect(seen[900].ellipsis.length, '装长标题文字的元素（或其祖先）应设了省略号截断（text-overflow: ellipsis）').toBeGreaterThanOrEqual(1);
  expect(Math.max(0, ...seen[900].ellipsis), '900px 下长标题放不下，必须真被省略号截断（被截部分 > 0px）').toBeGreaterThan(0);
});

test('B7 历史回合：点击折叠条展开再收起 → aria-expanded 与各段 hidden 来回切换，三次读到的文案完全相同', async ({ page }) => {
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.m.marker);
  await expect(turnRows(page)).toHaveCount(9, { timeout: 20_000 });
  const row = turnRows(page).filter({ hasText: MISC.b7toggle.anchor }).first();
  const before = await stripSnapshot(row);
  expect(before.headAria, '初始收起').toBe('false');
  expect(before.hiddenKinds, '收起态可折段带 hidden').toEqual(['group']);

  await headOf(row).click();
  const open = await stripSnapshot(row);
  expect(open.headAria, '点一下展开').toBe('true');
  expect(open.hiddenKinds, '展开后可折段不带 hidden').toEqual([]);

  await headOf(row).click();
  const closed = await stripSnapshot(row);
  expect(closed.headAria, '再点一下收起').toBe('false');
  expect(closed.hiddenKinds, '收起后可折段重新带 hidden').toEqual(['group']);
  expect(open.headText, '展开后折叠条文案与展开前完全相同').toBe(before.headText);
  expect(closed.headText, '收起后折叠条文案与展开前完全相同').toBe(before.headText);
});

/** 全页范围内：头行 4 点动画 / 用时（r154 R3 起头行不再有，恒为 0）、直播标记、底部状态行各有几个（历史回合应一个都没有）。 */
const liveMarks = async (scope) => ({
  dots: await scope.locator('[data-strip-dots]').count(),
  elapsed: await scope.locator('[data-strip-elapsed]').count(),
  live: await scope.locator('[data-strip-live]').count(),
  line: await scope.locator('[data-live-line]').count(),
});

// r154 R3 换锚：点阵动画与用时从折叠条头行挪到了页面底部的状态行 [data-live-line]（[data-live-elapsed]）；
// 本条守护的意图不变——直播标记只属于正在生成的这一轮、用时每秒走、结束后全部消失、历史回合没有——只是判据换到新位置。
test('B8 直播回合：折叠条带直播标记，头行没有 4 点动画与用时（r154 R3 起挪到底部状态行），状态行的用时每秒增加；结束后直播标记与状态行消失；同页历史回合从头到尾没有', async ({ page }) => {
  const LIVE = 'R152A-B8 直播正文。';
  writeScenario({
    events: [
      { kind: 'thinking', text: 'B8 先想一想。' },
      { kind: 'tool', name: 'Bash', input: { command: 'ls', description: 'B8 直播工具标题' }, result: 'ok' },
      { kind: 'text', text: LIVE },
    ],
    holdBeforeResult: true, // 假命令行停在 result 之前：回合保持“正在生成”
  });
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.h.marker);
  await expect(turnRows(page)).toHaveCount(HIST_ROWS.length, { timeout: 20_000 });
  expect(await liveMarks(page.locator('body')), '发消息之前：历史回合没有任何直播标记，也没有底部状态行').toEqual({ dots: 0, elapsed: 0, live: 0, line: 0 });

  await sendInOpenSession(page, 'B8 跑一轮');
  const root = stripRootOf(page, LIVE);
  await expect(root, '正在生成的回合应画出折叠条').toHaveCount(1, { timeout: 40_000 });
  const head = headOf(root);
  await expect(head, '生成中折叠条带 data-strip-live="true"').toHaveAttribute('data-strip-live', 'true');
  await expect(head.locator('[data-strip-dots]'), 'r154 起折叠条头行里不再有 4 点动画').toHaveCount(0);
  await expect(head.locator('[data-strip-elapsed]'), 'r154 起折叠条头行里不再有用时').toHaveCount(0);
  const lineElapsed = page.locator('[data-live-line] [data-live-elapsed]');
  await expect(page.locator('[data-live-line]'), '整页恰有 1 个底部状态行').toHaveCount(1);
  const readLineElapsed = async () => ((await lineElapsed.first().textContent()) || '').trim();
  const t0 = await readLineElapsed();
  expect(t0, '状态行用时文字形如 12s 或 2m 22s').toMatch(/^(\d+m )?\d+s$/);
  const s0 = parseElapsed(t0);
  await expect.poll(async () => parseElapsed(await readLineElapsed()), { timeout: 10_000, message: `状态行用时应每秒增加（起点 ${t0}）` })
    .toBeGreaterThan(s0);
  expect(await liveMarks(page.locator('body')), '整页只有正在生成的这一条带直播标记；头行无点阵与用时；底部状态行恰 1 个')
    .toEqual({ dots: 0, elapsed: 0, live: 1, line: 1 });
  for (const h of HIST_ROWS) {
    const histRow = turnRows(page).filter({ hasText: h.anchor }).first();
    expect(await liveMarks(histRow), `生成中：历史回合 ${h.key} 不得有 4 点动画 / 用时 / 直播标记 / 状态行`).toEqual({ dots: 0, elapsed: 0, live: 0, line: 0 });
  }

  releaseRound();
  await waitRoundIdle(page);
  await expectTail(headOf(stripRootOf(page, LIVE)), 'B8 直播工具标题', '回合结束后：末尾是最后一个工具的标题');
  await expect.poll(async () => await liveMarks(page.locator('body')), { timeout: 15_000, message: '回合结束后：直播标记与底部状态行全部消失（头行本来就没有点阵与用时）' })
    .toEqual({ dots: 0, elapsed: 0, live: 0, line: 0 });
});

test('B9 直播回合：最新工具 = 最后一个还没结果的；都有结果取最后一个（甲有结果乙在跑→乙；乙回结果→乙；丙在跑→丙；丁已回→仍丙；丙回→丁）', async ({ page }) => {
  const M = (n) => `R152A-B9-${n}`;
  const bash = (d) => ({ command: 'echo b9', description: d });
  writeScenario({
    events: [
      { kind: 'thinking', text: 'B9 先想一想。' },
      { kind: 'tool', name: 'Bash', input: bash('B9 工具甲'), result: 'ok' },
      { kind: 'tool', name: 'Bash', input: bash('B9 工具乙'), pending: 'done-b', afterText: M('AFTER-B') },
      { kind: 'text', text: M('MARK-1') },
      { kind: 'wait', file: 'go-c' },
      { kind: 'tool', name: 'Bash', input: bash('B9 工具丙'), pending: 'done-c', afterText: M('AFTER-C') },
      { kind: 'text', text: M('MARK-2') },
      { kind: 'wait', file: 'go-d' },
      { kind: 'tool', name: 'Bash', input: bash('B9 工具丁'), result: 'ok' },
      { kind: 'text', text: M('MARK-3') },
    ],
    holdBeforeResult: true,
  });
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.l9.marker);
  await sendInOpenSession(page, 'B9 跑一轮');
  const root = stripRootOf(page, M('MARK-1'));
  await expect(root).toHaveCount(1, { timeout: 40_000 });
  const head = headOf(root);
  const seen = (t) => expect(page.getByText(t).first(), `等「${t}」出现（它排在对应工具结果之后，出现即说明结果已送达页面）`).toBeVisible({ timeout: 20_000 });

  await expectTail(head, 'B9 工具乙', '甲有结果、乙已发出还没结果 → 末尾是乙');
  touchCtl('done-b'); await seen(M('AFTER-B'));
  await expectTail(head, 'B9 工具乙', '乙有结果后（都有结果）→ 仍是乙（最后一个）');
  touchCtl('go-c'); await seen(M('MARK-2'));
  await expectTail(head, 'B9 工具丙', '丙发出且还没结果 → 是丙');
  touchCtl('go-d'); await seen(M('MARK-3'));
  await expectTail(head, 'B9 工具丙', '丁已有结果、丙还在跑 → 取还在跑的丙（不是最后一个丁）');
  touchCtl('done-c'); await seen(M('AFTER-C'));
  await expectTail(head, 'B9 工具丁', '丙也回了结果（都有结果）→ 最后一个丁');
  releaseRound();
  await waitRoundIdle(page);
  await expectTail(headOf(stripRootOf(page, M('MARK-1'))), 'B9 工具丁', '回合结束后：最后一个工具丁');
});

test('B10 直播回合：新工具丙刚开始、入参还没传完 → 末尾仍是甲；入参传完后换成丙自己的标题', async ({ page }) => {
  writeScenario({
    events: [
      { kind: 'thinking', text: 'B10 先想一想。' },
      { kind: 'tool', name: 'Bash', input: { command: 'echo a', description: 'B10 工具甲' }, result: 'ok' },
      // 丙按真实流式形态发：content_block_start(input:{}) + input_json_delta 分段；最后一段卡在 go-finish 之前
      { kind: 'tool', name: 'Bash', input: { command: 'echo c', description: 'B10 工具丙' }, result: 'ok',
        streamChunks: ['', '{"descr', 'iption":"B10 工具丙","command":"echo c"}'], streamGate: 'go-finish' },
      { kind: 'text', text: 'R152A-B10-MARK' },
    ],
    holdBeforeResult: true,
  });
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.l10.marker);
  await sendInOpenSession(page, 'B10 跑一轮');
  const root = page.locator('[data-strip-root]').last(); // 会话里一个历史回合 + 正在生成的这一轮：取最后一条
  await expect(root).toHaveCount(1, { timeout: 40_000 });
  // 前置自证：丙的工具块已经画出来了（思考 + 甲 + 丙 = 3 步），否则“入参未传完”这个现场没造出来，后面的断言没有意义
  await expect.poll(async () => await root.getAttribute('data-strip-steps'), {
    timeout: 30_000, message: '夹具自证失败：页面没有为“入参还没传完”的工具丙画出工具块（步数没到 3）',
  }).toBe('3');
  const head = headOf(root);
  await expectTail(head, 'B10 工具甲', '丙入参未传完（输入为空、没有结果）→ 末尾仍是它之前最近一个有标题的工具甲');

  touchCtl('go-finish');
  await expectTail(head, 'B10 工具丙', '丙的入参传完后 → 换成丙自己的标题');
  releaseRound();
  await waitRoundIdle(page);
  await expectTail(headOf(page.locator('[data-strip-root]').last()), 'B10 工具丙', '回合结束后：最后一个工具丙');
});

test('B11 错误契约：工具入参异常（不是对象 / 字段类型不对 / 奇怪字符）→ 不抛错、不白屏，标题退回工具原名', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openApp(page);
  await openSessionByMarker(page, SESSIONS.e.marker);
  await expect(turnRows(page), '7 个异常入参的回合都应画出来（没白屏）').toHaveCount(ERROR_ROWS.length, { timeout: 20_000 });
  for (const round of ERROR_ROWS) {
    const row = turnRows(page).filter({ hasText: round.anchor }).first();
    await expect(headOf(row), `B11 ${round.label}：这一轮应有折叠条`).toHaveCount(1);
    const parts = await headParts(headOf(row));
    expect.soft(round.expectAny, `B11 ${round.label}：折叠条标题应在合规取值内（整句「${parts.text}」，实际标题 ${JSON.stringify(parts.tail)}）`)
      .toContain(parts.tail);
  }
  expect(await page.evaluate(() => window.__r152a_xss), 'description 里的 <script> 只能当文字，不能被执行').toBeUndefined();
  expect(errors, '页面不得有未捕获异常').toEqual([]);
});
