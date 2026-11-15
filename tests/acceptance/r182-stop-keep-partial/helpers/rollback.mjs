// r188-rollback-flow 用例共用的页面操作与观测(只通过页面:文案 / role / title / data-* 锚点)。
// 口径照接口文件:观察窗口 = 从消息区第一次出现「重发轮。」起,每 250 毫秒读一次,直到新一轮结束(见过停止键之后停止键消失)后 6 秒。
import { expect } from '@playwright/test';
import { readView, waitView, clickSession, composerBox } from './runtime.mjs';

export const RELAUNCH_SCENARIO = { chunkCount: 5, chunkIntervalMs: 1500, textPrefix: '重发轮。' };
export const countOf = (text, s) => text.split(s).length - 1;

/** 对某条用户消息卡打开「回滚 / 重新编辑」菜单并点指定菜单项(itemName 为菜单项可见文字的正则)。 */
export async function pickRollbackItem(page, prompt, itemName, what) {
  const card = page.locator('[data-cgui="message-user"]').filter({ hasText: prompt }).first();
  await expect(card, `${what}:这条用户消息卡应带 data-message-id(最多等 5 秒)`).toHaveAttribute('data-message-id', /.+/, { timeout: 5_000 });
  // 停止 / 回合刚结束后的头一两秒,消息列表会重排、用户消息卡可能被重新挂载,刚打开的菜单会跟着消失。
  // 所以「悬停 → 点菜单键 → 点菜单项」整组重来:每步短超时,点不到就从悬停重新开始;菜单项一点成功立刻返回(不会点两次)。
  const STEP_MS = 1_200;
  const TOTAL_MS = 8_000;
  const start = Date.now();
  let attempt = 0;
  let lastStep = '悬停用户消息卡';
  let lastErr = '';
  while (Date.now() - start < TOTAL_MS) {
    attempt += 1;
    try {
      lastStep = '悬停用户消息卡';
      await card.hover({ timeout: STEP_MS });
      lastStep = '点「回滚 / 重新编辑」';
      await card.getByTitle('回滚 / 重新编辑').click({ timeout: STEP_MS });
      lastStep = `点菜单项 ${itemName}`;
      await page.getByRole('button', { name: itemName }).click({ timeout: STEP_MS });
      return;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e).split('\n')[0];
      await page.waitForTimeout(150);
    }
  }
  throw new Error(`${what}:${TOTAL_MS} 毫秒内共尝试 ${attempt} 次仍没点到菜单项 ${itemName};最后一次(第 ${attempt} 次)卡在「${lastStep}」:${lastErr}`);
}

/** 「编辑后重发」:点菜单项,等原文回到输入框,不发送。 */
export async function editAndResendFill(page, prompt, what) {
  await pickRollbackItem(page, prompt, /编辑后重发/, what);
  await expect(composerBox(page).last(), `${what}:「编辑后重发」应把原文放回输入框`).toHaveValue(prompt, { timeout: 20_000 });
}

/**
 * 等「重发轮。」第一次出现(最多 appearTimeoutMs),再按观察窗口口径读到结束。
 * t0 = 触发回退的那次点击 / 发送的时刻。返回 { appearMs(从 t0 到第一次出现;没出现为 null), samples(窗口内读数,dt 为距第一次出现的毫秒), doneAt(新一轮结束时刻;没结束为 null) }。
 */
export async function observeRelaunch(page, prompts, t0, { appearTimeoutMs = 40_000, maxWindowMs = 60_000 } = {}) {
  const first = await waitView(page, prompts, (v) => v.text.includes('重发轮。'), appearTimeoutMs, 250);
  if (!first.ok) return { appearMs: null, samples: [first.v], doneAt: null };
  const base = first.v.t;
  const samples = [];
  let seenStop = false;
  let doneAt = null;
  let v = first.v;
  for (;;) {
    v.dt = v.t - base;
    samples.push(v);
    if (v.stop) seenStop = true;
    if (doneAt == null && seenStop && !v.stop) doneAt = v.t;
    if (doneAt != null && v.t - doneAt >= 6000) break;
    if (v.t - base > maxWindowMs) break;
    await page.waitForTimeout(250);
    v = await readView(page, prompts);
  }
  return { appearMs: base - t0, samples, doneAt };
}

/** 后台每 250 毫秒读一次页面,直到 stop();读数带 dt(距 t0 毫秒)。 */
export function startSampler(page, prompts, t0 = Date.now()) {
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const v = await readView(page, prompts);
        v.dt = v.t - t0;
        samples.push(v);
      } catch { /* 页面正在跳转 / 关闭:忽略这一次 */ }
      await page.waitForTimeout(250);
    }
  })();
  return { samples, stop: async () => { running = false; await loop; } };
}

/** 切走再切回:点乙,停 1.5 秒,点回甲,等 5 秒后读一次。 */
export async function switchAwayAndBack(page, ctx, prompts) {
  await clickSession(page, 'yi', ctx);
  await page.waitForTimeout(1500);
  await clickSession(page, 'jia', ctx);
  await page.waitForTimeout(5000);
  return readView(page, prompts);
}

/** 片段编号 → 出现次数。 */
export function fragIds(text) {
  const ids = {};
  for (const x of text.match(/片段\d{4}/g) || []) ids[x] = (ids[x] || 0) + 1;
  return ids;
}

/** 期末(或切回后)的共同断言:片段总数 5、5 个不同编号且各 1 次(withIds)、「重发轮。」恰好 1 次(withRelaunch)。 */
export function expectFiveFragments(view, what, { withIds = true, withRelaunch = true } = {}) {
  expect(view.total, `${what}:整个消息区片段总数应为 5`).toBe(5);
  if (withIds) {
    const ids = fragIds(view.text);
    expect(Object.keys(ids).length, `${what}:应有 5 个不同编号;实际 ${JSON.stringify(ids)}`).toBe(5);
    expect(Math.max(0, ...Object.values(ids)), `${what}:每个编号恰好 1 次;实际 ${JSON.stringify(ids)}`).toBe(1);
  }
  if (withRelaunch) expect(countOf(view.text, '重发轮。'), `${what}:「重发轮。」在消息区出现的次数`).toBe(1);
}
