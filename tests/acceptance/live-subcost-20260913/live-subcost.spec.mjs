// 直播子代理金额(2026-09-13)浏览器验收 —— 用户实报那条的唯一验收语义:
// 「子代理的花费(在它完成后)自动显示」= **回合还在进行中**时,卡片上就有金额,
// 不必等回合结束后的历史刷新。
//
// 现场由假 CLI 三段式造出(见 fake-claude.mjs):task_started → 【等 go】 →
// 落盘转写 + task_notification → 【等 finish】。两个等待点让"金额出现的那一刻回合是否
// 仍在进行"可证:金额出现时 finish 还没放行、界面上的"停止"键还在。
//
// 端口/数据全隔离(见 harness.mjs),不碰 6677/6689 与真实 ~/.claude。
import { test, expect } from '@playwright/test';
import { startApp } from './harness.mjs';
import { bootUI } from '../r64-genui/browser/harness.js';

/** 卡片上那个金额节点的稳定身份:title 前缀(TaskCard 传的说明文案)。 */
const COST_TITLE_PREFIX = '该子代理自己的费用';
/** 100k input × $3/MTok(claude-sonnet-4-6 内置价)= $0.30 → 展示 ¥2.16。 */
const EXPECTED_CNY = 2.16;

const parseCny = (t) => Number(String(t).replace(/[^\d.]/g, ''));

test('子代理完成后金额立刻出现在卡片上,且回合仍在进行中', async ({ page }) => {
  const app = await startApp();
  try {
    const box = await bootUI(page, app);
    const tag = page.locator(`span[title^="${COST_TITLE_PREFIX}"]`);
    const stopBtn = page.getByRole('button', { name: /停止/ });

    await box.fill('E2E:直播子代理金额');
    await box.press('Enter');

    // ── 前置:卡片已出现、子代理还在跑 ──────────────────────────────────────
    await page.getByText('fixer', { exact: true }).first().waitFor({ timeout: 25_000 });
    expect(await stopBtn.count(), '前置:回合应当在跑(界面上有"停止")').toBeGreaterThan(0);
    expect(await tag.count(), '前置:子代理还在跑时卡片上不该有任何金额').toBe(0);

    // ── 放行:子代理落盘 + 自报完成(回合仍不结束)────────────────────────
    app.ctl.go();
    await tag.first().waitFor({ timeout: 25_000 });
    const money = (await tag.first().textContent()).trim();

    // ── 核心断言:金额出现的那一刻,回合仍在进行中 ─────────────────────────
    expect(await stopBtn.count(), '金额出现时必须仍在同一回合内(停止键还在)').toBeGreaterThan(0);
    expect(Math.abs(parseCny(money) - EXPECTED_CNY) < 0.005,
      `卡片金额应是 ¥${EXPECTED_CNY.toFixed(2)}(该子代理转写的用量),实际 ${money}`).toBe(true);

    // ── 回合结束 → 历史接管:金额不变、不出现第二份 ───────────────────────
    app.ctl.finish();
    await expect.poll(async () => stopBtn.count(), { timeout: 25_000 }).toBe(0);
    await expect.poll(async () => tag.count(), { timeout: 25_000 }).toBe(1);
    await expect.poll(async () => (await tag.first().textContent()).trim(), { timeout: 25_000 })
      .toBe(money);
  } finally {
    await app.stop();
  }
});
