// B. 会话费用(行为 4、5)。种子会话直写 jsonl(用量可控;Q05 用 claude-sonnet-4-5,Q04 用按提示量分档计价的 claude-haiku-5-5),真实 App 里读头部与回复气泡上的费用。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, claudeDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { readText } from '../r151b-xsession-p1/helpers/api.mjs';
import { boot, openSessionBySearch } from '../r151b-xsession-p1/helpers/ui.mjs';
import { seedCostSession, costFacts } from './helpers/cost.mjs';

test.describe.configure({ timeout: 150_000 });
const SETTINGS = () => path.join(claudeDir(homeDir()), 'settings.json');
let prevSettings = null;
// 临时 HOME 里没有任何凭证时界面按"订阅包月"口径一律不显示金额;给一份假 token 把口径钉成按量付费(假 CLI 用不到它)
test.beforeEach(() => { prevSettings = readText(SETTINGS()); fs.writeFileSync(SETTINGS(), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-r151q-local-billing-pin' } })); });
test.afterEach(() => { if (prevSettings === null) fs.rmSync(SETTINGS(), { force: true }); else fs.writeFileSync(SETTINGS(), prevSettings); });
const NOTE = '按当前价目表估算';

const CTX_BTN = /\d+(\.\d+)?[kKM]?\/\d+(\.\d+)?[kKM]? \(\d+%\)/;
/** 点开会话头部的"上下文"按钮(会话信息 / 统计弹层),返回弹层里新增的文字行与页面上的金额节点。 */
async function openStats(page) {
  const before = new Set((await page.evaluate(() => document.body.innerText)).split('\n'));
  await page.getByRole('button', { name: CTX_BTN }).first().click();
  await page.waitForTimeout(800);
  const added = (await page.evaluate(() => document.body.innerText)).split('\n').filter((l) => l.trim() && !before.has(l));
  return { added, facts: await costFacts(page) };
}

// claude-haiku-5-5 的公开报价(美元 / 每百万 token),分两档:单次调用的提示 token = input + cache_read + cache_creation 三项相加,
// 严格大于 100,000 时这一整次调用按高档计价,否则按基础档。高档每一项恰好是基础档的 5 倍。
const QUOTE = {
  threshold: 100_000,
  base: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125 },
  high: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625 },
};
const usdAtTier = (tier, u) => {
  const p = QUOTE[tier];
  return (u.input * p.input + u.output * p.output + (u.cacheRead || 0) * p.cacheRead + (u.cacheCreate || 0) * p.cacheWrite5m) / 1e6;
};
const usdByQuote = (u) => usdAtTier(u.input + (u.cacheRead || 0) + (u.cacheCreate || 0) > QUOTE.threshold ? 'high' : 'base', u);
const usd4 = (n) => n.toFixed(4);
const AMOUNT = /[$¥￥]\s?\d[\d,]*(?:\.(\d+))?/;
/** 界面上一个金额显示精度的一个单位(至少按两位小数算),用来给"加起来相等"留出取整误差。 */
function displayUnit(row) {
  const shown = [row.text, row.attr].find((t) => t && AMOUNT.test(t)) || '';
  return 10 ** -Math.max(2, (shown.match(AMOUNT)?.[1] || '').length);
}
const brief = (r) => ({ text: r.text, amount: r.amount, tag: r.tag, cgui: r.cgui, top: r.top, 悬停提示末尾: r.attr ? r.attr.slice(-120) : null });

test('Q04 消息全部已加载、其中一条回复(claude-haiku-5-5)的提示量跨过长上下文分档 → 头部费用 = 各回复气泡费用之和且按分档计价,不显示估算说明', async ({ page }) => {
  // 两条回复、没有更早消息未加载:先一条提示 2 万(基础档),再一条提示 15 万(高档)。
  // 输出各 4 万:haiku 很便宜,输出给少了两条的金额都会被界面取整吃掉,"逐条计价"和"整体一把算"就分不出来
  const replies = [{ input: 20_000, output: 40_000 }, { input: 150_000, output: 40_000 }];
  const S = seedCostSession({ tag: 'q04', model: 'claude-haiku-5-5', replies });
  await boot(page);
  await openSessionBySearch(page, S.firstText, S.lastText);
  await expect.poll(async () => (await costFacts(page)).rows.filter((r) => r.inList).length, { timeout: 15_000, message: '两条回复气泡上都应显示费用' }).toBe(2);
  const { added, facts } = await openStats(page);
  const afterText = await page.evaluate(() => document.body.innerText);
  const bubbles = facts.rows.filter((r) => r.inList && r.visible).sort((a, b) => a.top - b.top); // 从上到下 = 先基础档、后高档
  const header = facts.rows.filter((r) => !r.inList && r.visible);
  const wantUsd = replies.map(usdByQuote);
  const allBaseUsd = replies.reduce((n, u) => n + usdAtTier('base', u), 0);
  const noteLines = afterText.split('\n').filter((l) => l.includes('估算'));
  // 断言失败信息里放精简版(报价 + 界面金额);节点明细、悬停提示、新增文字只在下面的 console.log 里打印一次
  const dump = `\n按公开报价算(美元):基础档那条 ${usd4(wantUsd[0])}、高档那条 ${usd4(wantUsd[1])},合计 ${usd4(wantUsd[0] + wantUsd[1])};若全部 token 都按基础档:${usd4(allBaseUsd)}`
    + `\n界面上:气泡金额(从上到下)${JSON.stringify(bubbles.map((r) => r.text))},头部金额节点${JSON.stringify(header.map((r) => r.text))}`;
  console.log(`[Q04 实测明细]${dump}\n气泡节点:${JSON.stringify(bubbles.map(brief))}\n头部/弹层金额节点:${JSON.stringify(header.map(brief))}`
    + `\n点开头部统计后新增的文字:${JSON.stringify(added).slice(0, 1500)}\n页面上含"估算"的行:${JSON.stringify(noteLines)}`);
  expect(bubbles.length, `前置:消息区里应恰好有 2 条回复气泡费用${dump}`).toBe(2);
  expect(header.length, `前置:头部统计里应有费用${dump}`).toBeGreaterThan(0);
  expect(bubbles[0].amount, `前置:基础档那条回复的气泡应显示出非零金额(要拿它反推"界面金额 ÷ 美元"的比例)${dump}`).toBeGreaterThan(0);

  // ① 头部费用 = 各回复气泡费用之和(容许界面取整:头部和每个气泡各差最多一个显示单位)
  const sum = bubbles.reduce((n, r) => n + r.amount, 0);
  const tolerance = [header[0], ...bubbles].reduce((n, r) => n + displayUnit(r), 0);
  expect.soft(Math.abs(header[0].amount - sum), `头部费用 ${header[0].amount} 应等于各回复气泡费用之和 ${sum}(容许界面取整误差 ${tolerance.toFixed(4)})${dump}`).toBeLessThanOrEqual(tolerance + 1e-9);

  // ② 按分档计价:头部费用明显高于"全部 token 都按基础档"。界面金额与美元的比例,用基础档那条气泡反推(基础档与分档逻辑无关)
  const rate = bubbles[0].amount / wantUsd[0];
  const allBaseShown = rate * allBaseUsd;
  expect.soft(header[0].amount, `头部费用 ${header[0].amount} 应明显高于"全部 token 都按基础档"的 ${allBaseShown.toFixed(3)}(= 报价 ${usd4(allBaseUsd)} 美元 × 界面/美元比例 ${rate.toFixed(2)};至少 2 倍)${dump}`).toBeGreaterThan(2 * allBaseShown);

  // ③ 全部消息已加载:不显示"按当前价目表估算"的说明(页面可见文字里没有,金额节点的悬停提示里也没有)
  const noteVisible = afterText.includes(NOTE);
  const noteInTooltips = facts.rows.some((r) => r.visible && (r.attr || '').includes(NOTE));
  expect.soft(noteVisible || noteInTooltips, `全部消息已加载时不应显示"${NOTE}"的说明(页面可见文字里有:${noteVisible};金额节点悬停提示里有:${noteInTooltips};含"估算"的行:${JSON.stringify(noteLines)})${dump}`).toBe(false);
});

test('Q05 (相邻) 还有更早消息未加载(300 条会话只载最近一屏)→ 费用旁显示估算说明,统计范围写全量条数', async ({ page }) => {
  const S = seedCostSession({ tag: 'q05', replies: Array.from({ length: 150 }, () => ({ input: 1_000, output: 200 })) });
  await boot(page);
  await openSessionBySearch(page, S.firstText, S.lastText);
  await expect(page.getByText(/进度范围\s*\d+\/300/).first(), '前置:只载入了最近一段(更早的消息还没加载)').toBeVisible({ timeout: 15_000 });
  const { added } = await openStats(page);
  const text = added.join('\n');
  expect.soft(text.includes(NOTE), `还有更早消息没加载时应显示"${NOTE}"的说明(点开后新增的文字:${JSON.stringify(added).slice(0, 1200)})`).toBe(true);
  expect.soft(/统计范围[::]\s*全量\s*300\s*条/.test(text), `统计范围应写全量 300 条(点开后新增的文字:${JSON.stringify(added).slice(0, 1200)})`).toBe(true);
});
