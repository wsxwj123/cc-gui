// B04~B05：Chromium 与 WebKit 各跑一次（同一个文件被两个 Playwright 项目各吃一遍，用例名后面会带项目名）。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import {
  boot, ensureRow, clickRow, openAndWait, waitMarker, watchHistory, sleep, resetCtl, finishRounds, sendAndWaitRunning,
} from './helpers/app.mjs';

test.describe.configure({ timeout: 240_000 });

test('B04 从侧栏切到没打开过的 X：从点击到结束标记出现后再过 2 秒，前端对 X 的历史接口恰好发 1 次请求', async ({ page }) => {
  const reqs = watchHistory(page);
  await boot(page);
  await ensureRow(page, 'X');
  await openAndWait(page, 'S4');
  await ensureRow(page, 'X'); // 跨工作区：先展开 X 所在工作区（不计入下面的计时）
  const tClick = Date.now();
  await clickRow(page, 'X');
  const ms = await waitMarker(page, SESSIONS.X.end, 60_000);
  expect(ms, 'X 的结束标记应在 60 秒内出现').not.toBeNull();
  await sleep(2_000);
  const mine = reqs.filter((r) => r.sid === SESSIONS.X.sid && r.at >= tClick);
  expect(mine.length, `点击 X 后对 X 的 GET /api/sessions/<X>/messages 应恰好 1 次；实测 ${mine.length} 次：${mine.map((r) => r.url.replace(/^.*\/api/, '/api')).join(' | ')}`).toBe(1);
});

test('B05 回复进行中在 P、Q 之间每 700 毫秒交替点 12 次（不等加载）：最后一次点击后 10 秒内最后点的会话结束标记出现', async ({ page }) => {
  resetCtl();
  try {
    await boot(page);
    await ensureRow(page, 'P');
    await ensureRow(page, 'Q');
    await openAndWait(page, 'S5');
    await sendAndWaitRunning(page, 'S5', `${SESSIONS.S5.beg} B05 请开始一段长回复`);
    await ensureRow(page, 'P'); // 跨工作区：先展开 P、Q 所在工作区
    const keys = [];
    let tLast = 0;
    for (let i = 0; i < 12; i += 1) {
      const key = i % 2 === 0 ? 'P' : 'Q';
      keys.push(key);
      await clickRow(page, key);
      tLast = Date.now();
      if (i < 11) await sleep(700);
    }
    const last = keys[keys.length - 1];
    const ms = await waitMarker(page, SESSIONS[last].end, 10_000 - (Date.now() - tLast));
    const total = Date.now() - tLast;
    expect(ms, `最后一次点击（${last}）后 10 秒内应出现 ${last} 的结束标记；实测 ${ms === null ? '10 秒内未出现' : `${total}ms`}`).not.toBeNull();
  } finally {
    await finishRounds();
  }
});
