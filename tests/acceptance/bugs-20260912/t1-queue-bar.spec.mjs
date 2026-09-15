// T-1xx · 排队消息只占一行（用户实报：长消息进排队后把排队条撑高，把输入框和正文往上顶）。
//
// 观测锚点（全部是产品公开钩子）：
//   [data-testid="queue-bar"]  排队条容器
//   [data-testid="queue-item"] 排队条目（li）
//   条目里带 title 的 span   = 消息文字那一行（悬停能看全文靠的就是它的 title）
//
// 预置（fixture）：排队队列从"持久化的待发队列"铺进去。**为什么不能像用户那样连发两条**：
//   排队是"回合进行中再发送"才产生的状态，本隔离实例没有可用凭据、起不了真回合；
//   而一条普通排队消息在本实例里进会话 1.5s 内就会被自动发出（这是产品的正常行为）。
//   所以夹具在队首放一条"并入结果无法确认"的条目 —— 它是产品自己的暂停态（界面上就写着
//   「并入结果无法确认，已暂停后续队列」），会挡住后面的条目不被自动发出，测量才稳定。
//   被测量的长消息本身是**普通排队条目**（无并入态、无额外按钮），与用户看到的形态一致。
import { test, expect } from '@playwright/test';
import { ensureFixtures } from './helpers/fixtures.mjs';
import { getRuntime, openApp, openSession } from './helpers/runtime.mjs';

const fx = ensureFixtures();
const lines = (n, tag) => Array.from({ length: n }, (_, i) =>
  `${tag}第 ${i + 1} 行：这一行足够长，用来把排队条目撑高，验证它是不是只占一行。`).join('\n');
const LONG_TEXT = lines(60, '六十行');
const SHORTER_TEXT = lines(6, '六行');

/** 一行的高度上限：字号 11px、行高 leading-snug ≈ 15px，留一倍余量。 */
const ONE_LINE_MAX_PX = 40;

async function openQueueFixture(page) {
  const { baseURL } = getRuntime();
  await page.addInitScript(([key, value]) => {
    try { window.localStorage.setItem(key, value); } catch { /* 隐私模式等 */ }
  }, ['cgui-message-queue', JSON.stringify({
    [fx.sessions.small]: [
      {
        text: '夹具：并入结果无法确认的条目（挡住后面的排队消息被自动发出）',
        queuedAt: 1789223000000, queueId: 'fixture-barrier', steerId: 'fixture-steer', steerState: 'needs-review',
      },
      { text: LONG_TEXT, queuedAt: 1789223000001, queueId: 'fixture-long-60' },
      { text: SHORTER_TEXT, queuedAt: 1789223000002, queueId: 'fixture-long-6' },
    ],
  })]);
  await openApp(page);
  await openSession(page, fx.markers.small);
  await expect(page.locator('[data-testid="queue-bar"]')).toBeVisible({ timeout: 20_000 });
  return baseURL;
}

/** 消息文字里第 1 行以什么开头 —— 就是这个夹具文案的前缀，用它认条目。 */
const queueItemWithTextStarting = (page, tag) =>
  page.locator('[data-testid="queue-item"]').filter({ has: page.locator(`span[title^="${tag}第 1 行"]`) });
const textSpan = (item) => item.locator('span[title]');

async function spanMetrics(item) {
  return await textSpan(item).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      height: Math.round(r.height),
      textLen: (el.textContent || '').length,
      titleEqualsText: el.getAttribute('title') === el.textContent,
    };
  });
}

test('T-101 长排队消息的排队条目高度不超过一行（修前 650px / 修后 38px）', async ({ page }) => {
  await openQueueFixture(page);
  const item = queueItemWithTextStarting(page, '六十行').first();
  await expect(item).toBeVisible();

  const liHeight = await item.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const span = await spanMetrics(item);

  // 原始数字留在报错里，失败时一眼看到"多高"而不是只有一句断言失败
  expect(span.textLen, '夹具消息本身必须是长文本（多行），否则这条用例测不到东西').toBeGreaterThan(1000);
  const tooTall = [];
  if (span.height > ONE_LINE_MAX_PX) tooTall.push(`文字行高 ${span.height}px`);
  if (liHeight > ONE_LINE_MAX_PX) tooTall.push(`整条高 ${liHeight}px`);
  expect(tooTall, `排队条目没被压成一行（上限 ${ONE_LINE_MAX_PX}px，60 行消息）：${tooTall.join('、')}`).toEqual([]);
});

test('T-102 排队条目高度不随消息长度变化（6 行与 60 行一样高）', async ({ page }) => {
  await openQueueFixture(page);
  const sixLines = queueItemWithTextStarting(page, '六行').first();
  const sixtyLines = queueItemWithTextStarting(page, '六十行').first();
  await expect(sixLines).toBeVisible();
  await expect(sixtyLines).toBeVisible();

  // 量的是"这一条自己的高度"。列表的分隔线（divide-y 只给非末条加 1px 下边框）属于
  // "排在列表第几位"，不属于"这条消息有多长" —— 单独量出来扣掉，不代表放宽判据：
  // 文字行高与扣除分隔线后的整条高度都必须与消息长度无关。
  const metricsOf = async (item) => await item.evaluate((el) => {
    const span = el.querySelector('span[title]');
    const border = parseFloat(getComputedStyle(el).borderBottomWidth || '0') || 0;
    return {
      li: Math.round(el.getBoundingClientRect().height),
      separator: Math.round(border),
      text: Math.round(span.getBoundingClientRect().height),
      textLen: (span.textContent || '').length,
    };
  });
  const short = await metricsOf(sixLines);
  const long = await metricsOf(sixtyLines);

  console.log(`[T-102] 60 行：条目 ${long.li}px（含分隔线 ${long.separator}px，净高 ${long.li - long.separator}px）文字行高 ${long.text}px`
    + ` / 6 行：条目 ${short.li}px（含分隔线 ${short.separator}px，净高 ${short.li - short.separator}px）文字行高 ${short.text}px`);
  expect(short.textLen, '夹具：六行那条确实是短一点的（长度不同才有可比性）').toBeLessThan(long.textLen);
  expect(
    long.text,
    `60 行消息的文字行高 ${long.text}px、6 行消息的文字行高 ${short.text}px —— 必须相等`,
  ).toBe(short.text);
  expect(
    long.li - long.separator,
    `60 行消息的条目净高 ${long.li - long.separator}px（${long.li}px 含 ${long.separator}px 分隔线）、`
    + `6 行消息的 ${short.li - short.separator}px（${short.li}px 含 ${short.separator}px 分隔线）—— 必须相等`,
  ).toBe(short.li - short.separator);
});

test('T-103 长排队消息悬停仍能看到全文（title 与原文逐字相同）', async ({ page }) => {
  await openQueueFixture(page);
  const item = queueItemWithTextStarting(page, '六十行').first();
  await expect(item).toBeVisible();
  const span = await spanMetrics(item);

  expect(span.textLen, '排队条目里的文字必须仍是完整原文（不能靠少渲染文字来"变矮"）').toBe(LONG_TEXT.length);
  expect(span.titleEqualsText, 'title 必须等于消息原文（悬停看全文这条既有能力不许被截断改坏）').toBe(true);
});

test('T-104 短排队消息本来就只占一行（防修复把正常形态改坏）', async ({ page }) => {
  await openQueueFixture(page);
  // 队首那条短条目（并入态，带按钮）——文字本身就短，任何情况下都该是一行。
  const shortItem = page.locator('[data-testid="queue-item"]').first();
  await expect(shortItem).toBeVisible();
  const span = await spanMetrics(shortItem);

  expect(span.textLen).toBeLessThan(100);
  expect(span.height, `短排队条目的文字行高 ${span.height}px`).toBeLessThanOrEqual(ONE_LINE_MAX_PX);
});
