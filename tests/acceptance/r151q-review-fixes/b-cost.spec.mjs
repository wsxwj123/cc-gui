// B. 会话费用(行为 4、5)。种子会话直写 jsonl(模型 claude-sonnet-4-5,用量可控),真实 App 里读头部与回复气泡上的费用。
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

test('Q04 消息全部已加载、其中一条回复用量跨过长上下文分档 → 头部费用 = 各回复气泡费用之和,且不显示估算说明', async ({ page }) => {
  // 三条回复:15 万 / 25 万(跨 20 万分档)/ 2 千 输入 token
  const S = seedCostSession({ tag: 'q04', replies: [{ input: 150_000, output: 1_000 }, { input: 250_000, output: 1_000 }, { input: 2_000, output: 500 }] });
  await boot(page);
  await openSessionBySearch(page, S.firstText, S.lastText);
  await expect.poll(async () => (await costFacts(page)).rows.filter((r) => r.inList).length, { timeout: 15_000, message: '三条回复气泡上都应显示费用' }).toBe(3);
  const { added, facts } = await openStats(page);
  const bubbles = facts.rows.filter((r) => r.inList && r.visible);
  const header = facts.rows.filter((r) => !r.inList && r.visible);
  const sum = bubbles.reduce((n, r) => n + r.amount, 0);
  const dump = `\n气泡费用:${JSON.stringify(bubbles.map((r) => r.amount))};头部/弹层金额节点:${JSON.stringify(header.map((r) => r.text))}\n点开头部统计后新增的文字:${JSON.stringify(added).slice(0, 1500)}`;
  expect.soft(added.join('\n').includes(NOTE), `全部消息已加载时不应显示"${NOTE}"的说明${dump}`).toBe(false);
  expect.soft(header.length, `头部统计里应有费用${dump}`).toBeGreaterThan(0);
  if (header.length) expect.soft(Math.abs(header[0].amount - sum), `头部费用 ${header[0].amount} 应等于各回复气泡费用之和 ${sum}(允许显示取整误差 0.02)${dump}`).toBeLessThan(0.02);
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
