// r194-title-sync 验收(黑盒):同一个会话在「完成浮条 / 会话标题 / 顶栏会话名 / 侧栏会话行」四处显示同一个名字;改名后四处几秒内一起变。
// 只通过页面与 HTTP 对外接口观测;名字全部带用例编号 + 本次运行随机串(见 helpers/fixtures.mjs)。
import { test, expect } from '@playwright/test';
import { fixtureManifest, openApp, reloadApp, expandGroup, collapseGroup, clickRowWith, rowTexts, sessionRows, sendText, readTitle, readTopbarName,
  waitThreePlaces, rowMenu, submitRename, startBannerWatch, waitBannerAppear, waitBannerGone, bannerNamesSeen, bannerRowsAtFirst } from './helpers/runtime.mjs';
import { setHold, readStatus } from './helpers/fixtures.mjs';

const PASS = process.env.R194_PASS || 'main';
const manifest = fixtureManifest();
const only = (pass) => test.skip(PASS !== pass, `本条只在「${pass}」趟跑(后端 ${pass === 'watch' ? '监听' : '不监听'}会话目录)`);

/** 等假命令行报告「这个工作区里的一轮已结束」,返回结束时刻(epoch 毫秒);超时抛错。 */
async function waitTurnFinished(page, wsName, timeoutMs = 40_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = readStatus(wsName);
    if (st && st.processed >= 1 && st.finishedAt) return st.finishedAt;
    if (Date.now() >= end) throw new Error(`假命令行 ${timeoutMs}ms 内没有结束 ${wsName} 里的那一轮(状态 ${JSON.stringify(st)})`);
    await page.waitForTimeout(150);
  }
}
async function waitReceived(page, wsName) {
  const end = Date.now() + 20_000;
  for (;;) {
    const st = readStatus(wsName);
    if (st && st.received >= 1) return;
    if (Date.now() >= end) throw new Error(`假命令行没有收到 ${wsName} 里的用户消息`);
    await page.waitForTimeout(100);
  }
}

/** 第 1/2/3/6 条共用的开头:A 里的会话 S 开始一轮,回复没结束就点开 T。返回 { c }。afterSwitch 在点开 T 之后、观察之前做额外动作。 */
async function startReplyThenSwitchToT(page, c, { name, holdSec, afterSwitch }) {
  setHold(c.wsAName, holdSec);
  await openApp(page);
  await expandGroup(page, c.wsAName);
  await expandGroup(page, c.wsBName);
  await clickRowWith(page, name);
  await sendText(page, `请回复 ${c.id}`);
  await waitReceived(page, c.wsAName);
  await clickRowWith(page, c.tMarker);
  if (afterSwitch) await afterSwitch();
  await startBannerWatch(page);
}

/** 等 S 这一轮结束 → 8 秒内出现浮条;再等浮条消失。返回 { finishedAt, appearedAt }。 */
async function watchBannerLifecycle(page, c) {
  const finishedAt = await waitTurnFinished(page, c.wsAName);
  const appearedAt = await waitBannerAppear(page, finishedAt + 8_000);
  expect(appearedAt, 'S 这一轮结束后 8 秒内应出现完成浮条(「… · 回复完成」)').not.toBeNull();
  expect(await waitBannerGone(page, 25_000), '完成浮条应在约 10 秒后消失').toBe(true);
  return { finishedAt, appearedAt };
}

test.describe('r194 会话名四处一致', () => {
  test('T1 后台回复完成:浮条从出现到消失一直是「甲」,侧栏 S 行写「甲」,任何时刻没出现过「乙」', async ({ page }) => {
    only('main');
    const c = manifest.cases.t1;
    await startReplyThenSwitchToT(page, c, { name: c.jia, holdSec: 12 });
    await watchBannerLifecycle(page, c);
    expect(await bannerNamesSeen(page), '浮条从出现到消失,文字应始终是「甲 · 回复完成」,不能出现「乙」').toEqual([`${c.jia} · 回复完成`]);
    expect(await bannerRowsAtFirst(page), '浮条出现的那一刻,侧栏 S 那一行应写「甲」').toContain(c.jia);
    expect((await bannerRowsAtFirst(page)).some((t) => t.includes(c.yi)), '浮条出现时侧栏不应有「乙」').toBe(false);
  });

  test('T2 A 组收起且本次打开页面后没展开过:浮条从出现起就是「甲」;之后展开 A,S 行写「甲」', async ({ page }) => {
    only('main');
    const c = manifest.cases.t2;
    setHold(c.wsAName, 18);
    await openApp(page);
    await expandGroup(page, c.wsAName);
    await expandGroup(page, c.wsBName);
    await clickRowWith(page, c.jia);
    await sendText(page, `请回复 ${c.id}`);
    await waitReceived(page, c.wsAName);
    await clickRowWith(page, c.tMarker);
    await collapseGroup(page, c.wsAName);
    await reloadApp(page);
    // 前提:刷新后 A 是收起的(这次打开页面以来没展开过);T 在 B 组里,B 展开后点开 T。
    await expect(page.locator('[data-cgui="project-row"]').filter({ hasText: c.wsAName }).first(), '前提:刷新后 A 组应是收起的').toHaveAttribute('aria-expanded', 'false');
    await expandGroup(page, c.wsBName);
    await clickRowWith(page, c.tMarker);
    await startBannerWatch(page);
    await watchBannerLifecycle(page, c);
    expect(await bannerNamesSeen(page), '浮条从出现起就应是「甲 · 回复完成」,不能出现「乙」').toEqual([`${c.jia} · 回复完成`]);
    await expandGroup(page, c.wsAName);
    await expect.poll(async () => await rowTexts(page), { timeout: 5_000, message: '展开 A 后,S 那一行应写「甲」' }).toContain(c.jia);
    expect((await rowTexts(page)).some((t) => t.includes(c.yi)), '展开 A 后侧栏不应有「乙」').toBe(false);
  });

  test('T3 点完成浮条跳到 S:会话标题、顶栏会话名、侧栏 S 行都写「甲」', async ({ page }) => {
    only('main');
    const c = manifest.cases.t3;
    await startReplyThenSwitchToT(page, c, { name: c.jia, holdSec: 12 });
    const finishedAt = await waitTurnFinished(page, c.wsAName);
    const appearedAt = await waitBannerAppear(page, finishedAt + 8_000);
    expect(appearedAt, 'S 这一轮结束后 8 秒内应出现完成浮条').not.toBeNull();
    await page.getByRole('button', { name: /回复完成/ }).first().click({ timeout: 8_000 });
    const snap = { title: null, top: null, row: null };
    const end = Date.now() + 6_000;
    for (;;) {
      snap.title = await readTitle(page);
      snap.top = await readTopbarName(page);
      snap.row = (await rowTexts(page)).find((t) => t.includes('甲') || t.includes('乙')) ?? null;
      if (snap.title === c.jia && snap.top === c.jia && snap.row === c.jia) break;
      if (Date.now() >= end) break;
      await page.waitForTimeout(150);
    }
    expect(snap, '点浮条跳到 S 后,标题、顶栏名、侧栏 S 行都应是「甲」').toEqual({ title: c.jia, top: c.jia, row: c.jia });
  });

  for (const mode of ['watch', 'nowatch']) {
    const trace = mode === 'watch' ? 'T4-watch' : 'T4-nowatch';
    test(`${trace} 行菜单「重命名」改为「丙」:10 秒内侧栏 S 行、会话标题、顶栏会话名都写「丙」(${mode === 'watch' ? '后端监听会话目录' : '后端不监听会话目录'})`, async ({ page }) => {
      only(mode === 'watch' ? 'watch' : 'main');
      const c = manifest.cases[mode === 'watch' ? 't4w' : 't4n'];
      await openApp(page);
      await expandGroup(page, c.wsAName);
      await clickRowWith(page, c.jia);
      await expect.poll(() => readTitle(page), { timeout: 10_000, message: '打开 S 后会话标题应写「甲」' }).toBe(c.jia);
      await rowMenu(page, sessionRows(page).first(), '重命名');
      await submitRename(page, c.bing);
      const snap = await waitThreePlaces(page, c.bing, 10_000);
      expect(snap, '改名后 10 秒内三处都应是「丙」').toEqual({ row: c.bing, title: c.bing, top: c.bing });
    });
  }

  for (const mode of ['watch', 'nowatch']) {
    const trace = mode === 'watch' ? 'T5-watch' : 'T5-nowatch';
    test(`${trace} 会话标题铅笔改为「丁」:10 秒内会话标题、顶栏会话名、侧栏 S 行都写「丁」(${mode === 'watch' ? '后端监听会话目录' : '后端不监听会话目录'})`, async ({ page }) => {
      only(mode === 'watch' ? 'watch' : 'main');
      const c = manifest.cases[mode === 'watch' ? 't5w' : 't5n'];
      await openApp(page);
      await expandGroup(page, c.wsAName);
      await clickRowWith(page, c.jia);
      await expect.poll(() => readTitle(page), { timeout: 10_000, message: '打开 S 后会话标题应写「甲」' }).toBe(c.jia);
      await page.getByTitle('重命名会话').first().click({ force: true });
      await submitRename(page, c.ding);
      const snap = await waitThreePlaces(page, c.ding, 10_000);
      expect(snap, '改名后 10 秒内三处都应是「丁」').toEqual({ row: c.ding, title: c.ding, top: c.ding });
    });
  }

  test('T6 相邻回归:会话记录里没有名字、偏好里记「乙二」:后台回复完成浮条与侧栏行都写「乙二」', async ({ page }) => {
    only('main');
    const c = manifest.cases.t6;
    await startReplyThenSwitchToT(page, c, { name: c.yi2, holdSec: 12 });
    await watchBannerLifecycle(page, c);
    expect(await bannerNamesSeen(page), '浮条应始终是「乙二 · 回复完成」').toEqual([`${c.yi2} · 回复完成`]);
    expect(await bannerRowsAtFirst(page), '浮条出现时侧栏 R 那一行应写「乙二」').toContain(c.yi2);
  });

  test('T7 相邻回归:正在看的会话 S 回复完成时,不出完成浮条', async ({ page }) => {
    only('main');
    const c = manifest.cases.t7;
    setHold(c.wsAName, 8);
    await openApp(page);
    await expandGroup(page, c.wsAName);
    await clickRowWith(page, c.jia);
    await sendText(page, `请回复 ${c.id}`);
    await waitReceived(page, c.wsAName);
    await startBannerWatch(page);
    const finishedAt = await waitTurnFinished(page, c.wsAName);
    await page.waitForTimeout(Math.max(0, finishedAt + 5_000 - Date.now()));
    expect(await bannerNamesSeen(page), '正在看的会话回复完成时不应出现任何「回复完成」浮条').toEqual([]);
    await expect(page.getByText('R194OK').first(), '回复本身应已显示在当前会话里(证明这一轮确实完成并被看见)').toBeVisible({ timeout: 5_000 });
  });

  test('T8 行菜单「分支会话」:10 秒内侧栏出现「甲分支1」新会话行,打开后会话标题与顶栏会话名都写「甲分支1」', async ({ page }) => {
    only('main');
    const c = manifest.cases.t8;
    await openApp(page);
    await expandGroup(page, c.wsAName);
    await clickRowWith(page, c.jia);
    await expect.poll(() => readTitle(page), { timeout: 10_000, message: '打开 S 后会话标题应写「甲」' }).toBe(c.jia);
    await rowMenu(page, sessionRows(page).filter({ hasText: c.jia }).first(), '分支会话');
    await expect.poll(async () => await rowTexts(page), { timeout: 10_000, message: '10 秒内侧栏应出现「甲分支1」那一行' }).toContain(c.branch);
    await clickRowWith(page, c.branch);
    // 分支会话会开成左右分屏(左边是原会话 S,标题仍是「甲」),页面上有两个会话标题:
    // 读出每个窗格的会话标题,要求其中有一个是「甲分支1」(新会话那一格)。(主会话锁定前修订:原来只读页面上第一个标题,读到的是左边 S 的;期望值不变)
    const paneTitles = () => page.getByTitle('重命名会话').evaluateAll((bs) => bs.map((b) => { const s = b.parentElement && b.parentElement.querySelector('span'); return s ? s.textContent.trim() : null; }));
    const end = Date.now() + 8_000;
    let snap;
    for (;;) {
      const titles = await paneTitles();
      snap = { title: titles.includes(c.branch) ? c.branch : (titles.join(' | ') || null), top: await readTopbarName(page) };
      if (snap.title === c.branch && snap.top === c.branch) break;
      if (Date.now() >= end) break;
      await page.waitForTimeout(150);
    }
    expect(snap, '打开分支会话后,新会话所在窗格的会话标题与顶栏会话名都应是「甲分支1」').toEqual({ title: c.branch, top: c.branch });
  });
});
