// r149 本地存储验收(黑盒)。只由 run.sh 调起:tests/acceptance/r149-storage/run.sh [-g 'S-A']
// 依据:.devflow/BRIEF-r148b.md 的 S 组。套件结构照抄 r148-perf(假 claude + 隔离实例 + dev server),
// helpers 是从 r148-perf 复制来的副本(原目录只读),只在 helpers/ui.mjs 末尾追加了造数与测量(「r149 追加」)。
//
// 用户实报:首页发消息被拦,提示「无法保存待发消息：本地存储空间不足。附件仍保留，请移除部分附件后重试。」
// (没有带附件)。主会话对真实数据只读统计:本地存储上限约 5 MB、已用 5.4 MB,其中 cgui-input-history:<会话键>
// 共 211 个键占 92%,88% 的条目是旧全局键 cgui-input-history(100 条)的原样副本 —— 每个新会话第一次发消息,
// 就把旧全局那 100 条抄进自己的键里。
//
// 本套件的数据全是自己造的同形态数据(不读任何真实数据):填到 setItem 抛错为止,不写死字节数。
//   S-A  存储被"旧全局副本"占满时,从首页发一条不带附件的消息:发得出去、不报错;输入历史占用下降 70% 以上
//   S-B  启动后自动瘦身:占用下降 70% 以上;再启动一次不再变化;旧全局键、各会话自己的条目、别的键都不动
//   S-C  新会话第一次发消息:它的会话键里只有这一条;上键仍能依次翻出本会话的、再到旧全局的
//   S-D  存储被"各会话自己的内容"占满(瘦身腾不出)时在会话里排队一条:排得进去、不报错;
//        被腾掉的是别的会话的输入历史,当前显示的这条会话的输入历史(哪怕最大)一条不少
//   S-E  真的腾不出空间(占满存储的不是输入历史)时才报错,没有附件时不提附件
import { test, expect } from '@playwright/test';
import { NAV, R149 } from './helpers/fixtures.mjs';
import {
  boot, composer, fillStorageWithHistory, HISTORY_PREFIX, inputHistoryUsage, LEGACY_HISTORY_KEY, legacyEntry, openSessionBySearch,
  readHistoryOf, readStorageItem, releaseAllRuns, seedLegacyHistory, sendPrompt, sessionRow, storageErrorCount, waitTurnRunning,
} from './helpers/ui.mjs';

const CTL = process.env.R118_CTL;
const KEEP_KEY = 'cgui-draft:r149-keep';        // 一个不是输入历史的键:任何时候都不许被动
const KEEP_VALUE = 'R149 这是一份草稿,不许被自动清理';

test.afterEach(async () => { releaseAllRuns(CTL); });

async function bootWithProject(page) {
  await boot(page);
  await openSessionBySearch(page, NAV.mark);
  await expect(sessionRow(page, NAV.mark), '侧栏里应能看到夹具会话').toBeVisible({ timeout: 20_000 });
}
const setItem = (page, key, value) => page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);

test('S-A 存储被旧全局历史的副本占满:从首页发一条不带附件的消息 —— 发得出去、不报错,输入历史占用下降 70% 以上', async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId('home-input'), '应落在首页').toBeVisible({ timeout: 20_000 });
  await setItem(page, KEEP_KEY, KEEP_VALUE);
  const legacy = await seedLegacyHistory(page, 100);
  const filled = await fillStorageWithHistory(page, { mode: 'copies' });
  console.log(`[S-A] 造了 ${filled.keys} 个会话键,已写不进:${filled.full}`);
  expect(filled.full, '本地存储应已填到写不进去(否则这条复现不了)').toBe(true);
  expect(filled.keys, '应是"很多个会话键"的形态').toBeGreaterThanOrEqual(30);
  const before = await inputHistoryUsage(page);

  const prompt = 'r149 存储满时从首页发一条';
  await page.getByTestId('home-input').fill(prompt);
  await page.getByTestId('home-send').click();
  await page.waitForTimeout(2_500);
  expect(await storageErrorCount(page), '不应出现"无法保存待发消息"的报错(修前:本地存储空间不足…请移除部分附件后重试)').toBe(0);
  await expect(page.getByText(`收到:${prompt}`, { exact: false }).first(), '消息应真的发了出去(假 CLI 收到并回了第一块)').toBeVisible({ timeout: 30_000 });

  const after = await inputHistoryUsage(page);
  console.log(`[S-A] 输入历史占用:${before.chars} → ${after.chars} 字符(${before.keys} → ${after.keys} 个键),下降 ${(100 - (after.chars / before.chars) * 100).toFixed(1)}%`);
  expect(after.chars, '输入历史总占用应比填充时下降 70% 以上').toBeLessThan(before.chars * 0.3);
  expect(JSON.parse(await readStorageItem(page, LEGACY_HISTORY_KEY)), '旧全局键原样保留(升级前的历史还要能翻)').toEqual(legacy);
  expect(await readStorageItem(page, KEEP_KEY), '不是输入历史的键不许被动').toBe(KEEP_VALUE);
});

test('S-B 启动后自动瘦身:占用下降 70% 以上,再启动一次不再变化;旧全局键、各会话自己的条目、别的键都不动', async ({ page }) => {
  await boot(page);
  await setItem(page, KEEP_KEY, KEEP_VALUE);
  const legacy = await seedLegacyHistory(page, 100);
  const filled = await fillStorageWithHistory(page, { mode: 'copies' });
  expect(filled.full).toBe(true);
  const before = await inputHistoryUsage(page);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await expect.poll(async () => (await inputHistoryUsage(page)).chars, { message: '启动后几秒内输入历史占用应下降 70% 以上', timeout: 12_000 })
    .toBeLessThan(before.chars * 0.3);
  await page.waitForTimeout(1_000);
  const slim = await inputHistoryUsage(page);
  console.log(`[S-B] 启动瘦身:${before.chars} → ${slim.chars} 字符(${before.keys} → ${slim.keys} 个键)`);

  // 各会话自己发的那一条还在(只剔掉了与旧全局相同的副本)
  const own = await page.evaluate((prefix) => {
    const out = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(...JSON.parse(localStorage.getItem(k)));
    }
    return { total: out.length, own: out.filter((x) => /^会话 \d+ 自己发的一条$/.test(x)).length, legacyCopies: out.filter((x) => x.startsWith('R149旧全局第')).length };
  }, HISTORY_PREFIX);
  expect(own.legacyCopies, '会话键里不应再有旧全局条目的副本').toBe(0);
  expect(own.own, '各会话自己发的条目应保留').toBeGreaterThanOrEqual(30);
  expect(JSON.parse(await readStorageItem(page, LEGACY_HISTORY_KEY)), '旧全局键原样保留').toEqual(legacy);
  expect(await readStorageItem(page, KEEP_KEY), '不是输入历史的键不许被动').toBe(KEEP_VALUE);

  // 幂等:再启动一次,什么都不再变
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
  await page.waitForTimeout(4_000);
  expect(await inputHistoryUsage(page), '第二次启动不应再改动输入历史').toEqual(slim);
});

test('S-C 新会话第一次发消息:它的会话键里只有这一条;上键仍能先翻出本会话的、再翻出旧全局的', async ({ page }) => {
  await bootWithProject(page);
  await seedLegacyHistory(page, 100);
  const S = R149[0];
  await openSessionBySearch(page, S.mark);
  expect(await readHistoryOf(page, S.sid), '这条会话还没发过消息,不该有自己的输入历史键').toBeNull();
  const prompt = 'r149 新会话的第一条';
  await sendPrompt(page, prompt);
  await waitTurnRunning(page, S.sid, prompt);

  const own = await readHistoryOf(page, S.sid);
  console.log(`[S-C] 会话键里的条数:${Array.isArray(own) ? own.length : own}`);
  expect(own, '会话键里应只有刚发的这一条(修前:这一条 + 旧全局 100 条的副本)').toEqual([prompt]);

  const box = composer(page);
  await box.click();
  await box.press('ArrowUp');
  await expect(box, '第一下上键:本会话自己的').toHaveValue(prompt);
  await box.press('ArrowUp');
  await expect(box, '第二下上键:旧全局最新的一条(升级前的历史仍翻得出来)').toHaveValue(legacyEntry(0));
  await box.press('ArrowUp');
  await expect(box, '第三下上键:旧全局第二条').toHaveValue(legacyEntry(1));
  await box.press('ArrowDown'); await box.press('ArrowDown'); await box.press('ArrowDown');
  await expect(box, '一路下键回到空输入框').toHaveValue('');
});

test('S-D 存储被各会话自己的输入历史占满(瘦身腾不出):在会话里排队一条 —— 排得进、不报错;腾掉的是别的会话的,当前显示的会话一条不少', async ({ page }) => {
  await bootWithProject(page);
  const S = R149[1];
  await openSessionBySearch(page, S.mark);
  const first = 'r149 占位回合';
  await sendPrompt(page, first);
  await waitTurnRunning(page, S.sid, first);             // 回合停在第一块:之后再发的会进待发队列

  await setItem(page, KEEP_KEY, KEEP_VALUE);
  // 当前显示的这条会话:输入历史全是自己的内容,而且做成最大的一个键(约 12 万字符)
  const mine = [first, ...Array.from({ length: 60 }, (_, i) => `R149-本会话自己的-${i} ` + '只属于正在显示的这条会话。'.repeat(150))];
  await setItem(page, `${HISTORY_PREFIX}${S.sid}`, JSON.stringify(mine));
  const filled = await fillStorageWithHistory(page, { mode: 'own', perKeyChars: 20_000 });
  console.log(`[S-D] 造了 ${filled.keys} 个别的会话的键(各约 2 万字符),已写不进:${filled.full}`);
  expect(filled.full, '本地存储应已填到写不进去').toBe(true);
  const before = await inputHistoryUsage(page);

  const queued = 'r149 排队这条';
  await sendPrompt(page, queued);
  await page.waitForTimeout(2_000);
  expect(await storageErrorCount(page), '不应出现"无法保存待发消息"的报错').toBe(0);
  expect(await readStorageItem(page, 'cgui-message-queue'), '这条应已落进持久化的待发队列').toContain(queued);

  const after = await inputHistoryUsage(page);
  const mineAfter = await readHistoryOf(page, S.sid);
  console.log(`[S-D] 输入历史键数:${before.keys} → ${after.keys};本会话的键 ${mine.length} → ${Array.isArray(mineAfter) ? mineAfter.length : mineAfter} 条`);
  expect(after.keys, '应腾掉了别的会话的输入历史键').toBeLessThan(before.keys);
  expect(Array.isArray(mineAfter), '当前显示的会话的输入历史键必须还在').toBe(true);
  for (let i = 0; i < 60; i += 1) expect(mineAfter.includes(mine[i + 1]), `本会话自己的第 ${i} 条不许被删`).toBe(true);
  expect(await readStorageItem(page, KEEP_KEY), '不是输入历史的键不许被动').toBe(KEEP_VALUE);
});

test('S-E 占满存储的不是输入历史(腾不出空间):这时才报错;没带附件时报错不提附件', async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId('home-input')).toBeVisible({ timeout: 20_000 });
  // 用不是输入历史的键填满(自动清理不许碰它们)
  const filled = await page.evaluate(() => {
    let n = 0;
    for (const size of [200_000, 20_000, 2_000, 200, 20]) {
      for (;;) { try { localStorage.setItem(`r149-ballast-${n}`, 'b'.repeat(size)); n += 1; } catch { break; } if (n > 5000) break; }
    }
    let full = false;
    try { localStorage.setItem('r149-probe', 'y'.repeat(120)); localStorage.removeItem('r149-probe'); } catch { full = true; }
    return { n, full };
  });
  expect(filled.full).toBe(true);
  await page.getByTestId('home-input').fill('r149 这条存不进去');
  await page.getByTestId('home-send').click();
  const err = page.getByText('无法保存待发消息', { exact: false }).first();
  await expect(err, '腾不出空间时应报错').toBeVisible({ timeout: 8_000 });
  const text = (await err.innerText()).trim();
  console.log(`[S-E] 报错文案:${text}`);
  expect(text, '没有附件时不提附件').not.toContain('附件');
  expect(text, '客观陈述存储已满').toContain('无法保存待发消息：本地存储已满。');
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('r149-ballast-')).length), '不是输入历史的键一个都不许删').toBe(filled.n);
});
