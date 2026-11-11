// B10~B15：WebKit 内核（Mac 版应用）下的回归；这些行为在当前代码上本来就应该正常，修复后不能被破坏。
import { test, expect } from '@playwright/test';
import { SESSIONS } from './helpers/fixtures.mjs';
import {
  boot, ensureRow, clickRow, openAndWait, waitMarker, markerShown, markerInPage, markerInPane, switchLoop, describeSwitches,
  resetCtl, finishRounds, sendAndWaitRunning, stopBtn, countMatches, messageRows, loadOlder, setPaneCount, focusPane, sleep,
} from './helpers/app.mjs';

test.describe.configure({ timeout: 240_000 });

test('B10 回复进行中切走再切回：10 秒内停止键重新出现，3 秒内回复继续变长，用户消息只显示 1 次', async ({ page }) => {
  resetCtl();
  const userMark = 'R168USERB10';
  try {
    await boot(page);
    await ensureRow(page, 'X');
    await ensureRow(page, 'Y');
    await openAndWait(page, 'S10');
    await sendAndWaitRunning(page, 'S10', `${SESSIONS.S10.beg} ${userMark} 请开始一段长回复`);
    await sleep(2_000);
    await ensureRow(page, 'X'); // 打开 S 会收起 X 所在工作区：先展开（不计入下面的切换计时）
    const sw =await switchLoop(page, ['X', 'Y', 'X'], 3, { pause: 800 });
    const swBad = sw.filter((r) => r.ms === null || r.ms > 10_000);
    expect(swBad, `回复进行中的三次切换都应在 10 秒内出现目标结束标记；实测：${describeSwitches(sw)}`).toEqual([]);
    await ensureRow(page, 'S10'); // 跨工作区：先展开 S 所在工作区
    const tBack = Date.now();
    await clickRow(page, 'S10');
    await expect(stopBtn(page), '切回 S 后 10 秒内停止键应重新出现').toBeVisible({ timeout: 10_000 });
    const backMs = Date.now() - tBack;
    // 用页面上出现过的最大增量词编号衡量"回复变长"（重新渲染时重复/折叠会让出现次数忽多忽少，最大编号只增不减）
    const maxTok = () => page.evaluate(() => {
      const el = document.querySelector('[data-cgui="message-list"]');
      const all = el ? ((el.textContent || '').match(/R168T(\d{5})/g) || []) : [];
      return all.reduce((m, s) => Math.max(m, Number(s.slice(5))), 0);
    });
    const c0 = await maxTok();
    let c1 = c0;
    const t1 = Date.now();
    while (Date.now() - t1 < 3_000 && c1 <= c0) { await sleep(250); c1 = await maxTok(); }
    expect(c1, `停止键重现（${backMs}ms）后 3 秒内回复正文应继续变长：最大增量词编号 ${c0} -> ${c1}`).toBeGreaterThan(c0);
    const userCount = await countMatches(page, new RegExp(userMark, 'g'));
    expect(userCount, `S 里的用户消息应只显示 1 次，实测 ${userCount} 次`).toBe(1);
  } finally {
    await finishRounds();
  }
});

test('B11 快速连切：点 X 后 100 毫秒内点 Y，10 秒内显示 Y 的结束标记，且之后 3 秒内 X 的结束标记始终不出现', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'X');
  await ensureRow(page, 'Y');
  await clickRow(page, 'X');
  await sleep(60);
  const xAlready = await markerInPage(page, SESSIONS.X.end);
  test.info().annotations.push({ type: 'note', description: `点 Y 之前 X 的结束标记是否已出现：${xAlready}` });
  await clickRow(page, 'Y');
  const ms = await waitMarker(page, SESSIONS.Y.end, 10_000);
  expect(ms, '点 Y 后 10 秒内应显示 Y 的结束标记').not.toBeNull();
  const leaks = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 3_000) {
    if (await markerInPage(page, SESSIONS.X.end)) leaks.push(Date.now() - t0);
    await sleep(100);
  }
  expect(leaks, `之后 3 秒内 X 的结束标记不应出现在页面上（出现的时刻 ms：${leaks.join(',')}）`).toEqual([]);
});

test('B12 连切到 Y 加载完后点「加载更早」：10 秒内消息条数变多，按钮不停在禁用/转圈', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'X');
  await ensureRow(page, 'Y');
  await clickRow(page, 'X');
  await sleep(60);
  await clickRow(page, 'Y');
  expect(await waitMarker(page, SESSIONS.Y.end, 10_000), '前置：Y 应在 10 秒内加载完').not.toBeNull();
  const entry = loadOlder(page).first();
  await expect(entry, 'Y 加载完后应有「加载更早」入口').toBeVisible({ timeout: 10_000 });
  const before = await messageRows(page).count();
  await entry.dispatchEvent('click');
  let after = before;
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000 && after <= before) { await sleep(250); after = await messageRows(page).count(); }
  expect(after, `点「加载更早」后 10 秒内消息条数应变多：${before} -> ${after}`).toBeGreaterThan(before);
  const btn = page.locator('[data-history-load-older] button');
  if (await btn.count()) await expect(btn, '「加载更早」按钮不应停留在禁用状态').toBeEnabled({ timeout: 10_000 });
});

test('B13 X 加载完后再点侧栏里的 X（当前已打开的会话）：3 秒后 X 的结束标记仍在，会话区不变空', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'X');
  await openAndWait(page, 'X');
  await clickRow(page, 'X');
  await sleep(3_000);
  expect(await markerShown(page, SESSIONS.X.end), '再点一次当前会话 3 秒后 X 的结束标记应仍在页面上').toBe(true);
  expect(await messageRows(page).count(), '会话区消息行数应大于 0').toBeGreaterThan(0);
});

test('B14 分屏：左窗格开 X，右窗格在 S、T 间来回切 4 次：左窗格 X 始终在，右窗格每次 10 秒内显示目标会话结束标记', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'S14');
  await ensureRow(page, 'T14');
  const snap = (label) => page.evaluate(([lab, marks]) => `${lab}: ` + JSON.stringify([...document.querySelectorAll('[data-testid="pane"]')].map((el) => marks.filter((m) => (el.textContent || '').includes(m)))), [label, [SESSIONS.X.end, SESSIONS.S14.end, SESSIONS.T14.end]]);
  await openAndWait(page, 'X');
  console.log(await snap('B14 X 打开后'));
  await setPaneCount(page, 2);
  console.log(await snap('B14 分屏=2 后'));
  await ensureRow(page, 'S14'); // 跨工作区：X 在另一个工作区，先展开 S、T 所在工作区
  console.log(await snap('B14 展开工作区后'));
  await focusPane(page, 1);
  console.log(await snap('B14 点右窗格后'));
  await clickRow(page, 'S14');
  await sleep(1_500);
  console.log(await snap('B14 点 S14 后 1.5 秒'));
  const first = await waitMarker(page, SESSIONS.S14.end, 10_000, (p, m) => markerInPane(p, 1, m));
  expect(first, '前置：右窗格应在 10 秒内显示 S 的结束标记').not.toBeNull();
  const rs = [];
  const leftGone = [];
  const facts = [];
  for (let i = 0; i < 4; i += 1) {
    const key = i % 2 === 0 ? 'T14' : 'S14';
    await focusPane(page, 1);
    const t0 = Date.now();
    await clickRow(page, key);
    const ms = await waitMarker(page, SESSIONS[key].end, 10_000, (p, m) => markerInPane(p, 1, m));
    rs.push({ i: i + 1, key, ms: ms === null ? null : Date.now() - t0 });
    if (!(await markerInPane(page, 0, SESSIONS.X.end))) leftGone.push(i + 1);
    const paneFacts = await page.evaluate((marks) => [...document.querySelectorAll('[data-testid="pane"]')].map((el) => marks.filter((m) => (el.textContent || '').includes(m))), [SESSIONS.X.end, SESSIONS.S14.end, SESSIONS.T14.end]);
    facts.push(`#${i + 1}->${key}: 各窗格含的结束标记=${JSON.stringify(paneFacts)}`);
    await sleep(1_000);
  }
  expect(leftGone, `左窗格 X 的结束标记应始终在（消失的切换序号：${leftGone.join(',')}）；窗格内容：${facts.join(' ; ')}；右窗格切换耗时：${JSON.stringify(rs)}`).toEqual([]);
  const bad = rs.filter((r) => r.ms === null);
  expect(bad, `右窗格每次切换 10 秒内应显示目标结束标记；实测 ${JSON.stringify(rs)}`).toEqual([]);
});

test('B15 WebKit 无回复时在 X、Y 之间来回点 8 次：每次切完 10 秒内目标会话的结束标记都出现', async ({ page }) => {
  await boot(page);
  await ensureRow(page, 'X');
  await ensureRow(page, 'Y');
  const rs = await switchLoop(page, ['X', 'Y'], 8);
  const bad = rs.filter((r) => r.ms === null || r.ms > 10_000);
  expect(bad, `WebKit 下 8 次切换都应在 10 秒内出现结束标记；实测：${describeSwitches(rs)}`).toEqual([]);
});
