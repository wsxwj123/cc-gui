// B01~B03：Chromium 内核（Windows 版应用 / Chrome、Edge 打开的网页）下来回切会话不卡死。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import {
  boot, ensureRow, switchLoop, describeSwitches, resetCtl, finishRounds, sendAndWaitRunning, openAndWait, sleep,
} from './helpers/app.mjs';

test.describe.configure({ timeout: 240_000 });

test('B01 Chromium 无回复时在 X、Y 之间来回点 8 次：每次切完 10 秒内目标会话的结束标记都出现', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'X');
  await ensureRow(page, 'Y');
  const rs = await switchLoop(page, ['X', 'Y'], 8);
  const bad = rs.filter((r) => r.ms === null || r.ms > 10_000);
  expect(bad, `8 次切换都应在 10 秒内出现结束标记；实测：${describeSwitches(rs)}`).toEqual([]);
});

test('B02 Chromium 回复进行中在 X、Y 之间来回点 8 次：每次切完 10 秒内目标会话的结束标记都出现', async ({ page }) => {
  resetCtl();
  try {
    await boot(page);
    await ensureRow(page, 'X');
    await ensureRow(page, 'Y');
    await openAndWait(page, 'S2');
    await sendAndWaitRunning(page, 'S2', `${SESSIONS.S2.beg} B02 请开始一段长回复`);
    await ensureRow(page, 'X'); // 打开 S 会收起 X 所在工作区：先展开（不计入下面的切换计时）
    const rs = await switchLoop(page, ['X', 'Y'], 8);
    const bad = rs.filter((r) => r.ms === null || r.ms > 10_000);
    expect(bad, `回复进行中 8 次切换都应在 10 秒内出现结束标记；实测：${describeSwitches(rs)}`).toEqual([]);
  } finally {
    await finishRounds();
  }
});

test('B03 Chromium 做完 8 次切换后，同页请求 /api/health 在 1 秒内返回 200', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'X');
  await ensureRow(page, 'Y');
  const rs = await switchLoop(page, ['X', 'Y'], 8);
  const health = await Promise.race([
    page.evaluate(async () => {
      const t = performance.now();
      try {
        const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(1000) });
        return { status: r.status, ms: Math.round(performance.now() - t) };
      } catch (e) {
        return { status: null, ms: Math.round(performance.now() - t), error: String(e && e.name) };
      }
    }),
    sleep(6_000).then(() => ({ status: null, ms: 6000, error: 'page-evaluate-hung' })),
  ]);
  expect(health, `切换 8 次后 /api/health 应在 1 秒内返回 200；实测 ${JSON.stringify(health)}（切换：${describeSwitches(rs)}）`).toMatchObject({ status: 200 });
  expect(health.ms, `/api/health 耗时应 < 1000ms，实测 ${health.ms}ms`).toBeLessThan(1000);
});
