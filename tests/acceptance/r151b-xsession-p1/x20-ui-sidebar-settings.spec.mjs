// 行为清单 20–22:侧栏待处理条数、Dock 角标(浏览器里只能验窗口标题不变)、设置页「会话」分区。
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { seedSession, uniq, makeWorkspace } from './helpers/fixtures.mjs';
import { xs } from './helpers/api.mjs';
import { boot, openSessionSettings, sidebar, note, showWorktreeProjects } from './helpers/ui.mjs';

test.describe.configure({ timeout: 180_000 });
const api = xs();
/** 找到 data-testid=<id> 的徽标里、往上 5 层内文字包含 label 的那一个,返回徽标文字;没有返回 null。 */
const badgeNear = (page, id, label) => page.evaluate(([tid, text]) => {
  for (const b of document.querySelectorAll(`[data-cgui="sidebar"] [data-testid="${tid}"]`)) {
    let e = b;
    for (let i = 0; i < 5 && e; i += 1, e = e.parentElement) if ((e.textContent || '').includes(text)) return (b.textContent || '').trim();
  }
  return null;
}, [id, label]);
const NOTICE = '开启后，你可以把回复转发给本机 CC-GUI 的其它会话，对方会话里会出现一张卡片，确认后才处理。GUI 会话之间经 CLI 原生通道直接发送的消息会被拒绝并提示改为转发。消息只在本机会话之间传递，对方处理时会随它的模型请求发给它所用的 provider。';

test('X20 侧栏:会话行 xs-unread = 该会话待处理条数(0 不出现);项目折叠时 xs-unread-project = 该项目所有会话之和,展开或为 0 时不出现', async ({ page }) => {
  await api.on();
  const mark = uniq('R151BX20');
  const proj = makeWorkspace(`x20-proj-${mark}`);
  const projName = path.basename(proj);
  const now = Date.now();
  const src = seedSession(`x20-src-${mark}`);
  const sNew = seedSession('x20-new', { cwd: proj, title: `${mark} 最新`, mtime: new Date(now) });
  const sZero = seedSession('x20-zero', { cwd: proj, title: `${mark} 没有消息`, mtime: new Date(now - 60_000) });
  for (let i = 0; i < 10; i += 1) seedSession(`x20-f${i}`, { cwd: proj, title: `${mark} 填充${i}`, mtime: new Date(now - 120_000 * (i + 1)) });
  const sOld = seedSession('x20-old', { cwd: proj, title: `${mark} 最旧`, mtime: new Date(now - 10 * 86_400_000) });
  await api.send(src.sid, [sNew.sid], 'R151B x20 一');
  await api.send(src.sid, [sNew.sid], 'R151B x20 二');
  await api.send(src.sid, [sOld.sid], 'R151B x20 三');
  await boot(page);
  // 前置:本套件的工作区都建在工作树(…/.claude/worktrees/…)里,侧栏默认不列 worktree 项目 →
  // 先经设置页「会话」分区打开「在项目列表显示 worktree 项目」;用例结束时拨回,不留给后面的用例
  const restoreWorktree = await showWorktreeProjects(page);
  try {
    const projLabel = sidebar(page).getByText(projName).first();
    await expect(projLabel, '前置:侧栏里有这个项目').toBeVisible({ timeout: 30_000 });
    const rowVisible = () => sidebar(page).getByText(`${mark} 最新`).first().isVisible().catch(() => false);
    if (!(await rowVisible())) await projLabel.click();
    await expect(sidebar(page).getByText(`${mark} 最新`).first(), '前置:项目已展开').toBeVisible({ timeout: 10_000 });

    await expect.poll(() => badgeNear(page, 'xs-unread', `${mark} 最新`), { timeout: 15_000, message: '会话行显示 2' }).toBe('2');
    expect(await badgeNear(page, 'xs-unread', `${mark} 没有消息`), '0 条时不出现').toBeNull();
    expect(await badgeNear(page, 'xs-unread-project', projName), '项目展开时不出现项目汇总').toBeNull();
    await projLabel.click();
    await expect.poll(() => badgeNear(page, 'xs-unread-project', projName), { timeout: 10_000, message: '折叠后项目行显示 3(含侧栏没列出的会话)' }).toBe('3');
    await projLabel.click();
    await expect.poll(() => badgeNear(page, 'xs-unread-project', projName), { timeout: 10_000, message: '再展开后项目汇总消失' }).toBeNull();
  } finally {
    await restoreWorktree().catch((e) => note(`收尾:「在项目列表显示 worktree 项目」没能拨回:${String((e && e.message) || e).slice(0, 200)}`));
  }
});

test('X21 Dock 角标:浏览器里观测不到角标本身;总开关开着、来了待处理消息时,窗口标题不变', async ({ page }) => {
  note('Dock 角标是桌面端行为(Tauri),浏览器里无法观测;这里只验"窗口标题计数不变"。顶栏红点没有可测标识,未覆盖。');
  await api.on();
  const src = seedSession(`x21-src-${uniq('')}`);
  const tgt = seedSession(`x21-t-${uniq('')}`);
  await boot(page);
  await page.waitForTimeout(1_500);
  const before = await page.title();
  await api.send(src.sid, [tgt.sid], 'R151B x21 一');
  await api.send(src.sid, [tgt.sid], 'R151B x21 二');
  await page.waitForTimeout(2_500);
  expect(await page.title(), '窗口标题不受待处理消息影响').toBe(before);
});

test('X22 设置页「会话」分区:xsession-settings-section(搜"跨会话消息"能找到)、开关 role=switch、一期说明逐字、lastFailureAt 为空时没有引导失效提示、没有连锁上限输入框', async ({ page }) => {
  await api.off();
  const cfg = await api.config();
  expect(cfg.status, `前置:GET config 200(${cfg.text.slice(0, 200)})`).toBe(200);
  expect(cfg.body.nativeGuard.lastFailureAt, '前置:引导检查没有失效过').toBeNull();
  await boot(page);
  await openSessionSettings(page);
  const section = page.getByTestId('xsession-settings-section');
  await section.scrollIntoViewIfNeeded().catch(() => {});
  await expect(section).toBeVisible({ timeout: 10_000 });
  expect(await page.locator('#set-xsession').count(), '块 id="set-xsession"').toBe(1);
  const toggle = section.getByTestId('xsession-toggle');
  await expect(toggle).toHaveAttribute('role', 'switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect((await section.getByTestId('xsession-notice').innerText()).replace(/\s+/g, ' ').trim()).toBe(NOTICE);
  expect(await section.getByTestId('xsession-guard-warning').count(), 'lastFailureAt 为空时不显示').toBe(0);
  expect(await section.locator('input[type="number"]').count(), '没有连锁上限输入框').toBe(0);
  expect(await section.innerText(), '没有连锁上限设置').not.toContain('连锁上限');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
  await expect.poll(async () => (await api.config()).body.enabled, { message: '点开关后 GET config 为 true' }).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 });
  await expect.poll(async () => (await api.config()).body.enabled).toBe(false);

  const search = page.locator('input[data-testid="settings-search"], [data-testid="settings-search"] input').first();
  await expect(search, '设置页有搜索框').toBeVisible({ timeout: 5_000 });
  await search.fill('跨会话消息');
  await expect(page.locator('#set-xsession'), '搜"跨会话消息"能找到这个块').toBeVisible({ timeout: 10_000 });
});
